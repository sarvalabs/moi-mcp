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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AuthInfo } from "../auth/types.js";
import { getConfig } from "../config.js";
import { DappClient, type DappApi, type DappOperation } from "../dapp/client.js";
import { dappOrigin } from "../dapp/origin.js";
import { isDappSessionExpired, type DappSessionStore, type StoredDappSession } from "../dapp/store.js";
import { toMcpError } from "../errors.js";
import { MoiError } from "../moi-error.js";
import { NETWORKS } from "../moi/provider.js";
import { ErrorCode } from "../schema.js";
import { loadSession, type HostedWriteDeps } from "./hosted-writes.js";

export interface DappDeps {
  sessions: DappSessionStore;
  /** The wallet side: pairing store and hub, for the sign-in message. */
  writes: HostedWriteDeps;
  /** Injectable for tests; a real client for the origin otherwise. */
  clientFor?: (baseUrl: string) => DappClient;
  /** Tests only: let an http origin through the origin check. */
  allowInsecure?: boolean;
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** A dapp's operation list is re-read after this long. */
const API_CACHE_MS = 5 * 60 * 1000;

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

async function run<T extends Record<string, unknown>>(fn: () => Promise<{ value: T; text?: string }>) {
  try {
    const { value, text } = await fn();
    return { content: [{ type: "text" as const, text: text ?? JSON.stringify(value, null, 2) }], structuredContent: value };
  } catch (err) {
    throw toMcpError(err);
  }
}

export function registerDappTools(server: McpServer, deps: DappDeps, auth: AuthInfo | null): void {
  const clientFor = deps.clientFor ?? ((baseUrl: string) => new DappClient(baseUrl));
  const origin = (url: string) => dappOrigin(url, { allowInsecure: deps.allowInsecure });
  const apis = new Map<string, { api: DappApi | undefined; at: number }>();

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

  server.registerTool(
    "moi_dapp_sign_in",
    {
      title: "Sign in to a MOI dapp",
      description:
        "Sign in to a MOI dapp as the paired wallet, with Sign-In With MOI: the dapp hands out a short message, MOI Wallet " +
        "on the phone shows it and the person approves, and the session is kept on this server for as long as the dapp allows. " +
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
  );

  server.registerTool(
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
  );

  server.registerTool(
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
  );

  server.registerTool(
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
  );

  server.registerTool(
    "moi_dapp_call",
    {
      title: "Call an operation a MOI dapp publishes",
      description:
        "Call one operation from the dapp's published OpenAPI document, as the signed-in person. Only operations listed by " +
        "moi_dapp_api can be called. This can change state on the dapp: confirm with the person first for anything that is " +
        "not a plain read. Needs moi_dapp_sign_in for that dapp.",
      inputSchema: {
        url: UrlArg,
        operationId: z.string().min(1).describe("An operationId from moi_dapp_api."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Path and query parameters, by name."),
        body: z.unknown().optional().describe("The JSON body, for operations that take one."),
      },
      outputSchema: {
        dapp: z.string(),
        operationId: z.string(),
        status: z.number(),
        ok: z.boolean(),
        body: z.unknown(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, operationId, params, body }) =>
      run(async () => {
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
        try {
          const result = await clientFor(dapp).call(rec.cookie, op, { ...(params ? { params } : {}), ...(body !== undefined ? { body } : {}) });
          return { value: { dapp, operationId, ...result } };
        } catch (err) {
          if (err instanceof MoiError && err.code === ErrorCode.LAUNCHPAD_NOT_SIGNED_IN) await deps.sessions.delete(userId, dapp);
          throw err;
        }
      }),
  );
}
