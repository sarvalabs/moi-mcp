/**
 * Boots the REAL McpServer tool handlers in-process and talks to them through
 * the SDK's own Client over a linked in-memory transport, so tests exercise
 * the exact code path an MCP client does: input validation, the handler, and
 * output-schema validation on both server and client sides.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { resetConfigCache } from "../../src/config.js";
import { resetProviderCache } from "../../src/moi/provider.js";
import { DEFAULT_REGISTRY_LOGIC_ID } from "../../src/capabilities/reads/registry.js";
import { registerResources } from "../../src/resources/index.js";
import { localWriteDeps } from "../../src/tools/local-writes.js";
import { PreviewRegistry } from "../../src/tools/preview.js";
import { registerReadTools } from "../../src/capabilities/reads/tools.js";
import { registerLocalWriteTools, registerWalletTools } from "../../src/tools/register.js";
import { resetWalletClient, setWalletClient } from "../../src/tools/wallet.js";
import { withModernSchemaDialect } from "../../src/json-schema-dialect.js";
import type { SignClientLike, WcConfig } from "../../src/wc/client.js";
import { saveSession, type Session } from "../../src/wc/session.js";
import { ACCOUNT } from "./mock-node.js";

/** A syntactically valid Reown project id (32 hex). Never reaches a relay. */
export const PROJECT_ID = "0123456789abcdef0123456789abcdef";

export interface Harness {
  client: Client;
  server: McpServer;
  home: string;
  /** Result of the LAST tool call, as the client saw it. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /**
   * A write as a model performs it: the call without `confirm`, then, if that answered with a preview, the same call
   * with its token. Whatever the first call returned instead (a refusal, an error, a view) comes straight back.
   */
  send(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  /** All text blocks joined. */
  text: string;
}

const MANAGED_ENV = [
  "WC_PROJECT_ID",
  "MOI_NETWORK",
  "MOI_RPC_URL",
  "MOI_MCP_HOME",
  "REQUEST_TIMEOUT_MS",
  "LOG_LEVEL",
  "MOI_EXPLORER_URL",
  "MOI_READ_CALLER",
  "MOI_WC_PARAM_STYLE",
  "MOI_AGENT_REGISTRY_LOGIC_ID",
] as const;

let savedEnv: Record<string, string | undefined> | undefined;

/**
 * Point the server at the mock node.
 *
 * DELETING a key is not enough to isolate a test: loadConfig() re-runs dotenv
 * against the repo's real `.env` on every resetConfigCache, and dotenv fills in
 * exactly the keys that are UNSET. So every key any src file reads out of
 * process.env is SET here — including the two that never pass through
 * config.ts: MOI_WC_PARAM_STYLE (src/wc/client.ts paramStyle) and
 * MOI_READ_CALLER (src/moi/provider.ts getReadOnlySigner). Leaving either
 * merely deleted lets a developer's .env change the wallet payload encoding or
 * the read caller under test.
 */
export function applyEnv(rpcUrl: string, home: string, overrides: Record<string, string> = {}): void {
  savedEnv ??= Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, {
    WC_PROJECT_ID: PROJECT_ID,
    MOI_NETWORK: "custom",
    MOI_RPC_URL: rpcUrl,
    MOI_MCP_HOME: home,
    REQUEST_TIMEOUT_MS: "2000",
    LOG_LEVEL: "silent",
    MOI_EXPLORER_URL: "https://voyage.moi.technology",
    MOI_AGENT_REGISTRY_LOGIC_ID: DEFAULT_REGISTRY_LOGIC_ID,
    MOI_WC_PARAM_STYLE: "positional",
    MOI_READ_CALLER: ACCOUNT,
    ...overrides,
  });
  resetConfigCache();
  resetProviderCache();
  resetWalletClient();
}

export function restoreEnv(): void {
  if (!savedEnv) return;
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = undefined;
  resetConfigCache();
  resetProviderCache();
  resetWalletClient();
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moi-tools-"));
}

/**
 * Build the server exactly as src/index.ts does (minus `ping`), except that it gets a confirm-token registry of its
 * own, so no token can outlive its test or be spent by another.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "moi-mcp-test", version: "0.0.0" });
  registerReadTools(server);
  registerWalletTools(server);
  registerLocalWriteTools(server, { ...localWriteDeps(), previews: new PreviewRegistry() });
  registerResources(server);
  return server;
}

/** The journal the write path keeps in MOI_MCP_HOME, one parsed entry per line, oldest first. [] when there is none. */
export function journalLines(home: string): Array<Record<string, unknown>> {
  const file = join(home, "journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function startHarness(
  rpcUrl: string,
  options: { home?: string; env?: Record<string, string>; build?: () => McpServer } = {},
): Promise<Harness> {
  const home = options.home ?? tempHome();
  applyEnv(rpcUrl, home, options.env);

  // The stdio server's tools unless the test says which server it wants, such as the read gateway.
  const server = (options.build ?? buildServer)();
  const client = new Client({ name: "harness", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Wrap exactly as src/index.ts and src/http.ts do, so tests exercise the
  // schemas clients actually receive — the SDK stamps draft-07 otherwise.
  await server.connect(withModernSchemaDialect(serverTransport));
  await client.connect(clientTransport);
  // Caches every tool's outputSchema so callTool validates structuredContent
  // client-side too — the layer the write-tool regression slipped past.
  await client.listTools();

  const call: Harness["call"] = async (name, args = {}) => {
    const raw = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    const content = raw.content ?? [];
    return {
      ...raw,
      content,
      text: content.map((c) => c.text ?? "").join("\n"),
    };
  };

  return {
    client,
    server,
    home,
    call,
    async send(name, args = {}) {
      const first = await call(name, args);
      const preview = first.structuredContent as { status?: string; confirm?: string } | undefined;
      if (preview?.status !== "preview") return first;
      return call(name, { ...args, confirm: preview.confirm });
    },
    async close() {
      await client.close();
      await server.close();
      rmSync(home, { recursive: true, force: true });
      restoreEnv();
    },
  };
}

// ---------------------------------------------------------------------------
// Wallet fake
// ---------------------------------------------------------------------------

export interface WcRequest {
  topic: string;
  chainId: string;
  request: { method: string; params: unknown[] };
}

export interface FakeWallet {
  client: SignClientLike;
  request: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  /**
   * The SignClient factory installWallet hands to WalletConnectClient. Spying
   * on it is how a test proves a code path never CONSTRUCTS a wallet client —
   * `request` not being called is weaker, because construction alone opens a
   * relay connection and a wc.db in production.
   */
  factory: ReturnType<typeof vi.fn>;
  /** Every request the "phone" received, in order. */
  requests: WcRequest[];
}

/**
 * What the fake phone returns for a given interaction.
 *
 * Deliberately DERIVED from the request rather than constant: the write path's
 * contract is "the bytes the phone signed are the bytes the node receives",
 * and a constant reply makes that assertion true no matter what
 * signAndBroadcast forwards.
 */
export function signatureFor(req: WcRequest): { ix_args: string; signatures: string } {
  const digest = createHash("sha256").update(JSON.stringify(req.request.params[0])).digest("hex");
  return { ix_args: `0e5f0300${digest.slice(0, 32)}`, signatures: `0e1f03${digest.slice(32, 64)}` };
}

/**
 * Stand in for the SignClient + phone. `respond` decides what the wallet
 * answers with; the default signs anything. Throwing from it models a
 * rejection on the phone.
 */
export function fakeWallet(
  respond: (req: WcRequest) => unknown = signatureFor,
): FakeWallet {
  const requests: WcRequest[] = [];
  const request = vi.fn(async (args: unknown) => {
    const req = args as WcRequest;
    requests.push(req);
    return respond(req);
  });
  const disconnect = vi.fn(async () => {});
  const client: SignClientLike = {
    connect: vi.fn(async () => ({
      uri: "wc:test@2?relay-protocol=irn",
      approval: async () => new Promise(() => {}),
    })),
    request: request as SignClientLike["request"],
    disconnect,
    on: vi.fn(),
    session: { keys: [], get: () => undefined },
  };
  const factory = vi.fn(async () => client);
  return { client, request, disconnect, factory, requests };
}

/** Install a fake wallet on the tool layer for the current config. */
export function installWallet(home: string, wallet: FakeWallet, cfg: Partial<WcConfig> = {}): void {
  setWalletClient(
    {
      projectId: PROJECT_ID,
      home,
      network: "custom",
      requestTimeoutMs: 2000,
      ...cfg,
    },
    wallet.factory as unknown as (c: WcConfig) => Promise<SignClientLike>,
  );
}

/** Write a paired session into MOI_MCP_HOME, as a completed pairing would. */
export function seedSession(home: string, overrides: Partial<Session> = {}): Session {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    version: 1,
    topic: "topic-test",
    pairingTopic: "pairing-test",
    account: ACCOUNT,
    chainId: "moi:custom",
    network: "custom",
    peer: { name: "MOI Wallet", url: "https://wallet.moi.technology" },
    expiry: now + 3600,
    createdAt: now * 1000,
    ...overrides,
  };
  saveSession(home, session);
  return session;
}
