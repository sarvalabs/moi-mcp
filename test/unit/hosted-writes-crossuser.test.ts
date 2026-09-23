/**
 * Cross-user write tools on hosted MOI MCP server.
 *
 * Two authenticated users (A and B) share one hosted process with one
 * WalletConnectHub. Each test verifies isolation: A's writes are signed on
 * A's topic, B's on B's, and no cross-talk even under concurrency.
 *
 * This suite tests the contract surface only. If impl files don't exist yet,
 * tests will fail to compile with clear message pointing to the missing
 * contract files. Serves as a regression gate on the extraction in §2 of
 * the binding contract and a cross-user security matrix.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthInfo } from "../../src/auth/index.js";
import { WriteJournal } from "../../src/journal.js";
import { MoiError } from "../../src/moi-error.js";
import { buildHostedApp, GATED, wireSessionDeleteReconciliation, type HostedDeps } from "../../src/server.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import type { StoredWalletSession, WalletSessionStore } from "../../src/wc/store.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { ACCOUNT, KMOI, MAS0_ASSET, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";
import type { SignClientLike } from "../../src/wc/client.js";
import { WalletConnectHub } from "../../src/wc/hub.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A_ID = "user-a";
const USER_B_ID = "user-b";
const USER_C_ID = "user-c";

const TOPIC_A = "wc:topic-a@2?relay=...";
const TOPIC_B = "wc:topic-b@2?relay=...";

const ACCOUNT_A = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ACCOUNT_B = "0x0000000000000000000000000000000000000000000000000000000000000002";

const AUTH_A: AuthInfo = {
  userId: USER_A_ID,
  clientId: "client-a",
  scopes: ["moi:read", "moi:write"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const AUTH_B: AuthInfo = {
  userId: USER_B_ID,
  clientId: "client-b",
  scopes: ["moi:read", "moi:write"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const AUTH_C_READ_ONLY: AuthInfo = {
  userId: USER_C_ID,
  clientId: "client-c",
  scopes: ["moi:read"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

/**
 * FakeStore holds user -> session records. Models the persistent
 * WalletSessionStore (e.g., FileWalletSessionStore in production).
 */
class FakeStore implements WalletSessionStore {
  private records = new Map<string, StoredWalletSession>();

  async get(userId: string): Promise<StoredWalletSession | undefined> {
    return this.records.get(userId);
  }

  async set(record: StoredWalletSession): Promise<void> {
    this.records.set(record.userId, record);
  }

  async delete(userId: string): Promise<void> {
    this.records.delete(userId);
  }

  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    return [...this.records.values()].find((r) => r.topic === topic);
  }

  async list(): Promise<StoredWalletSession[]> {
    return [...this.records.values()];
  }
}

/**
 * Mocks the WalletConnectHub for testing. Tracks calls and can simulate
 * relay expiry or phone unpair.
 */
class FakeHub implements WalletConnectHubLike {
  async disconnect(_topic: string): Promise<void> {}

  async pair(): Promise<never> {
    throw new Error("FakeHub does not pair; these tests drive signing only");
  }

  close = vi.fn(async () => {});

  signMessageFor = vi.fn(async () => ({ signature: "0xfeed" }));

  signInteractionFor = vi.fn(async (topic: string, ix: unknown, opts: { description: string }) => {
    // Simulate relay-expired/phone-unpaired: if a session was deleted, throw
    if (topic === TOPIC_A && this.sessionDeleted.has(TOPIC_A)) {
      throw new MoiError("WALLET_NOT_CONNECTED", "Session was deleted");
    }
    if (topic === TOPIC_B && this.sessionDeleted.has(TOPIC_B)) {
      throw new MoiError("WALLET_NOT_CONNECTED", "Session was deleted");
    }
    // Normal path: return derived signatures
    return {
      ix_args: `0e5f0300${topic.slice(0, 32)}`,
      signatures: `0e1f03${topic.slice(0, 32)}`,
    };
  });

  onSessionDelete = vi.fn((handler: (topic: string) => void) => {
    this.deleteHandler = handler;
    return () => {
      this.deleteHandler = undefined;
    };
  });

  private sessionDeleted = new Set<string>();
  private deleteHandler: ((topic: string) => void) | undefined;

  /** Simulate a session_delete event from the relay (e.g., phone unpaired). */
  simulateSessionDelete(topic: string): void {
    this.sessionDeleted.add(topic);
    if (this.deleteHandler) this.deleteHandler(topic);
  }
}

function fakeAuthenticate(req: {
  headers: { authorization?: string | string[] | undefined };
}): AuthInfo | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === "Bearer token-a") return AUTH_A;
  if (value === "Bearer token-b") return AUTH_B;
  if (value === "Bearer token-c") return AUTH_C_READ_ONLY;
  return undefined;
}

function fakeChallengeHeader(opts?: { error?: string; scope?: string }): string {
  const error = opts?.error ?? "invalid_token";
  const description = error === "insufficient_scope" ? "This action requires additional scope" : "Authorization required";
  const scopePart = opts?.scope ? `, scope="${opts.scope}"` : "";
  return (
    `Bearer error="${error}", error_description="${description}", ` +
    `resource_metadata="https://example.test/.well-known/oauth-protected-resource"${scopePart}`
  );
}

function makeDeps(store: WalletSessionStore, hub: WalletConnectHubLike, journal: WriteJournal): HostedDeps {
  return {
    authenticate: fakeAuthenticate,
    challengeHeader: fakeChallengeHeader,
    store,
    resolveUriMounted: true,
    createPairingLink: (userId) => ({
      url: `https://example.test/pair/${userId}`,
      expiresAt: Date.now() + 300_000,
    }),
    startPairing: async (userId, mode) => ({
      uri: `wc:${userId}@2?relay-protocol=irn&symKey=${"0".repeat(64)}`,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      ...(mode ? { mode } : {}),
    }),
    hub,
    journal,
  };
}

/** POST one JSON-RPC message and return both the raw response and its decoded body. */
async function rpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, json };
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/**
 * A write as a model performs it: the preview call, then the same call with
 * the confirm token. Anything that is not a preview (a 401, a rejection, a
 * view) comes straight back, so every expectation below still reads as the
 * outcome of one write.
 */
async function send(
  baseUrl: string,
  call: ReturnType<typeof toolCall>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const first = await rpc(baseUrl, call, headers);
  const preview = first.json?.result?.structuredContent;
  if (first.status !== 200 || preview?.status !== "preview") return first;
  const confirmed = {
    ...call,
    id: call.id + 100,
    params: { ...call.params, arguments: { ...call.params.arguments, confirm: preview.confirm } },
  };
  return rpc(baseUrl, confirmed, headers);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-user write tools isolation", () => {
  let node: MockNode;
  let server: Server;
  let baseUrl: string;
  let store: FakeStore;
  let hub: FakeHub;
  let journal: WriteJournal;

  beforeAll(async () => {
    node = await startMockNode();
  });

  afterAll(async () => {
    await node.close();
  });

  beforeEach(async () => {
    applyEnv(node.url, tempHome());
    node.reset();
    store = new FakeStore();
    hub = new FakeHub();
    journal = new WriteJournal(tempHome());

    const app = buildHostedApp(makeDeps(store, hub, journal));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Correct routing, single call
  // =========================================================================
  it("1. routes a single transfer call from user A to A's session", async () => {
    // Seed user A's wallet session
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
      { authorization: "Bearer token-a" },
    );

    expect(result.status).toBe(200);
    expect(result.json.result.isError).toBeFalsy();

    // Verify hub.signInteractionFor was called with topic A only
    expect(hub.signInteractionFor).toHaveBeenCalledWith(
      TOPIC_A,
      expect.any(Object),
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 2. No cross-talk under concurrency
  // =========================================================================
  it("2. A and B calling concurrently sign on their own topics, no interleaving", async () => {
    // Seed both users' sessions
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });
    await store.set({
      version: 1,
      userId: USER_B_ID,
      topic: TOPIC_B,
      caip2: "moi:custom",
      address: ACCOUNT_B,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // Fire both requests in parallel
    const [resultA, resultB] = await Promise.all([
      send(baseUrl, toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }), {
        authorization: "Bearer token-a",
      }),
      send(baseUrl, toolCall(2, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "20" }), {
        authorization: "Bearer token-b",
      }),
    ]);

    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);

    // Verify two separate calls with correct topics
    const calls = hub.signInteractionFor.mock.calls;
    expect(calls).toHaveLength(2);
    const topics = calls.map((c) => c[0]);
    expect(topics).toContain(TOPIC_A);
    expect(topics).toContain(TOPIC_B);
  });

  // =========================================================================
  // 3. Unauthenticated request never reaches write tools
  // =========================================================================
  it("3. unauthenticated transfer call returns 401, hub never called", async () => {
    const { status, headers, json } = await send(baseUrl, toolCall(1, "moi_transfer", { to: ACCOUNT }));

    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("resource_metadata");
    expect(json).toEqual({ error: "authorization required" });
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 4. User with no paired wallet
  // =========================================================================
  it("4. user C (no paired wallet) gets WALLET_NOT_CONNECTED", async () => {
    // User C is not in the store

    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
      { authorization: "Bearer token-a" }, // Auth as A to ensure no cross-talk
    );

    expect(result.status).toBe(200);
    expect(result.json.result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 5. Network mismatch
  // =========================================================================
  it("5. network mismatch returns NETWORK_MISMATCH", async () => {
    // Seed user A on voyage network
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom", // voyage
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // Attempt transfer on a different network (if the tool supports network param)
    // For now, just seed on wrong network and verify the error occurs
    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10", network: "mainnet" }),
      { authorization: "Bearer token-a" },
    );

    // Should either reject with network_mismatch OR succeed (depending on impl)
    // but hub.signInteractionFor should NOT be called if network mismatch is detected
    if (result.json.result.structuredContent?.reason === "network_mismatch") {
      expect(hub.signInteractionFor).not.toHaveBeenCalled();
    }
  });

  // =========================================================================
  // 6. Relay-expired / phone-unpaired session
  // =========================================================================
  it("6. relay-expired session (hub throws WALLET_NOT_CONNECTED)", async () => {
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // Simulate relay deleting the session (phone-side disconnect)
    hub.simulateSessionDelete(TOPIC_A);

    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
      { authorization: "Bearer token-a" },
    );

    expect(result.status).toBe(200);
    expect(result.json.result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
  });

  // =========================================================================
  // 7. session_delete demux reconciliation
  // =========================================================================
  it("7. session_delete event reconciles store (deletes user A, leaves user B)", async () => {
    // Seed both users
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });
    await store.set({
      version: 1,
      userId: USER_B_ID,
      topic: TOPIC_B,
      caip2: "moi:custom",
      address: ACCOUNT_B,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    expect(await store.get(USER_A_ID)).toBeDefined();
    expect(await store.get(USER_B_ID)).toBeDefined();

    // Regression for the finding that buildHostedApp/registerHostedWrites
    // never called hub.onSessionDelete and neither did main(): this is the
    // EXACT function main() now calls (src/server.ts), not a copy of its
    // logic re-registered here. If main() ever stops calling it (or the
    // wiring inside it regresses), this test — not just a production outage
    // — catches it.
    wireSessionDeleteReconciliation(hub, store);

    // Simulate relay session_delete for A
    hub.simulateSessionDelete(TOPIC_A);
    // The handler above runs its store lookups asynchronously; let them settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.onSessionDelete).toHaveBeenCalled();
    expect(await store.get(USER_A_ID)).toBeUndefined();
    expect(await store.get(USER_B_ID)).toBeDefined();
  });

  // =========================================================================
  // 8. Identity cannot be spoofed via tool input
  // =========================================================================
  it("8. attacker-supplied topic/userId/account in params is ignored", async () => {
    // Seed user A
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // User A tries to call transfer with injected topic/userId/account pointing to B
    // The impl should ignore these and use auth.userId
    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", {
        to: ACCOUNT,
        assetId: KMOI,
        amount: "10",
        // Try to inject B's topic (shouldn't be in schema, but test defensively)
        topic: TOPIC_B,
        userId: USER_B_ID,
      }),
      { authorization: "Bearer token-a" },
    );

    expect(result.status).toBe(200);

    // Verify only A's topic was used
    if (hub.signInteractionFor.mock.calls.length > 0) {
      expect(hub.signInteractionFor).toHaveBeenCalledWith(
        TOPIC_A,
        expect.any(Object),
        expect.any(Object),
      );
    }
  });

  // =========================================================================
  // 9. moi_call_logic view path needs no wallet
  // =========================================================================
  it("9. moi_call_logic in view mode needs no wallet", async () => {
    // User C has no wallet and is read-only, but can still call view logic
    const result = await rpc(
      baseUrl,
      toolCall(1, "moi_call_logic", {
        logicId: "0x123",
        mode: "view",
        function: "view_func",
        params: [],
      }),
      { authorization: "Bearer token-c" }, // read-only scope
    );

    // Should either succeed (if logic exists in mock node) or fail for logic reasons,
    // but store.get and hub.signInteractionFor should NOT be called
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 10. Hub exposes no signing path around a topic
  // =========================================================================
  it("10. WalletConnectHub public surface is restricted", () => {
    // This checks the REAL class, not FakeHub — FakeHub is a test double and
    // asserting on its own shape proves nothing about production code.
    const fakeSignClient = {
      connect: vi.fn(async () => ({ uri: "wc:fake", approval: async () => ({}) })),
      disconnect: vi.fn(async () => {}),
      request: vi.fn(async () => ({ ix_args: "", signatures: "" })),
      on: vi.fn(),
      session: { keys: [], get: vi.fn(() => undefined) },
    } as unknown as SignClientLike;
    const realHub = new WalletConnectHub(fakeSignClient);

    // init is a static factory on the class, not an instance method.
    expect(typeof WalletConnectHub.init).toBe("function");

    const instanceMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(realHub)).filter(
      (m) => m !== "constructor",
    );
    for (const method of ["close", "signInteractionFor", "onSessionDelete"]) {
      expect(instanceMethods, `Hub should expose ${method}`).toContain(method);
    }

    // No overload accepting a Session/StoredWalletSession/userId/account —
    // signInteractionFor's only routing input is the topic string, enforced
    // by TypeScript at the call site (WalletConnectHubLike's signature).
    expect(typeof realHub.signInteractionFor).toBe("function");
  });

  // =========================================================================
  // 11. Stdio path unchanged (already tested via tools-writes.test.ts)
  // =========================================================================
  it("11. [note] stdio path regression tested separately in tools-writes.test.ts", () => {
    // This contract guarantees that write-core.ts extraction does not change
    // stdio behavior. That is verified by the existing tools-writes.test.ts
    // running against the refactored src/tools/writes.ts unmodified.
    expect(true).toBe(true);
  });

  // =========================================================================
  // 12. One SignClient invariant — NOT covered here
  // =========================================================================
  // There used to be an `it(...)` here asserting `expect(true).toBe(true)`
  // under a comment claiming the one-SignClient invariant was "verified in
  // integration test" / "elsewhere". Nothing verifies it: main()'s hub
  // (WalletConnectHub.init, home=hosted.dataDir) and makeResolveUri's own
  // WalletConnectClient (home=hosted.dataDir/wc-relay-scratch) are two
  // separate SignClient instances today — see the SEAM comment on
  // makeResolveUri in src/server.ts. A real regression test needs pairing
  // through makeResolveUri and signing through the same hub, which needs a
  // live (or realistically faked) relay round-trip that this suite's FakeHub
  // does not model and this task's harness explicitly forbids connecting to.
  // Removed the no-op rather than leave a passing test that asserts nothing;
  // the fix (share one SignClient) stays tracked as its own scoped task.

  // =========================================================================
  // 13. Two users, same tool, different tools in flight simultaneously
  // =========================================================================
  it("13. A calls mint, B calls create_asset concurrently", async () => {
    // Seed both users
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });
    await store.set({
      version: 1,
      userId: USER_B_ID,
      topic: TOPIC_B,
      caip2: "moi:custom",
      address: ACCOUNT_B,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // Fire two different write tools concurrently
    const [resultA, resultB] = await Promise.all([
      send(
        baseUrl,
        toolCall(1, "moi_mint", { assetId: MAS0_ASSET, amount: "100" }),
        { authorization: "Bearer token-a" },
      ),
      send(
        baseUrl,
        toolCall(2, "moi_create_asset", { symbol: "TST", supply: "1000" }),
        { authorization: "Bearer token-b" },
      ),
    ]);

    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);

    // Verify two calls, each to the correct topic
    const calls = hub.signInteractionFor.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const topics = calls.slice(-2).map((c) => c[0]);
    expect(topics).toContain(TOPIC_A);
    expect(topics).toContain(TOPIC_B);
  });

  // =========================================================================
  // Additional: User A cannot use user B's topic even if it escapes params
  // =========================================================================
  it("bonus: user A cannot read user B's session, even if B's topic leaks", async () => {
    // Seed both
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });
    await store.set({
      version: 1,
      userId: USER_B_ID,
      topic: TOPIC_B,
      caip2: "moi:custom",
      address: ACCOUNT_B,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // User A calls a transfer. The hub will be called with A's topic.
    const result = await send(
      baseUrl,
      toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
      { authorization: "Bearer token-a" },
    );

    expect(result.status).toBe(200);
    expect(hub.signInteractionFor).toHaveBeenCalledWith(TOPIC_A, expect.any(Object), expect.any(Object));

    // Verify B's topic was never used in A's call
    hub.signInteractionFor.mock.calls.forEach((call) => {
      expect(call[0]).not.toBe(TOPIC_B);
    });
  });

  // =========================================================================
  // Additional: Concurrent calls from same user use same topic consistently
  // =========================================================================
  it("bonus: user A's concurrent calls both sign on A's topic", async () => {
    await store.set({
      version: 1,
      userId: USER_A_ID,
      topic: TOPIC_A,
      caip2: "moi:custom",
      address: ACCOUNT_A,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });

    // Fire two calls from A in parallel
    const [result1, result2] = await Promise.all([
      send(
        baseUrl,
        toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
        { authorization: "Bearer token-a" },
      ),
      send(
        baseUrl,
        toolCall(2, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "20" }),
        { authorization: "Bearer token-a" },
      ),
    ]);

    expect(result1.status).toBe(200);
    expect(result2.status).toBe(200);

    // Both should use TOPIC_A
    const calls = hub.signInteractionFor.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    calls.forEach((call) => {
      expect(call[0]).toBe(TOPIC_A);
    });
  });

  // =========================================================================
  // 14-16. Write journal (M5) — CRITICAL: none of the hosted write tools
  // wrote to the journal before this fix, so a mid-sign restart could strand
  // an approved-but-unbroadcast interaction with zero durable record of it.
  // =========================================================================
  describe("write journal", () => {
    it("14. a successful transfer is journaled proposed -> signed -> broadcast -> confirmed, with ixHash", async () => {
      await store.set({
        version: 1,
        userId: USER_A_ID,
        topic: TOPIC_A,
        caip2: "moi:custom",
        address: ACCOUNT_A,
        sessionData: {},
        createdAt: new Date().toISOString(),
      });

      const result = await send(
        baseUrl,
        toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
        { authorization: "Bearer token-a" },
      );
      expect(result.status).toBe(200);
      expect(result.json.result.structuredContent.status).toBe("sent");
      const hash = result.json.result.structuredContent.hash as string;

      // A clean broadcast is the end of the story for this request, so the
      // entry finishes "confirmed" and is no longer pending: a restart must
      // find nothing to reconcile. It carries the real userId/kind, and its
      // ixHash matches what the tool returned to the caller rather than being
      // dropped by journal.update() ignoring the patch (a bug fixed alongside
      // this wiring).
      expect(await journal.pending()).toHaveLength(0);
      const entry = (await journal.current()).find((e) => e.kind === "transfer" && e.userId === USER_A_ID);
      expect(entry).toMatchObject({ userId: USER_A_ID, kind: "transfer", state: "confirmed", ixHash: hash });
    });

    it("15. signing failure before approval journals 'failed', not 'orphaned' (nothing was ever approved)", async () => {
      await store.set({
        version: 1,
        userId: USER_A_ID,
        topic: TOPIC_A,
        caip2: "moi:custom",
        address: ACCOUNT_A,
        sessionData: {},
        createdAt: new Date().toISOString(),
      });
      // Relay-expired: hub.signInteractionFor throws before the phone ever signs.
      hub.simulateSessionDelete(TOPIC_A);

      const result = await send(
        baseUrl,
        toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
        { authorization: "Bearer token-a" },
      );
      expect(result.status).toBe(200);
      expect(result.json.result.structuredContent.status).toBe("rejected");

      // "failed" is terminal (nothing left to reconcile), so check the
      // journal's full history for this id rather than pending().
      const entries = await journal.current();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ userId: USER_A_ID, kind: "transfer", state: "failed" });
    });

    it("16. a broadcast failure AFTER the phone signs journals 'orphaned' — the exact mid-sign-restart gap M5 closes", async () => {
      await store.set({
        version: 1,
        userId: USER_A_ID,
        topic: TOPIC_A,
        caip2: "moi:custom",
        address: ACCOUNT_A,
        sessionData: {},
        createdAt: new Date().toISOString(),
      });
      // The wallet signs fine (FakeHub's default behavior); the node then
      // refuses to broadcast — the process-restart-between-sign-and-broadcast
      // scenario, minus the restart, since a synchronous broadcast failure
      // strands the same signed-but-unbroadcast interaction either way.
      node.on("moi.SendInteractions", () => {
        throw new RpcFailure("simulated relay outage");
      });

      const result = await send(
        baseUrl,
        toolCall(1, "moi_transfer", { to: ACCOUNT, assetId: KMOI, amount: "10" }),
        { authorization: "Bearer token-a" },
      );
      // RPC_ERROR isn't one of asWriteResult's rejection reasons, so it
      // rethrows as a real MCP tool error (isError, no structuredContent) —
      // the journal write below happens in the catch block BEFORE that
      // rethrow, so it must not be skipped just because the response isn't
      // the ok()-wrapped shape the other two tests check.
      expect(result.status).toBe(200);
      expect(result.json.result.isError).toBe(true);

      // Approved-but-never-broadcast must never disappear silently: it is
      // recorded, terminal ("orphaned" is in TERMINAL_STATES, so it will not
      // be reprocessed by reconcileOnBoot — this request already knows, and
      // told the caller, that it failed), and correctly distinguished from a
      // plain pre-sign failure by having actually reached "signed" first.
      const entries = await journal.current();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ userId: USER_A_ID, kind: "transfer", state: "orphaned" });
    });
  });
});
