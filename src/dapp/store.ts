/**
 * Per-user sessions with MOI dapps, keyed by the same identity as the wallet
 * pairing plus the dapp's origin. A dapp that follows docs/dapp-conventions.md
 * signs a person in by having their wallet sign a message and answers with a
 * session cookie; that cookie is what lives here, so later calls to that dapp
 * act as the person. Records are stored like wallet sessions: hashed
 * filenames, 0600 files, never logged.
 *
 * Unlike wallet sessions, a record is sealed with AES-256-GCM before it
 * reaches disk or Redis (key from MOI_SESSION_KEY, see src/auth/crypto.ts), so
 * a copy of the data directory, a backup or a Redis snapshot holds no usable
 * cookie. A sealed record is bound to its slot: the sha256 of the user and
 * dapp (keyOf) is the GCM additional data, so a record copied into another
 * person's or another dapp's slot fails to open. The limits: this does not
 * stop a compromised running process, which holds the key, and an older
 * sealed record put back into its own slot would still open.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { RedisClientType } from "redis";
import { z } from "zod";

import { seal, unseal } from "../auth/crypto.js";
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
  /** Unix seconds: the dapp's own cookie lifetime, capped at a day (MAX_SESSION_SECONDS in client.ts). */
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

/** The HKDF label the dapp session key is derived under; server.ts and tests share it. */
export const DAPP_SESSION_KEY_LABEL = "dapp-session";

/** What the boot purge found: plain records it removed, sealed-or-damaged ones it kept. */
export interface DappPurge {
  /** Unencrypted records from before sealing, removed. */
  plain: number;
  /** Records that do not open with this key and are not plain: left in place. */
  unreadable: number;
}

/**
 * The two real stores. The purge is not on DappSessionStore so the fakes in
 * the tool tests, which have nothing to purge, keep compiling as they are.
 */
export interface DappSessionBackend extends DappSessionStore {
  purgePlain(): Promise<DappPurge>;
}

export function isDappSessionExpired(record: StoredDappSession, nowMs = Date.now()): boolean {
  return record.expiresAt * 1000 <= nowMs;
}

function keyOf(userId: string, baseUrl: string): string {
  return createHash("sha256").update(`${userId}\n${baseUrl.replace(/\/+$/, "")}`).digest("hex");
}

/**
 * A record read as the person's session, or undefined for anything that does
 * not open with this key in this slot, including a plain record from before
 * sealing. The read path never deletes: a mistyped key must read as signed
 * out, not wipe the store, and a delete between a read and its verdict could
 * remove a session signed in a moment ago. Removal is the boot purge's job.
 */
function open(raw: string, key: Buffer, slot: string): StoredDappSession | undefined {
  const plain = unseal(raw, key, slot);
  if (plain === undefined) {
    log("debug", "a dapp session record does not open with this key; reading it as signed out");
    return undefined;
  }
  try {
    const parsed = StoredDappSession.safeParse(JSON.parse(plain));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  log("error", "ignoring an unreadable dapp session record");
  return undefined;
}

/**
 * What the boot purge should do with a stored value. Only a value the old
 * plain schema positively accepts is "plain", so a file in some other or
 * future format, or a damaged one, is never deleted on a guess.
 */
function classify(raw: string, key: Buffer, slot: string): "open" | "plain" | "unreadable" {
  if (unseal(raw, key, slot) !== undefined) return "open";
  try {
    if (StoredDappSession.safeParse(JSON.parse(raw)).success) return "plain";
  } catch {
    /* not JSON */
  }
  return "unreadable";
}

/**
 * Remove the plain records left from before sealing, once, before the server
 * listens. Nobody is migrated: a plain record is never trusted again (anyone
 * who could write the data directory could have planted one), so those people
 * sign in again. Counts only in the log line, always written, so a wrong or
 * rotated MOI_SESSION_KEY shows at startup instead of as a silent sign-out.
 */
export async function purgeDappSessionsOnBoot(store: Pick<DappSessionBackend, "purgePlain">): Promise<DappPurge> {
  const done = await store.purgePlain();
  log(
    "info",
    `dapp sessions: removed ${done.plain} unencrypted record(s); ${done.unreadable} record(s) do not open with the current MOI_SESSION_KEY and read as signed out`,
  );
  return done;
}

/** Records as sealed JSON files under <dataDir>/dapps/<hash>.json. */
export class FileDappSessionStore implements DappSessionBackend {
  private readonly dir: string;

  /** The key is required so a store that writes plain records cannot be built. */
  constructor(
    dataDir: string,
    private readonly key: Buffer,
  ) {
    this.dir = join(dataDir, "dapps");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  async get(userId: string, baseUrl: string): Promise<StoredDappSession | undefined> {
    const slot = keyOf(userId, baseUrl);
    const file = join(this.dir, `${slot}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return open(readFileSync(file, "utf8"), this.key, slot);
    } catch {
      return undefined;
    }
  }

  async set(record: StoredDappSession): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const slot = keyOf(record.userId, record.baseUrl);
    const file = join(this.dir, `${slot}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${seal(JSON.stringify(record), this.key, slot)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async delete(userId: string, baseUrl: string): Promise<void> {
    rmSync(join(this.dir, `${keyOf(userId, baseUrl)}.json`), { force: true });
  }

  async listFor(userId: string): Promise<StoredDappSession[]> {
    const out: StoredDappSession[] = [];
    for await (const { slot, raw } of this.records()) {
      const rec = open(raw, this.key, slot);
      if (rec && rec.userId === userId) out.push(rec);
    }
    return out;
  }

  async purgePlain(): Promise<DappPurge> {
    const done: DappPurge = { plain: 0, unreadable: 0 };
    for await (const { slot, file, raw } of this.records()) {
      const kind = classify(raw, this.key, slot);
      if (kind === "plain") {
        rmSync(file, { force: true });
        done.plain++;
      } else if (kind === "unreadable") {
        // Kept: sealed under another key, or not ours to judge.
        done.unreadable++;
      }
    }
    return done;
  }

  /** Every record file, with its slot (the file name's hash). A file that cannot be read is skipped. */
  private async *records(): AsyncGenerator<{ slot: string; file: string; raw: string }> {
    if (!existsSync(this.dir)) return;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.dir, name);
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

const PREFIX = "moi:dapp:";

/** The same records in Redis, expiring with the dapp session itself. */
export class RedisDappSessionStore implements DappSessionBackend {
  constructor(
    private readonly client: RedisClientType,
    private readonly key: Buffer,
  ) {}

  async get(userId: string, baseUrl: string): Promise<StoredDappSession | undefined> {
    const slot = keyOf(userId, baseUrl);
    const raw = await this.client.get(PREFIX + slot);
    return raw === null ? undefined : open(raw, this.key, slot);
  }

  async set(record: StoredDappSession): Promise<void> {
    const slot = keyOf(record.userId, record.baseUrl);
    const ttl = Math.max(1, record.expiresAt - Math.floor(Date.now() / 1000));
    await this.client.set(PREFIX + slot, seal(JSON.stringify(record), this.key, slot), { EX: ttl });
  }

  async delete(userId: string, baseUrl: string): Promise<void> {
    await this.client.del(PREFIX + keyOf(userId, baseUrl));
  }

  async listFor(userId: string): Promise<StoredDappSession[]> {
    const out: StoredDappSession[] = [];
    for await (const { slot, raw } of this.records()) {
      const rec = open(raw, this.key, slot);
      if (rec && rec.userId === userId) out.push(rec);
    }
    return out;
  }

  async purgePlain(): Promise<DappPurge> {
    const done: DappPurge = { plain: 0, unreadable: 0 };
    for await (const { slot, redisKey, raw } of this.records()) {
      const kind = classify(raw, this.key, slot);
      if (kind === "plain") {
        await this.client.del(redisKey);
        done.plain++;
      } else if (kind === "unreadable") {
        done.unreadable++;
      }
    }
    return done;
  }

  /** Every record, with its slot (the key's hash). A value that vanished between scan and read is skipped. */
  private async *records(): AsyncGenerator<{ slot: string; redisKey: string; raw: string }> {
    for await (const key of this.client.scanIterator({ MATCH: PREFIX + "*", COUNT: 100 })) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const redisKey = k as string;
        const raw = await this.client.get(redisKey);
        if (raw === null) continue;
        yield { slot: redisKey.slice(PREFIX.length), redisKey, raw };
      }
    }
  }
}
