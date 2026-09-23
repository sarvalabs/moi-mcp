import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileLaunchpadSessionStore,
  isLaunchpadSessionExpired,
  type StoredLaunchpadSession,
} from "../../src/launchpad/store.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-launchpad-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function record(over: Partial<StoredLaunchpadSession> = {}): StoredLaunchpadSession {
  return {
    version: 1,
    userId: "user-a",
    baseUrl: "https://launchpad.example",
    cookie: "eyJ.session.token",
    walletAddress: "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    ...over,
  };
}

describe("FileLaunchpadSessionStore", () => {
  it("round-trips a record and forgets it on delete", async () => {
    const store = new FileLaunchpadSessionStore(freshDir());
    expect(await store.get("user-a")).toBeUndefined();
    await store.set(record());
    expect((await store.get("user-a"))?.cookie).toBe("eyJ.session.token");
    await store.delete("user-a");
    expect(await store.get("user-a")).toBeUndefined();
  });

  it("names files by a hash of the user id and keeps them private", async () => {
    const dir = freshDir();
    const store = new FileLaunchpadSessionStore(dir);
    await store.set(record({ userId: "../../etc/passwd" }));
    const files = readdirSync(join(dir, "launchpad"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const mode = statSync(join(dir, "launchpad", files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps one user's session away from another's", async () => {
    const store = new FileLaunchpadSessionStore(freshDir());
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.get("a"))?.cookie).toBe("cookie-a");
    expect((await store.get("b"))?.cookie).toBe("cookie-b");
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    expect((await store.get("b"))?.cookie).toBe("cookie-b");
  });

  it("reports expiry from the Launchpad's own lifetime", () => {
    const now = Date.now();
    expect(isLaunchpadSessionExpired(record({ expiresAt: Math.floor(now / 1000) - 1 }), now)).toBe(true);
    expect(isLaunchpadSessionExpired(record({ expiresAt: Math.floor(now / 1000) + 60 }), now)).toBe(false);
  });
});
