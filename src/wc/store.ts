/**
 * Wallet session store backed by the filesystem.
 *
 * Each user's session is stored as JSON at <dataDir>/sessions/{sha256(userId).json},
 * with mode 0600. Filenames are hashed to prevent path traversal attacks.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "../config.js";
import { z } from "zod";

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

/**
 * File-backed wallet session store.
 * - Stores sessions in <dataDir>/sessions/ with 0700 permissions
 * - Each session file is named after sha256(userId) in hex format to prevent path traversal
 * - Files are written atomically (write temp, rename)
 */
export class FileWalletSessionStore implements WalletSessionStore {
  private sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Get a session by user ID, returning undefined if missing or unparsable.
   */
  async get(userId: string): Promise<StoredWalletSession | undefined> {
    const file = this.userSessionPath(userId);
    if (!existsSync(file)) return undefined;

    try {
      const data = readFileSync(file, "utf8");
      const parsed = StoredWalletSession.safeParse(JSON.parse(data));
      if (!parsed.success) {
        log("error", `Failed to parse wallet session for user ${userId}: ${parsed.error.message}`);
        return undefined;
      }
      return parsed.data;
    } catch (err) {
      log("error", `Failed to read wallet session for user ${userId}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Store a session record, writing atomically.
   */
  async set(record: StoredWalletSession): Promise<void> {
    const file = this.userSessionPath(record.userId);
    const tmpFile = `${file}.tmp`;

    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });

    // Write to temp file with 0600 permissions, then atomically rename
    writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const fs = await import("node:fs/promises");
    await fs.rename(tmpFile, file);
  }

  /**
   * Delete a session record by user ID.
   */
  async delete(userId: string): Promise<void> {
    const file = this.userSessionPath(userId);
    rmSync(file, { force: true });
  }

  /**
   * Find a session by WalletConnect topic by scanning all sessions.
   */
  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    const sessions = await this.list();
    return sessions.find((s) => s.topic === topic);
  }

  /**
   * List all stored sessions.
   */
  async list(): Promise<StoredWalletSession[]> {
    const fs = await import("node:fs/promises");
    const sessions: StoredWalletSession[] = [];

    if (!existsSync(this.sessionsDir)) return [];

    try {
      const files = await fs.readdir(this.sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(this.sessionsDir, file);
        try {
          const data = await fs.readFile(filePath, "utf8");
          const parsed = StoredWalletSession.safeParse(JSON.parse(data));
          if (parsed.success) {
            sessions.push(parsed.data);
          }
        } catch {
          // Skip unparsable files silently during list
        }
      }
    } catch {
      // If directory doesn't exist or can't be read, return empty list
    }

    return sessions;
  }

  /**
   * Get the file path for a user's session, using sha256(userId) as filename.
   * Hashing prevents path traversal attacks.
   */
  private userSessionPath(userId: string): string {
    const hash = createHash("sha256").update(userId).digest("hex");
    return join(this.sessionsDir, `${hash}.json`);
  }
}
