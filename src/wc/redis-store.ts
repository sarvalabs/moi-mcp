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
 * What is in here is sensitive, and both stores seal it before it reaches
 * Redis (AES-256-GCM, a key per store derived from MOI_SESSION_KEY, see
 * src/auth/crypto.ts; the key name is the additional data). The session record
 * holds a topic, an address and a user id and no key. The WalletConnect state
 * holds the symmetric key of every pairing and the relay identity, which is
 * what lets the holder raise a signing prompt on somebody's phone, so that is
 * the half that matters. Sealing means a snapshot, a replica or a backup of this
 * Redis is not enough to read either. It does not make an open Redis safe:
 * anyone who can reach it can still delete or replace values, so it still wants
 * auth, TLS, and no shared tenancy with cache workloads. It also wants
 * persistence enabled: a Redis run as a pure cache comes back empty and
 * silently un-pairs everyone. One value stays in the clear: the topic index
 * (moi:topic:<topic>, whose value is a user id). It holds no key and is useless
 * without the sealed state, so it is not worth a migration of its own.
 *
 * Values written before sealing are sealed in place at boot by sealPlain()
 * (src/wc/seal-migration.ts). A plain value is never read afterwards, and a
 * read never deletes anything.
 */

import { createClient, type RedisClientType } from "redis";

import { seal, unseal } from "../auth/crypto.js";
import { log } from "../config.js";
import { sealValues, walletConnectText, type SealCounts, type StoredValue } from "./seal-migration.js";
import {
  openWalletRecord,
  plainWalletRecord,
  walletSlot,
  wcJson,
  type StoredWalletSession,
  type WalletSessionStore,
} from "./store.js";

/** Namespace for our own session records. */
const SESSION_PREFIX = "moi:session:";
/** Secondary index so findByTopic is a key read rather than a scan of every session. */
const TOPIC_PREFIX = "moi:topic:";
/** Namespace for the WalletConnect SDK's own key/value state. */
const WC_PREFIX = "moi:wc:";

/** Hashed so a userId can never shape the key beyond its own namespace. */
function userKey(userId: string): string {
  return SESSION_PREFIX + walletSlot(userId);
}

/** Every key under a prefix. node-redis 4 yields keys one at a time, 5 and 6 yield arrays of them. */
async function* scanKeys(client: RedisClientType, prefix: string): AsyncGenerator<string> {
  for await (const found of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    const batch = Array.isArray(found) ? found : [found];
    for (const key of batch) yield key as string;
  }
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
 * Wallet sessions in Redis, same contract as the file store. Each record is
 * sealed, with its slot (the hash in its key) as the additional data.
 */
export class RedisWalletSessionStore implements WalletSessionStore {
  /** The key is required so a store that writes plain records cannot be built. */
  constructor(
    private readonly client: RedisClientType,
    private readonly sealKey: Buffer,
  ) {}

  async get(userId: string): Promise<StoredWalletSession | undefined> {
    const raw = await this.client.get(userKey(userId));
    if (raw === null) return undefined;
    return openWalletRecord(raw, this.sealKey, walletSlot(userId));
  }

  async set(record: StoredWalletSession): Promise<void> {
    const previous = await this.get(record.userId);
    const multi = this.client.multi();
    multi.set(userKey(record.userId), seal(JSON.stringify(record), this.sealKey, walletSlot(record.userId)));
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

  /** Every record that opens with this key. One that does not is skipped, never thrown, so it cannot take down every lookup. */
  async list(): Promise<StoredWalletSession[]> {
    const out: StoredWalletSession[] = [];
    for await (const key of scanKeys(this.client, SESSION_PREFIX)) {
      const raw = await this.client.get(key);
      if (raw === null) continue;
      const record = openWalletRecord(raw, this.sealKey, key.slice(SESSION_PREFIX.length));
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * Seal the plain records left from before sealing, in place. One SET puts a
   * value in place atomically. A SET also clears any expiry, and these keys
   * were never written with one.
   */
  async sealPlain(): Promise<SealCounts> {
    return sealValues(this.sealable(), this.sealKey, plainWalletRecord);
  }

  private async *sealable(): AsyncGenerator<StoredValue> {
    for await (const key of scanKeys(this.client, SESSION_PREFIX)) {
      const raw = await this.client.get(key);
      if (raw === null) continue;
      yield {
        aad: key.slice(SESSION_PREFIX.length),
        raw,
        replace: async (sealed) => {
          await this.client.set(key, sealed);
        },
      };
    }
  }
}

/**
 * WalletConnect's own state in Redis.
 *
 * Implements the SDK's IKeyValueStorage shape (getKeys, getEntries, getItem,
 * setItem, removeItem) so `SignClient.init({ storage })` keeps its keychain,
 * subscriptions and session data somewhere every instance can reach. Values
 * are sealed under a key derived for WalletConnect state, with the key name
 * (without the moi:wc: prefix) as the additional data.
 */
export class RedisKeyValueStorage {
  /** The key is required so a store that writes plain values cannot be built. */
  constructor(
    private readonly client: RedisClientType,
    private readonly sealKey: Buffer,
  ) {}

  async getKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of scanKeys(this.client, WC_PREFIX)) keys.push(key.slice(WC_PREFIX.length));
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
    const plain = unseal(raw, this.sealKey, key);
    if (plain === undefined) {
      log("debug", "a WalletConnect state value does not open with this key; reading it as missing");
      return undefined;
    }
    try {
      return JSON.parse(plain) as T;
    } catch {
      return undefined;
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.client.set(WC_PREFIX + key, seal(wcJson(value), this.sealKey, key));
  }

  async removeItem(key: string): Promise<void> {
    await this.client.del(WC_PREFIX + key);
  }

  /** Seal the plain values the SDK wrote before sealing. They are JSON text, as this class always wrote them. */
  async sealPlain(): Promise<SealCounts> {
    return sealValues(this.sealable(), this.sealKey, walletConnectText);
  }

  private async *sealable(): AsyncGenerator<StoredValue> {
    for await (const key of scanKeys(this.client, WC_PREFIX)) {
      const raw = await this.client.get(key);
      if (raw === null) continue;
      yield {
        aad: key.slice(WC_PREFIX.length),
        raw,
        replace: async (sealed) => {
          await this.client.set(key, sealed);
        },
      };
    }
  }
}
