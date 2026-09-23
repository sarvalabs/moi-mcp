/**
 * Per-user MOI Agent Launchpad sessions.
 *
 * Signing in to the Launchpad with the paired wallet yields its session
 * cookie, a signed JWT the Launchpad honours for seven days. The connector
 * keeps that cookie here, keyed by the same identity as the wallet pairing,
 * so later Launchpad calls act as the person without a browser in the loop.
 *
 * The cookie is bearer-equivalent for everything the Launchpad lets an owner
 * do (create agents, fetch setup scripts that embed agent keys), so records
 * get the same treatment as wallet sessions: hashed filenames, 0600 files,
 * never logged.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { RedisClientType } from "redis";
import { z } from "zod";

import { log } from "../config.js";

export const StoredLaunchpadSession = z.object({
  version: z.literal(1),
  userId: z.string(),
  /** The Launchpad the cookie belongs to; a session for one deployment is meaningless at another. */
  baseUrl: z.string().url(),
  /** Value of the Launchpad's session cookie. Treated as a secret. */
  cookie: z.string().min(1),
  /** The wallet the session was signed in with. */
  walletAddress: z.string(),
  createdAt: z.string(),
  /** Unix seconds, from the Launchpad's own cookie lifetime. */
  expiresAt: z.number().int(),
});
export type StoredLaunchpadSession = z.infer<typeof StoredLaunchpadSession>;

export interface LaunchpadSessionStore {
  get(userId: string): Promise<StoredLaunchpadSession | undefined>;
  set(record: StoredLaunchpadSession): Promise<void>;
  delete(userId: string): Promise<void>;
}

export function isLaunchpadSessionExpired(record: StoredLaunchpadSession, nowMs = Date.now()): boolean {
  return record.expiresAt * 1000 <= nowMs;
}

function hashedId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

/** Records as JSON files under <dataDir>/launchpad/<sha256(userId)>.json, like the wallet store. */
export class FileLaunchpadSessionStore implements LaunchpadSessionStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "launchpad");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  async get(userId: string): Promise<StoredLaunchpadSession | undefined> {
    const file = this.pathFor(userId);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = StoredLaunchpadSession.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        log("error", `ignoring unreadable launchpad session for ${hashedId(userId).slice(0, 12)}`);
        return undefined;
      }
      return parsed.data;
    } catch {
      log("error", `ignoring unparsable launchpad session for ${hashedId(userId).slice(0, 12)}`);
      return undefined;
    }
  }

  async set(record: StoredLaunchpadSession): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.pathFor(record.userId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async delete(userId: string): Promise<void> {
    rmSync(this.pathFor(userId), { force: true });
  }

  private pathFor(userId: string): string {
    return join(this.dir, `${hashedId(userId)}.json`);
  }
}

const REDIS_PREFIX = "moi:launchpad:";

/** The same records in Redis, expiring with the Launchpad session itself. */
export class RedisLaunchpadSessionStore implements LaunchpadSessionStore {
  constructor(private readonly client: RedisClientType) {}

  async get(userId: string): Promise<StoredLaunchpadSession | undefined> {
    const raw = await this.client.get(REDIS_PREFIX + hashedId(userId));
    if (raw === null) return undefined;
    try {
      const parsed = StoredLaunchpadSession.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
    log("error", `ignoring unreadable launchpad session for ${hashedId(userId).slice(0, 12)}`);
    return undefined;
  }

  async set(record: StoredLaunchpadSession): Promise<void> {
    const ttl = Math.max(1, record.expiresAt - Math.floor(Date.now() / 1000));
    await this.client.set(REDIS_PREFIX + hashedId(record.userId), JSON.stringify(record), { EX: ttl });
  }

  async delete(userId: string): Promise<void> {
    await this.client.del(REDIS_PREFIX + hashedId(userId));
  }
}
