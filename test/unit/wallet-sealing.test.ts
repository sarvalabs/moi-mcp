/**
 * The four wallet stores seal what they write, and a record that is plain,
 * altered, sealed under another key or moved to another slot reads as missing
 * without anything being deleted: the pairing records and the WalletConnect
 * state, each in files and in (a fake) Redis. The boot migration is in
 * seal-migration.test.ts and wallet-seal-backends.test.ts.
 */
import { Crypto } from "@walletconnect/core";
import { pino } from "@walletconnect/logger";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { seal, unseal } from "../../src/auth/crypto.js";
import { RedisKeyValueStorage, RedisWalletSessionStore } from "../../src/wc/redis-store.js";
import { FileKeyValueStorage, FileWalletSessionStore, walletSlot } from "../../src/wc/store.js";
import { fakeRedis } from "../helpers/fake-redis.js";
import { session, walletKey, wcKey } from "../helpers/hosted.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-wallet-seal-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = walletKey();
const OTHER = walletKey("o".repeat(44));
const WC = wcKey();
const WC_OTHER = wcKey("o".repeat(44));

function flipped(sealed: string, field: "ct" | "tag"): string {
  const o = JSON.parse(sealed) as Record<string, string>;
  const bytes = Buffer.from(o[field]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return JSON.stringify({ ...o, [field]: bytes.toString("base64url") });
}

/** Text that is not a sealed value of any kind, and sealed values that are not a pairing record. */
const DAMAGED = ["", "{", "null", "[]", '"x"', "42", "not json"];
const NOT_A_RECORD = ["null", "[]", '{"version":1}', "not json"];

const alice = session({ userId: "alice", topic: "topic-a", address: "0xAliceAddress", sessionData: { peer: "AlicePhone" } });
const bob = session({ userId: "bob", topic: "topic-b" });

// ---------------------------------------------------------------------------
// Pairing records, files
// ---------------------------------------------------------------------------

describe("FileWalletSessionStore, sealed", () => {
  const fileOf = (dir: string, userId: string) => join(dir, "sessions", `${walletSlot(userId)}.json`);

  it("round-trips: set, get, findByTopic, list and delete", async () => {
    const store = new FileWalletSessionStore(freshDir(), KEY);
    const carol = session({ userId: "carol", topic: "topic-c" });
    for (const r of [alice, bob, carol]) await store.set(r);

    expect(await store.get("alice")).toEqual(alice);
    expect(await store.get("nobody")).toBeUndefined();
    expect((await store.findByTopic("topic-b"))?.userId).toBe("bob");
    expect((await store.list()).map((r) => r.userId).sort()).toEqual(["alice", "bob", "carol"]);

    await store.delete("bob");
    expect(await store.get("bob")).toBeUndefined();
    expect(await store.get("alice")).toEqual(alice);
  });

  it("stores nothing readable: the envelope only, in a 0600 file named by the hash, in a 0700 folder", async () => {
    const dir = freshDir();
    await new FileWalletSessionStore(dir, KEY).set(alice);
    const text = readFileSync(fileOf(dir, "alice"), "utf8");
    for (const secret of ["alice", "topic-a", "0xAliceAddress", "AlicePhone", "sessionData"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["alg", "ct", "iv", "tag", "v"]);
    expect(JSON.parse(text)).toMatchObject({ v: 2, alg: "A256GCM" });
    expect(statSync(fileOf(dir, "alice")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sessions")).mode & 0o777).toBe(0o700);
  });

  it("reads as not paired under another key, and destroys nothing", async () => {
    const dir = freshDir();
    await new FileWalletSessionStore(dir, KEY).set(alice);
    const before = readFileSync(fileOf(dir, "alice"), "utf8");
    const other = new FileWalletSessionStore(dir, OTHER);

    expect(await other.get("alice")).toBeUndefined();
    expect(await other.findByTopic("topic-a")).toBeUndefined();
    expect(await other.list()).toEqual([]);
    expect(readFileSync(fileOf(dir, "alice"), "utf8")).toBe(before);
    expect(await new FileWalletSessionStore(dir, KEY).get("alice")).toEqual(alice);

    await other.set(alice); // a fresh pairing under the new key simply replaces it
    expect(await other.get("alice")).toEqual(alice);
  });

  it("does not open a record moved to another person's slot", async () => {
    const dir = freshDir();
    const store = new FileWalletSessionStore(dir, KEY);
    await store.set(alice);
    await store.set(bob);
    writeFileSync(fileOf(dir, "bob"), readFileSync(fileOf(dir, "alice"), "utf8")); // alice's bytes in bob's slot

    expect(await store.get("bob")).toBeUndefined();
    expect((await store.list()).map((r) => r.userId)).toEqual(["alice"]);
    expect((await store.findByTopic("topic-a"))?.userId).toBe("alice");
    expect(await store.get("alice")).toEqual(alice);
  });

  it("derives independent keys: text sealed for pairings does not open as WalletConnect state", () => {
    const text = seal("x", KEY, "slot");
    expect(unseal(text, KEY, "slot")).toBe("x");
    expect(unseal(text, WC, "slot")).toBeUndefined();
  });

  it.each(["ct", "tag"] as const)("reads as not paired when a byte of %s is changed", async (field) => {
    const dir = freshDir();
    const store = new FileWalletSessionStore(dir, KEY);
    await store.set(alice);
    writeFileSync(fileOf(dir, "alice"), flipped(readFileSync(fileOf(dir, "alice"), "utf8"), field));
    expect(await store.get("alice")).toBeUndefined();
  });

  it("does not read a plain record from before sealing, and reading it deletes nothing", async () => {
    const dir = freshDir();
    const store = new FileWalletSessionStore(dir, KEY);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(fileOf(dir, "alice"), `${JSON.stringify(alice, null, 2)}\n`);
    expect(await store.get("alice")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(existsSync(fileOf(dir, "alice"))).toBe(true);
  });

  it("reads damaged text, and sealed text that is not a pairing record, as not paired without throwing", async () => {
    const dir = freshDir();
    const store = new FileWalletSessionStore(dir, KEY);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    for (const text of DAMAGED) {
      writeFileSync(fileOf(dir, "alice"), text);
      expect(await store.get("alice"), text).toBeUndefined();
    }
    for (const payload of NOT_A_RECORD) {
      writeFileSync(fileOf(dir, "alice"), seal(payload, KEY, walletSlot("alice")));
      expect(await store.get("alice"), payload).toBeUndefined();
    }
    expect(await store.list()).toEqual([]);
  });

  it("leaves no temporary file, and list ignores a leftover one and a stray file", async () => {
    const dir = freshDir();
    const store = new FileWalletSessionStore(dir, KEY);
    await store.set(alice);
    expect(readdirSync(join(dir, "sessions")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    writeFileSync(`${fileOf(dir, "alice")}.tmp`, JSON.stringify(bob));
    writeFileSync(join(dir, "sessions", "note.txt"), "hello");
    expect((await store.list()).map((r) => r.userId)).toEqual(["alice"]);
  });
});

// ---------------------------------------------------------------------------
// Pairing records, Redis
// ---------------------------------------------------------------------------

describe.each([
  ["one key at a time", false],
  ["in batches", true],
])("RedisWalletSessionStore, sealed (scan %s)", (_label, batched) => {
  const redisKey = (userId: string) => `moi:session:${walletSlot(userId)}`;

  it("round-trips a record sealed under its hashed key, with the topic index in the clear", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisWalletSessionStore(client, KEY);
    await store.set(alice);
    await store.set(bob);

    const text = data.get(redisKey("alice"))!;
    for (const secret of ["alice", "topic-a", "0xAliceAddress", "sessionData"]) expect(text, secret).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ v: 2, alg: "A256GCM" });
    expect(data.get("moi:topic:topic-a")).toBe("alice"); // the one value left in the clear, on purpose

    expect(await store.get("alice")).toEqual(alice);
    expect((await store.findByTopic("topic-b"))?.userId).toBe("bob");
    expect((await store.list()).map((r) => r.userId).sort()).toEqual(["alice", "bob"]);

    await store.delete("alice");
    expect(data.has(redisKey("alice"))).toBe(false);
    expect(data.has("moi:topic:topic-a")).toBe(false);
    expect(await store.get("bob")).toEqual(bob);
  });

  it("drops the old topic index when a person pairs again", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisWalletSessionStore(client, KEY);
    await store.set(session({ userId: "carol", topic: "topic-old" }));
    await store.set(session({ userId: "carol", topic: "topic-new" }));
    expect(await store.findByTopic("topic-old")).toBeUndefined();
    expect((await store.findByTopic("topic-new"))?.userId).toBe("carol");
    expect(data.has("moi:topic:topic-old")).toBe(false);
  });

  it("reads as not paired under another key, for a moved value, an altered one, damaged text and a plain record, and never deletes", async () => {
    const { client, data } = fakeRedis(batched);
    const store = new RedisWalletSessionStore(client, KEY);
    await store.set(alice);
    await store.set(bob);
    const sealedAlice = data.get(redisKey("alice"))!;

    expect(await new RedisWalletSessionStore(client, OTHER).get("alice")).toBeUndefined();
    expect(await new RedisWalletSessionStore(client, OTHER).list()).toEqual([]);

    data.set(redisKey("bob"), sealedAlice); // moved to another person's key
    expect(await store.get("bob")).toBeUndefined();

    for (const text of [flipped(sealedAlice, "ct"), flipped(sealedAlice, "tag"), ...DAMAGED, JSON.stringify(bob)]) {
      data.set(redisKey("bob"), text);
      expect(await store.get("bob"), text).toBeUndefined();
    }
    expect((await store.list()).map((r) => r.userId)).toEqual(["alice"]);
    expect(data.get(redisKey("alice"))).toBe(sealedAlice);
    expect(data.has(redisKey("bob"))).toBe(true);
    expect(client.del).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WalletConnect state, files
// ---------------------------------------------------------------------------

describe("FileKeyValueStorage, sealed", () => {
  const KEYCHAIN = "wc@2:core:0.3//keychain";
  const keychainFile = (dir: string) => join(dir, "wc@2", "core", "0.3", "keychain");

  it("round-trips the shapes the SDK writes, and lists keys in colon form", async () => {
    const kv = new FileKeyValueStorage(join(freshDir(), "wc.db"), WC);
    await kv.setItem(KEYCHAIN, { topicA: "key-a", seed: "s" });
    await kv.setItem("wc@2:client:0.3//session", [{ topic: "t", expiry: 1_700_000_000 }]);
    await kv.setItem("WALLETCONNECT_CLIENT_ID", "did:key:z6MkTestOnly");
    await kv.setItem("wc@2:core:0.3//count", 7);

    expect(await kv.getItem(KEYCHAIN)).toEqual({ topicA: "key-a", seed: "s" });
    expect(await kv.getItem("wc@2:core:0.3:keychain")).toEqual({ topicA: "key-a", seed: "s" }); // the same key
    expect(await kv.getItem("WALLETCONNECT_CLIENT_ID")).toBe("did:key:z6MkTestOnly");
    expect(await kv.getItem("wc@2:core:0.3//count")).toBe(7);
    expect(await kv.getItem("missing")).toBeUndefined();
    expect((await kv.getKeys()).sort()).toEqual([
      "WALLETCONNECT_CLIENT_ID",
      "wc@2:client:0.3:session",
      "wc@2:core:0.3:count",
      "wc@2:core:0.3:keychain",
    ]);
    expect(await kv.getEntries()).toContainEqual(["wc@2:core:0.3:count", 7]);

    await kv.removeItem(KEYCHAIN);
    expect(await kv.getItem(KEYCHAIN)).toBeUndefined();
    await kv.removeItem(KEYCHAIN); // already gone: not an error
  });

  it("uses the SDK's layout, sealed, with files 0600 and folders 0700", async () => {
    const dir = join(freshDir(), "wc.db");
    await new FileKeyValueStorage(dir, WC).setItem(KEYCHAIN, { topicA: "key-a" });
    const text = readFileSync(keychainFile(dir), "utf8");
    expect(text).not.toContain("key-a");
    expect(JSON.parse(text)).toMatchObject({ v: 2, alg: "A256GCM" });
    expect(statSync(keychainFile(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "wc@2", "core")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "wc@2", "core", "0.3"))).toEqual(["keychain"]);
  });

  it("reads as missing under another key, for a moved file and for an altered one, and keeps the file", async () => {
    const dir = join(freshDir(), "wc.db");
    const kv = new FileKeyValueStorage(dir, WC);
    await kv.setItem(KEYCHAIN, { topicA: "key-a" });
    await kv.setItem("wc@2:core:0.3//other", { n: 1 });
    const before = readFileSync(keychainFile(dir), "utf8");

    expect(await new FileKeyValueStorage(dir, WC_OTHER).getItem(KEYCHAIN)).toBeUndefined();
    expect(readFileSync(keychainFile(dir), "utf8")).toBe(before);

    writeFileSync(join(dir, "wc@2", "core", "0.3", "other"), before); // the key chain's bytes under another key
    expect(await kv.getItem("wc@2:core:0.3//other")).toBeUndefined();

    writeFileSync(keychainFile(dir), flipped(before, "ct"));
    expect(await kv.getItem(KEYCHAIN)).toBeUndefined();
  });

  // Why the hosted boot stops when WalletConnect state does not open (sealWalletStateOnBoot). This drives the SDK's own
  // key-chain and relay-identity code, with no relay and no network: Core.init runs getClientId right after it loads
  // state, and when the key chain reads as missing the SDK mints a new relay identity and writes a new chain over it.
  it("documents why the boot stops: the SDK replaces a key chain it cannot read", async () => {
    const dir = join(freshDir(), "wc.db");
    await new FileKeyValueStorage(dir, WC).setItem(KEYCHAIN, { topicA: "key-a" });
    const wrong = new FileKeyValueStorage(dir, WC_OTHER); // the key was changed or mistyped

    const logger = pino({ level: "silent" });
    const crypto = new Crypto({ storage: wrong, customStoragePrefix: "", logger } as never, logger);
    await crypto.init();
    await crypto.getClientId();

    expect(Object.keys((await wrong.getItem<object>(KEYCHAIN))!)).toEqual(["client_ed25519_seed"]); // topicA is gone
    expect(await new FileKeyValueStorage(dir, WC).getItem(KEYCHAIN)).toBeUndefined(); // and the right key no longer helps
  });

  it("refuses a key that would leave its directory", async () => {
    const root = freshDir();
    const kv = new FileKeyValueStorage(join(root, "wc.db"), WC);
    for (const key of ["../x", "a:..:b", "..", "", ":::"]) await expect(kv.setItem(key, 1), key).rejects.toThrow(/invalid WalletConnect storage key/);
    expect(readdirSync(root)).toEqual(["wc.db"]);
  });

  it("leaves no temporary file, and lists neither a leftover one nor a dot file", async () => {
    const dir = join(freshDir(), "wc.db");
    const kv = new FileKeyValueStorage(dir, WC);
    await kv.setItem(KEYCHAIN, 1);
    expect(readdirSync(join(dir, "wc@2", "core", "0.3"))).toEqual(["keychain"]);
    writeFileSync(join(dir, "wc@2", "core", "0.3", "x.tmp"), "1");
    writeFileSync(join(dir, ".DS_Store"), "\u0000\u0001");
    expect(await kv.getKeys()).toEqual(["wc@2:core:0.3:keychain"]);
  });

  it("writes what the SDK's own storage wrote: a bigint as a string, nothing as an empty string", async () => {
    const kv = new FileKeyValueStorage(join(freshDir(), "wc.db"), WC);
    await kv.setItem("wc@2:core:0.3//history", { id: 12n, nested: [{ id: 3n }] });
    expect(await kv.getItem("wc@2:core:0.3//history")).toEqual({ id: "12n", nested: [{ id: "3n" }] });
    await kv.setItem("wc@2:core:0.3//nothing", undefined);
    expect(await kv.getItem("wc@2:core:0.3//nothing")).toBe("");
  });

  it("stops with words when wc.db is a file from an older layout, and does not touch it", () => {
    const root = freshDir();
    const file = join(root, "wc.db");
    writeFileSync(file, "old layout");
    expect(() => new FileKeyValueStorage(file, WC)).toThrow(/wc\.db is a file from an older WalletConnect storage layout/);
    expect(() => new FileKeyValueStorage(file, WC)).toThrow(/Start the release you are upgrading from once/);
    expect(readFileSync(file, "utf8")).toBe("old layout");
  });
});

// ---------------------------------------------------------------------------
// WalletConnect state, Redis
// ---------------------------------------------------------------------------

describe.each([
  ["one key at a time", false],
  ["in batches", true],
])("RedisKeyValueStorage, sealed (scan %s)", (_label, batched) => {
  it("round-trips sealed values under moi:wc:<key>", async () => {
    const { client, data } = fakeRedis(batched);
    const kv = new RedisKeyValueStorage(client, WC);
    await kv.setItem("wc@2:core:0.3//keychain", { topicA: "key-a" });
    await kv.setItem("wc@2:client:0.3//session", [{ topic: "t" }]);

    const text = data.get("moi:wc:wc@2:core:0.3//keychain")!;
    expect(text).not.toContain("key-a");
    expect(JSON.parse(text)).toMatchObject({ v: 2, alg: "A256GCM" });
    expect(await kv.getItem("wc@2:core:0.3//keychain")).toEqual({ topicA: "key-a" });
    expect((await kv.getKeys()).sort()).toEqual(["wc@2:client:0.3//session", "wc@2:core:0.3//keychain"]);
    expect(await kv.getEntries()).toContainEqual(["wc@2:client:0.3//session", [{ topic: "t" }]]);

    await kv.removeItem("wc@2:core:0.3//keychain");
    expect(await kv.getItem("wc@2:core:0.3//keychain")).toBeUndefined();
  });

  it("writes what the SDK's storage wrote for a bigint and for nothing", async () => {
    const kv = new RedisKeyValueStorage(fakeRedis(batched).client, WC);
    await kv.setItem("k", { id: 12n });
    expect(await kv.getItem("k")).toEqual({ id: "12n" });
    await kv.setItem("n", undefined);
    expect(await kv.getItem("n")).toBe("");
  });

  it("reads as missing under another key, for a moved value, an altered one and a plain one, and never deletes", async () => {
    const { client, data } = fakeRedis(batched);
    const kv = new RedisKeyValueStorage(client, WC);
    await kv.setItem("a", { n: 1 });
    await kv.setItem("b", { n: 2 });
    const sealedA = data.get("moi:wc:a")!;

    expect(await new RedisKeyValueStorage(client, WC_OTHER).getItem("a")).toBeUndefined();
    for (const text of [sealedA, flipped(sealedA, "tag"), '{"n":2}']) {
      data.set("moi:wc:b", text); // a copy under another key, an altered value, a plain one
      expect(await kv.getItem("b"), text).toBeUndefined();
    }
    expect(data.get("moi:wc:a")).toBe(sealedA);
    expect(data.has("moi:wc:b")).toBe(true);
    expect(client.del).not.toHaveBeenCalled();
  });
});
