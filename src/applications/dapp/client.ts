/**
 * The MOI dapp conventions as a client (docs/dapp-conventions.md).
 *
 * Sign-In With MOI: the dapp hands out a message for a wallet address, the
 * wallet signs it, the dapp answers the signature with a session cookie.
 * The message is checked (checkSignInMessage) before nonce() returns it, so
 * the phone is only ever asked to sign a sign-in for this origin and this wallet.
 * Operations: the dapp publishes an OpenAPI document; the connector calls
 * only operations listed there, with the session cookie, and nothing else.
 * No MCP imports.
 */

import { z } from "zod";

import { clip, MAX_BODY_BYTES, readCapped, readWhole } from "../../bounds.js";
import { MoiError } from "../../moi-error.js";
import type { FetchLike } from "../../public-fetch.js";
import { ErrorCode } from "../../schema.js";

const TIMEOUT_MS = 20_000;
export const SESSION_COOKIE = "moi_session";
/**
 * The longest this server keeps a dapp session, whatever Max-Age the dapp sets,
 * and what a cookie with no Max-Age gets. Capped here, where the cookie is
 * read, so the stored record and the time the tool tells the person agree.
 */
export const MAX_SESSION_SECONDS = 24 * 60 * 60;
const MAX_OPERATIONS = 200;
/** Sign-in and every other JSON answer: useless when cut, so over this is an error. */
const MAX_JSON_BYTES = 1024 * 1024;
/** The published OpenAPI document: useless when cut, so over this is an error. */
const MAX_OPENAPI_BYTES = 2 * 1024 * 1024;

export const SIWM_ROUTES = {
  nonce: "/api/auth/nonce",
  verify: "/api/auth/verify",
  logout: "/api/auth/logout",
} as const;

/** Where a dapp may publish its OpenAPI document, tried in order. */
export const OPENAPI_PATHS = ["/.well-known/openapi.json", "/openapi.json", "/api/openapi.json"] as const;

// Defined with the address guard that builds one (src/public-fetch.ts); re-exported for the clients that take one.
export type { FetchLike };

const Nonce = z.object({ nonce: z.string().min(1).optional(), message: z.string().min(20) });
const Verified = z.object({ ok: z.literal(true) }).passthrough();

/** How far Issued At may be from this server's clock, either way. The Launchpad's own nonce lives five minutes. */
export const SIGN_IN_WINDOW_MS = 5 * 60_000;
/** A real message is about 200 characters; the Launchpad's verify route takes up to 2000. */
const SIGN_IN_MAX_CHARS = 1024;

export interface DappSession {
  cookie: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface DappOperation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary?: string;
  /** Names of path and query parameters, from the document. */
  parameters: Array<{ name: string; in: "path" | "query"; required: boolean }>;
  hasBody: boolean;
}

export interface DappApi {
  title?: string;
  version?: string;
  operations: DappOperation[];
}

export interface DappCallResult {
  status: number;
  ok: boolean;
  /** Parsed JSON when the dapp answered JSON, else the text, cut at 64 KB (bytes, not characters). */
  body: unknown;
  truncated: boolean;
}

function errorOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const parts = [o["error"], o["message"], o["reason"], o["detail"]].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length > 0) return clip(parts.join(": "), 300);
  }
  return `HTTP ${status}`;
}

/** The session cookie out of a response, with when the dapp says it ends. */
export function sessionCookieFrom(res: Response): DappSession | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const all: string[] =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
  for (const line of all) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1);
    if (!value) continue;
    let seconds = MAX_SESSION_SECONDS;
    for (const attr of attrs) {
      const m = /^max-age=(\d+)$/i.exec(attr);
      if (m) seconds = Number(m[1]);
    }
    // A long run of digits reads as Infinity, which would serialise to null
    // and leave a stored record nobody can read; the cap bounds it too.
    return { cookie: value, expiresAt: Math.floor(Date.now() / 1000) + Math.min(seconds, MAX_SESSION_SECONDS) };
  }
  return undefined;
}

// The six-line form in docs/dapp-conventions.md and nothing else. The dapp name
// is the one free-text slot, so it excludes control, format (zero-width,
// direction-override, tag) and line-separator characters; every other field is
// printable ASCII without a space. Anchored and bounded at every group, and only
// run on text already capped at SIGN_IN_MAX_CHARS, so it cannot backtrack badly.
const PRINTABLE = "[\\x21-\\x7e]";
const SIGN_IN_FORM = new RegExp(
  "^[^\\p{C}\\p{Zl}\\p{Zp}]{1,80} wants you to sign in with your MOI account\\.\\n\\n" +
    `Wallet: (${PRINTABLE}{1,128})\\nNonce: ${PRINTABLE}{1,128}\\n` +
    `Issued At: (${PRINTABLE}{1,40})\\nOrigin: (${PRINTABLE}{1,200})$`,
  "u",
);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type SignInVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a message a dapp handed out may be put in front of the wallet: the
 * six-line sign-in form, for this origin and this wallet, issued just now.
 * Pure, with `now` a parameter, so a test needs no fake clock. The reasons are
 * fixed text on purpose: the message and the dapp's name come from a host that
 * may be hostile, and an error lands in the model's context. The Issued At rule
 * does not stop a hostile dapp, which writes its own time; it stops a stale or
 * cached relay. The security-carrying rules are the form, Origin and Wallet.
 */
export function checkSignInMessage(
  message: string,
  want: { origin: string; wallet: string; now?: number },
): SignInVerdict {
  if (message.length > SIGN_IN_MAX_CHARS) return { ok: false, reason: "is too long to be a sign-in message" };
  const m = SIGN_IN_FORM.exec(message);
  if (!m) return { ok: false, reason: "is not the standard sign-in message" };
  const wallet = m[1] ?? "";
  const issuedAt = m[2] ?? "";
  const origin = (m[3] ?? "").toLowerCase();
  const here = want.origin.toLowerCase();
  // The Launchpad writes its configured origin verbatim and compares it as a
  // plain string, so at most one trailing slash can differ. Do not parse this
  // line with new URL(): that would admit a path, port or userinfo after the origin.
  if (origin !== here && origin !== `${here}/`) return { ok: false, reason: "is for a different site" };
  if (wallet.toLowerCase() !== want.wallet.trim().toLowerCase()) return { ok: false, reason: "is for a different wallet" };
  const at = Date.parse(issuedAt);
  if (!ISO_TIME.test(issuedAt) || !Number.isFinite(at)) return { ok: false, reason: "has no readable Issued At time" };
  // Written as "not within" rather than "beyond" so a non-finite clock value refuses instead of passing.
  if (!(Math.abs((want.now ?? Date.now()) - at) <= SIGN_IN_WINDOW_MS)) {
    return { ok: false, reason: "was issued more than five minutes away from this server's clock" };
  }
  return { ok: true };
}

/**
 * The request one published operation becomes: path parameters fill the template, query parameters go on the URL, the
 * body is kept only where the operation declares one. Pure, and the one place this is worked out, so the preview shown
 * for a write and the request that is sent cannot differ.
 */
export function requestFor(
  op: DappOperation,
  args: { params?: Record<string, string | number | boolean>; body?: unknown } = {},
): { method: DappOperation["method"]; target: string; body?: unknown } {
  const params = args.params ?? {};
  let path = op.path;
  const query = new URLSearchParams();
  for (const p of op.parameters) {
    const value = params[p.name];
    if (value === undefined) {
      if (p.required) throw new MoiError(ErrorCode.INVALID_ARGS, `${op.operationId} needs the parameter "${p.name}".`);
      continue;
    }
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else query.set(p.name, String(value));
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `${op.operationId} has an unfilled path parameter in ${op.path}.`);
  }
  // encodeURIComponent leaves "." alone and fetch resolves dot segments, so an id of ".." would send
  // DELETE /api/agents/.. as DELETE /api/, a path the dapp never published, under a preview that showed the other.
  // "%2e%2e" is safe: encodeURIComponent turns its "%" into "%25". The filled path is checked, not each value, so
  // two adjacent parameters that are each "." are caught too.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `${op.operationId}: a path parameter cannot be "." or "..", because the URL would resolve to a path the dapp did not publish.`,
    );
  }
  const qs = query.toString();
  return {
    method: op.method,
    target: qs ? `${path}?${qs}` : path,
    ...(op.hasBody && args.body !== undefined ? { body: args.body } : {}),
  };
}

export class DappClient {
  readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  // -- Sign-In With MOI ----------------------------------------------------

  async nonce(walletAddress: string): Promise<{ message: string }> {
    const res = await this.request("POST", SIWM_ROUTES.nonce, { body: { walletAddress } });
    const out = await this.parse(res, Nonce, SIWM_ROUTES.nonce, false);
    // The one place the message is minted for the sign-in tool, the Launchpad's included (LaunchpadClient overrides
    // nothing here), so a bad one can reach neither the phone nor /verify.
    const verdict = checkSignInMessage(out.message, { origin: new URL(this.baseUrl).origin, wallet: walletAddress });
    if (!verdict.ok) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `Not signing: the sign-in message from ${this.baseUrl} ${verdict.reason}. Nothing was sent to the wallet.`,
        { reason: verdict.reason },
      );
    }
    return out;
  }

  async verify(input: { address: string; message: string; signature: string }): Promise<DappSession> {
    const res = await this.request("POST", SIWM_ROUTES.verify, { body: input });
    await this.parse(res, Verified, SIWM_ROUTES.verify, false);
    const session = sessionCookieFrom(res);
    if (!session) {
      throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `${this.baseUrl} accepted the signature but set no session cookie.`);
    }
    return session;
  }

  async logout(cookie: string): Promise<void> {
    const res = await this.request("POST", SIWM_ROUTES.logout, { cookie });
    // The answer is not wanted; do not leave the dapp holding the connection open until the timeout.
    await res.body?.cancel().catch(() => undefined);
  }

  // -- Published operations ------------------------------------------------

  /** The dapp's OpenAPI document, reduced to what a caller needs. Undefined when it publishes none. */
  async api(): Promise<DappApi | undefined> {
    let unreadable: MoiError | undefined;
    for (const path of OPENAPI_PATHS) {
      let res: Response;
      try {
        res = await this.request("GET", path, {});
      } catch (err) {
        // A refused address is the answer, not a missing document; the next path would be refused too.
        if (err instanceof MoiError && err.code === ErrorCode.INVALID_ARGS) throw err;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(
          await readWhole(res, MAX_OPENAPI_BYTES, `The OpenAPI document at ${this.baseUrl}${path}`, "Publish a smaller document."),
        );
      } catch (err) {
        // A MoiError here is the size limit or a failed read; a document that is not JSON is a SyntaxError and only
        // means the next path, as before.
        if (err instanceof MoiError) unreadable ??= err;
        continue;
      }
      const api = summarizeOpenApi(doc);
      if (api) return api;
    }
    // No path gave a document, and one was too large to read: say that, not that the dapp publishes none.
    if (unreadable) throw unreadable;
    return undefined;
  }

  /**
   * One published operation, with the session. Path parameters fill the
   * template, query parameters go on the URL, the body goes as JSON.
   */
  async call(
    cookie: string,
    op: DappOperation,
    args: { params?: Record<string, string | number | boolean>; body?: unknown } = {},
  ): Promise<DappCallResult> {
    const req = requestFor(op, args);
    const res = await this.request(req.method, req.target, {
      cookie,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const { text: cut, truncated } = await readCapped(res, MAX_BODY_BYTES, this.baseUrl);
    let body: unknown = cut;
    if ((res.headers.get("content-type") ?? "").includes("json") && !truncated) {
      try {
        body = JSON.parse(cut);
      } catch {
        body = cut;
      }
    }
    if (res.status === 401) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
        `${this.baseUrl} no longer recognises this session. Sign in again with moi_dapp_sign_in.`,
      );
    }
    return { status: res.status, ok: res.ok, body, truncated };
  }

  // -- plumbing ------------------------------------------------------------

  protected async request(
    method: string,
    path: string,
    opts: { cookie?: string; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.cookie) headers["cookie"] = `${SESSION_COOKIE}=${opts.cookie}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        // A redirect could carry the cookie somewhere else. Never follow one.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // The address guard (src/public-fetch.ts) refuses with a MoiError. undici reports a failure in its connect step as
      // TypeError("fetch failed") with the real error as the cause, so look there too: the guard's own words are what the
      // person needs, not "fetch failed".
      const refused = err instanceof MoiError ? err : err instanceof Error && err.cause instanceof MoiError ? err.cause : undefined;
      if (refused) throw refused;
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `Could not reach ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  protected async parse<T>(
    res: Response,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    path: string,
    withSession: boolean,
  ): Promise<T> {
    if (!res.ok) await this.fail(res, path, withSession);
    let body: unknown;
    try {
      body = JSON.parse(await readWhole(res, MAX_JSON_BYTES, `${this.baseUrl}${path}`));
    } catch (err) {
      // The size limit and a failed read are MoiErrors and must not be reported as "not JSON".
      if (err instanceof MoiError) throw err;
      throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `${this.baseUrl}${path} answered with something other than JSON.`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `${this.baseUrl}${path} answered in a shape this server does not understand: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    return parsed.data;
  }

  /**
   * A 401 to a request that carried the session means the session is dead.
   * A 401 to sign-in itself means the signature was refused.
   */
  protected async fail(res: Response, path: string, withSession: boolean): Promise<never> {
    let body: unknown;
    try {
      // The same 64 KB as a call's answer, so a long validation error still parses. A refusal over it is unreadable
      // here, which also bounds the copy of the body that goes into the error's data below.
      const { text, truncated } = await readCapped(res, MAX_BODY_BYTES, `${this.baseUrl}${path}`);
      body = truncated ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (res.status === 401 && withSession) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
        `${this.baseUrl} no longer recognises this session. Call moi_dapp_sign_in with url ${this.baseUrl} to sign in again.`,
      );
    }
    throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `${this.baseUrl}${path} refused: ${errorOf(body, res.status)}`, {
      status: res.status,
      ...(body && typeof body === "object" ? { body } : {}),
    });
  }
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
// The document is the dapp's own text and is read in full up to 2 MB, so what reaches a model is clipped here, where the
// structured copy of moi_dapp_api is built. A path is skipped rather than clipped, so a callable path is never rewritten.
const MAX_PATH_CHARS = 512;
const MAX_NAME_CHARS = 200;
const MAX_SUMMARY_CHARS = 300;
const MAX_PARAMS = 25;

/** An OpenAPI 3 document reduced to its operations. Undefined when it is not one. */
export function summarizeOpenApi(doc: unknown): DappApi | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as { openapi?: unknown; info?: { title?: unknown; version?: unknown }; paths?: Record<string, unknown> };
  if (typeof d.openapi !== "string" || !d.paths || typeof d.paths !== "object") return undefined;
  const operations: DappOperation[] = [];
  for (const [path, item] of Object.entries(d.paths)) {
    if (!item || typeof item !== "object" || !path.startsWith("/") || path.length > MAX_PATH_CHARS) continue;
    const shared = Array.isArray((item as { parameters?: unknown }).parameters)
      ? ((item as { parameters: unknown[] }).parameters as unknown[])
      : [];
    for (const [method, raw] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method) || !raw || typeof raw !== "object") continue;
      const op = raw as { operationId?: unknown; summary?: unknown; parameters?: unknown; requestBody?: unknown };
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => p as { name?: unknown; in?: unknown; required?: unknown })
        .filter((p) => typeof p.name === "string" && p.name.length <= MAX_NAME_CHARS && (p.in === "path" || p.in === "query"))
        .map((p) => ({ name: p.name as string, in: p.in as "path" | "query", required: p.required === true || p.in === "path" }));
      if (params.length > MAX_PARAMS) continue;
      const operationId = clip(
        typeof op.operationId === "string" && op.operationId.length > 0
          ? op.operationId
          : `${method}${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`,
        MAX_NAME_CHARS,
      );
      operations.push({
        operationId,
        method: method.toUpperCase() as DappOperation["method"],
        path,
        ...(typeof op.summary === "string" ? { summary: clip(op.summary, MAX_SUMMARY_CHARS) } : {}),
        parameters: params,
        hasBody: op.requestBody !== undefined,
      });
      if (operations.length >= MAX_OPERATIONS) break;
    }
    if (operations.length >= MAX_OPERATIONS) break;
  }
  return {
    ...(typeof d.info?.title === "string" ? { title: clip(d.info.title, MAX_NAME_CHARS) } : {}),
    ...(typeof d.info?.version === "string" ? { version: clip(d.info.version, MAX_NAME_CHARS) } : {}),
    operations,
  };
}
