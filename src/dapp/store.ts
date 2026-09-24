/**
 * Per-user sessions with MOI dapps, keyed by the same identity as the wallet
 * pairing plus the dapp's origin. A dapp that follows docs/dapp-conventions.md
 * signs a person in by having their wallet sign a message and answers with a
 * session cookie; that cookie is what lives here, so later calls to that dapp
 * act as the person. Records are stored like wallet sessions: hashed
 * filenames, 0600 files, never logged.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { RedisClientType } from "redis";
import { z } from "zod";

import { log } from "../config.js";

export const StoredDappSession = z.object({
  version: z.literal(1),
  userId: z.string(),
  /** The dapp's origin exactly as signed in to. */
  baseUrl: z.string().url(),
  /** The dapp's session cookie value. */
  cookie: z.string().min(1),
  walletAddress: z.string(),
  createdAt: z.string(),
  /** Unix seconds, from the dapp's own cookie lifetime. */
  expiresAt: z.number().int(),
});
export type StoredDappSession = z.infer<typeof StoredDappSession>;

export interface DappSessionStore {
  get(userId: string, baseUrl: string): Promise<StoredDappSession | undefined>;
  set(record: StoredDappSession): Promise<void>;
  delete(userId: string, baseUrl: string): Promise<void>;
  /** Every dapp this user is signed in to. */
  listFor(userId: string): Promise<StoredDappSession[]>;
}

export function isDappSessionExpired(record: StoredDappSession, nowMs = Date.now()): boolean {
  return record.expiresAt * 1000 <= nowMs;
}

function keyOf(userId: string, baseUrl: string): string {
  return createHash("sha256").update(`${userId}\n${baseUrl.replace(/\/+$/, "")}`).digest("hex");
}

function parse(raw: string): StoredDappSession | undefined {
  try {
    const parsed = StoredDappSession.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  log("error", "ignoring an unreadable dapp session record");
  return undefined;
}

/** Records as JSON files under <dataDir>/dapps/<hash>.json. */
export class FileDappSessionStore implements DappSessionStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "dapps");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  async get(userId: string, baseUrl: string): Promise<StoredDappSession | undefined> {
    const file = join(this.dir, `${keyOf(userId, baseUrl)}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  async set(record: StoredDappSession): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${keyOf(record.userId, record.baseUrl)}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async delete(userId: string, baseUrl: string): Promise<void> {
    rmSync(join(this.dir, `${keyOf(userId, baseUrl)}.json`), { force: true });
  }

  async listFor(userId: string): Promise<StoredDappSession[]> {
    if (!existsSync(this.dir)) return [];
    const out: StoredDappSession[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = parse(await readFile(join(this.dir, name), "utf8"));
        if (rec && rec.userId === userId) out.push(rec);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

const PREFIX = "moi:dapp:";

/** The same records in Redis, expiring with the dapp session itself. */
export class RedisDappSessionStore implements DappSessionStore {
  constructor(private readonly client: RedisClientType) {}

  async get(userId: string, baseUrl: string): Promise<StoredDappSession | undefined> {
    const raw = await this.client.get(PREFIX + keyOf(userId, baseUrl));
    return raw === null ? undefined : parse(raw);
  }

  async set(record: StoredDappSession): Promise<void> {
    const ttl = Math.max(1, record.expiresAt - Math.floor(Date.now() / 1000));
    await this.client.set(PREFIX + keyOf(record.userId, record.baseUrl), JSON.stringify(record), { EX: ttl });
  }

  async delete(userId: string, baseUrl: string): Promise<void> {
    await this.client.del(PREFIX + keyOf(userId, baseUrl));
  }

  async listFor(userId: string): Promise<StoredDappSession[]> {
    const out: StoredDappSession[] = [];
    for await (const key of this.client.scanIterator({ MATCH: PREFIX + "*", COUNT: 100 })) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const raw = await this.client.get(k as string);
        if (raw === null) continue;
        const rec = parse(raw);
        if (rec && rec.userId === userId) out.push(rec);
      }
    }
    return out;
  }
}
