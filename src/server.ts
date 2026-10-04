#!/usr/bin/env node
/**
 * Hosted HTTP transport — the multi-user entry point for the MOI Claude
 * connector.
 *
 * Unlike src/http.ts (stateless, read-only, no auth) this endpoint carries a
 * real wallet surface behind OAuth: every request still builds a fresh,
 * throwaway McpServer (no session ID, nothing shared across requests — see
 * withModernSchemaDialect + StreamableHTTPServerTransport below), but when the
 * caller is authenticated it additionally lists the per-user wallet tools
 * (src/tools/wallet-hosted.ts), backed by a WalletSessionStore keyed on the
 * OAuth subject.
 *
 * LAZY AUTH. claude.ai's custom-connector flow does not run OAuth up front —
 * it calls a tool, and only on a 401 with `WWW-Authenticate: ...
 * resource_metadata="..."` does it show the inline Connect card and retry the
 * SAME call once the user has signed in. A 200 response with `isError` does
 * NOT trigger that UI, so every gated path below must answer with a real 401,
 * never a tool error. GATED lists every tool that needs a wallet or writes to
 * one, including moi_transfer/moi_create_asset/moi_mint/moi_call_logic —
 * write tools that this milestone does not yet register — so the gate is
 * already correct the day they land.
 *
 * Run:  moi-mcp-hosted        (HOSTED_PORT, default 8788)
 * Point an MCP client (or claude.ai's custom-connector field) at:
 *   http://host:HOSTED_PORT/mcp
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Application, type Request, type Response } from "express";
import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { deriveKey } from "./auth/crypto.js";
import { mountAuth, type AuthHandle, type AuthInfo } from "./auth/index.js";
import { getConfig, getHostedConfig, log } from "./config.js";
import { messageOf } from "./errors.js";
import { HOSTED_INSTRUCTIONS } from "./instructions.js";
import { newHttpServer, MCP_PATH } from "./http.js";
import { brandAsset, landingHtml } from "./branding.js";
import { securityHeaders } from "./security-headers.js";
import { cleanErrors } from "./clean-errors.js";
import { rateLimit } from "./auth/rate-limit.js";
import { randomUUID } from "node:crypto";
import { withModernSchemaDialect } from "./json-schema-dialect.js";
import { WriteJournal } from "./journal.js";
import {
  createPairingLink as createPairingLinkFor,
  consumeForUser,
  modeForUser,
  mountPairing,
  type PairingSeed,
} from "./pairing/index.js";
import { expiryFor, isExpired, type PairingMode } from "./wc/lifetime.js";
import type { LaunchpadDeps } from "./applications/launchpad/tools.js";
import { LaunchpadClient } from "./applications/launchpad/client.js";
import { createDownloadModule } from "./applications/launchpad/download.js";
import {
  DAPP_SESSION_KEY_LABEL,
  FileDappSessionStore,
  isDappSessionExpired,
  purgeDappSessionsOnBoot,
  RedisDappSessionStore,
  type DappSessionBackend,
} from "./applications/dapp/store.js";
import type { DappDeps } from "./applications/dapp/tools.js";
import { faucetDepsFor, type FaucetDeps } from "./applications/faucet/tools.js";
import { registerTools } from "./tools/register.js";
import { WalletConnectHub, type WalletConnectHubLike } from "./wc/hub.js";
import { sealWalletStateOnBoot } from "./wc/seal-migration.js";
import {
  FileKeyValueStorage,
  FileWalletSessionStore,
  type StoredWalletSession,
  WALLET_SESSION_KEY_LABEL,
  WC_STORAGE_KEY_LABEL,
  type WalletSessionStore,
} from "./wc/store.js";
import { connectRedis, RedisKeyValueStorage, RedisWalletSessionStore } from "./wc/redis-store.js";

const MAX_BODY_BYTES = 1_000_000;

/**
 * Every tool that needs a wallet, or writes to the chain. Checked against
 * `params.name` for `tools/call` only — `initialize`, `tools/list`, and every
 * read tool/resource stay public. moi_transfer, moi_create_asset, moi_mint
 * and moi_call_logic are not registered by this file (that is the hosted
 * write path, a later milestone) but are listed here so the gate needs no
 * change when they land.
 */
export const GATED = [
  "moi_transfer",
  "moi_create_account",
  "moi_configure_account",
  "moi_create_asset",
  "moi_mint",
  "moi_call_logic",
  "moi_deploy_logic",
  "moi_asset_invoke",
  "moi_connect_wallet",
  "moi_disconnect_wallet",
  "moi_wallet_status",
  "moi_launchpad_status",
  "moi_launchpad_create_agent",
  "moi_launchpad_register_agent",
  "moi_launchpad_telegram_link",
  "moi_launchpad_setup_script",
  "moi_register_agent",
  "moi_set_agent_status",
  "moi_transfer_agent",
  "moi_dapp_sign_in",
  "moi_dapp_sessions",
  "moi_dapp_sign_out",
  "moi_dapp_api",
  "moi_dapp_call",
  "moi_faucet",
] as const;

/**
 * Scope required per gated tool. moi_wallet_status only reads the paired
 * account, so a moi:read token covers it; every other gated tool either
 * moves funds/writes chain state or mutates the wallet pairing itself
 * (starting a new WalletConnect pairing, or tearing one down), so all of
 * them require moi:write. Keyed off GATED so adding a tool there without an
 * entry here is a compile error, not a silent unscoped gate.
 */
const REQUIRED_SCOPE: Record<(typeof GATED)[number], "moi:read" | "moi:write"> = {
  moi_transfer: "moi:write",
  moi_create_account: "moi:write",
  moi_configure_account: "moi:write",
  moi_create_asset: "moi:write",
  moi_mint: "moi:write",
  moi_call_logic: "moi:write",
  moi_deploy_logic: "moi:write",
  moi_asset_invoke: "moi:write",
  moi_connect_wallet: "moi:write",
  moi_disconnect_wallet: "moi:write",
  moi_wallet_status: "moi:read",
  moi_launchpad_status: "moi:read",
  moi_launchpad_create_agent: "moi:write",
  moi_launchpad_register_agent: "moi:write",
  moi_launchpad_telegram_link: "moi:write",
  moi_launchpad_setup_script: "moi:write",
  moi_register_agent: "moi:write",
  moi_set_agent_status: "moi:write",
  moi_transfer_agent: "moi:write",
  moi_dapp_sign_in: "moi:write",
  moi_dapp_sessions: "moi:read",
  moi_dapp_sign_out: "moi:write",
  moi_dapp_api: "moi:read",
  moi_dapp_call: "moi:write",
  moi_faucet: "moi:write",
};

export interface HostedDeps {
  authenticate: AuthHandle["authenticate"];
  challengeHeader: AuthHandle["challengeHeader"];
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  journal: WriteJournal;
  /** Whether mountPairing(app, ...) was called on the outer app main() builds this onto. Surfaced at /health only — this app never serves /pair itself. */
  resolveUriMounted: boolean;
  /**
   * Wrapper over pairing/index.js's createPairingLink(userId, publicUrl, seed)
   * with the publicUrl baked in by whoever builds this object. The seed lets
   * moi_connect_wallet make the page show the proposal it just started.
   */
  createPairingLink(userId: string, seed?: PairingSeed): { url: string; expiresAt: number };
  /** Public origin, used to advertise absolute icon URLs in serverInfo. */
  publicUrl?: string;
  /**
   * Start a WalletConnect pairing for this user and persist the session once
   * the phone approves. Returns the wc: URI to show them and when it dies.
   * `mode` is the lifetime the user asked for in chat; the pairing page's
   * toggle applies when it is omitted.
   */
  startPairing(userId: string, mode?: PairingMode): Promise<{ uri: string; expiresAt: number }>;
  /** The MOI Agent Launchpad tools; absent when no Launchpad is configured (tests). */
  launchpad?: LaunchpadDeps;
  /** The generic dapp tools; absent in tests that do not need them. */
  dapp?: DappDeps;
  /** The devnet faucet tool; absent unless MOI_FAUCET_URL and MOI_FAUCET_KEY are set and the network is voyage (faucetDepsFor). */
  faucet?: FaucetDeps;
}

/** Collect a JSON body, refusing anything oversized. Mirrors src/http.ts. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** The tool name of a `tools/call`, or undefined for anything else. */
function toolCallName(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return undefined;
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

/** Every gated tool name `body` (a single JSON-RPC message, or a batch of them) calls. */
function gatedToolNames(body: unknown): Array<(typeof GATED)[number]> {
  const messages = Array.isArray(body) ? body : [body];
  const names: Array<(typeof GATED)[number]> = [];
  for (const m of messages) {
    const name = toolCallName(m);
    if (name !== undefined && (GATED as readonly string[]).includes(name)) {
      names.push(name as (typeof GATED)[number]);
    }
  }
  return names;
}

/**
 * The hosted MCP endpoint, dependency-injected so tests need no real OAuth
 * server or WalletConnect relay. main() wires the real ones (mountAuth,
 * mountPairing, FileWalletSessionStore, a real createPairingLink) below.
 */
export function buildHostedApp(deps: HostedDeps): Application {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders(deps.publicUrl));

  app.get("/health", (_req, res) => {
    let network = "unknown";
    let configOk = true;
    try {
      network = getConfig().MOI_NETWORK;
    } catch {
      configOk = false;
    }
    send(res, configOk ? 200 : 503, {
      ok: configOk,
      network,
      readOnly: false,
      pairingMounted: deps.resolveUriMounted,
    });
  });

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      log("error", `hosted request failed: ${messageOf(err)}`);
      if (!res.headersSent) send(res, 400, { error: messageOf(err) });
      return;
    }

    // LAZY-AUTH GATE. Only a gated tools/call triggers authenticate(); every
    // other message (initialize, tools/list, a read tool, a resource) is
    // public and never even asks deps.authenticate for a token. A 200 with
    // isError does not make claude.ai show the Connect card — this 401 +
    // header is the only thing that does, so it must reach the client
    // untouched by the transport below.
    let auth: AuthInfo | undefined;
    const gatedTools = gatedToolNames(body);
    if (gatedTools.length > 0) {
      auth = deps.authenticate(req);
      if (!auth) {
        res.setHeader("WWW-Authenticate", deps.challengeHeader());
        send(res, 401, { error: "authorization required" });
        return;
      }

      // SCOPE GATE. Presence of a valid token is not enough — a moi:read-only
      // token must not be able to start/tear down a wallet pairing, transfer
      // funds, etc. Answer with the RFC 6750 §3.1 shape (403 +
      // error="insufficient_scope") so a client that understands scopes can
      // re-request authorization with the missing one instead of looping on
      // a 401 it can never resolve by re-presenting the same token.
      const missingScope = gatedTools
        .map((name) => REQUIRED_SCOPE[name])
        .find((scope) => !auth!.scopes.includes(scope));
      if (missingScope) {
        res.setHeader("WWW-Authenticate", deps.challengeHeader({ error: "insufficient_scope", scope: missingScope }));
        send(res, 403, {
          error: "insufficient_scope",
          error_description: `This action requires the '${missingScope}' scope.`,
        });
        return;
      }
    }

    // Stateless: a fresh server and transport per request, exactly like
    // src/http.ts, so concurrent callers can never observe each other's state.
    const server = newHttpServer({ instructions: HOSTED_INSTRUCTIONS, publicUrl: deps.publicUrl });
    registerTools(server, { mode: "hosted", deps, auth: auth ?? null });

    const transport = withModernSchemaDialect(
      new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
    );
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("error", `request failed: ${messageOf(err)}`);
      if (!res.headersSent) send(res, 400, { error: messageOf(err) });
    }
  };

  // Generous, since one conversation can issue several tool calls a second,
  // but a ceiling: the RPC node behind this should not be someone's free
  // load generator.
  const mcpLimiter = rateLimit({ windowMs: 60_000, max: 240 });
  app.post(MCP_PATH, mcpLimiter, handleMcp);
  app.get(MCP_PATH, mcpLimiter, handleMcp);

  app.get("/", (_req, res) => {
    res.status(200).type("html").send(landingHtml("MOI MCP", MCP_PATH));
  });
  app.get(["/favicon.ico", "/favicon.png", "/favicon.svg", "/logo.png", "/logo.svg", "/apple-touch-icon.png"], (req, res) => {
    const brand = brandAsset(req.path);
    if (!brand) {
      res.status(404).end();
      return;
    }
    res.status(200).set("cache-control", "public, max-age=86400").type(brand.type).send(brand.body);
  });
  app.delete(MCP_PATH, mcpLimiter, handleMcp);

  app.use((_req, res) => {
    send(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
  });
  app.use(cleanErrors);

  return app;
}

// ---------------------------------------------------------------------------
// main() — wires the real auth server, pairing page, file-backed session
// store, and a WalletConnect client used only to resolve a pairing link's URI.
// ---------------------------------------------------------------------------

/**
 * Build the resolveUri callback mountPairing needs: start a WalletConnect
 * pairing, hand back the URI immediately for the QR page, and — once the
 * phone approves, in the background — persist the paired session and mark
 * the pairing link consumed.
 *
 * Pairing runs on the hub's SignClient, and that is load-bearing rather than
 * hygiene: signInteractionFor() resolves a topic against its own client's
 * session store, so a session paired on any other client is invisible to the
 * signer and every write for that user would fail "session no longer valid"
 * forever.
 *
 * The approved session is also written to `store` (FileWalletSessionStore,
 * keyed by sha256(userId)). That is the only place a tool may learn a
 * specific user's topic — the relay client itself has no notion of which
 * user paired, so asking it would give whoever paired most recently.
 */
function makeStartPairing(
  cfg: ReturnType<typeof getConfig>,
  hub: WalletConnectHubLike,
  store: WalletSessionStore,
  journal: WriteJournal,
): HostedDeps["startPairing"] {
  return async (userId: string, mode?: PairingMode) => {
    const { uri, approval } = await hub.pair(cfg.MOI_NETWORK);

    // Do not block the pairing page on the phone tap; it already polls via
    // its own cached-promise mechanism (src/pairing/index.ts handleGet).
    approval.then(
      async (session) => {
        const record: StoredWalletSession = {
          version: 1,
          userId,
          topic: session.topic,
          // The WalletConnect namespace key IS the CAIP-2 chain id here —
          // toSession() in wc/client.ts already resolved it against the
          // granted namespaces, not just what we requested.
          caip2: session.chainId,
          address: session.account,
          sessionData: session,
          createdAt: new Date(session.createdAt * 1000).toISOString(),
          // The chat tool passes the mode the user asked for. The page has no
          // way to, so its toggle is read here at approval time instead, so a
          // choice made after the link was issued still counts.
          mode: mode ?? modeForUser(userId),
          expiresAt: expiryFor(mode ?? modeForUser(userId), Math.floor(Date.now() / 1000)),
        };
        try {
          const previous = await store.get(userId);
          if (previous && previous.topic !== session.topic) {
            // Recorded like a write: replacing the phone that gets asked to
            // sign is the most consequential thing a session can do.
            await journal.append({
              id: randomUUID(),
              userId,
              kind: "pairing_replaced",
              state: "confirmed",
              detail: JSON.stringify({ from: previous.address, to: session.account }),
            });
            log("info", "a user replaced their wallet pairing");
          }
          await store.set(record);
          consumeForUser(userId);
        } catch (err) {
          log("error", `failed to persist wallet session for a user: ${messageOf(err)}`);
        }
      },
      (err: unknown) => log("error", `pairing not completed: ${messageOf(err)}`),
    );

    // WalletConnect proposals live about five minutes; tell the user so.
    return { uri, expiresAt: Math.floor(Date.now() / 1000) + 5 * 60 };
  };
}

/**
 * Keep `store` honest when a phone unpairs out-of-band: the relay's
 * session_delete event carries only a topic, resolved back to a userId via
 * `store.findByTopic` (never a caller-supplied identity — this is
 * server-to-server relay wiring, not a tool call).
 *
 * Exported so a test can assert the exact production wiring reconciles the
 * store, rather than only a copy of this logic re-registered inside the test
 * itself.
 */
export function wireSessionDeleteReconciliation(hub: WalletConnectHubLike, store: WalletSessionStore): void {
  hub.onSessionDelete((topic) => {
    void (async () => {
      try {
        const rec = await store.findByTopic(topic);
        if (rec) await store.delete(rec.userId);
      } catch (err) {
        log("error", `failed to reconcile session_delete for a topic: ${messageOf(err)}`);
      }
    })();
  });
}

/**
 * M5: reconcile any write left pending (proposed/signed/broadcast) by a
 * process restart between phone-sign and broadcast. This process never
 * persists the signed payload (ix_args/signatures) outside the request that
 * produced it, so a strand cannot be safely re-broadcast from the journal
 * alone — reconciling means reporting it honestly (loudly, once) and marking
 * it terminal so the next status check reflects reality instead of a tool
 * silently retrying against a stale nonce.
 */
export async function reconcileJournalOnBoot(journal: WriteJournal): Promise<void> {
  await journal.reconcileOnBoot(async (entry) => {
    const hash = (entry as { ixHash?: unknown }).ixHash;
    if (entry.state === "broadcast" && typeof hash === "string" && hash.length > 0) {
      // The node accepted it and gave us a hash before the process died. That
      // is a transaction on the chain, and the only honest thing to record is
      // that it landed. Calling it orphaned would be a lie the journal then
      // tells forever.
      log("info", `journal: ${entry.kind} ${entry.id} had broadcast before exit; recording it confirmed`);
      await journal.update(entry.id, "confirmed", { detail: "finalized on boot; broadcast completed before exit" });
      return;
    }
    log(
      "error",
      `journal: interaction ${entry.id} (${entry.kind}, user ${entry.userId}) was left in state ` +
        `'${entry.state}' by a previous process exit and cannot be safely re-broadcast; marking orphaned.`,
    );
    await journal.update(entry.id, "orphaned", { detail: `reconciled on boot from state '${entry.state}'` });
  });
}

async function main(): Promise<void> {
  const cfg = getConfig(); // loads dotenv as a side effect; call before getHostedConfig()
  const hosted = getHostedConfig(); // a missing or short MOI_SESSION_KEY fails the boot here
  const dappKey = deriveKey(hosted.MOI_SESSION_KEY, DAPP_SESSION_KEY_LABEL);
  const walletKey = deriveKey(hosted.MOI_SESSION_KEY, WALLET_SESSION_KEY_LABEL);
  const wcKey = deriveKey(hosted.MOI_SESSION_KEY, WC_STORAGE_KEY_LABEL);

  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders(hosted.PUBLIC_URL));

  // Redis when a URL is configured, files otherwise. The stores move together
  // on purpose: our session record and the WalletConnect SDK's key material are
  // two halves of the same thing, and splitting them across backends would give
  // a replacement process the topic without the key to use it. All three
  // (pairings, WalletConnect state, dapp sessions) are sealed, each under its
  // own key derived from MOI_SESSION_KEY.
  let store: FileWalletSessionStore | RedisWalletSessionStore;
  let wcStorage: FileKeyValueStorage | RedisKeyValueStorage;
  let dappSessions: DappSessionBackend;
  if (hosted.REDIS_URL) {
    const redis = await connectRedis(hosted.REDIS_URL);
    store = new RedisWalletSessionStore(redis, walletKey);
    wcStorage = new RedisKeyValueStorage(redis, wcKey);
    dappSessions = new RedisDappSessionStore(redis, dappKey);
    log("info", "wallet sessions and WalletConnect state in redis");
  } else {
    store = new FileWalletSessionStore(hosted.dataDir, walletKey);
    wcStorage = new FileKeyValueStorage(join(hosted.dataDir, "wc.db"), wcKey);
    dappSessions = new FileDappSessionStore(hosted.dataDir, dappKey);
    log("info", `wallet sessions on disk under ${hosted.dataDir}`);
  }
  // Before anything can read a dapp session or the server listens: plain
  // records from before sealing are removed here, once, and never read.
  await purgeDappSessionsOnBoot(dappSessions);
  // Pairings and the WalletConnect client's state written before sealing are
  // sealed in place here, once, before the client starts and before the server
  // listens. Nobody is un-paired and nothing is deleted. If any WalletConnect
  // value will not open or could not be sealed, this throws and the client is
  // never started over state it cannot read.
  await sealWalletStateOnBoot({ sessions: store, wcStorage });

  const { authenticate, challengeHeader } = mountAuth(app, {
    publicUrl: hosted.PUBLIC_URL,
    dataDir: hosted.dataDir,
    mcpPath: MCP_PATH,
    // Lets the consent page say which wallet this browser is already paired
    // to, and offer a fresh identity to someone who says it is not theirs.
    pairedWallet: async (userId) => {
      const record = await store.get(userId);
      return record && !isExpired(record) ? { address: record.address } : undefined;
    },
  });
  const hub = await WalletConnectHub.init({
    projectId: cfg.WC_PROJECT_ID,
    home: hosted.dataDir,
    network: cfg.MOI_NETWORK,
    // The hosted budget, not the stdio one: claude.ai allows 300 s per call.
    requestTimeoutMs: hosted.HOSTED_TIMEOUT_MS,
    storage: wcStorage,
  });
  const journal = new WriteJournal(hosted.dataDir);
  // Decided once, here: the tool is absent from tools/list unless both settings are set, the client accepts them and the
  // network is the devnet. Never log `hosted` or either setting: the key is part of the faucet's address.
  const faucet = faucetDepsFor(hosted, cfg.MOI_NETWORK, { store });
  wireSessionDeleteReconciliation(hub, store);
  await reconcileJournalOnBoot(journal);

  const startPairing = makeStartPairing(cfg, hub, store, journal);
  mountPairing(app, { resolveUri: async (userId) => (await startPairing(userId)).uri });

  // The Launchpad: its session per user next to the wallet pairing, and the
  // one-time page that hands an agent's setup script to a browser. The Launchpad is signed in to with moi_dapp_sign_in,
  // so the Launchpad tools and the dapp tools below are given the one dappSessions store: a session the generic tool
  // files is the one these tools read.
  const launchpadClient = new LaunchpadClient(hosted.MOI_LAUNCHPAD_URL);
  const downloads = createDownloadModule();
  downloads.mountDownloads(app, {
    fetchScript: async (userId, agentId) => {
      const rec = await dappSessions.get(userId, launchpadClient.baseUrl);
      if (!rec || isDappSessionExpired(rec)) throw new Error("no launchpad session");
      return launchpadClient.setupScript(rec.cookie, agentId);
    },
  });

  app.use(
    buildHostedApp({
      authenticate,
      challengeHeader,
      store,
      hub,
      journal,
      resolveUriMounted: true,
      createPairingLink: (userId: string, seed?: PairingSeed) => createPairingLinkFor(userId, hosted.PUBLIC_URL, seed),
      startPairing,
      publicUrl: hosted.PUBLIC_URL,
      launchpad: {
        client: launchpadClient,
        sessions: dappSessions,
        writes: { store, hub, journal },
        createDownloadLink: (userId, agentId) => downloads.createDownloadLink(userId, agentId, hosted.PUBLIC_URL),
      },
      dapp: { sessions: dappSessions, writes: { store, hub, journal } },
      ...(faucet ? { faucet } : {}),
    }),
  );

  app.use(cleanErrors);

  app.listen(hosted.HOSTED_PORT, () => {
    // Never log a token, cookie, or pairing URL — only what is safe in a
    // shared process log.
    log(
      "info",
      `moi-mcp-hosted listening on :${hosted.HOSTED_PORT}${MCP_PATH} (public url ${hosted.PUBLIC_URL}, network ${cfg.MOI_NETWORK})`,
    );
  });
}

// npm installs bins as SYMLINKS (node_modules/.bin/moi-mcp-hosted ->
// dist/server.js), so argv[1]'s basename differs from this module's file
// name and a naive endsWith() check makes the bin exit silently. Compare
// realpaths instead — copied from src/http.ts, which hit this bug first.
const isMain = (() => {
  try {
    return process.argv[1]
      ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
      : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[moi-mcp] fatal: ${messageOf(err)}\n`);
    process.exit(1);
  });
}
