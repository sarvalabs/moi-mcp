/**
 * What differs per backend in the boot migration: how a plain value is found,
 * where its sealed copy goes, the additional data it is bound to, the file
 * mode, and what a failed replacement leaves. The counting rules themselves are
 * tested once, in seal-migration.test.ts. The same cases run against the four
 * stores through one small harness.
 */
import { KeyValueStorage } from "@walletconnect/keyvaluestorage";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, type Mock } from "vitest";

import { unseal } from "../../src/auth/crypto.js";
import { RedisKeyValueStorage, RedisWalletSessionStore } from "../../src/wc/redis-store.js";
import type { SealPlainStore } from "../../src/wc/seal-migration.js";
import { FileKeyValueStorage, FileWalletSessionStore, walletSlot, type WalletSessionStore } from "../../src/wc/store.js";
import { fakeRedis } from "../helpers/fake-redis.js";
import { session, walletKey, wcKey } from "../helpers/hosted.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-seal-backend-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ZERO = { sealed: 0, alreadySealed: 0, unreadable: 0, failed: 0 };

function flipped(sealed: string): string {
  const o = JSON.parse(sealed) as Record<string, string>;
  const bytes = Buffer.from(o["tag"]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return JSON.stringify({ ...o, tag: bytes.toString("base64url") });
}

/** One backend, with slot numbers instead of its own names. */
interface Harness {
  key: Buffer;
  otherKey: Buffer;
  /** A store on this backend's data, sealing under `key`. */
  open(key: Buffer): SealPlainStore;
  /** Put a plain value in slot n as the version before sealing wrote it: its stored text, and what a read gives once sealed. */
  plant(n: number): { text: string; expected: unknown };
  /** Put a sealed value in slot n through a real store built with `key`. */
  sealed(n: number, key: Buffer): Promise<void>;
  /** Overwrite slot n's stored text. */
  put(n: number, text: string): void;
  /** The stored text of slot n, or undefined. */
  raw(n: number): string | undefined;
  /** The store's own read of slot n under `key`. */
  read(n: number, key: Buffer): Promise<unknown>;
  /** The additional data slot n is sealed under. */
  aad(n: number): string;
  /** Make putting a sealed copy in slot n fail, as a full disk would. Returns the undo. */
  blockReplace(n: number): () => void;
  /** The file mode of slot n, for the file backends. */
  mode?(n: number): number;
}

const user = (n: number) => `user-${n}`;
const plainRecord = (n: number) =>
  session({
    userId: user(n),
    topic: `topic-${n}`,
    createdAt: "2026-01-01T00:00:00.000Z", // fixed, so two calls give equal records
    mode: "once",
    expiresAt: 1_900_000_000 + n,
    sessionData: { peer: `peer-${n}` },
  });

function fileSessions(): Harness & { sessionsDir: string } {
  const dir = freshDir();
  const file = (n: number) => join(dir, "sessions", `${walletSlot(user(n))}.json`);
  return {
    sessionsDir: join(dir, "sessions"),
    key: walletKey(),
    otherKey: walletKey("o".repeat(44)),
    open: (key) => new FileWalletSessionStore(dir, key),
    plant(n) {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      // The old form: pretty JSON, plus a field this code does not know, which must survive.
      const text = `${JSON.stringify({ ...plainRecord(n), futureField: 1 }, null, 2)}\n`;
      writeFileSync(file(n), text);
      chmodSync(file(n), 0o644);
      return { text, expected: plainRecord(n) };
    },
    sealed: (n, key) => new FileWalletSessionStore(dir, key).set(plainRecord(n)),
    put(n, text) {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(file(n), text);
    },
    raw: (n) => (existsSync(file(n)) ? readFileSync(file(n), "utf8") : undefined),
    read: (n, key) => new FileWalletSessionStore(dir, key).get(user(n)),
    aad: (n) => walletSlot(user(n)),
    blockReplace(n) {
      mkdirSync(`${file(n)}.tmp`); // a directory where the temporary file must go
      return () => rmSync(`${file(n)}.tmp`, { recursive: true });
    },
    mode: (n) => statSync(file(n)).mode & 0o777,
  };
}

/** Make the next sets of one key fail on a fake Redis, as a full disk or a dropped connection would. */
function failSetOf(fake: ReturnType<typeof fakeRedis>, target: string): () => void {
  const set = fake.client.set as unknown as Mock;
  const real = set.getMockImplementation()!;
  set.mockImplementation(async (key: string, ...rest: unknown[]) => {
    if (key === target) throw new Error("disk full");
    return real(key, ...rest);
  });
  return () => set.mockImplementation(real);
}

function redisSessions(): Harness {
  const fake = fakeRedis();
  const redisKey = (n: number) => `moi:session:${walletSlot(user(n))}`;
  return {
    key: walletKey(),
    otherKey: walletKey("o".repeat(44)),
    open: (key) => new RedisWalletSessionStore(fake.client, key),
    plant(n) {
      const text = JSON.stringify({ ...plainRecord(n), futureField: 1 });
      fake.data.set(redisKey(n), text);
      fake.data.set(`moi:topic:topic-${n}`, user(n));
      return { text, expected: plainRecord(n) };
    },
    sealed: (n, key) => new RedisWalletSessionStore(fake.client, key).set(plainRecord(n)),
    put: (n, text) => void fake.data.set(redisKey(n), text),
    raw: (n) => fake.data.get(redisKey(n)),
    read: (n, key) => new RedisWalletSessionStore(fake.client, key).get(user(n)),
    aad: (n) => walletSlot(user(n)),
    blockReplace: (n) => failSetOf(fake, redisKey(n)),
  };
}

const sdkKey = (n: number) => `wc@2:core:0.3//item${n}`;

function fileWc(): Harness {
  const wcDir = join(freshDir(), "wc.db");
  const file = (n: number) => join(wcDir, "wc@2", "core", "0.3", `item${n}`);
  return {
    key: wcKey(),
    otherKey: wcKey("o".repeat(44)),
    open: (key) => new FileKeyValueStorage(wcDir, key),
    plant(n) {
      mkdirSync(dirname(file(n)), { recursive: true });
      const text = JSON.stringify({ n });
      writeFileSync(file(n), text);
      chmodSync(file(n), 0o644); // what the SDK's files were
      return { text, expected: { n } };
    },
    sealed: (n, key) => new FileKeyValueStorage(wcDir, key).setItem(sdkKey(n), { n }),
    put(n, text) {
      mkdirSync(dirname(file(n)), { recursive: true });
      writeFileSync(file(n), text);
    },
    raw: (n) => (existsSync(file(n)) ? readFileSync(file(n), "utf8") : undefined),
    read: (n, key) => new FileKeyValueStorage(wcDir, key).getItem(sdkKey(n)),
    aad: (n) => `wc@2:core:0.3:item${n}`, // the normalised key
    blockReplace(n) {
      mkdirSync(`${file(n)}.tmp`);
      return () => rmSync(`${file(n)}.tmp`, { recursive: true });
    },
    mode: (n) => statSync(file(n)).mode & 0o777,
  };
}

function redisWc(): Harness {
  const fake = fakeRedis();
  const redisKey = (n: number) => `moi:wc:${sdkKey(n)}`;
  return {
    key: wcKey(),
    otherKey: wcKey("o".repeat(44)),
    open: (key) => new RedisKeyValueStorage(fake.client, key),
    plant(n) {
      const text = JSON.stringify({ n });
      fake.data.set(redisKey(n), text);
      return { text, expected: { n } };
    },
    sealed: (n, key) => new RedisKeyValueStorage(fake.client, key).setItem(sdkKey(n), { n }),
    put: (n, text) => void fake.data.set(redisKey(n), text),
    raw: (n) => fake.data.get(redisKey(n)),
    read: (n, key) => new RedisKeyValueStorage(fake.client, key).getItem(sdkKey(n)),
    aad: (n) => sdkKey(n), // the key without the moi:wc: prefix
    blockReplace: (n) => failSetOf(fake, redisKey(n)),
  };
}

describe.each([
  ["pairing records, files", fileSessions],
  ["pairing records, Redis", redisSessions],
  ["WalletConnect state, files", fileWc],
  ["WalletConnect state, Redis", redisWc],
])("sealing in place: %s", (_name, make) => {
  it("seals a plain value where it is, binds it to its slot, and reads it as before", async () => {
    const h = make();
    const { text, expected } = h.plant(1);
    expect(await h.read(1, h.key)).toBeUndefined(); // plain is not read once sealing is in

    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, sealed: 1 });

    expect(await h.read(1, h.key)).toEqual(expected);
    expect(unseal(h.raw(1)!, h.key, h.aad(1))).toBe(text); // from its own text, nothing lost
    if (h.mode) expect(h.mode(1)).toBe(0o600); // a 0644 file is 0600 now
  });

  it("does not open a sealed value moved to another slot", async () => {
    const h = make();
    await h.sealed(1, h.key);
    h.put(2, h.raw(1)!);
    expect(await h.read(2, h.key)).toBeUndefined();
    expect(await h.read(1, h.key)).toBeDefined();
  });

  it("leaves a value that is already sealed alone, byte for byte", async () => {
    const h = make();
    await h.sealed(1, h.key);
    const before = h.raw(1);
    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, alreadySealed: 1 });
    expect(h.raw(1)).toBe(before);
  });

  it("keeps a value sealed under another key, counts it, and the other key still reads it", async () => {
    const h = make();
    await h.sealed(1, h.otherKey);
    const before = h.raw(1);
    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, unreadable: 1 });
    expect(h.raw(1)).toBe(before);
    expect(await h.read(1, h.otherKey)).toBeDefined();
  });

  it("handles a mix, and a second run changes no byte", async () => {
    const h = make();
    h.plant(1);
    h.plant(2);
    await h.sealed(3, h.key);
    await h.sealed(4, h.otherKey);
    await h.sealed(5, h.key);
    h.put(5, flipped(h.raw(5)!));

    expect(await h.open(h.key).sealPlain()).toEqual({ sealed: 2, alreadySealed: 1, unreadable: 2, failed: 0 });
    const after = [1, 2, 3, 4, 5].map((n) => h.raw(n));
    expect(after.every((t) => t !== undefined)).toBe(true); // nothing was deleted
    expect(await h.read(1, h.key)).toBeDefined();
    expect(await h.read(2, h.key)).toBeDefined();

    expect(await h.open(h.key).sealPlain()).toEqual({ sealed: 0, alreadySealed: 3, unreadable: 2, failed: 0 });
    expect([1, 2, 3, 4, 5].map((n) => h.raw(n))).toEqual(after);
  });

  it("keeps the plain value when its sealed copy cannot be put in place, and finishes on the next run", async () => {
    const h = make();
    const { text } = h.plant(1);
    h.plant(2);
    const undo = h.blockReplace(1);

    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, sealed: 1, failed: 1 });
    expect(h.raw(1)).toBe(text); // exactly as it was
    expect(await h.read(2, h.key)).toBeDefined();

    undo();
    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, sealed: 1, alreadySealed: 1 });
    expect(await h.read(1, h.key)).toBeDefined();
  });

  it("gives all zeros for an empty store", async () => {
    const h = make();
    expect(await h.open(h.key).sealPlain()).toEqual(ZERO);
  });
});

// ---------------------------------------------------------------------------
// Pairing records: what only they have
// ---------------------------------------------------------------------------

describe.each([
  ["files", fileSessions],
  ["Redis", redisSessions],
])("pairing records, %s", (_name, make) => {
  const store = (h: Harness) => h.open(h.key) as SealPlainStore & WalletSessionStore;

  it("keeps text that is not a pairing record, counts it, and deletes nothing", async () => {
    const h = make();
    const texts = ['{"version":1}', "{", "[]", ""];
    texts.forEach((text, i) => h.put(i + 1, text));
    expect(await store(h).sealPlain()).toEqual({ ...ZERO, unreadable: texts.length });
    texts.forEach((text, i) => expect(h.raw(i + 1)).toBe(text));
  });

  it("keeps the lifetime fields, and every lookup works as before", async () => {
    const h = make();
    [1, 2, 3].forEach((n) => h.plant(n));
    const s = store(h);
    await s.sealPlain();

    expect(await s.get(user(2))).toMatchObject({ mode: "once", expiresAt: 1_900_000_002, topic: "topic-2" });
    expect((await s.findByTopic("topic-3"))?.userId).toBe(user(3));
    expect((await s.list()).map((r) => r.userId).sort()).toEqual([user(1), user(2), user(3)]);
    await s.delete(user(1));
    expect(await s.get(user(1))).toBeUndefined();
    expect((await s.list()).map((r) => r.userId).sort()).toEqual([user(2), user(3)]);
  });
});

describe("pairing records in files: temporary files", () => {
  it("seals a plain record beside a stale temporary copy, and leaves none behind", async () => {
    const h = fileSessions();
    const { text } = h.plant(1);
    writeFileSync(join(h.sessionsDir, `${walletSlot(user(1))}.json.tmp`), text); // what an interrupted older write left

    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, sealed: 1 });
    expect(readdirSync(h.sessionsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await h.read(1, h.key)).toBeDefined();
  });

  it("neither reads nor counts a stale temporary copy that has no record", async () => {
    const h = fileSessions();
    await h.sealed(1, h.key);
    writeFileSync(join(h.sessionsDir, "stale.json.tmp"), "{}");
    expect(await h.open(h.key).sealPlain()).toEqual({ ...ZERO, alreadySealed: 1 });
  });
});

// ---------------------------------------------------------------------------
// WalletConnect state: what only it has
// ---------------------------------------------------------------------------

describe("WalletConnect state in files", () => {
  it("seals what the SDK's own storage wrote, in its layout, and the values read back as the SDK read them", async () => {
    const root = freshDir();
    const dir = join(root, "wc.db");
    const sdk = new KeyValueStorage({ database: dir });
    const keychain = { topicA: "key-a", client_ed25519_seed: "seed" };
    await sdk.setItem("wc@2:core:0.3//keychain", keychain);
    await sdk.setItem("wc@2:client:0.3//session", [{ topic: "t", expiry: 1_700_000_000 }]);
    await sdk.setItem("WALLETCONNECT_CLIENT_ID", "did:key:z6MkTestOnly"); // written unquoted

    const kv = new FileKeyValueStorage(dir, wcKey());
    expect(await kv.getItem("wc@2:core:0.3//keychain")).toBeUndefined(); // plain is not read
    expect(await kv.sealPlain()).toEqual({ ...ZERO, sealed: 3 });

    expect(await kv.getItem("wc@2:core:0.3//keychain")).toEqual(keychain);
    expect(await kv.getItem("wc@2:client:0.3//session")).toEqual([{ topic: "t", expiry: 1_700_000_000 }]);
    expect(await kv.getItem("WALLETCONNECT_CLIENT_ID")).toBe("did:key:z6MkTestOnly");
    expect((await kv.getKeys()).sort()).toEqual(["WALLETCONNECT_CLIENT_ID", "wc@2:client:0.3:session", "wc@2:core:0.3:keychain"]);
    expect(readFileSync(join(dir, "wc@2", "core", "0.3", "keychain"), "utf8")).not.toContain("key-a");
  });

  it("seals a bare string, an empty file and a number as the SDK read them, and ignores a stray temporary file or dot file", async () => {
    const dir = join(freshDir(), "wc.db");
    mkdirSync(join(dir, "wc@2", "core", "0.3"), { recursive: true });
    writeFileSync(join(dir, "bare"), "did:key:z6MkTestOnly");
    writeFileSync(join(dir, "empty"), "");
    writeFileSync(join(dir, "wc@2", "core", "0.3", "num"), "123");
    writeFileSync(join(dir, "wc@2", "core", "0.3", "x.tmp"), "left over");
    writeFileSync(join(dir, ".DS_Store"), "\u0000\u0001");

    const kv = new FileKeyValueStorage(dir, wcKey());
    expect(await kv.sealPlain()).toEqual({ ...ZERO, sealed: 3 });
    expect(await kv.getItem("bare")).toBe("did:key:z6MkTestOnly");
    expect(await kv.getItem("empty")).toBe("");
    expect(await kv.getItem("wc@2:core:0.3//num")).toBe(123);
    expect(readFileSync(join(dir, "wc@2", "core", "0.3", "x.tmp"), "utf8")).toBe("left over");
    expect(readFileSync(join(dir, ".DS_Store"), "utf8")).toBe("\u0000\u0001");
  });

  it("gives all zeros on a fresh deployment, where wc.db does not exist yet", async () => {
    const dir = join(freshDir(), "wc.db");
    expect(await new FileKeyValueStorage(dir, wcKey()).sealPlain()).toEqual(ZERO);
  });
});

describe("WalletConnect state in Redis", () => {
  it("seals text that is not JSON as a string, the way a bare file value is", async () => {
    const { client, data } = fakeRedis();
    data.set("moi:wc:WALLETCONNECT_CLIENT_ID", "did:key:z6MkTestOnly");
    const kv = new RedisKeyValueStorage(client, wcKey());
    expect(await kv.sealPlain()).toEqual({ ...ZERO, sealed: 1 });
    expect(await kv.getItem("WALLETCONNECT_CLIENT_ID")).toBe("did:key:z6MkTestOnly");
  });
});
