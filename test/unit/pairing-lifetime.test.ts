/**
 * Pairing lifetimes: the person picks how long a pairing lives when asked in the chat (once, day or week), and the
 * server honours it.
 *
 * None of this protects funds; every transaction still needs the phone. What it bounds is how long a stale
 * server-side record can raise prompts on someone's phone, which is the actual exposure of a stolen cookie.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPairingModule } from "../../src/pairing/index.js";
import { makeStartPairing } from "../../src/server.js";
import {
  DAY_TTL_SECONDS,
  expiresAtOf,
  expiryFor,
  isExpired,
  lifetimeOfMode,
  modeOfLifetime,
  ONCE_TTL_SECONDS,
  PAIRING_MODES,
  PERSISTENT_TTL_SECONDS,
} from "../../src/wc/lifetime.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import { FileWalletSessionStore, type StoredWalletSession } from "../../src/wc/store.js";
import { fakeHub, fakeJournal, fakeStore } from "../helpers/hosted.js";

const NOW = 1_700_000_000;

function record(over: Partial<StoredWalletSession> = {}): StoredWalletSession {
  return {
    version: 1,
    userId: "u1",
    topic: "t1",
    caip2: "moi:14",
    address: "0xabc",
    sessionData: {},
    createdAt: new Date(NOW * 1000).toISOString(),
    ...over,
  };
}

describe("lifetime arithmetic", () => {
  it("gives each lifetime its time", () => {
    expect(expiryFor("persistent", NOW)).toBe(NOW + PERSISTENT_TTL_SECONDS);
    expect(expiryFor("day", NOW)).toBe(NOW + DAY_TTL_SECONDS);
    expect(expiryFor("once", NOW)).toBe(NOW + ONCE_TTL_SECONDS);
    expect(PERSISTENT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(DAY_TTL_SECONDS).toBe(24 * 60 * 60);
    expect(ONCE_TTL_SECONDS).toBe(15 * 60);
  });

  it("maps the tool's three words to stored modes and back", () => {
    expect(modeOfLifetime("once")).toBe("once");
    expect(modeOfLifetime("day")).toBe("day");
    expect(modeOfLifetime("week")).toBe("persistent");
    expect(lifetimeOfMode("once")).toBe("once");
    expect(lifetimeOfMode("day")).toBe("day");
    expect(lifetimeOfMode("persistent")).toBe("week");
    // A record from before lifetimes existed has no mode and was a week.
    expect(lifetimeOfMode(undefined)).toBe("week");
  });

  it("stores exactly three modes, so a record from before this change still parses", () => {
    expect([...PAIRING_MODES].sort()).toEqual(["day", "once", "persistent"]);
  });

  it("expires exactly at the boundary, not before", () => {
    const r = record({ expiresAt: NOW + 10 });
    expect(isExpired(r, NOW + 9)).toBe(false);
    expect(isExpired(r, NOW + 10)).toBe(true);
  });

  it("ages a record from before lifetimes existed as persistent from its creation", () => {
    // No expiresAt at all: the shape every pairing had before this change.
    const legacy = record();
    expect(expiresAtOf(legacy)).toBe(NOW + PERSISTENT_TTL_SECONDS);
    expect(isExpired(legacy, NOW + PERSISTENT_TTL_SECONDS - 1)).toBe(false);
    expect(isExpired(legacy, NOW + PERSISTENT_TTL_SECONDS)).toBe(true);
  });

  it("treats an unparsable createdAt as already expired rather than immortal", () => {
    expect(isExpired(record({ createdAt: "not a date" }), NOW)).toBe(true);
  });
});

describe("store round-trips the new fields and still reads old records", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("keeps mode and expiresAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-lifetime-"));
    dirs.push(dir);
    const store = new FileWalletSessionStore(dir);
    await store.set(record({ mode: "once", expiresAt: NOW + 5 }));
    const back = await store.get("u1");
    expect(back?.mode).toBe("once");
    expect(back?.expiresAt).toBe(NOW + 5);
  });

  it("keeps mode day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-lifetime-"));
    dirs.push(dir);
    const store = new FileWalletSessionStore(dir);
    await store.set(record({ mode: "day", expiresAt: NOW + DAY_TTL_SECONDS }));
    const back = await store.get("u1");
    expect(back?.mode).toBe("day");
    expect(back?.expiresAt).toBe(NOW + DAY_TTL_SECONDS);
  });

  it("still reads a record written with mode persistent and an expiry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-lifetime-"));
    dirs.push(dir);
    const store = new FileWalletSessionStore(dir);
    await store.set(record({ mode: "persistent", expiresAt: NOW + PERSISTENT_TTL_SECONDS }));
    const back = await store.get("u1");
    expect(back?.mode).toBe("persistent");
    expect(back?.expiresAt).toBe(NOW + PERSISTENT_TTL_SECONDS);
  });

  it("rejects a record whose mode is not one of the three", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-lifetime-"));
    dirs.push(dir);
    const store = new FileWalletSessionStore(dir);
    await store.set(record({ mode: "forever" as never, expiresAt: NOW + 5 }));
    expect(await store.get("u1")).toBeUndefined();
  });

  it("accepts a record with neither field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-lifetime-"));
    dirs.push(dir);
    const store = new FileWalletSessionStore(dir);
    await store.set(record());
    const back = await store.get("u1");
    expect(back).toBeDefined();
    expect(back?.mode).toBeUndefined();
  });
});

describe("the pairing page offers no lifetime choice", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function boot(now: () => number) {
    const mod = createPairingModule(now);
    const app = express();
    mod.mountPairing(app, { resolveUri: async () => "wc:abc@2?relay-protocol=irn&symKey=00" });
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, r));
    const { port } = server.address() as AddressInfo;
    return { mod, base: `http://127.0.0.1:${port}` };
  }

  it("renders no lifetime control", async () => {
    const { mod, base } = await boot(() => 1_000_000);
    const { url } = mod.createPairingLink("alice", base);
    const html = await (await fetch(`${base}/pair/${url.split("/pair/")[1]}`)).text();
    expect(html).not.toContain('name="mode"');
    expect(html).not.toContain("Keep me connected");
    expect(html).not.toContain("Just this once");
    expect(html).not.toContain("for a week");
  });

  it("has no mode route", async () => {
    const { mod, base } = await boot(() => 1_000_000);
    const token = mod.createPairingLink("alice", base).url.split("/pair/")[1]!;
    const res = await fetch(`${base}/pair/${token}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "once" }),
    });
    expect(res.status).toBe(404);
  });

  it("still renders the code, the copy button and the expiry", async () => {
    const { mod, base } = await boot(() => 1_000_000);
    const { url, expiresAt } = mod.createPairingLink("alice", base);
    const res = await fetch(`${base}/pair/${url.split("/pair/")[1]}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<svg");
    expect(html).toContain('id="copy"');
    expect(html).toContain(new Date(expiresAt * 1000).toUTCString());
  });
});

describe("an approval writes the lifetime the chat chose", () => {
  const URI = "wc:abc@2?relay-protocol=irn&symKey=00";

  /** A hub whose pairing is approved at once, so the record the approval writes can be read back. */
  function approvingHub(createdAt: number): WalletConnectHubLike {
    const hub = fakeHub();
    hub.pair = vi.fn(async () => ({
      uri: URI,
      approval: Promise.resolve({ topic: "t-new", chainId: "moi:custom", account: "0xabc", createdAt }),
    })) as never;
    return hub;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["once", ONCE_TTL_SECONDS],
    ["day", DAY_TTL_SECONDS],
    ["persistent", PERSISTENT_TTL_SECONDS],
  ] as const)("stores mode %s with an expiry counted from the approval", async (mode, seconds) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW * 1000));
    const records = new Map<string, StoredWalletSession>();
    const store = fakeStore(records);
    const start = makeStartPairing({ MOI_NETWORK: "custom" } as never, approvingHub(NOW), store, fakeJournal() as never);

    const out = await start("u1", mode);
    expect(out.uri).toBe(URI);
    // The approval is already resolved; let the background write finish.
    await vi.waitFor(() => expect(records.get("u1")).toBeDefined());

    const written = records.get("u1")!;
    expect(written.mode).toBe(mode);
    expect(written.expiresAt).toBe(NOW + seconds);
    expect(isExpired(written, NOW + seconds - 1)).toBe(false);
    expect(isExpired(written, NOW + seconds)).toBe(true);
  });
});
