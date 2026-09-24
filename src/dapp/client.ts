/**
 * The MOI dapp conventions as a client (docs/dapp-conventions.md).
 *
 * Sign-In With MOI: the dapp hands out a message for a wallet address, the
 * wallet signs it, the dapp answers the signature with a session cookie.
 * Operations: the dapp publishes an OpenAPI document; the connector calls
 * only operations listed there, with the session cookie, and nothing else.
 * No MCP imports.
 */

import { z } from "zod";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

const TIMEOUT_MS = 20_000;
export const SESSION_COOKIE = "moi_session";
const DEFAULT_SESSION_SECONDS = 7 * 24 * 60 * 60;
/** The largest response body handed back to a model. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_OPERATIONS = 200;

export const SIWM_ROUTES = {
  nonce: "/api/auth/nonce",
  verify: "/api/auth/verify",
  logout: "/api/auth/logout",
} as const;

/** Where a dapp may publish its OpenAPI document, tried in order. */
export const OPENAPI_PATHS = ["/.well-known/openapi.json", "/openapi.json", "/api/openapi.json"] as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const Nonce = z.object({ nonce: z.string().min(1).optional(), message: z.string().min(20) });
const Verified = z.object({ ok: z.literal(true) }).passthrough();

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
  /** Parsed JSON when the dapp answered JSON, else the text, cut at 64 KB. */
  body: unknown;
  truncated: boolean;
}

function errorOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const parts = [o["error"], o["message"], o["reason"], o["detail"]].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length > 0) return parts.join(": ");
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
    let seconds = DEFAULT_SESSION_SECONDS;
    for (const attr of attrs) {
      const m = /^max-age=(\d+)$/i.exec(attr);
      if (m) seconds = Number(m[1]);
    }
    return { cookie: value, expiresAt: Math.floor(Date.now() / 1000) + seconds };
  }
  return undefined;
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
    return this.parse(res, Nonce, SIWM_ROUTES.nonce, false);
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
    await this.request("POST", SIWM_ROUTES.logout, { cookie });
  }

  // -- Published operations ------------------------------------------------

  /** The dapp's OpenAPI document, reduced to what a caller needs. Undefined when it publishes none. */
  async api(): Promise<DappApi | undefined> {
    for (const path of OPENAPI_PATHS) {
      let res: Response;
      try {
        res = await this.request("GET", path, {});
      } catch {
        continue;
      }
      if (!res.ok) continue;
      let doc: unknown;
      try {
        doc = await res.json();
      } catch {
        continue;
      }
      const api = summarizeOpenApi(doc);
      if (api) return api;
    }
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
    const qs = query.toString();
    const res = await this.request(op.method, qs ? `${path}?${qs}` : path, {
      cookie,
      ...(op.hasBody && args.body !== undefined ? { body: args.body } : {}),
    });
    const text = await res.text();
    const truncated = text.length > MAX_BODY_BYTES;
    const cut = truncated ? text.slice(0, MAX_BODY_BYTES) : text;
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
      body = await res.json();
    } catch {
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
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (res.status === 401 && withSession) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
        `${this.baseUrl} no longer recognises this session. Sign in again.`,
      );
    }
    throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `${this.baseUrl}${path} refused: ${errorOf(body, res.status)}`, {
      status: res.status,
      ...(body && typeof body === "object" ? { body } : {}),
    });
  }
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** An OpenAPI 3 document reduced to its operations. Undefined when it is not one. */
export function summarizeOpenApi(doc: unknown): DappApi | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as { openapi?: unknown; info?: { title?: unknown; version?: unknown }; paths?: Record<string, unknown> };
  if (typeof d.openapi !== "string" || !d.paths || typeof d.paths !== "object") return undefined;
  const operations: DappOperation[] = [];
  for (const [path, item] of Object.entries(d.paths)) {
    if (!item || typeof item !== "object" || !path.startsWith("/")) continue;
    const shared = Array.isArray((item as { parameters?: unknown }).parameters)
      ? ((item as { parameters: unknown[] }).parameters as unknown[])
      : [];
    for (const [method, raw] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method) || !raw || typeof raw !== "object") continue;
      const op = raw as { operationId?: unknown; summary?: unknown; parameters?: unknown; requestBody?: unknown };
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => p as { name?: unknown; in?: unknown; required?: unknown })
        .filter((p) => typeof p.name === "string" && (p.in === "path" || p.in === "query"))
        .map((p) => ({ name: p.name as string, in: p.in as "path" | "query", required: p.required === true || p.in === "path" }));
      const operationId =
        typeof op.operationId === "string" && op.operationId.length > 0
          ? op.operationId
          : `${method}${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
      operations.push({
        operationId,
        method: method.toUpperCase() as DappOperation["method"],
        path,
        ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
        parameters: params,
        hasBody: op.requestBody !== undefined,
      });
      if (operations.length >= MAX_OPERATIONS) break;
    }
    if (operations.length >= MAX_OPERATIONS) break;
  }
  return {
    ...(typeof d.info?.title === "string" ? { title: d.info.title } : {}),
    ...(typeof d.info?.version === "string" ? { version: d.info.version } : {}),
    operations,
  };
}
