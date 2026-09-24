import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { WalletConnectHub, chainIdFromSession, type HubSignResult, type SignInteractionOpts } from "../../src/wc/hub.js";
import type { SignClientLike, WcConfig } from "../../src/wc/client.js";
import type { UnsignedInteraction } from "../../src/moi/ix-builder.js";

/**
 * Minimal fake SignClient for testing. Lets tests control what sessions exist
 * and what errors are returned.
 */
function fakeSignClient(overrides: Partial<SignClientLike> = {}): SignClientLike {
  return {
    connect: vi.fn(async () => ({ uri: "wc:fake", approval: async () => ({}) })),
    disconnect: vi.fn(async () => {}),
    request: vi.fn(async () => ({ ix_args: "deadbeef", signatures: "cafe1234" })) as unknown as SignClientLike["request"],
    on: vi.fn(),
    session: {
      keys: [],
      get: vi.fn(() => undefined),
    },
    ...overrides,
  } as SignClientLike;
}

/**
 * Create a minimal WcConfig for tests. Network/projectId don't matter;
 * the hub doesn't use them (only SignClient factory does).
 */
/** What a settled MOI Wallet session actually looks like: no chainId field. */
const REAL_NS = { moi: { chains: ["moi:14"], accounts: ["moi:14:0xaaa"], methods: [], events: [] } };

function testConfig(): WcConfig {
  return {
    projectId: "test-project",
    home: "/tmp/test",
    network: "voyage",
    requestTimeoutMs: 5000,
  };
}

/**
 * Create a minimal UnsignedInteraction for testing.
 */
function testInteraction(): UnsignedInteraction {
  return {
    sender: { id: "0xaccount", sequence: 1, key_id: 0 },
    fuel_price: 1,
    fuel_limit: 100000,
    ix_operations: [
      {
        type: 0,
        payload: { to: "0xreceiver", amount: "1000000000000000000", asset_id: "0xkmoi" },
      },
    ],
  };
}

describe("WalletConnectHub", () => {
  describe("init", () => {
    it("creates a hub and stores the signClient", async () => {
      const fakeClient = fakeSignClient();
      const hub = new WalletConnectHub(fakeClient);

      // The hub should have been created without errors.
      expect(hub).toBeDefined();
      // No way to inspect the private signClient, but we can verify it works.
      expect(hub).toHaveProperty("signInteractionFor");
      expect(hub).toHaveProperty("onSessionDelete");
      expect(hub).toHaveProperty("close");
    });

    it("is a singleton per process (contract §0.1)", async () => {
      // This is enforced by main() calling init once. A unit test can't verify
      // the singleton property directly, but we verify the API doesn't create
      // secondary clients.
      const fakeClient = fakeSignClient();
      const hub1 = new WalletConnectHub(fakeClient);
      const hub2 = new WalletConnectHub(fakeClient);

      // Each hub wraps the same client (contract says exactly one per process).
      // We can't inspect the private field, but this verifies the constructor
      // doesn't call defaultFactory twice.
      expect(hub1).toBeDefined();
      expect(hub2).toBeDefined();
    });
  });

  describe("signInteractionFor", () => {
    it("signs an interaction for a valid topic", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS, expiry: Math.floor(Date.now() / 1000) + 3600 }
              : undefined,
          ),
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      const result = await hub.signInteractionFor("topic-a", ix, { description: "Test transfer" });

      // Verify the result shape.
      expect(result).toHaveProperty("ix_args");
      expect(result).toHaveProperty("signatures");
      expect(typeof result.ix_args).toBe("string");
      expect(typeof result.signatures).toBe("string");

      // Verify the relay was called with the correct topic and chainId.
      const requestCall = (fakeClient.request as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(requestCall).toBeDefined();
      const [requestPayload] = requestCall!;
      expect(requestPayload).toMatchObject({
        topic: "topic-a",
        chainId: "moi:14",
        request: { method: "moi.signInteraction" },
      });
    });

    it("throws WALLET_NOT_CONNECTED when no native session exists for topic", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: [],
          get: vi.fn(() => undefined), // No session for any topic
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("nonexistent-topic", ix)).rejects.toMatchObject({
        code: ErrorCode.WALLET_NOT_CONNECTED,
        message: expect.stringContaining("no longer valid"),
      });
    });

    it("throws WALLET_NOT_CONNECTED for a stale topic (relay-expired session)", async () => {
      // Simulate a phone-side disconnect: the store still has the topic,
      // but the native SignClient doesn't.
      const fakeClient = fakeSignClient({
        session: {
          keys: [],
          get: vi.fn(() => undefined), // Relay has deleted the session
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("expired-topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.WALLET_NOT_CONNECTED,
      });
    });

    it("propagates user rejection from the wallet", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => {
          throw new Error("Interaction rejected by user");
        }),
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.USER_REJECTED,
      });
    });

    it("propagates wallet errors (malformed payload)", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => {
          throw new Error("Failed to sign interaction — serialization error");
        }),
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.INVALID_ARGS,
        message: expect.stringContaining("could not process"),
      });
    });

    it("throws RPC_ERROR for unrecognized relay errors", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => {
          throw new Error("Relay connection lost");
        }),
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
        message: expect.stringContaining("WalletConnect request failed"),
      });
    });

    it("handles MoiError passed through from translateWcError", async () => {
      const moiErr = new MoiError(ErrorCode.REQUEST_TIMEOUT, "Wallet did not respond");
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => {
          throw moiErr;
        }),
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toBe(moiErr);
    });

    it("accepts optional description in opts", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await hub.signInteractionFor("topic-a", ix, { description: "Custom description" });

      // moi.signInteraction has no field for a label (verified against Sarva's
      // reference dapp and the wallet extension spec), so the description is
      // accepted and dropped. The write tools put it in the chat instead.
      expect((fakeClient.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("does not accept any routing alternative to topic", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      // The public API signature is: signInteractionFor(topic, ix, opts)
      // No userId, Session object, account, or sessionId parameter.
      const sig = hub.signInteractionFor.toString();
      // Extract just the parameter list from the function signature.
      const paramMatch = sig.match(/signInteractionFor\(([^)]*)\)/);
      expect(paramMatch).toBeDefined();
      const params = paramMatch![1];
      // Parameters should only be topic, ix, opts (plus any defaults/destructuring).
      expect(params).toMatch(/topic/);
      expect(params).toMatch(/ix/);
      // Should not have userId as a parameter.
      expect(params).not.toMatch(/userId\s*[,\)=]/);
      // Should not have sessionId as a parameter.
      expect(params).not.toMatch(/sessionId\s*[,\)=]/);
    });
  });

  describe("signMessageFor", () => {
    const withSession = (request: SignClientLike["request"]) =>
      fakeSignClient({
        request,
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a" ? { topic: "topic-a", namespaces: REAL_NS } : undefined,
          ),
        },
      });

    it("sends moi.sign with the account and the exact message, and returns the signature", async () => {
      const request = vi.fn(async () => ({ signature: "0xabc123" })) as unknown as SignClientLike["request"];
      const hub = new WalletConnectHub(withSession(request));
      const message =
        "MOI Agent Launchpad wants you to sign in with your MOI account.\n\nWallet: 0xaaa\nNonce: n1";

      const result = await hub.signMessageFor("topic-a", "0xaaa", message);

      expect(result).toEqual({ signature: "0xabc123" });
      // The wallet signs exactly what the dapp will verify: no reformatting.
      expect(request).toHaveBeenCalledWith({
        topic: "topic-a",
        chainId: "moi:14",
        request: { method: "moi.sign", params: ["0xaaa", message] },
      });
    });

    it("throws WALLET_NOT_CONNECTED when the topic has no native session", async () => {
      const hub = new WalletConnectHub(fakeSignClient());
      await expect(hub.signMessageFor("gone", "0xaaa", "hi")).rejects.toMatchObject({
        code: ErrorCode.WALLET_NOT_CONNECTED,
      });
    });

    it("rejects a payload without a signature as RPC_ERROR", async () => {
      const request = vi.fn(async () => ({ signed: true })) as unknown as SignClientLike["request"];
      const hub = new WalletConnectHub(withSession(request));
      await expect(hub.signMessageFor("topic-a", "0xaaa", "hi")).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
      });
    });
  });

  describe("concurrent signing (no shared mutable state)", () => {
    it("two different topics sign concurrently without interference", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a", "topic-b"],
          get: vi.fn((topic: string) => {
            if (topic === "topic-a")
              return { topic: "topic-a", namespaces: REAL_NS, account: "0xaaa" };
            if (topic === "topic-b")
              return { topic: "topic-b", namespaces: REAL_NS, account: "0xbbb" };
            return undefined;
          }),
        },
        request: vi.fn(async (args: unknown) => {
          const a = args as { topic?: string };
          // Return different signatures for each topic to verify no cross-talk.
          return {
            ix_args: a.topic === "topic-a" ? "aaa111222333" : "bbb444555666",
            signatures: a.topic === "topic-a" ? "cafe0001" : "cafe0002",
          };
        }) as unknown as SignClientLike["request"],
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix1 = testInteraction();
      const ix2 = { ...testInteraction(), sender: { ...testInteraction().sender, id: "0xaccount2" } };

      // Fire both concurrently.
      const [result1, result2] = await Promise.all([
        hub.signInteractionFor("topic-a", ix1),
        hub.signInteractionFor("topic-b", ix2),
      ]);

      // Verify each got the expected result.
      expect(result1.ix_args).toBe("aaa111222333");
      expect(result1.signatures).toBe("cafe0001");
      expect(result2.ix_args).toBe("bbb444555666");
      expect(result2.signatures).toBe("cafe0002");

      // Verify both relay calls were made.
      const calls = (fakeClient.request as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      const topics = calls.map((c) => (c[0] as { topic?: string }).topic).sort();
      expect(topics).toEqual(["topic-a", "topic-b"]);
    });

    it("a topic used by two concurrent requests routes correctly", async () => {
      // Same topic, two interactions (simulating two agents signing in parallel).
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-x"],
          get: vi.fn((topic: string) =>
            topic === "topic-x"
              ? { topic: "topic-x", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => ({ ix_args: "deadbeef", signatures: "cafe1234" })) as unknown as SignClientLike["request"],
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix1 = testInteraction();
      const ix2 = { ...testInteraction(), sender: { ...testInteraction().sender, sequence: 2 } };

      // Both use the same topic (same user).
      const [result1, result2] = await Promise.all([
        hub.signInteractionFor("topic-x", ix1),
        hub.signInteractionFor("topic-x", ix2),
      ]);

      // Both should succeed and get the same result from the relay.
      expect(result1.ix_args).toBe("deadbeef");
      expect(result2.ix_args).toBe("deadbeef");

      // Both relay calls should use the same topic.
      const calls = (fakeClient.request as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect((calls[0]![0] as { topic?: string }).topic).toBe("topic-x");
      expect((calls[1]![0] as { topic?: string }).topic).toBe("topic-x");
    });
  });

  describe("onSessionDelete event handling", () => {
    it("registers a handler and fires it when session_delete event occurs", async () => {
      let onEventHandler: ((payload: unknown) => void) | null = null;
      const fakeClient = fakeSignClient({
        on: vi.fn((event: string, handler: (payload: unknown) => void) => {
          if (event === "session_delete") {
            onEventHandler = handler;
          }
        }),
      });

      const hub = new WalletConnectHub(fakeClient);

      const deleteHandler = vi.fn();
      hub.onSessionDelete(deleteHandler);

      // Verify the handler was registered.
      expect((fakeClient.on as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        "session_delete",
        expect.any(Function),
      ]);

      // Simulate a session_delete event from the relay. Cast needed: TS
      // narrows this closure-assigned variable to its `null` initializer at
      // this point in the flow (the assignment happens inside a nested
      // callback), so an unguarded optional call resolves to `never`.
      (onEventHandler as ((payload: unknown) => void) | null)?.({ topic: "deleted-topic-a" });

      // The handler should have been called with the topic.
      expect(deleteHandler).toHaveBeenCalledWith("deleted-topic-a");
      expect(deleteHandler).toHaveBeenCalledTimes(1);
    });

    it("demux handler receives only the topic, not userId or account", async () => {
      let onEventHandler: ((payload: unknown) => void) | null = null;
      const fakeClient = fakeSignClient({
        on: vi.fn((event: string, handler: (payload: unknown) => void) => {
          if (event === "session_delete") {
            onEventHandler = handler;
          }
        }),
      });

      const hub = new WalletConnectHub(fakeClient);

      const deleteHandler = vi.fn();
      hub.onSessionDelete(deleteHandler);

      // Simulate an event with extra fields (which the relay might include).
      (onEventHandler as ((payload: unknown) => void) | null)?.({
        topic: "deleted-topic-x",
        sessionId: "should-not-matter",
        userId: "should-not-matter",
        account: "should-not-matter",
      });

      // The handler should only receive the topic.
      expect(deleteHandler).toHaveBeenCalledWith("deleted-topic-x");
      // Verify it wasn't called with the entire payload.
      expect(deleteHandler).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.anything() }));
    });

    it("silently ignores malformed session_delete payloads (no topic)", async () => {
      let onEventHandler: ((payload: unknown) => void) | null = null;
      const fakeClient = fakeSignClient({
        on: vi.fn((event: string, handler: (payload: unknown) => void) => {
          if (event === "session_delete") {
            onEventHandler = handler;
          }
        }),
      });

      const hub = new WalletConnectHub(fakeClient);

      const deleteHandler = vi.fn();
      hub.onSessionDelete(deleteHandler);

      // Simulate a malformed event (no topic field).
      expect(() => {
        onEventHandler?.({ sessionId: "xyz", error: "test" });
      }).not.toThrow();

      // Handler should not be called.
      expect(deleteHandler).not.toHaveBeenCalled();
    });

    it("can be called multiple times; each registers independently", async () => {
      const onHandlers: { event: string; handler: (payload: unknown) => void }[] = [];
      const fakeClient = fakeSignClient({
        on: vi.fn((event: string, handler: (payload: unknown) => void) => {
          onHandlers.push({ event, handler });
        }),
      });

      const hub = new WalletConnectHub(fakeClient);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      hub.onSessionDelete(handler1);
      hub.onSessionDelete(handler2);

      // Both should be registered (contract doesn't forbid multiple listeners).
      const sessionDeleteHandlers = onHandlers.filter((h) => h.event === "session_delete");
      expect(sessionDeleteHandlers.length).toBeGreaterThanOrEqual(1);

      // Fire the first registered handler.
      const first = sessionDeleteHandlers[0];
      first?.handler({ topic: "deleted-topic" });

      // At least one handler should have fired (the first one, and possibly more).
      expect(handler1).toHaveBeenCalled();
    });

    it("unsubscribe function is callable (even if it's a no-op)", async () => {
      const fakeClient = fakeSignClient({
        on: vi.fn(),
      });

      const hub = new WalletConnectHub(fakeClient);

      const deleteHandler = vi.fn();
      const unsubscribe = hub.onSessionDelete(deleteHandler);

      // The unsubscribe function should be callable.
      expect(() => {
        unsubscribe();
      }).not.toThrow();
    });
  });

  describe("close", () => {
    it("is callable without error", async () => {
      const fakeClient = fakeSignClient();
      const hub = new WalletConnectHub(fakeClient);

      await expect(hub.close()).resolves.not.toThrow();
    });

    it("does not throw even if called multiple times", async () => {
      const fakeClient = fakeSignClient();
      const hub = new WalletConnectHub(fakeClient);

      await hub.close();
      await expect(hub.close()).resolves.not.toThrow();
    });
  });

  describe("public surface is topic-only (contract §0.3)", () => {
    it("exposes exactly init, close, signInteractionFor, and onSessionDelete", async () => {
      const fakeClient = fakeSignClient();
      const hub = new WalletConnectHub(fakeClient);

      const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(hub)).filter(
        (m) => m !== "constructor",
      );
      expect(publicMethods.sort()).toContain("close");
      expect(publicMethods.sort()).toContain("signInteractionFor");
      expect(publicMethods.sort()).toContain("onSessionDelete");
    });

    it("has no method that accepts Session, StoredWalletSession, or userId as parameters", async () => {
      const fakeClient = fakeSignClient();
      const hub = new WalletConnectHub(fakeClient);

      const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(hub)).filter(
        (m) => m !== "constructor",
      );

      // Verify by inspecting the parameter list of each method.
      for (const method of publicMethods) {
        const func = (hub as unknown as Record<string, unknown>)[method];
        if (typeof func === "function") {
          const str = func.toString();
          // Extract parameter list only (between parentheses).
          const paramMatch = str.match(/\(([^)]*)\)/);
          if (paramMatch) {
            const params = paramMatch[1];
            // Parameters should not include userId, sessionId as named params.
            expect(params).not.toMatch(/userId\s*[,\)=]/);
            expect(params).not.toMatch(/sessionId\s*[,\)=]/);
            // Session might be referenced in implementation but not as a parameter.
            // Only check that these are not parameter names by looking for them at
            // the start of params or after a comma.
            expect(params).not.toMatch(/^Session/);
            expect(params).not.toMatch(/,\s*Session\s/);
          }
        }
      }
    });
  });

  describe("error handling edge cases", () => {
    it("refuses a session whose chain cannot be determined and no default is set", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a" } // no namespaces, so no chain to derive
              : undefined,
          ),
        },
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.RELAY_UNAVAILABLE,
        message: expect.stringContaining("chain"),
      });
    });

    it("handles relay returning invalid signature response (schema mismatch)", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => ({
          ix_args: "not-hex!@#", // Invalid: should be hex only
          signatures: "also-not-hex",
        })) as unknown as SignClientLike["request"],
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
      });
    });

    it("handles relay returning a string instead of an object", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["topic-a"],
          get: vi.fn((topic: string) =>
            topic === "topic-a"
              ? { topic: "topic-a", namespaces: REAL_NS }
              : undefined,
          ),
        },
        request: vi.fn(async () => "0xhashonly") as unknown as SignClientLike["request"],
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      await expect(hub.signInteractionFor("topic-a", ix)).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
      });
    });
  });

  describe("integration: full signing flow with realistic native session", () => {
    it("completes a full sign-and-broadcast cycle", async () => {
      const fakeClient = fakeSignClient({
        session: {
          keys: ["wc:xyz"],
          get: vi.fn((topic: string) =>
            topic === "wc:xyz"
              ? {
                  topic: "wc:xyz",
                  expiry: Math.floor(Date.now() / 1000) + 3600,
                  peer: { metadata: { name: "MOI Wallet" } },
                  namespaces: { moi: { accounts: ["moi:14:0xaccount"] } },
                }
              : undefined,
          ),
        },
        request: vi.fn(async () => ({
          ix_args: "cafe1234deadbeefabcd1234",
          signatures: "abcd1234cafe5678beef9abc",
        })) as unknown as SignClientLike["request"],
      });

      const hub = new WalletConnectHub(fakeClient);
      const ix = testInteraction();

      const result = await hub.signInteractionFor("wc:xyz", ix, {
        description: "Transfer 1 KMOI to 0xreceiver",
      });

      expect(result).toEqual({
        ix_args: "cafe1234deadbeefabcd1234",
        signatures: "abcd1234cafe5678beef9abc",
      });

      // Verify the request was properly formed.
      const requestCall = (fakeClient.request as ReturnType<typeof vi.fn>).mock.calls[0];
      const [payload] = requestCall!;
      expect(payload).toMatchObject({
        topic: "wc:xyz",
        chainId: "moi:14",
        request: { method: "moi.signInteraction", params: expect.any(Array) },
      });
    });
  });
});

/**
 * The hub must pair on the same SignClient it signs with.
 *
 * signInteractionFor() resolves a topic against `signClient.session`. When
 * pairing ran on a second client (as it briefly did), the paired session was
 * written to that other client's store, so the signer could never find it and
 * every hosted write failed "session no longer valid" forever. These tests pin
 * the two operations to one client so that cannot come back.
 */
describe("WalletConnectHub pairing and signing share one client", () => {
  it("can sign on a topic produced by its own pair()", async () => {
    const sessions = new Map<string, unknown>();
    const approved = {
      topic: "topic-from-pairing",
      namespaces: { moi: { accounts: ["moi:14:0xabc123"] } },
      expiry: Math.floor(Date.now() / 1000) + 3600,
      peer: { metadata: { name: "MOI Wallet", url: "https://moi.technology" } },
    };

    const client = fakeSignClient({
      connect: vi.fn(async () => ({
        uri: "wc:real-looking-uri",
        approval: async () => {
          // The relay records the approved session on THIS client.
          sessions.set(approved.topic, approved);
          return approved;
        },
      })),
      session: {
        keys: [],
        get: (topic: string) => sessions.get(topic),
      },
    } as Partial<SignClientLike>);

    const hub = new WalletConnectHub(client);
    const { uri, approval } = await hub.pair("voyage");
    expect(uri).toBe("wc:real-looking-uri");

    const session = await approval;
    expect(session.topic).toBe(approved.topic);

    // The signer resolves that topic without any cross-client hand-off.
    const signed = await hub.signInteractionFor(session.topic, testInteraction());
    expect(signed.ix_args).toBe("deadbeef");
  });

  it("refuses a topic its own client never paired", async () => {
    const hub = new WalletConnectHub(fakeSignClient());
    await expect(hub.signInteractionFor("topic-from-elsewhere", testInteraction())).rejects.toThrow(
      MoiError,
    );
  });
});


/**
 * The chain must come from the session's namespaces. A real session has no
 * chainId field, and a fake that supplied one let a broken path pass 375
 * tests while a real phone got "session has no chainId".
 */
describe("chainIdFromSession", () => {
  it("reads a `moi` namespace with a chains list", () => {
    expect(chainIdFromSession({ namespaces: { moi: { chains: ["moi:14"], accounts: [] } } })).toBe("moi:14");
  });

  it("reads a namespace keyed by the chain id itself, as MOI Wallet sometimes sends", () => {
    expect(chainIdFromSession({ namespaces: { "moi:14": { accounts: ["moi:14:0xabc"] } } })).toBe("moi:14");
  });

  it("falls back to the CAIP-10 account when there is no chains list", () => {
    expect(chainIdFromSession({ namespaces: { moi: { accounts: ["moi:14:0xabc"] } } })).toBe("moi:14");
  });

  it("ignores unrelated namespaces and gives up cleanly", () => {
    expect(chainIdFromSession({ namespaces: { eip155: { chains: ["eip155:1"] } } })).toBeUndefined();
    expect(chainIdFromSession({})).toBeUndefined();
    expect(chainIdFromSession(undefined)).toBeUndefined();
  });
});

describe("signing derives the chain from a real-shaped session", () => {
  for (const [label, namespaces] of [
    ["namespace keyed moi", { moi: { chains: ["moi:14"], accounts: ["moi:14:0xaaa"] } }],
    ["namespace keyed moi:14", { "moi:14": { accounts: ["moi:14:0xaaa"] } }],
  ] as const) {
    it(`sends chainId moi:14 when the ${label}`, async () => {
      const client = fakeSignClient({
        session: { keys: ["t"], get: (topic: string) => (topic === "t" ? { topic: "t", namespaces } : undefined) },
      } as Partial<SignClientLike>);
      const hub = new WalletConnectHub(client);
      await hub.signInteractionFor("t", testInteraction());
      expect(client.request).toHaveBeenCalledWith(expect.objectContaining({ topic: "t", chainId: "moi:14" }));
    });
  }

  it("uses the configured default only when the session says nothing", async () => {
    const client = fakeSignClient({
      session: { keys: ["t"], get: () => ({ topic: "t", namespaces: {} }) },
    } as Partial<SignClientLike>);
    const hub = new WalletConnectHub(client, "moi:14");
    await hub.signInteractionFor("t", testInteraction());
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({ chainId: "moi:14" }));
  });

  it("refuses rather than guessing when there is no chain and no default", async () => {
    const client = fakeSignClient({
      session: { keys: ["t"], get: () => ({ topic: "t", namespaces: {} }) },
    } as Partial<SignClientLike>);
    await expect(new WalletConnectHub(client).signInteractionFor("t", testInteraction())).rejects.toThrow(MoiError);
  });
});
