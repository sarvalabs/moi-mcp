/**
 * Redis-backed wallet sessions and WalletConnect SDK storage.
 *
 * The file-backed store ties the server to one machine with one disk. That is
 * fine on a VM and awkward everywhere else: a container that gets replaced
 * loses every pairing, and every user has to scan a QR again. Moving both
 * stores to Redis makes the process disposable.
 *
 * Two stores live here because session state lives in two places:
 *
 *  - RedisWalletSessionStore holds our own record of which wallet belongs to
 *    which authenticated user.
 *  - RedisKeyValueStorage holds WalletConnect's internal state, which the SDK
 *    exposes as a pluggable IKeyValueStorage. Without this second one, another
 *    instance would know a user's topic but not the key material behind it, so
 *    it still could not sign for them.
 *
 * What is in here is sensitive. A session record carries the symmetric key that
 * lets the holder raise a signing prompt on somebody's phone, so this Redis
 * wants auth, TLS, and no shared tenancy with cache workloads. It also wants
 * persistence enabled: a Redis run as a pure cache comes back empty and
 * silently un-pairs everyone.
 */

import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import { log } from "../config.js";
import { StoredWalletSession, type WalletSessionStore } from "./store.js";

/** Namespace for our own session records. */
const SESSION_PREFIX = "moi:session:";
/** Secondary index so findByTopic is a key read rather than a scan of every session. */
const TOPIC_PREFIX = "moi:topic:";
/** Namespace for the WalletConnect SDK's own key/value state. */
const WC_PREFIX = "moi:wc:";

/** Hashed so a userId can never shape the key beyond its own namespace. */
function userKey(userId: string): string {
  return SESSION_PREFIX + createHash("sha256").update(userId).digest("hex");
}

/**
 * Opens a Redis connection and fails loudly if it cannot.
 *
 * Deliberately not lazy: a server that starts happily and only discovers at
 * the first write that it has nowhere to read sessions from is worse than one
 * that refuses to boot.
 */
export async function connectRedis(url: string): Promise<RedisClientType> {
  const client: RedisClientType = createClient({ url });
  client.on("error", (err) => {
    // Never log the URL; it carries the password.
    log("error", `redis connection error: ${err instanceof Error ? err.message : String(err)}`);
  });
  await client.connect();
  return client;
}

/**
 * Wallet sessions in Redis, same contract as the file store.
 */
export class RedisWalletSessionStore implements WalletSessionStore {
  constructor(private readonly client: RedisClientType) {}

  async get(userId: string): Promise<StoredWalletSession | undefined> {
    const raw = await this.client.get(userKey(userId));
    if (raw === null) return undefined;
    return this.parse(raw, userId);
  }

  async set(record: StoredWalletSession): Promise<void> {
    const previous = await this.get(record.userId);
    const multi = this.client.multi();
    multi.set(userKey(record.userId), JSON.stringify(record));
    multi.set(TOPIC_PREFIX + record.topic, record.userId);
    // Re-pairing gives the user a new topic; drop the old index entry so a
    // relay event for the dead topic cannot resolve back to them.
    if (previous && previous.topic !== record.topic) {
      multi.del(TOPIC_PREFIX + previous.topic);
    }
    await multi.exec();
  }

  async delete(userId: string): Promise<void> {
    const existing = await this.get(userId);
    const multi = this.client.multi();
    multi.del(userKey(userId));
    if (existing) multi.del(TOPIC_PREFIX + existing.topic);
    await multi.exec();
  }

  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    const userId = await this.client.get(TOPIC_PREFIX + topic);
    if (userId === null) return undefined;
    const record = await this.get(userId);
    // A stale index entry is not an error; it just means the session went away
    // between the two reads.
    return record && record.topic === topic ? record : undefined;
  }

  async list(): Promise<StoredWalletSession[]> {
    const out: StoredWalletSession[] = [];
    for await (const key of this.client.scanIterator({ MATCH: SESSION_PREFIX + "*", COUNT: 100 })) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const raw = await this.client.get(k as string);
        if (raw === null) continue;
        const parsed = this.parse(raw, k as string);
        if (parsed) out.push(parsed);
      }
    }
    return out;
  }

  /** A record we cannot read is skipped with a warning, never thrown, so one
   *  corrupt value cannot take down every lookup. */
  private parse(raw: string, hint: string): StoredWalletSession | undefined {
    try {
      const parsed = StoredWalletSession.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      log("error", `ignoring unreadable wallet session record (${hint.slice(0, 24)})`);
      return undefined;
    } catch {
      log("error", `ignoring unparsable wallet session record (${hint.slice(0, 24)})`);
      return undefined;
    }
  }
}

/**
 * WalletConnect's own state in Redis.
 *
 * Implements the SDK's IKeyValueStorage shape (getKeys, getEntries, getItem,
 * setItem, removeItem) so `SignClient.init({ storage })` keeps its keychain,
 * subscriptions and session data somewhere every instance can reach.
 */
export class RedisKeyValueStorage {
  constructor(private readonly client: RedisClientType) {}

  async getKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of this.client.scanIterator({ MATCH: WC_PREFIX + "*", COUNT: 100 })) {
      const batch = Array.isArray(key) ? key : [key];
      for (const k of batch) keys.push((k as string).slice(WC_PREFIX.length));
    }
    return keys;
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const entries: [string, T][] = [];
    for (const key of await this.getKeys()) {
      const value = await this.getItem<T>(key);
      if (value !== undefined) entries.push([key, value]);
    }
    return entries;
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(WC_PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.client.set(WC_PREFIX + key, JSON.stringify(value));
  }

  async removeItem(key: string): Promise<void> {
    await this.client.del(WC_PREFIX + key);
  }
}
