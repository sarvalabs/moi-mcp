/**
 * The first review round's findings (sarvalabs/moi-mcp#4), each pinned.
 *
 * 1. The rate limiter must not key on the client-written front of
 *    X-Forwarded-For; rotating it per request turned the limiter off.
 * 2. A journal failure after the phone signed must land as "orphaned",
 *    never "failed"; and nothing after a successful broadcast may turn
 *    that success into an error the caller sees.
 * 3. DELETE on /mcp goes through the same limiter as GET and POST.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientAddress, rateLimit } from "../../src/auth/rate-limit.js";
import { buildHostedApp, type HostedDeps } from "../../src/server.js";
import { KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";
import { applyEnv, fakeWallet, installWallet, restoreEnv, startHarness, tempHome, type Harness } from "../helpers/harness.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, send, session, structured, USER } from "../helpers/hosted.js";

describe("clientAddress", () => {
  it("keys a remote connection on the socket and ignores the header entirely", () => {
    expect(clientAddress("203.0.113.9", "1.1.1.1, 2.2.2.2")).toBe("203.0.113.9");
  });

  it("keys a local-proxy connection on the LAST header entry, the one the proxy appended", () => {
    expect(clientAddress("127.0.0.1", "9.9.9.9, 203.0.113.9")).toBe("203.0.113.9");
    expect(clientAddress("::1", "203.0.113.9")).toBe("203.0.113.9");
    expect(clientAddress("::ffff:127.0.0.1", ["9.9.9.9", "203.0.113.9"])).toBe("203.0.113.9");
  });

  it("falls back to the socket when a local connection carries no header", () => {
    expect(clientAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(clientAddress(undefined, undefined)).toBe("unknown");
  });
});

describe("the limiter survives a rotating X-Forwarded-For", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("rotating the client-written front no longer mints fresh buckets", async () => {
    const app = express();
    app.post("/x", rateLimit({ windowMs: 60_000, max: 2 }), (_req, res) => res.json({ ok: true }));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The test connects from loopback, exactly like a request arriving
    // through the local nginx: the rightmost entry is the appended, real
    // address, and everything left of it is attacker-writable.
    const as = (fwd: string) => fetch(`${base}/x`, { method: "POST", headers: { "x-forwarded-for": fwd } });
    expect((await as("6.6.6.1, 203.0.113.9")).status).toBe(200);
    expect((await as("6.6.6.2, 203.0.113.9")).status).toBe(200);
    const third = await as("6.6.6.3, 203.0.113.9");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different appended address is genuinely a different client.
    expect((await as("6.6.6.4, 203.0.113.10")).status).toBe(200);
  });
});

describe("write-path bookkeeping failures", () => {
  let node: MockNode;
  let h: Harness;
  const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };
  const soon = () => Math.floor(Date.now() / 1000) + 600;

  beforeEach(async () => {
    node = await startMockNode();
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());
  });

  afterEach(async () => {
    await h.close();
    await node.close();
  });

  it("a journal failure AFTER the phone signed lands as orphaned, never failed", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const journal = fakeJournal();
    journal.update.mockImplementation(async (_id: string, state: string) => {
      if (state === "signed") throw new Error("disk full");
    });
    const client = await connect(deps(store, hub, journal));

    const result = await send(client, "moi_transfer", TRANSFER);

    expect(result.isError).toBe(true);
    const states = journal.update.mock.calls.map((c) => c[1]);
    expect(states).toContain("orphaned");
    expect(states).not.toContain("failed");
    // The signature exists but the broadcast never ran.
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("a store failure while forgetting a once-pairing does not turn a landed transaction into an error", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: soon() })]]);
    const store = fakeStore(records);
    (store.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("redis down");
    });
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal));

    const out = structured<{ status?: string; hash?: string }>(await send(client, "moi_transfer", TRANSFER));

    expect(out.status).toBe("sent");
    expect(out.hash).toBe(SENT_HASH);
    // The failure is logged and swallowed; the journal still finishes.
    const states = journal.update.mock.calls.map((c) => c[1]);
    expect(states).toContain("broadcast");
    expect(states).toContain("confirmed");
    expect(states).not.toContain("orphaned");
  });

  it("a journal failure after broadcast still reports the success", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const journal = fakeJournal();
    journal.update.mockImplementation(async (_id: string, state: string) => {
      if (state === "broadcast") throw new Error("disk full");
    });
    const client = await connect(deps(store, hub, journal));

    const out = structured<{ status?: string; hash?: string }>(await send(client, "moi_transfer", TRANSFER));
    expect(out.status).toBe("sent");
    expect(out.hash).toBe(SENT_HASH);
  });
});

describe("DELETE on /mcp is rate limited like everything else", () => {
  let node: MockNode;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    node = await startMockNode();
    applyEnv(node.url, tempHome());
    const hosted: HostedDeps = {
      authenticate: () => undefined,
      challengeHeader: () => 'Bearer resource_metadata="x"',
      store: fakeStore(new Map()),
      hub: fakeHub(),
      journal: fakeJournal(),
      resolveUriMounted: false,
      createPairingLink: (userId: string) => ({ url: `https://example.test/pair/${userId}`, expiresAt: Date.now() + 60_000 }),
      startPairing: async () => ({ uri: "wc:x@2", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
    } as unknown as HostedDeps;
    server = createServer(buildHostedApp(hosted));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    restoreEnv();
    await node.close();
  });

  it("the 241st DELETE in a minute is refused", async () => {
    let last = 0;
    for (let i = 0; i < 241; i++) {
      const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
      last = res.status;
      if (i === 0) expect(res.status).not.toBe(429);
    }
    expect(last).toBe(429);
  }, 30_000);
});
