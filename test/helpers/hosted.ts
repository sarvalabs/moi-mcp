/**
 * Fixtures for exercising the hosted write tools through a real McpServer
 * over an in-memory transport, against the mock node, with only the store,
 * hub and journal faked. A test that pokes the store directly would pass no
 * matter what the handler did.
 */
import { vi, type Mock } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { deriveKey } from "../../src/auth/crypto.js";
import { toPoloHex, toWireJson, type UnsignedInteraction } from "../../src/moi/ix-builder.js";
import type { AuthInfo } from "../../src/auth/types.js";
import { DAPP_SESSION_KEY_LABEL } from "../../src/applications/dapp/store.js";
import type { HostedWriteDeps } from "../../src/tools/hosted-writes.js";
import { registerHostedWrites, type HostedWriteOptions } from "../../src/tools/register.js";
import type { PreviewRegistry } from "../../src/tools/preview.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import {
  WALLET_SESSION_KEY_LABEL,
  WC_STORAGE_KEY_LABEL,
  type StoredWalletSession,
  type WalletSessionStore,
} from "../../src/wc/store.js";
import { ACCOUNT } from "./mock-node.js";

export const USER = "user-a";
export const TOPIC = "topic-a";

/**
 * A MOI_SESSION_KEY-shaped secret for tests: 44 base64 characters, the length
 * `openssl rand -base64 32` gives. Built rather than typed, so no literal that
 * looks like a key sits in the repo; it protects nothing.
 */
export const SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

/** The dapp session key the hosted server derives from MOI_SESSION_KEY, for tests that build a real store. */
export function dappKey(secret: string = SESSION_SECRET): Buffer {
  return deriveKey(secret, DAPP_SESSION_KEY_LABEL);
}

/** The wallet pairing store's key, derived the way main() derives it. */
export function walletKey(secret: string = SESSION_SECRET): Buffer {
  return deriveKey(secret, WALLET_SESSION_KEY_LABEL);
}

/** The WalletConnect storage's key, derived the way main() derives it. */
export function wcKey(secret: string = SESSION_SECRET): Buffer {
  return deriveKey(secret, WC_STORAGE_KEY_LABEL);
}

/**
 * The environment a hosted server needs beyond its defaults, with MOI_SESSION_KEY
 * set, for tests that load hosted config. `over` replaces any of it.
 */
export function hostedEnv(dataDir: string, over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { MOI_DATA_DIR: dataDir, MOI_SESSION_KEY: SESSION_SECRET, ...over };
}

export function session(over: Partial<StoredWalletSession> = {}): StoredWalletSession {
  return {
    version: 1,
    userId: USER,
    topic: TOPIC,
    caip2: "moi:custom",
    address: ACCOUNT,
    sessionData: {},
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function fakeStore(records: Map<string, StoredWalletSession>): WalletSessionStore {
  return {
    get: vi.fn(async (userId: string) => records.get(userId)),
    set: vi.fn(async (r: StoredWalletSession) => void records.set(r.userId, r)),
    delete: vi.fn(async (userId: string) => void records.delete(userId)),
    findByTopic: vi.fn(async (topic: string) => [...records.values()].find((r) => r.topic === topic)),
    list: vi.fn(async () => [...records.values()]),
  };
}

export type FakeHub = WalletConnectHubLike & { disconnect: Mock; signInteractionFor: Mock; signMessageFor: Mock };

export function fakeHub(): FakeHub {
  return {
    pair: vi.fn(async () => {
      throw new Error("not used here");
    }),
    signMessageFor: vi.fn(async () => ({ signature: "0xfeed" })),
    // An honest phone: the bytes of the interaction it was asked to sign, which the write path checks before it
    // broadcasts. The real hub returns unprefixed hex (PoloHex in src/schema.ts), so this does too. Not a canned value:
    // a constant reply would be accepted or refused regardless of the interaction.
    signInteractionFor: vi.fn(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: toPoloHex(toWireJson(ix) as never),
      signatures: "0x" + "2".repeat(128),
    })),
    onSessionDelete: vi.fn(() => () => {}),
    disconnect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

/**
 * A phone that has not answered yet. Both signing calls on `hub` stay pending until tap(), then answer as the hub did
 * before. fail(err) makes them reject instead (the person refused, or the wait timed out). `asked` resolves the moment
 * either call is made, so a test knows the wait is open before it moves the clock.
 */
export function slowPhone(hub: FakeHub): { asked: Promise<void>; tap: () => void; fail: (err: unknown) => void } {
  let ask!: () => void;
  const asked = new Promise<void>((resolve) => (ask = resolve));
  let tap!: () => void;
  let fail!: (err: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    tap = resolve;
    fail = reject;
  });
  settled.catch(() => {}); // a test that never reaches the hub must not leave an unhandled rejection
  const answerInteraction = hub.signInteractionFor.getMockImplementation()!;
  const answerMessage = hub.signMessageFor.getMockImplementation()!;
  hub.signInteractionFor.mockImplementation(async (...args: unknown[]) => {
    ask();
    await settled;
    return answerInteraction(...args);
  });
  hub.signMessageFor.mockImplementation(async (...args: unknown[]) => {
    ask();
    await settled;
    return answerMessage(...args);
  });
  return { asked, tap, fail };
}

export interface FakeJournal {
  append: Mock;
  update: Mock;
}

export function fakeJournal(): FakeJournal {
  return { append: vi.fn(async () => {}), update: vi.fn(async () => {}) };
}

export function authFor(userId: string): AuthInfo {
  return {
    userId,
    clientId: "c",
    scopes: ["moi:write"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

export function deps(
  store: WalletSessionStore,
  hub: WalletConnectHubLike,
  journal: FakeJournal = fakeJournal(),
  previews?: PreviewRegistry,
): HostedWriteDeps {
  return { store, hub, journal, previews } as unknown as HostedWriteDeps;
}

/**
 * Wire a real McpServer with the hosted writes and hand back a connected client. `options` is what registerHostedWrites
 * takes: a test of moi_deploy_logic passes a short deployWaitMs, because the hosted default watches for the receipt for 30 seconds.
 */
export async function connect(d: HostedWriteDeps, who: AuthInfo = authFor(USER), options: HostedWriteOptions = {}): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerHostedWrites(server, d, who, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

export function structured<T = Record<string, unknown>>(r: ToolResult): T {
  return r.structuredContent as T;
}

/**
 * A write as a model performs it: the preview call, then the same call with
 * the confirm token. Anything that is not a preview comes straight back.
 */
export async function send(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const first = await client.callTool({ name, arguments: args });
  const preview = structured<{ status?: string; confirm?: string }>(first);
  if (preview?.status !== "preview") return first;
  return client.callTool({ name, arguments: { ...args, confirm: preview.confirm } });
}
