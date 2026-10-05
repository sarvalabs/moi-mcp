/**
 * Pairing lifetimes: the user picks how long a pairing lives, on the page and
 * out of the model's reach, and the server honours it.
 *
 * None of this protects funds; every transaction still needs the phone. What
 * it bounds is how long a stale server-side record can raise prompts on
 * someone's phone, which is the actual exposure of a stolen cookie.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createPairingModule } from "../../src/pairing/index.js";
import {
  DEFAULT_MODE,
  expiresAtOf,
  expiryFor,
  isExpired,
  ONCE_TTL_SECONDS,
  PERSISTENT_TTL_SECONDS,
} from "../../src/wc/lifetime.js";
import { FileWalletSessionStore, type StoredWalletSession } from "../../src/wc/store.js";

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
  it("gives a persistent pairing a week and a once pairing fifteen minutes", () => {
    expect(expiryFor("persistent", NOW)).toBe(NOW + PERSISTENT_TTL_SECONDS);
    expect(expiryFor("once", NOW)).toBe(NOW + ONCE_TTL_SECONDS);
    expect(PERSISTENT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(ONCE_TTL_SECONDS).toBe(15 * 60);
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

describe("the pairing page owns the choice", () => {
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

  it("defaults to persistent and records what the page posts", async () => {
    let time = 1_000_000;
    const { mod, base } = await boot(() => time);
    const { url } = mod.createPairingLink("alice", base);
    const token = url.split("/pair/")[1]!;

    expect(mod.modeForUser("alice")).toBe(DEFAULT_MODE);

    const res = await fetch(`${base}/pair/${token}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "once" }),
    });
    expect(res.status).toBe(200);
    expect(mod.modeForUser("alice")).toBe("once");
  });

  it("rejects a mode it does not know, so nothing can invent a lifetime", async () => {
    let time = 1_000_000;
    const { mod, base } = await boot(() => time);
    const token = mod.createPairingLink("alice", base).url.split("/pair/")[1]!;

    const res = await fetch(`${base}/pair/${token}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "forever" }),
    });
    expect(res.status).toBe(400);
    expect(mod.modeForUser("alice")).toBe(DEFAULT_MODE);
  });

  it("refuses to change a link that has expired or been used", async () => {
    let time = 1_000_000;
    const { mod, base } = await boot(() => time);
    const token = mod.createPairingLink("alice", base).url.split("/pair/")[1]!;
    mod.consumeForUser("alice");

    const res = await fetch(`${base}/pair/${token}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "once" }),
    });
    expect(res.status).toBe(410);
  });

  it("renders the choice on the page with the current mode selected", async () => {
    let time = 1_000_000;
    const { mod, base } = await boot(() => time);
    const { url } = mod.createPairingLink("alice", base);
    const token = url.split("/pair/")[1]!;
    await fetch(`${base}/pair/${token}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "once" }),
    });

    const html = await (await fetch(`${base}/pair/${token}`)).text();
    expect(html).toContain('name="mode" value="once" checked');
    expect(html).toContain("Keep me connected");
    expect(html).toContain("Just this once");
  });
});
