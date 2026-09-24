import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileDappSessionStore, isDappSessionExpired, type StoredDappSession } from "../../src/dapp/store.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-dapps-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function record(over: Partial<StoredDappSession> = {}): StoredDappSession {
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

describe("FileDappSessionStore", () => {
  it("round-trips a record and forgets it on delete", async () => {
    const store = new FileDappSessionStore(freshDir());
    expect(await store.get("user-a", "https://launchpad.example")).toBeUndefined();
    await store.set(record());
    expect((await store.get("user-a", "https://launchpad.example"))?.cookie).toBe("eyJ.session.token");
    // Same user, another dapp: a different record.
    expect(await store.get("user-a", "https://other.example")).toBeUndefined();
    await store.delete("user-a", "https://launchpad.example");
    expect(await store.get("user-a", "https://launchpad.example")).toBeUndefined();
  });

  it("names files by a hash of the user id and keeps them private", async () => {
    const dir = freshDir();
    const store = new FileDappSessionStore(dir);
    await store.set(record({ userId: "../../etc/passwd" }));
    const files = readdirSync(join(dir, "dapps"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const mode = statSync(join(dir, "dapps", files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps one user's session away from another's", async () => {
    const store = new FileDappSessionStore(freshDir());
    await store.set(record({ userId: "a", cookie: "cookie-a" }));
    await store.set(record({ userId: "a", baseUrl: "https://other.example", cookie: "cookie-a2" }));
    await store.set(record({ userId: "b", cookie: "cookie-b" }));
    expect((await store.get("a", "https://launchpad.example"))?.cookie).toBe("cookie-a");
    expect((await store.get("b", "https://launchpad.example"))?.cookie).toBe("cookie-b");
    expect((await store.listFor("a")).map((r) => r.cookie).sort()).toEqual(["cookie-a", "cookie-a2"]);
    await store.delete("a", "https://launchpad.example");
    expect(await store.get("a", "https://launchpad.example")).toBeUndefined();
    expect((await store.listFor("a")).map((r) => r.cookie)).toEqual(["cookie-a2"]);
    expect((await store.get("b", "https://launchpad.example"))?.cookie).toBe("cookie-b");
  });

  it("reports expiry from the Launchpad's own lifetime", () => {
    const now = Date.now();
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) - 1 }), now)).toBe(true);
    expect(isDappSessionExpired(record({ expiresAt: Math.floor(now / 1000) + 60 }), now)).toBe(false);
  });
});
