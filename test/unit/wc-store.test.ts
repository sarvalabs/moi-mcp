import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileWalletSessionStore, type StoredWalletSession } from "../../src/wc/store.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-store-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function testSession(userId: string = "user123", overrides: Partial<StoredWalletSession> = {}): StoredWalletSession {
  return {
    version: 1,
    userId,
    topic: "wc-topic-abc",
    caip2: "moi:14",
    address: "0xabc123",
    sessionData: { some: "data" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("FileWalletSessionStore", () => {
  describe("set and get", () => {
    it("round-trips a session through disk", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);
      const session = testSession("user1");

      await store.set(session);
      const retrieved = await store.get("user1");

      expect(retrieved).toEqual(session);
    });

    it("returns undefined for missing sessions", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const result = await store.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns undefined for corrupt files", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      // Write bad JSON directly to the sessions directory
      const sessionsDir = join(dir, "sessions");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(sessionsDir, `${hash}.json`);

      require("node:fs").mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
      require("node:fs").writeFileSync(filePath, "{not valid json", { mode: 0o600 });

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });

    it("returns undefined for files that don't match schema", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      // Write valid JSON but missing required fields
      const sessionsDir = join(dir, "sessions");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(sessionsDir, `${hash}.json`);

      require("node:fs").mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
      require("node:fs").writeFileSync(filePath, JSON.stringify({ version: 1 }), { mode: 0o600 });

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });

    it("creates sessions directory with 0700 permissions", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);
      const sessionsDir = join(dir, "sessions");

      await store.set(testSession("user1"));

      const stat = statSync(sessionsDir);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it("stores session files with 0600 permissions", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      await store.set(testSession("user1"));

      const sessionsDir = join(dir, "sessions");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(sessionsDir, `${hash}.json`);

      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("delete", () => {
    it("removes a session", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      await store.set(testSession("user1"));
      await store.delete("user1");

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });

    it("is idempotent", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      // Delete nonexistent session should not throw
      expect(async () => {
        await store.delete("nonexistent");
      }).not.toThrow();
    });
  });

  describe("findByTopic", () => {
    it("finds a session by topic", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const session = testSession("user1", { topic: "wc-abc-123" });
      await store.set(session);

      const found = await store.findByTopic("wc-abc-123");
      expect(found).toEqual(session);
    });

    it("returns undefined when topic not found", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const result = await store.findByTopic("nonexistent-topic");
      expect(result).toBeUndefined();
    });

    it("scans through list to find matching topic", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const session1 = testSession("user1", { topic: "topic1" });
      const session2 = testSession("user2", { topic: "topic2" });
      const session3 = testSession("user3", { topic: "topic3" });

      await store.set(session1);
      await store.set(session2);
      await store.set(session3);

      const found = await store.findByTopic("topic2");
      expect(found?.userId).toBe("user2");
    });
  });

  describe("list", () => {
    it("returns all stored sessions", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const session1 = testSession("user1");
      const session2 = testSession("user2");
      const session3 = testSession("user3");

      await store.set(session1);
      await store.set(session2);
      await store.set(session3);

      const list = await store.list();
      expect(list).toHaveLength(3);
      expect(list.map((s) => s.userId).sort()).toEqual(["user1", "user2", "user3"]);
    });

    it("returns empty list when no sessions exist", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const list = await store.list();
      expect(list).toEqual([]);
    });

    it("skips unparsable files when listing", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      // Add a valid session
      await store.set(testSession("user1"));

      // Write a bad file directly
      const sessionsDir = join(dir, "sessions");
      const badFile = join(sessionsDir, "badfile.json");
      require("node:fs").writeFileSync(badFile, "not json");

      // List should only return the valid session
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.userId).toBe("user1");
    });
  });

  describe("atomicity", () => {
    it("does not leave temp files after set", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      await store.set(testSession("user1"));

      const sessionsDir = join(dir, "sessions");
      const files = require("node:fs").readdirSync(sessionsDir);

      // Should have only one .json file, no .tmp files
      const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("passthrough fields", () => {
    it("passes through mandates field as unknown", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const mandates = { type: "custom", rules: [1, 2, 3] };
      const session = testSession("user1", { mandates });

      await store.set(session);
      const retrieved = await store.get("user1");

      expect(retrieved?.mandates).toEqual(mandates);
    });

    it("passes through policy field as unknown", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const policy = { version: 2, constraints: { maxAmount: "1000.0" } };
      const session = testSession("user1", { policy });

      await store.set(session);
      const retrieved = await store.get("user1");

      expect(retrieved?.policy).toEqual(policy);
    });

    it("omits optional fields when not present", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      const session = testSession("user1");
      // Explicitly remove optional fields
      const { mandates, policy, ...minimal } = session;

      await store.set(minimal as StoredWalletSession);
      const retrieved = await store.get("user1");

      expect(retrieved).toHaveProperty("version");
      expect(retrieved).toHaveProperty("userId");
      expect(retrieved?.mandates).toBeUndefined();
      expect(retrieved?.policy).toBeUndefined();
    });
  });

  describe("path traversal protection", () => {
    it("hashes userId in filename to prevent path traversal", async () => {
      const dir = tempDataDir();
      const store = new FileWalletSessionStore(dir);

      // Try to use a path traversal userId
      const maliciousId = "../../../etc/passwd";

      await store.set(testSession(maliciousId));

      // The file should be in the sessions directory only
      const sessionsDir = join(dir, "sessions");
      const hash = createHash("sha256").update(maliciousId).digest("hex");
      const filePath = join(sessionsDir, `${hash}.json`);

      // File should exist and be readable
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("etc");

      // But it should NOT exist outside the sessions directory
      const parentDir = join(dir, "etc");
      expect(require("node:fs").existsSync(parentDir)).toBe(false);
    });
  });
});
