/**
 * Any MOI dapp from the chat, without code per dapp: sign in with the paired
 * wallet (Sign-In With MOI), then call the operations the dapp publishes in
 * its OpenAPI document. See docs/dapp-conventions.md for what a dapp has to
 * offer for this to work. The Launchpad tools are the hand-written form of
 * the same idea.
 *
 * Sessions exist only for origins the person signed in to with a tap on the
 * phone, and a call only goes to an operation the dapp itself lists.
 */

import { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { boundedResult, limitDepth, MAX_BODY_BYTES, MAX_DEPTH } from "../../bounds.js";
import { getConfig, log } from "../../config.js";
import { DappClient, requestFor, type DappApi, type DappOperation } from "./client.js";
import { dappOrigin, publicFetch, type Resolver } from "./origin.js";
import { isDappSessionExpired, type DappSessionStore, type StoredDappSession } from "./store.js";
import { toMcpError } from "../../errors.js";
import { MoiError } from "../../moi-error.js";
import { NETWORKS } from "../../moi/provider.js";
import { ErrorCode } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { ConfirmArg, loadSession, previewsOf, type HostedWriteDeps } from "../../tools/hosted-writes.js";
import { cut, fingerprintDigest, PREVIEW_BODY_CHARS, previewBlock, redeemOrIssue } from "../../tools/preview.js";

export interface DappDeps {
  sessions: DappSessionStore;
  /** The wallet side: pairing store and hub, for the sign-in message. */
  writes: HostedWriteDeps;
  /** Injectable for tests; a real client for the origin otherwise. */
  clientFor?: (baseUrl: string) => DappClient;
  /** Tests only: let an http origin through the origin check. */
  allowInsecure?: boolean;
  /** Tests only: stands in for DNS, so a test never resolves a real name. */
  resolve?: Resolver;
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** A dapp's operation list is re-read after this long. */
const API_CACHE_MS = 5 * 60 * 1000;
/** How much of the dapp's own description of an operation a preview shows. */
const DAPP_SUMMARY_CHARS = 200;

const UrlArg = z.string().url().describe("The dapp's address, for example https://launchpad.moi.technology. Only the origin is used.");

const DappOperationOut = z.object({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().optional(),
  parameters: z.array(z.object({ name: z.string(), in: z.enum(["path", "query"]), required: z.boolean() })),
  hasBody: z.boolean(),
});

function requireAuth(auth: AuthInfo | null): AuthInfo {
  if (!auth) throw new MoiError(ErrorCode.WALLET_NOT_CONNECTED, "Sign in to this connector before using a dapp.");
  return auth;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** The dapp's own text on one line, with no control or direction characters, so it cannot lay out the preview. */
const plain = (s: string) => s.replace(/[\p{C}\p{Zl}\p{Zp}\s]+/gu, " ").trim();

/** What moi_dapp_call returns: the dapp's answer, or for a write the preview that comes first. */
type DappCallValue = {
  dapp: string;
  operationId: string;
  status: number | "preview";
  ok?: boolean;
  body?: unknown;
  truncated?: boolean;
  confirm?: string;
  summary?: string;
  details?: Record<string, string>;
  expiresAt?: string;
  note?: string;
};

async function run<T extends Record<string, unknown>>(fn: () => Promise<{ value: T; text?: string }>) {
  try {
    const { value, text } = await fn();
    return boundedResult(value, text);
  } catch (err) {
    throw toMcpError(err);
  }
}

export function dappTools(deps: DappDeps, auth: AuthInfo | null): ToolDef[] {
  // Built once per registerDappTools call, and for the system resolver once per process (publicFetch caches it): the hosted
  // server registers these tools afresh on every request, and an Agent holds a connection pool. allowInsecure is the test
  // switch and keeps the plain fetch, as it keeps the lexical rules off.
  const guarded = deps.allowInsecure ? undefined : publicFetch(deps.resolve);
  const clientFor = deps.clientFor ?? ((baseUrl: string) => new DappClient(baseUrl, guarded));
  const origin = (url: string) => dappOrigin(url, { allowInsecure: deps.allowInsecure });
  const apis = new Map<string, { api: DappApi | undefined; at: number }>();
  const tools: ToolDef[] = [];

  async function requireSession(userId: string, dapp: string): Promise<StoredDappSession> {
    const rec = await deps.sessions.get(userId, dapp);
    if (rec && !isDappSessionExpired(rec)) return rec;
    if (rec) await deps.sessions.delete(userId, dapp);
    throw new MoiError(
      ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
      rec
        ? `The session with ${dapp} has expired. Call moi_dapp_sign_in for it again.`
        : `Not signed in to ${dapp}. Call moi_dapp_sign_in with its address first; it signs one message with the paired wallet.`,
    );
  }

  async function apiFor(dapp: string): Promise<DappApi | undefined> {
    const cached = apis.get(dapp);
    if (cached && Date.now() - cached.at < API_CACHE_MS) return cached.api;
    const api = await clientFor(dapp).api();
    apis.set(dapp, { api, at: Date.now() });
    return api;
  }

  tools.push(defineTool(
    "moi_dapp_sign_in",
    {
      title: "Sign in to a MOI dapp",
      description:
        "Sign in to a MOI dapp as the paired wallet, with Sign-In With MOI: the dapp hands out a short message, MOI Wallet " +
        "on the phone shows it and the person approves, and the session is kept on this server, encrypted, for up to a day (less if the dapp ends it sooner). " +
        "Works for any dapp that follows the MOI dapp conventions. Needs a paired wallet. Nothing is sent on chain.",
      inputSchema: { url: UrlArg },
      outputSchema: { dapp: z.string(), signedIn: z.literal(true), wallet: z.string(), expiresAt: z.string() },
      annotations: ACT,
    },
    async ({ url }) =>
      run(async () => {
        const who = requireAuth(auth);
        const dapp = origin(url);
        const cfg = getConfig();
        const wallet = await loadSession(deps.writes, who, NETWORKS[cfg.MOI_NETWORK].caip2);
        const client = clientFor(dapp);
        const { message } = await client.nonce(wallet.address);
        const { signature } = await deps.writes.hub.signMessageFor(wallet.topic, wallet.address, message);
        const session = await client.verify({ address: wallet.address, message, signature });
        await deps.sessions.set({
          version: 1,
          userId: who.userId,
          baseUrl: dapp,
          cookie: session.cookie,
          walletAddress: wallet.address,
          createdAt: new Date().toISOString(),
          expiresAt: session.expiresAt,
        });
        return {
          value: { dapp, signedIn: true as const, wallet: wallet.address, expiresAt: iso(session.expiresAt) },
          text: `Signed in to ${dapp} as ${wallet.address}, until ${iso(session.expiresAt)}.`,
        };
      }),
  ));

  tools.push(defineTool(
    "moi_dapp_sessions",
    {
      title: "Dapps signed in to",
      description: "The MOI dapps this connector holds a session for, on behalf of the signed-in person, and when each ends.",
      inputSchema: {},
      outputSchema: { sessions: z.array(z.object({ dapp: z.string(), wallet: z.string(), expiresAt: z.string() })) },
      annotations: READ,
    },
    async () =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const all = await deps.sessions.listFor(userId);
        const live = all.filter((r) => !isDappSessionExpired(r));
        return {
          value: { sessions: live.map((r) => ({ dapp: r.baseUrl, wallet: r.walletAddress, expiresAt: iso(r.expiresAt) })) },
        };
      }),
  ));

  tools.push(defineTool(
    "moi_dapp_sign_out",
    {
      title: "Sign out of a MOI dapp",
      description: "Forget the session with a dapp. The wallet pairing is untouched.",
      inputSchema: { url: UrlArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ url }) =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const dapp = origin(url);
        const rec = await deps.sessions.get(userId, dapp);
        await deps.sessions.delete(userId, dapp);
        if (rec) {
          try {
            await clientFor(dapp).logout(rec.cookie);
          } catch {
            /* our record is gone, which is the guarantee */
          }
        }
        return { value: { dapp, signedIn: false }, text: rec ? `Signed out of ${dapp}.` : `There was no session with ${dapp}.` };
      }),
  ));

  tools.push(defineTool(
    "moi_dapp_api",
    {
      title: "What a MOI dapp can do",
      description:
        "The operations a MOI dapp publishes in its OpenAPI document: id, method, path, parameters, whether a body is taken. " +
        "Read this before moi_dapp_call. A dapp that publishes no document cannot be called this way.",
      inputSchema: { url: UrlArg },
      outputSchema: {
        dapp: z.string(),
        published: z.boolean(),
        title: z.string().optional(),
        version: z.string().optional(),
        operations: z.array(DappOperationOut),
      },
      annotations: READ,
    },
    async ({ url }) =>
      run<{ dapp: string; published: boolean; title?: string; version?: string; operations: DappOperation[] }>(async () => {
        requireAuth(auth);
        const dapp = origin(url);
        const api = await apiFor(dapp);
        if (!api) {
          return {
            value: { dapp, published: false, operations: [] },
            text: `${dapp} publishes no OpenAPI document at any of the conventional paths, so it has no callable operations here.`,
          };
        }
        return {
          value: {
            dapp,
            published: true,
            ...(api.title ? { title: api.title } : {}),
            ...(api.version ? { version: api.version } : {}),
            operations: api.operations,
          },
        };
      }),
  ));

  tools.push(defineTool(
    "moi_dapp_call",
    {
      title: "Call an operation a MOI dapp publishes",
      description:
        "Call one operation from the dapp's published OpenAPI document, as the signed-in person. Only operations listed by " +
        "moi_dapp_api can be called. Needs moi_dapp_sign_in for that dapp. A GET runs at once. Any other method changes " +
        "state on the dapp, so it is two calls, always: the first, without confirm, sends nothing and returns the exact " +
        "request (method, path, parameters, body) and a confirm token; show it to the person and get an explicit yes; the " +
        "second, with the same arguments plus confirm, sends it. The token works once, for ten minutes, for this person, " +
        "this wallet and these arguments. If the second call fails or times out the token is spent and the write may or " +
        "may not have happened: check the dapp's state before previewing again. The preview shows the dapp's own " +
        "description of the operation; that is the dapp's claim, not something this server checked. An answer is read up to " +
        "64 KB (bytes): past that truncated is true and body is only its start, as text. Data nested deeper than 19 levels is " +
        "left out, also with truncated true. When that happens, ask the operation for less: a smaller page, a filter, fewer fields.",
      inputSchema: {
        url: UrlArg,
        operationId: z.string().min(1).describe("An operationId from moi_dapp_api."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Path and query parameters, by name."),
        body: z.unknown().optional().describe("The JSON body, for operations that take one."),
        confirm: ConfirmArg.describe(
          "Only for operations that are not GET. The token from this call's preview. Omit it to get the preview; pass it, " +
            "with the same url, operationId, params and body, to send the request.",
        ),
      },
      // Each expression is written out on its own: one zod instance used twice in a shape makes the JSON schema emit a $ref.
      outputSchema: {
        dapp: z.string(),
        operationId: z.string(),
        status: z.union([z.number(), z.literal("preview")]),
        ok: z.boolean().optional(),
        body: z.unknown(),
        truncated: z.boolean().optional(),
        confirm: z.string().optional(),
        summary: z.string().optional(),
        details: z.record(z.string(), z.string()).optional(),
        expiresAt: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, operationId, params, body, confirm }) =>
      run<DappCallValue>(async () => {
        const userId = requireAuth(auth).userId;
        const dapp = origin(url);
        const rec = await requireSession(userId, dapp);
        const api = await apiFor(dapp);
        const op = api?.operations.find((o) => o.operationId === operationId);
        if (!op) {
          throw new MoiError(
            ErrorCode.INVALID_ARGS,
            api
              ? `${dapp} publishes no operation "${operationId}". moi_dapp_api lists the ones it has.`
              : `${dapp} publishes no OpenAPI document, so nothing can be called on it this way.`,
          );
        }
        const args = { ...(params ? { params } : {}), ...(body !== undefined ? { body } : {}) };
        // Anything that is not a GET, including a method this code does not know, is gated.
        const isWrite = op.method !== "GET";
        if (isWrite) {
          // Worked out before any token is issued, so a missing parameter or a ".." fails here and no token exists for it.
          const req = requestFor(op, args);
          const pending = redeemOrIssue(
            previewsOf(deps.writes),
            {
              userId,
              kind: "dapp_call",
              // The token is bound to everything the call depends on: the operation as the dapp defines it now (method,
              // path template, the filled target, so a dapp that redefines it between the calls fails to redeem), the
              // wallet signed in as (so a re-sign-in as another paired wallet does too), and the arguments. The dapp's
              // summary is left out: it is the dapp's text, and one that varied would make every confirm re-preview.
              fingerprint: fingerprintDigest({
                dapp,
                operationId,
                method: op.method,
                path: op.path,
                target: req.target,
                wallet: rec.walletAddress,
                params: params ?? {},
                body: req.body,
              }),
            },
            confirm,
          );
          if (pending) {
            // The server's own account of the request. The dapp's description goes last, on one line, quoted and
            // labelled, so it reads as the dapp's claim and cannot continue the sentences around it.
            const details: Record<string, string> = {
              Dapp: dapp,
              Operation: plain(operationId),
              As: rec.walletAddress,
              Request: plain(`${op.method} ${req.target}`),
              Body:
                req.body !== undefined
                  ? cut(JSON.stringify(req.body), PREVIEW_BODY_CHARS)
                  : body !== undefined
                    ? "(not sent: this operation takes no body)"
                    : "(none)",
              ...(op.summary
                ? { "The dapp says (its own words, not checked)": JSON.stringify(cut(plain(op.summary), DAPP_SUMMARY_CHARS)) }
                : {}),
            };
            const summary = `${op.method} ${dapp}${plain(req.target)}`;
            return {
              value: {
                dapp,
                operationId,
                status: "preview" as const,
                confirm: pending.token,
                summary,
                details,
                expiresAt: new Date(pending.expiresAt).toISOString(),
                ...(pending.note ? { note: pending.note } : {}),
              },
              text: previewBlock({
                what: dapp,
                summary,
                details,
                token: pending.token,
                expiresAt: pending.expiresAt,
                ...(pending.note ? { note: pending.note } : {}),
              }),
            };
          }
        }
        // One info line per write, with no params, body, query, cookie, token or error message in it. This is not a
        // durable audit trail: log() drops info at the default LOG_LEVEL=error, and only the pm2 apps set info.
        // Dapp writes are not journaled on purpose. src/journal.ts tracks the life of a signed chain interaction, and
        // reconcileJournalOnBoot would mislabel any entry left unfinished as an orphaned interaction that cannot be
        // re-broadcast, which a dapp write is not.
        try {
          const result = await clientFor(dapp).call(rec.cookie, op, args);
          if (isWrite) log("info", `dapp write: user ${userId} ${op.method} ${operationId} on ${dapp} -> ${result.status}`);
          // The body sits one level down in the result, so cutting it at one level less keeps the whole value within MAX_DEPTH.
          const shown = limitDepth(result.body, MAX_DEPTH - 1);
          const notes = [
            ...(result.truncated
              ? [`The answer was cut at ${MAX_BODY_BYTES / 1024} KB and the rest was not read. Ask the operation for less (a smaller page, a filter, fewer fields) and call again.`]
              : []),
            ...(shown.truncated ? [`Data nested deeper than ${MAX_DEPTH - 1} levels was left out.`] : []),
          ];
          return {
            value: {
              dapp,
              operationId,
              status: result.status,
              ok: result.ok,
              body: shown.value,
              truncated: result.truncated || shown.truncated,
              ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
            },
          };
        } catch (err) {
          if (isWrite) {
            log("info", `dapp write: user ${userId} ${op.method} ${operationId} on ${dapp} -> failed${err instanceof MoiError ? ` (${err.code})` : ""}`);
          }
          if (err instanceof MoiError && err.code === ErrorCode.LAUNCHPAD_NOT_SIGNED_IN) await deps.sessions.delete(userId, dapp);
          throw err;
        }
      }),
  ));
  return tools;
}
