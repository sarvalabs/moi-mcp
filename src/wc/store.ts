/**
 * Wallet session stores backed by the filesystem, and the file-backed storage
 * the WalletConnect client keeps its own state in.
 *
 * A pairing is stored at <dataDir>/sessions/{sha256(userId)}.json, mode 0600;
 * filenames are hashed to prevent path traversal. The WalletConnect client's
 * state (its key chain, subscriptions, requests) is one file per key under
 * <dataDir>/wc.db/, laid out the way the SDK's own file storage lays it out,
 * so the files an earlier version wrote are found where they are.
 *
 * Everything in both is sealed with AES-256-GCM before it reaches disk (key
 * from MOI_SESSION_KEY, one derived key per store, src/auth/crypto.ts). The
 * record's own slot is the GCM additional data: sha256(userId) for a pairing,
 * the normalised storage key for WalletConnect state, so a record copied into
 * another slot fails to open. The limits: this does not stop a compromised
 * running process, which holds the key, and an older sealed record put back
 * into its own slot would still open.
 *
 * Records written before sealing are sealed in place, once, at boot, by
 * sealPlain() (src/wc/seal-migration.ts). The read paths never accept a plain
 * record and never delete one.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { seal, unseal } from "../auth/crypto.js";
import { log } from "../config.js";
import {
  replaceFile,
  sealValues,
  walletConnectText,
  type SealCounts,
  type StoredValue,
} from "./seal-migration.js";

/** The HKDF labels the two stores' keys are derived under (deriveKey in src/auth/crypto.ts). server.ts and the tests share them. */
export const WALLET_SESSION_KEY_LABEL = "wallet-session";
export const WC_STORAGE_KEY_LABEL = "wc-storage";

/**
 * Stored wallet session record, including version and user tracking.
 * Mandates and policy are passed through as unknown to support future extensions.
 */
export const StoredWalletSession = z.object({
  version: z.literal(1),
  userId: z.string(),
  topic: z.string(),         // WalletConnect session topic
  caip2: z.string(),          // CAIP-2 chain id
  address: z.string(),        // wallet address
  sessionData: z.unknown(),
  createdAt: z.string(),      // ISO string
  mandates: z.unknown().optional(),
  policy: z.unknown().optional(),
  /** Chosen on the pairing page. Absent on records from before lifetimes existed. */
  mode: z.enum(["persistent", "once"]).optional(),
  /** Unix seconds. Absent means: persistent, aged from createdAt (see wc/lifetime.ts). */
  expiresAt: z.number().int().optional(),
});
export type StoredWalletSession = z.infer<typeof StoredWalletSession>;

/**
 * Interface for storing and retrieving wallet sessions by user ID.
 */
export interface WalletSessionStore {
  get(userId: string): Promise<StoredWalletSession | undefined>;
  set(record: StoredWalletSession): Promise<void>;
  delete(userId: string): Promise<void>;
  findByTopic(topic: string): Promise<StoredWalletSession | undefined>;
  list(): Promise<StoredWalletSession[]>;
}

/** A person's slot: sha256(userId) in hex. The file name (without .json), the Redis key suffix, and the GCM additional data. */
export function walletSlot(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

/**
 * A pairing record read from sealed text, or undefined for anything that does
 * not open with this key in this slot, including a plain record from before
 * sealing. Never deletes: a mistyped key must read as not paired, not wipe the
 * store.
 */
export function openWalletRecord(raw: string, key: Buffer, slot: string): StoredWalletSession | undefined {
  const plain = unseal(raw, key, slot);
  if (plain === undefined) {
    log("debug", "a wallet session record does not open with this key; reading it as not paired");
    return undefined;
  }
  try {
    const parsed = StoredWalletSession.safeParse(JSON.parse(plain));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  log("error", "ignoring an unreadable wallet session record");
  return undefined;
}

/**
 * What the boot migration seals for a pairing record: the stored text itself
 * (so nothing the schema does not know is lost), when it is JSON the existing
 * schema accepts. Anything else is not a pairing record this code can vouch for.
 */
export function plainWalletRecord(raw: string): string | undefined {
  try {
    return StoredWalletSession.safeParse(JSON.parse(raw)).success ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * File-backed wallet session store.
 * - Stores sealed sessions in <dataDir>/sessions/ with 0700 permissions
 * - Each file is named after sha256(userId) in hex format to prevent path traversal
 * - Files are written atomically (write temp, rename)
 */
export class FileWalletSessionStore implements WalletSessionStore {
  private sessionsDir: string;

  /** The key is required so a store that writes plain records cannot be built. */
  constructor(
    dataDir: string,
    private readonly sealKey: Buffer,
  ) {
    this.sessionsDir = join(dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  /** A session by user ID, or undefined if missing, plain, unreadable, or sealed for another slot or key. */
  async get(userId: string): Promise<StoredWalletSession | undefined> {
    const slot = walletSlot(userId);
    const file = join(this.sessionsDir, `${slot}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return openWalletRecord(readFileSync(file, "utf8"), this.sealKey, slot);
    } catch (err) {
      log("error", `Failed to read wallet session for user ${userId}: ${String(err)}`);
      return undefined;
    }
  }

  /** Store a session record, sealed, writing atomically. */
  async set(record: StoredWalletSession): Promise<void> {
    const slot = walletSlot(record.userId);
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    replaceFile(join(this.sessionsDir, `${slot}.json`), seal(JSON.stringify(record), this.sealKey, slot));
  }

  /** Delete a session record by user ID. */
  async delete(userId: string): Promise<void> {
    rmSync(join(this.sessionsDir, `${walletSlot(userId)}.json`), { force: true });
  }

  /** Find a session by WalletConnect topic by scanning all sessions. */
  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    const sessions = await this.list();
    return sessions.find((s) => s.topic === topic);
  }

  /** Every session that opens with this key. What cannot be read is skipped. */
  async list(): Promise<StoredWalletSession[]> {
    const sessions: StoredWalletSession[] = [];
    for await (const { slot, raw } of this.records()) {
      const record = openWalletRecord(raw, this.sealKey, slot);
      if (record) sessions.push(record);
    }
    return sessions;
  }

  /** Seal the plain records left from before sealing, in place. See sealWalletStateOnBoot. */
  async sealPlain(): Promise<SealCounts> {
    return sealValues(this.sealable(), this.sealKey, plainWalletRecord);
  }

  private async *sealable(): AsyncGenerator<StoredValue> {
    for await (const { slot, file, raw } of this.records()) {
      yield { aad: slot, raw, replace: (sealed) => replaceFile(file, sealed, true) };
    }
  }

  /** Every .json file with its slot (the file name's hash). A file that cannot be read is skipped. */
  private async *records(): AsyncGenerator<{ slot: string; file: string; raw: string }> {
    if (!existsSync(this.sessionsDir)) return;
    let names: string[];
    try {
      names = await readdir(this.sessionsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.sessionsDir, name);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      yield { slot: name.slice(0, -".json".length), file, raw };
    }
  }
}

/**
 * What the SDK's own storage wrote for a value, so the SDK sees no difference:
 * JSON, a bigint as a string such as "12n" (its safeJsonStringify), and nothing
 * as an empty string. Used by both WalletConnect storages.
 */
export function wcJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)) ?? '""';
}

/**
 * unstorage's key normalisation, which the SDK's file storage applied to every
 * key before it chose a file. It is repeated here so the files an earlier
 * version wrote are found where they are: `wc@2:core:0.3//keychain` is the file
 * wc@2/core/0.3/keychain.
 */
function normalizeKey(key: string): string {
  return (key.split("?")[0] ?? "").replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "");
}

/**
 * The WalletConnect client's own state in sealed files, one file per key, in
 * the layout the SDK's file storage uses (so <dataDir>/wc.db/ is both the old
 * and the new location, and the migration seals the old files in place).
 * Implements the SDK's IKeyValueStorage shape (getKeys, getEntries, getItem,
 * setItem, removeItem). Files and folders are 0600 and 0700.
 *
 * The additional data is the normalised key, the one thing both the SDK's key
 * and a file's path give back, so a file moved to another key does not open.
 *
 * Writes are synchronous (the SDK's own were not): the write and the rename
 * then cannot interleave with another write to the same file. The cost is
 * that the event loop waits while a whole value is serialised, sealed and
 * written, and the SDK rewrites a whole value on each change.
 */
export class FileKeyValueStorage {
  /** The key is required so a store that writes plain records cannot be built. */
  constructor(
    private readonly dir: string,
    private readonly sealKey: Buffer,
  ) {
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(
        `${basename(dir)} is a file from an older WalletConnect storage layout, not a directory. ` +
          "Start the release you are upgrading from once, so its WalletConnect client converts it, " +
          "or move the file aside, then start again.",
      );
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** The file a key lives in and the normalised key (the additional data). Refuses a key that would leave the directory. */
  private locate(key: string): { file: string; name: string } {
    const name = normalizeKey(key);
    const parts = name.split(":");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("invalid WalletConnect storage key");
    }
    return { file: join(this.dir, ...parts), name };
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const { file, name } = this.locate(key);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined; // missing, or a directory
    }
    const plain = unseal(raw, this.sealKey, name);
    if (plain === undefined) {
      log("debug", "a WalletConnect state file does not open with this key; reading it as missing");
      return undefined;
    }
    try {
      return JSON.parse(plain) as T;
    } catch {
      return undefined;
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const { file, name } = this.locate(key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    replaceFile(file, seal(wcJson(value), this.sealKey, name));
  }

  async removeItem(key: string): Promise<void> {
    rmSync(this.locate(key).file, { force: true });
  }

  /** Normalised keys (colon form), as the SDK's own storage returns them. */
  async getKeys(): Promise<string[]> {
    return Array.from(this.files(), (entry) => entry.name);
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const entries: [string, T][] = [];
    for (const key of await this.getKeys()) {
      const value = await this.getItem<T>(key);
      if (value !== undefined) entries.push([key, value]);
    }
    return entries;
  }

  /**
   * Seal what the SDK wrote before sealing, in place. A file is either JSON
   * text or a bare string (the SDK writes a string value unquoted, for example
   * the client id); a bare string is sealed as its JSON string, so reading it
   * back gives the same string.
   */
  async sealPlain(): Promise<SealCounts> {
    return sealValues(this.sealable(), this.sealKey, walletConnectText);
  }

  private async *sealable(): AsyncGenerator<StoredValue> {
    for (const { name, file } of this.files()) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      yield { aad: name, raw, replace: (sealed) => replaceFile(file, sealed, true) };
    }
  }

  /**
   * Every regular file under the directory, with its normalised key. Skipped:
   * our own .tmp files, anything whose name starts with a dot (the SDK never
   * writes one, and a Finder's .DS_Store is not text to rewrite) and anything
   * that is not a regular file.
   */
  private *files(dir: string = this.dir, prefix: string[] = []): Generator<{ name: string; file: string }> {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* this.files(path, [...prefix, entry.name]);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) yield { name: [...prefix, entry.name].join(":"), file: path };
    }
  }
}
