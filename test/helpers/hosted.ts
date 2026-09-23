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

import type { AuthInfo } from "../../src/auth/types.js";
import { registerHostedWrites, type HostedWriteDeps } from "../../src/tools/hosted-writes.js";
import type { PreviewRegistry } from "../../src/tools/preview.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import type { StoredWalletSession, WalletSessionStore } from "../../src/wc/store.js";
import { ACCOUNT } from "./mock-node.js";

export const USER = "user-a";
export const TOPIC = "topic-a";

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
    signInteractionFor: vi.fn(async () => ({
      ix_args: "0x" + "1".repeat(64),
      signatures: "0x" + "2".repeat(128),
    })),
    onSessionDelete: vi.fn(() => () => {}),
    disconnect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
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

/** Wire a real McpServer with the hosted writes and hand back a connected client. */
export async function connect(d: HostedWriteDeps, who: AuthInfo = authFor(USER)): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerHostedWrites(server, d, who);
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
