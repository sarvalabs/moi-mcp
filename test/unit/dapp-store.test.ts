import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RedisClientType } from "redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveKey, seal } from "../../src/auth/crypto.js";
import {
  DAPP_SESSION_KEY_LABEL,
  FileDappSessionStore,
  isDappSessionExpired,
  purgeDappSessionsOnBoot,
  RedisDappSessionStore,
  type StoredDappSession,
} from "../../src/dapp/store.js";
import { dappKey, SESSION_SECRET } from "../helpers/hosted.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-dapps-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = dappKey();
/** A different secret, so a record sealed under KEY does not open under it. */
const OTHER_KEY = dappKey("o".repeat(44));
const BASE = "https://launchpad.example";

function record(over: Partial<StoredDappSession> = {}): StoredDappSession {
  return {
    version: 1,
    userId: "user-a",
    baseUrl: BASE,
    cookie: "eyJ.session.token",
    walletAddress: "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    ...over,
  };
}

/** The slot a record lives in: the same hash the store files it under. */
function slotOf(userId: string, baseUrl: string): string {
  return createHash("sha256").update(`${userId}\n${baseUrl.replace(/\/+$/, "")}`).digest("hex");
}

/** A session record as it was written before sealing: the record itself, as JSON. */
function plainText(rec: StoredDappSession): string {
  return `${JSON.stringify(rec, null, 2)}\n`;
}

/** The sealed text with one byte of its ciphertext or tag changed. */
function flipped(sealed: string, field: "ct" | "tag"): string {
  const o = JSON.parse(sealed) as Record<string, string>;
  const bytes = Buffer.from(o[field]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return JSON.stringify({ ...o, [field]: bytes.toString("base64url") });
}

describe("FileDappSessionStore", () => {
  it("round-trips a record and forgets it on delete", async () => {
    const store = new FileDappSessionStore(freshDir(), KEY);
    expect(await store.get("user-a", BASE)).toBeUndefined();
    await store.set(record());
    expect((await store.get("user-a", BASE))?.cookie).toBe("eyJ.session.token");
    // Same user, another dapp: a different record.
    expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    await store.delete("user-a", BASE);
    expect(await store.get("user-a", BASE)).toBeUndefined();
  });

  it("names files by a hash of the user id and keeps them private", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir, KEY);
    await store.set(record({ userId: "../../etc/passwd" }));
    const files = readdirSync(join(dir, "dapps"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const mode = statSync(join(dir, "dapps", files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps one user's session away from another's", async () => {
    const store = new FileDappSessionStore(freshDir(), KEY);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "a", baseUrl: "https://other.example", cookie: "cookie-a2" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.get("a", BASE))?.cookie).toBe("cookie-a");
    expect((await store.get("b", BASE))?.cookie).toBe("cookie-b");
    expect((await store.listFor("a")).map((r) => r.cookie).sort()).toEqual(["cookie-a", "cookie-a2"]);
    await store.delete("a", BASE);
    expect(await store.get("a", BASE)).toBeUndefined();
    expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a2"]);
    expect((await store.get("b", BASE))?.cookie).toBe("cookie-b");
  });

  it("reports expiry from the session's own lifetime", () => {
    const now = Date.now();
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) - 1 }), now)).toBe(true);
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) + 60 }), now)).toBe(false);
  });

  it("stores nothing readable", async () => {
    const dir = freshDir();
    const rec = record({ userId: "alice@example.com", cookie: "COOKIE-VALUE-123" });
    await new FileDappSessionStore(dir, KEY).set(rec);
    const [name] = readdirSync(join(dir, "dapps"));
    const text = readFileSync(join(dir, "dapps", name!), "utf8");
    for (const secret of [rec.cookie, rec.userId, "launchpad.example", rec.walletAddress]) {
      expect(text).not.toContain(secret);
    }
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["alg", "ct", "iv", "tag", "v"]);
    expect(envelope["v"]).toBe(2);
    expect(envelope["alg"]).toBe("A256GCM");
    expect(statSync(join(dir, "dapps", name!)).mode & 0o777).toBe(0o600);
    expect(name).toBe(`${slotOf(rec.userId, rec.baseUrl)}.json`);
  });

  it("leaves no temporary file behind", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir, KEY);
    await store.set(record());
    await store.set(record({ cookie: "second" }));
    expect(readdirSync(join(dir, "dapps")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  describe("a record that does not open", () => {
    it("reads as signed out under another key and destroys nothing", async () => {
      const dir = freshDir();
      await new FileDappSessionStore(dir, KEY).set(record());
      const other = new FileDappSessionStore(dir, OTHER_KEY);
      expect(await other.get("user-a", BASE)).toBeUndefined();
      expect(await other.listFor("user-a")).toEqual([]);
      // Still there for the right key.
      const original = new FileDappSessionStore(dir, KEY);
      expect((await original.get("user-a", BASE))?.cookie).toBe("eyJ.session.token");
      // A later sign-in under the new key replaces it and then reads.
      await other.set(record({ cookie: "fresh" }));
      expect((await other.get("user-a", BASE))?.cookie).toBe("fresh");
    });

    it("refuses a sealed record copied into another person's slot", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      await store.set(record({ userId: "a", cookie: "cookie-a" }));
      await store.set(record({ userId: "b", cookie: "cookie-b" }));
      const files = join(dir, "dapps");
      writeFileSync(
        join(files, `${slotOf("b", BASE)}.json`),
        readFileSync(join(files, `${slotOf("a", BASE)}.json`)),
      );
      expect(await store.get("b", BASE)).toBeUndefined();
      expect((await store.get("a", BASE))?.cookie).toBe("cookie-a");
      // Not listed for either person under the wrong slot, either.
      expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a"]);
      expect(await store.listFor("b")).toEqual([]);
    });

    it("refuses a sealed record copied into another dapp's slot", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      await store.set(record({ cookie: "cookie-a" }));
      const files = join(dir, "dapps");
      writeFileSync(
        join(files, `${slotOf("user-a", "https://other.example")}.json`),
        readFileSync(join(files, `${slotOf("user-a", BASE)}.json`)),
      );
      expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    });

    it("reads as signed out when a byte of the ciphertext or tag was changed", async () => {
      for (const field of ["ct", "tag"] as const) {
        const dir = freshDir();
        const store = new FileDappSessionStore(dir, KEY);
        await store.set(record());
        const file = join(dir, "dapps", `${slotOf("user-a", BASE)}.json`);
        writeFileSync(file, flipped(readFileSync(file, "utf8"), field));
        expect(await store.get("user-a", BASE), field).toBeUndefined();
        expect(await store.listFor("user-a"), field).toEqual([]);
      }
    });

    it("reads a plain record from before sealing as signed out, and does not delete it", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      const file = join(dir, "dapps", `${slotOf("user-a", BASE)}.json`);
      writeFileSync(file, plainText(record()));
      expect(await store.get("user-a", BASE)).toBeUndefined();
      expect(await store.listFor("user-a")).toEqual([]);
      // Removal is the boot purge's job alone; a read never deletes.
      expect(existsSync(file)).toBe(true);
    });

    it("reads damaged and empty files as signed out without throwing", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      const slot = slotOf("user-a", BASE);
      for (const text of ["", "{", "null", "[]", '"x"', "42"]) {
        writeFileSync(join(dir, "dapps", `${slot}.json`), text);
        expect(await store.get("user-a", BASE), JSON.stringify(text)).toBeUndefined();
        expect(await store.listFor("user-a"), JSON.stringify(text)).toEqual([]);
      }
    });

    it("reads a sealed value that is not a session as signed out", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      const slot = slotOf("user-a", BASE);
      for (const payload of ["null", "[]", '{"version":1}', "not json"]) {
        writeFileSync(join(dir, "dapps", `${slot}.json`), seal(payload, KEY, slot));
        expect(await store.get("user-a", BASE), payload).toBeUndefined();
      }
    });

    it("skips what it cannot read and still lists the rest", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      await store.set(record({ cookie: "good" }));
      writeFileSync(join(dir, "dapps", "junk.json"), "{");
      writeFileSync(join(dir, "dapps", "note.txt"), "not a record");
      expect((await store.listFor("user-a")).map((r) => r.cookie)).toEqual(["good"]);
    });
  });

  describe("purgePlain", () => {
    it("removes plain records, counts what it kept, and leaves sealed ones alone", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      const files = join(dir, "dapps");
      await store.set(record({ userId: "keep", cookie: "sealed-cookie" }));
      // Two plain records.
      for (const userId of ["old-1", "old-2"]) {
        writeFileSync(join(files, `${slotOf(userId, BASE)}.json`), plainText(record({ userId, cookie: "plain-cookie" })));
      }
      // Sealed under another key: not ours to judge.
      await new FileDappSessionStore(dir, OTHER_KEY).set(record({ userId: "elsewhere", cookie: "other-key-cookie" }));
      // Damaged, and a format this code does not know.
      writeFileSync(join(files, "damaged.json"), "{");
      writeFileSync(join(files, "future.json"), JSON.stringify({ version: 3, anything: true }));
      // A temporary file left by an interrupted write.
      writeFileSync(join(files, `${slotOf("x", BASE)}.json.tmp`), plainText(record({ userId: "x" })));

      expect(await store.purgePlain()).toEqual({ plain: 2, unreadable: 3 });

      const left = readdirSync(files).sort();
      expect(left).toContain(`${slotOf("keep", BASE)}.json`);
      expect(left).toContain(`${slotOf("elsewhere", BASE)}.json`);
      expect(left).toContain("damaged.json");
      expect(left).toContain("future.json");
      expect(left).toContain(`${slotOf("x", BASE)}.json.tmp`);
      expect(left).not.toContain(`${slotOf("old-1", BASE)}.json`);
      expect(left).not.toContain(`${slotOf("old-2", BASE)}.json`);
      expect((await store.get("keep", BASE))?.cookie).toBe("sealed-cookie");
      // No remaining .json file holds the plain cookie.
      for (const name of left.filter((n) => n.endsWith(".json"))) {
        expect(readFileSync(join(files, name), "utf8")).not.toContain("plain-cookie");
      }
    });

    it("does not touch a store with nothing to purge", async () => {
      const store = new FileDappSessionStore(freshDir(), KEY);
      expect(await store.purgePlain()).toEqual({ plain: 0, unreadable: 0 });
      await store.set(record());
      expect(await store.purgePlain()).toEqual({ plain: 0, unreadable: 0 });
      expect((await store.get("user-a", BASE))?.cookie).toBe("eyJ.session.token");
    });

    it("is idempotent", async () => {
      const dir = freshDir();
      const store = new FileDappSessionStore(dir, KEY);
      writeFileSync(join(dir, "dapps", `${slotOf("old", BASE)}.json`), plainText(record({ userId: "old" })));
      expect(await store.purgePlain()).toEqual({ plain: 1, unreadable: 0 });
      expect(await store.purgePlain()).toEqual({ plain: 0, unreadable: 0 });
    });
  });
});

/**
 * A stand-in for the node-redis client with just the four calls the store
 * makes, recording the expiry each set was given. node-redis 4 yields keys one
 * at a time from scanIterator and 5 yields batches; both shapes are exercised.
 */
function fakeRedis(batched = false): { client: RedisClientType; data: Map<string, string>; ttls: Map<string, number> } {
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
  return { client: client as unknown as RedisClientType, data, ttls };
}

describe.each([
  ["one key at a time", false],
  ["in batches", true],
])("RedisDappSessionStore (scan %s)", (_label, batched) => {
  const redisKey = (userId: string, baseUrl = BASE) => `moi:dapp:${slotOf(userId, baseUrl)}`;

  it("round-trips a record under a hashed key, sealed, expiring with the session", async () => {
    const { client, data, ttls } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    const rec = record({ cookie: "COOKIE-VALUE-123", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await store.set(rec);

    expect([...data.keys()]).toEqual([redisKey("user-a")]);
    const stored = data.get(redisKey("user-a"))!;
    for (const secret of [rec.cookie, rec.userId, "launchpad.example", rec.walletAddress]) {
      expect(stored).not.toContain(secret);
    }
    expect((JSON.parse(stored) as { v: number; alg: string }).alg).toBe("A256GCM");
    // The expiry still follows expiresAt.
    expect(ttls.get(redisKey("user-a"))).toBeGreaterThan(3590);
    expect(ttls.get(redisKey("user-a"))).toBeLessThanOrEqual(3600);

    expect((await store.get("user-a", BASE))?.cookie).toBe("COOKIE-VALUE-123");
    expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    await store.delete("user-a", BASE);
    expect(await store.get("user-a", BASE)).toBeUndefined();
  });

  it("expires an already-past record in at least a second rather than never", async () => {
    const { client, ttls } = fakeRedis(batched);
    await new RedisDappSessionStore(client, KEY).set(record({ expiresAt: 1 }));
    expect(ttls.get(redisKey("user-a"))).toBe(1);
  });

  it("lists only one person's sessions", async () => {
    const { client } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "a", baseUrl: "https://other.example", cookie: "cookie-a2" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.listFor("a")).map((r) => r.cookie).sort()).toEqual(["cookie-a", "cookie-a2"]);
    expect((await store.listFor("b")).map((r) => r.cookie)).toEqual(["cookie-b"]);
  });

  it("reads as signed out under another key and keeps the value", async () => {
    const { client, data } = fakeRedis(batched);
    await new RedisDappSessionStore(client, KEY).set(record());
    const other = new RedisDappSessionStore(client, OTHER_KEY);
    expect(await other.get("user-a", BASE)).toBeUndefined();
    expect(await other.listFor("user-a")).toEqual([]);
    expect(data.has(redisKey("user-a"))).toBe(true);
  });

  it("refuses a sealed value copied under another person's key", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    data.set(redisKey("b"), data.get(redisKey("a"))!);
    expect(await store.get("b", BASE)).toBeUndefined();
    expect(await store.listFor("b")).toEqual([]);
    expect((await store.get("a", BASE))?.cookie).toBe("cookie-a");
  });

  it("reads as signed out when a byte was changed, and for damaged values", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    await store.set(record());
    data.set(redisKey("user-a"), flipped(data.get(redisKey("user-a"))!, "ct"));
    expect(await store.get("user-a", BASE)).toBeUndefined();
    for (const text of ["", "{", "null", "[]"]) {
      data.set(redisKey("user-a"), text);
      expect(await store.get("user-a", BASE), JSON.stringify(text)).toBeUndefined();
      expect(await store.listFor("user-a"), JSON.stringify(text)).toEqual([]);
    }
  });

  it("reads a plain value as signed out, and does not delete it", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    data.set(redisKey("user-a"), JSON.stringify(record()));
    expect(await store.get("user-a", BASE)).toBeUndefined();
    expect(await store.listFor("user-a")).toEqual([]);
    expect(client.del).not.toHaveBeenCalled();
    expect(data.has(redisKey("user-a"))).toBe(true);
  });

  it("skips a value that expired between the scan and the read", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "gone", cookie: "cookie-gone" }));
    (client.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) =>
      key === redisKey("gone") ? null : (data.get(key) ?? null),
    );
    expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a"]);
    expect(await store.purgePlain()).toEqual({ plain: 0, unreadable: 0 });
  });

  it("purges plain values, counts what it kept, and leaves sealed ones alone", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisDappSessionStore(client, KEY);
    await store.set(record({ userId: "keep", cookie: "sealed-cookie" }));
    for (const userId of ["old-1", "old-2"]) {
      data.set(redisKey(userId), JSON.stringify(record({ userId, cookie: "plain-cookie" })));
    }
    await new RedisDappSessionStore(client, OTHER_KEY).set(record({ userId: "elsewhere" }));
    data.set("moi:dapp:damaged", "{");
    // Another prefix is not ours at all.
    data.set("moi:wc:something", JSON.stringify(record({ userId: "wallet" })));

    expect(await store.purgePlain()).toEqual({ plain: 2, unreadable: 2 });

    expect(data.has(redisKey("old-1"))).toBe(false);
    expect(data.has(redisKey("old-2"))).toBe(false);
    expect(data.has(redisKey("keep"))).toBe(true);
    expect(data.has(redisKey("elsewhere"))).toBe(true);
    expect(data.has("moi:dapp:damaged")).toBe(true);
    expect(data.has("moi:wc:something")).toBe(true);
    expect((await store.get("keep", BASE))?.cookie).toBe("sealed-cookie");
    expect(await store.purgePlain()).toEqual({ plain: 0, unreadable: 2 });
  });
});

describe("purgeDappSessionsOnBoot", () => {
  let lines: string[];
  let savedLevel: string | undefined;
  beforeEach(() => {
    lines = [];
    savedLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLevel === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = savedLevel;
  });

  it("purges through the store and logs one line with the counts only", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir, KEY);
    writeFileSync(join(dir, "dapps", `${slotOf("old", BASE)}.json`), plainText(record({ userId: "old", cookie: "plain-cookie" })));
    await new FileDappSessionStore(dir, OTHER_KEY).set(record({ userId: "elsewhere", cookie: "other-cookie" }));

    expect(await purgeDappSessionsOnBoot(store)).toEqual({ plain: 1, unreadable: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/dapp sessions: removed 1 unencrypted record\(s\); 1 record\(s\) do not open with the current MOI_SESSION_KEY/);
    expect(lines[0]).not.toContain("plain-cookie");
    expect(lines[0]).not.toContain("other-cookie");
  });

  it("logs the line when there is nothing to purge, so a quiet boot is not mistaken for a skipped one", async () => {
    await purgeDappSessionsOnBoot({ purgePlain: async () => ({ plain: 0, unreadable: 0 }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("removed 0 unencrypted record(s); 0 record(s)");
  });
});

describe("the hosted server's wiring", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  // main() is not exported (the isMain guard), so the order it runs in is pinned
  // against the source: key, then the stores, then the purge, then anything
  // that can read a session, then listen.
  it("derives the key from the hosted config, builds both stores with it, and purges before it listens", () => {
    const server = read("src/server.ts");
    const at = (needle: string) => {
      const i = server.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const key = at("deriveKey(hosted.MOI_SESSION_KEY, DAPP_SESSION_KEY_LABEL)");
    const redis = at("new RedisDappSessionStore(redis, dappKey)");
    const file = at("new FileDappSessionStore(hosted.dataDir, dappKey)");
    const purge = at("await purgeDappSessionsOnBoot(dappSessions)");
    const auth = at("mountAuth(app");
    const downloads = at("downloads.mountDownloads(");
    const listen = at("app.listen(");
    expect(key).toBeLessThan(redis);
    expect(key).toBeLessThan(file);
    expect(Math.max(redis, file)).toBeLessThan(purge);
    expect(purge).toBeLessThan(auth);
    expect(purge).toBeLessThan(downloads);
    expect(purge).toBeLessThan(listen);
  });

  it("never logs the secret or the key", () => {
    const server = read("src/server.ts");
    expect(server).not.toMatch(/\$\{[^}]*(MOI_SESSION_KEY|dappKey)/);
    expect(server).not.toMatch(/log\([^;]*(MOI_SESSION_KEY|dappKey)/s);
  });

  it("is the only entry point that needs the key: stdio, the read gateway and the CLI never load hosted config", () => {
    for (const file of ["src/index.ts", "src/http.ts", "src/cli.ts"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/MOI_SESSION_KEY|loadHostedConfig|getHostedConfig/);
    }
  });

  it("derives the dapp store's key under its own label", () => {
    expect(DAPP_SESSION_KEY_LABEL).toBe("dapp-session");
    expect(dappKey().equals(deriveKey(SESSION_SECRET, DAPP_SESSION_KEY_LABEL))).toBe(true);
    expect(dappKey().equals(deriveKey(SESSION_SECRET, "wallet-session"))).toBe(false);
  });
});
