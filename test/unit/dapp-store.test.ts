import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedisClientType } from "redis";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileDappSessionStore,
  isDappSessionExpired,
  RedisDappSessionStore,
  type StoredDappSession,
} from "../../src/applications/dapp/store.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-dapps-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = "https://launchpad.example";

/** The slot a record lives in: the same hash the store files it under. */
function slotOf(userId: string, baseUrl: string): string {
  return createHash("sha256").update(`${userId}\n${baseUrl.replace(/\/+$/, "")}`).digest("hex");
}

function record(over: Partial<StoredDappSession> = {}): StoredDappSession {
  return {
    version: 1,
    userId: "user-a",
    baseUrl: "https://launchpad.example",
    cookie: "eyJ.session.token",
    walletAddress: "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    ...over,
  };
}

describe("FileDappSessionStore", () => {
  it("round-trips a record and forgets it on delete", async () => {
    const store = new FileDappSessionStore(freshDir());
    expect(await store.get("user-a", "https://launchpad.example")).toBeUndefined();
    await store.set(record());
    expect((await store.get("user-a", "https://launchpad.example"))?.cookie).toBe("eyJ.session.token");
    // Same user, another dapp: a different record.
    expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    await store.delete("user-a", "https://launchpad.example");
    expect(await store.get("user-a", "https://launchpad.example")).toBeUndefined();
  });

  it("names files by a hash of the user id and keeps them private", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir);
    await store.set(record({ userId: "../../etc/passwd" }));
    const files = readdirSync(join(dir, "dapps"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const mode = statSync(join(dir, "dapps", files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps one user's session away from another's", async () => {
    const store = new FileDappSessionStore(freshDir());
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "a", baseUrl: "https://other.example", cookie: "cookie-a2" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.get("a", "https://launchpad.example"))?.cookie).toBe("cookie-a");
    expect((await store.get("b", "https://launchpad.example"))?.cookie).toBe("cookie-b");
    expect((await store.listFor("a")).map((r) => r.cookie).sort()).toEqual(["cookie-a", "cookie-a2"]);
    await store.delete("a", "https://launchpad.example");
    expect(await store.get("a", "https://launchpad.example")).toBeUndefined();
    expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a2"]);
    expect((await store.get("b", "https://launchpad.example"))?.cookie).toBe("cookie-b");
  });

  it("reports expiry from the Launchpad's own lifetime", () => {
    const now = Date.now();
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) - 1 }), now)).toBe(true);
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) + 60 }), now)).toBe(false);
  });

  it("leaves no temporary file behind", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir);
    await store.set(record());
    await store.set(record({ cookie: "second" }));
    expect(readdirSync(join(dir, "dapps")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("reads damaged and empty files as signed out without throwing", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir);
    const slot = slotOf("user-a", BASE);
    for (const text of ["", "{", "null", "[]", '"x"', "42", '{"version":1}']) {
      writeFileSync(join(dir, "dapps", `${slot}.json`), text);
      expect(await store.get("user-a", BASE), JSON.stringify(text)).toBeUndefined();
      expect(await store.listFor("user-a"), JSON.stringify(text)).toEqual([]);
    }
  });

  it("skips what it cannot read and still lists the rest", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir);
    await store.set(record({ cookie: "good" }));
    writeFileSync(join(dir, "dapps", "junk.json"), "{");
    writeFileSync(join(dir, "dapps", "note.txt"), "not a record");
    expect((await store.listFor("user-a")).map((r) => r.cookie)).toEqual(["good"]);
  });
});

/**
 * A stand-in for the node-redis client with just the calls this store makes,
 * recording the expiry each set was given. node-redis 4 yields keys one at a
 * time from scanIterator and 5 yields batches; both shapes are exercised.
 */
function fakeRedis(batched: boolean) {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
      data.set(key, value);
      if (opts?.EX !== undefined) ttls.set(key, opts.EX);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
    scanIterator: vi.fn(async function* (opts: { MATCH: string }) {
      const prefix = opts.MATCH.replace(/\*$/, "");
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix));
      if (batched) yield keys;
      else yield* keys;
    }),
  };
  return { client: client as unknown as RedisClientType, mocks: client, data, ttls };
}

describe.each([
  ["one key at a time", false],
  ["in batches", true],
])("RedisDappSessionStore (scan %s)", (_label, batched) => {
  const redisKey = (userId: string, baseUrl = BASE) => `moi:dapp:${slotOf(userId, baseUrl)}`;

  it("round-trips a record under a hashed key, expiring with the session", async () => {
    const { client, data, ttls } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client);
    await store.set(record({ cookie: "COOKIE-VALUE-123", expiresAt: Math.floor(Date.now() / 1000) + 3600 }));

    expect([...data.keys()]).toEqual([redisKey("user-a")]);
    // The expiry follows expiresAt.
    expect(ttls.get(redisKey("user-a"))).toBeGreaterThan(3590);
    expect(ttls.get(redisKey("user-a"))).toBeLessThanOrEqual(3600);

    expect((await store.get("user-a", BASE))?.cookie).toBe("COOKIE-VALUE-123");
    expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    await store.delete("user-a", BASE);
    expect(await store.get("user-a", BASE)).toBeUndefined();
  });

  it("expires an already-past record in at least a second rather than never", async () => {
    const { client, ttls } = fakeRedis(batched);
    await new RedisDappSessionStore(client).set(record({ expiresAt: 1 }));
    expect(ttls.get(redisKey("user-a"))).toBe(1);
  });

  it("lists only one person's sessions", async () => {
    const { client } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "a", baseUrl: "https://other.example", cookie: "cookie-a2" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.listFor("a")).map((r) => r.cookie).sort()).toEqual(["cookie-a", "cookie-a2"]);
    expect((await store.listFor("b")).map((r) => r.cookie)).toEqual(["cookie-b"]);
  });

  it("reads damaged values as signed out without throwing", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client);
    for (const text of ["", "{", "null", "[]"]) {
      data.set(redisKey("user-a"), text);
      expect(await store.get("user-a", BASE), JSON.stringify(text)).toBeUndefined();
      expect(await store.listFor("user-a"), JSON.stringify(text)).toEqual([]);
    }
  });

  it("skips a value that expired between the scan and the read", async () => {
    const { client, mocks, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "gone", cookie: "cookie-gone" }));
    mocks.get.mockImplementation(async (key: string) => (key === redisKey("gone") ? null : (data.get(key) ?? null)));
    expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a"]);
  });
});
