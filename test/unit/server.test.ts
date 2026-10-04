/**
 * Hosted transport: the lazy-auth gate over real HTTP, and per-request wallet
 * tool registration. buildHostedApp takes fake auth/store deps, so none of
 * this touches a real OAuth server or WalletConnect relay.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthInfo } from "../../src/auth/index.js";
import { HOSTED_INSTRUCTIONS } from "../../src/instructions.js";
import { WriteJournal } from "../../src/journal.js";
import { toPoloHex, toWireJson, type UnsignedInteraction } from "../../src/moi/ix-builder.js";
import { TOOLS } from "../../src/schema.js";
import { buildHostedApp, GATED, type HostedDeps } from "../../src/server.js";
import { PROGRESS_EVERY_MS } from "../../src/tools/hosted-writes.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import type { StoredWalletSession, WalletSessionStore } from "../../src/wc/store.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { ACCOUNT, KMOI, OTHER, startMockNode, type MockNode } from "../helpers/mock-node.js";

const VALID_TOKEN = "test-token";
const READ_ONLY_TOKEN = "read-only-token";
const AUTH_INFO: AuthInfo = {
  userId: "user-1",
  clientId: "client-1",
  scopes: ["moi:read", "moi:write"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const READ_ONLY_AUTH_INFO: AuthInfo = {
  userId: "user-2",
  clientId: "client-2",
  scopes: ["moi:read"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function fakeAuthenticate(req: { headers: { authorization?: string | string[] | undefined } }): AuthInfo | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === `Bearer ${VALID_TOKEN}`) return AUTH_INFO;
  if (value === `Bearer ${READ_ONLY_TOKEN}`) return READ_ONLY_AUTH_INFO;
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
 * No test in this file exercises a write tool through to signing (those live
 * in hosted-writes.test.ts / hosted-writes-crossuser.test.ts) — this fake
 * only needs to satisfy HostedDeps.hub's type so registerHostedWrites can be
 * wired up for every authenticated request, same as production.
 */
class FakeHub implements WalletConnectHubLike {
  async disconnect(_topic: string): Promise<void> {}

  async pair(): Promise<never> {
    throw new Error("FakeHub does not pair; these tests drive signing only");
  }

  async signMessageFor(): Promise<{ signature: string }> {
    throw new Error("FakeHub.signMessageFor is not exercised by this test file");
  }
  async signInteractionFor(_topic: string, _ix: UnsignedInteraction): Promise<{ ix_args: string; signatures: string }> {
    throw new Error("FakeHub.signInteractionFor is not exercised by this test file");
  }
  onSessionDelete(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

/** A hub whose phone answers only when told to, so a call stays open. */
class HeldHub extends FakeHub {
  private ask!: () => void;
  readonly asked = new Promise<void>((resolve) => (this.ask = resolve));
  tap!: () => void;
  private readonly held = new Promise<void>((resolve) => (this.tap = resolve));
  override async signInteractionFor(_topic: string, ix: UnsignedInteraction): Promise<{ ix_args: string; signatures: string }> {
    this.ask();
    await this.held;
    // An honest phone: the bytes of the interaction it was asked to sign, which the write path checks before it broadcasts.
    return { ix_args: toPoloHex(toWireJson(ix) as never), signatures: "0x" + "2".repeat(128) };
  }
}

function makeDeps(store: WalletSessionStore): HostedDeps {
  return {
    authenticate: fakeAuthenticate,
    challengeHeader: fakeChallengeHeader,
    store,
    hub: new FakeHub(),
    journal: new WriteJournal(tempHome()),
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
  // The transport answers as a single-event SSE stream; a gate rejection
  // (401/400) answers as plain JSON instead. Handle both.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, json };
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("hosted transport", () => {
  let node: MockNode;
  let server: Server;
  let baseUrl: string;
  let store: FakeStore;

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

    const app = buildHostedApp(makeDeps(store));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv();
  });

  it("gates moi_transfer behind auth: 401 with a WWW-Authenticate resource_metadata challenge", async () => {
    const { status, headers, json } = await rpc(baseUrl, toolCall(1, "moi_transfer", { to: ACCOUNT }));
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("resource_metadata");
    expect(json).toEqual({ error: "authorization required" });
  });

  it("hands the model the hosted instructions at initialize, to a caller with no token", async () => {
    const { status, json } = await rpc(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(status).toBe(200);
    expect(json.result.instructions).toBe(HOSTED_INSTRUCTIONS);
  });

  it("lets an unauthenticated caller use ping and moi_get_account", async () => {
    const ping = await rpc(baseUrl, toolCall(1, "ping"));
    expect(ping.status).toBe(200);
    expect(ping.json.result.isError).toBeFalsy();

    const account = await rpc(baseUrl, toolCall(2, "moi_get_account", { address: ACCOUNT }));
    expect(account.status).toBe(200);
    expect(account.json.result.isError).toBeFalsy();
    expect(account.json.result.structuredContent.address).toBe(ACCOUNT);
  });

  it("reports wallet status false, then true after the store is seeded, for an authenticated caller", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };

    const before = await rpc(baseUrl, toolCall(1, "moi_wallet_status"), auth);
    expect(before.status).toBe(200);
    expect(before.json.result.structuredContent).toEqual({ connected: false });

    await store.set({
      version: 1,
      userId: AUTH_INFO.userId,
      topic: "topic-1",
      caip2: "moi:14",
      address: ACCOUNT,
      sessionData: { ok: true },
      createdAt: new Date().toISOString(),
    });

    const after = await rpc(baseUrl, toolCall(2, "moi_wallet_status"), auth);
    expect(after.status).toBe(200);
    expect(after.json.result.structuredContent).toMatchObject({
      connected: true,
      address: ACCOUNT,
      caip2: "moi:14",
    });
  });

  it("still 401s an unauthenticated moi_wallet_status call", async () => {
    const { status, json } = await rpc(baseUrl, toolCall(1, "moi_wallet_status"));
    expect(status).toBe(401);
    expect(json).toEqual({ error: "authorization required" });
  });

  it("403s a moi:read-only token calling moi_connect_wallet, with an insufficient_scope challenge", async () => {
    const auth = { authorization: `Bearer ${READ_ONLY_TOKEN}` };
    const { status, headers, json } = await rpc(baseUrl, toolCall(1, "moi_connect_wallet"), auth);
    expect(status).toBe(403);
    expect(headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(headers.get("www-authenticate")).toContain('scope="moi:write"');
    expect(json).toEqual({ error: "insufficient_scope", error_description: "This action requires the 'moi:write' scope." });
  });

  it("403s a moi:read-only token calling moi_disconnect_wallet and moi_transfer", async () => {
    const auth = { authorization: `Bearer ${READ_ONLY_TOKEN}` };
    const disconnect = await rpc(baseUrl, toolCall(1, "moi_disconnect_wallet"), auth);
    expect(disconnect.status).toBe(403);

    const transfer = await rpc(baseUrl, toolCall(2, "moi_transfer", { to: ACCOUNT }), auth);
    expect(transfer.status).toBe(403);
  });

  it("still lets a moi:read-only token call moi_wallet_status", async () => {
    const auth = { authorization: `Bearer ${READ_ONLY_TOKEN}` };
    const { status, json } = await rpc(baseUrl, toolCall(1, "moi_wallet_status"), auth);
    expect(status).toBe(200);
    expect(json.result.structuredContent).toEqual({ connected: false });
  });

  it("lets a full-scope token call moi_connect_wallet", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };
    const { status, json } = await rpc(baseUrl, toolCall(1, "moi_connect_wallet"), auth);
    expect(status).toBe(200);
    expect(json.result.isError).toBeFalsy();
  });

  it("answers with the QR image and the pairing page link, keeping the raw wc: string out of the chat text", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };
    const { json } = await rpc(baseUrl, toolCall(1, "moi_connect_wallet"), auth);
    const content = json.result.content as Array<{ type: string; mimeType?: string; data?: string; text?: string }>;

    const image = content.find((c) => c.type === "image");
    expect(image?.mimeType).toBe("image/png");
    // A real PNG, not an empty placeholder.
    expect(Buffer.from(image?.data ?? "", "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const text = content.find((c) => c.type === "text")?.text ?? "";
    // The image is the instruction where it renders. claude.ai never shows it
    // to the person and hides structuredContent from its model, so the text
    // must carry an https link to the pairing page, and must not carry the
    // wc: string, which is noise next to a code and a secret in a transcript.
    expect(text).not.toContain("wc:");
    expect(text).toMatch(/scan this qr code/i);
    expect(text).toContain("https://example.test/pair/");
    expect(json.result.structuredContent.pairingUrl).toMatch(/^https:\/\/example\.test\/pair\//);
    expect(json.result.structuredContent.uri).toContain("wc:");
    expect(json.result.structuredContent.mode).toBe("persistent");
  });

  it("forgets the pairing after one use when the user asks not to be remembered", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };
    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "moi_connect_wallet", arguments: { remember: false } },
    };
    const { json } = await rpc(baseUrl, body, auth);
    expect(json.result.structuredContent.mode).toBe("once");
  });

  // The in-memory transports the tool tests use ignore which stream a notification goes out on, so this is the one place
  // that shows the notice reaches the confirm call's own response stream, the only one a stateless request has.
  it("puts the notice on the confirm call's own stream while the phone is pending", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };
    await store.set({
      version: 1,
      userId: AUTH_INFO.userId,
      topic: "topic-1",
      caip2: "moi:custom",
      address: ACCOUNT,
      sessionData: {},
      createdAt: new Date().toISOString(),
    });
    // Its own app, because the one above has a hub that is never asked.
    const hub = new HeldHub();
    const held = createServer(buildHostedApp({ ...makeDeps(store), hub }));
    await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(held.address() as AddressInfo).port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const args = { to: OTHER, assetId: KMOI, amount: "1" };
      const preview = await rpc(url, toolCall(1, "moi_transfer", args), auth);
      const confirm = preview.json.result.structuredContent.confirm as string;
      expect(confirm).toBeTruthy();

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      // Not awaited: the response headers may not leave until the first frame does.
      const pending = fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "moi_transfer", arguments: { ...args, confirm }, _meta: { progressToken: "tok-1" } },
        }),
      });
      await hub.asked;
      await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS);

      const res = await pending;
      expect(res.status).toBe(200);
      reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      // Whole events only, and only their data lines: the SDK also writes a keep-alive comment on the same 15 second beat.
      const frames = () =>
        text
          .split("\n\n")
          .slice(0, -1)
          .flatMap((event) =>
            event
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice("data: ".length))),
          );
      const readUntil = async (done: () => boolean) => {
        while (!done()) {
          const chunk = await reader!.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      };

      await readUntil(() => frames().some((f) => f.method === "notifications/progress"));
      expect(frames().find((f) => f.method === "notifications/progress")).toEqual({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "tok-1",
          progress: 15,
          message: "Still waiting for your approval in MOI Wallet (15 s). Nothing is sent until you approve.",
        },
      });
      // The phone has not answered, so nothing but the notice has come back yet.
      expect(frames().some((f) => f.id === 2)).toBe(false);

      hub.tap();
      await readUntil(() => frames().some((f) => f.id === 2));
      expect(frames().find((f) => f.id === 2).result.structuredContent.status).toBe("sent");
    } finally {
      vi.useRealTimers();
      await reader?.cancel().catch(() => {});
      held.closeAllConnections();
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  it("GATED covers every wallet tool and every write tool in the schema's TOOLS manifest", () => {
    const gated = GATED as readonly string[];
    const writeTools = Object.entries(TOOLS)
      .filter(([, def]) => def.write)
      .map(([name]) => name);
    const walletTools = ["moi_connect_wallet", "moi_wallet_status", "moi_disconnect_wallet"];

    for (const name of [...writeTools, ...walletTools]) {
      expect(gated, `GATED must include ${name}`).toContain(name);
    }
  });
});
