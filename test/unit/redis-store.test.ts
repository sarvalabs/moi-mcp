/**
 * Redis-backed stores, exercised against a real Redis.
 *
 * Skipped when none is reachable, because a mocked Redis would prove nothing:
 * the reason this store exists is to survive a process going away, and only a
 * real server can demonstrate that.
 */
import { connect as tcpConnect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StoredWalletSession } from "../../src/wc/store.js";
import {
  connectRedis,
  RedisKeyValueStorage,
  RedisWalletSessionStore,
} from "../../src/wc/redis-store.js";

const URL = process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6379";

/**
 * Is anything listening? connectRedis() retries a refused connection rather
 * than throwing, so calling it with no Redis around hung this file's setup
 * hook until vitest killed it and failed the suite. A plain TCP probe answers
 * in milliseconds and lets the suite report itself as skipped, which is the
 * honest outcome: these tests need a real server, and a mocked one would
 * prove nothing.
 */
async function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new global.URL(url);
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: hostname || "127.0.0.1", port: Number(port) || 6379 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const REDIS_UP = process.env["TEST_REDIS_URL"] !== "skip" && (await reachable(URL));

let client: Awaited<ReturnType<typeof connectRedis>> | undefined;
let available = false;

beforeAll(async () => {
  if (!REDIS_UP) return;
  client = await connectRedis(URL);
  await client.ping();
  available = true;
});

afterAll(async () => {
  if (client) {
    for (const p of ["moi:session:*", "moi:topic:*", "moi:wc:*"]) {
      for await (const k of client.scanIterator({ MATCH: p, COUNT: 100 })) {
        const batch = Array.isArray(k) ? k : [k];
        for (const one of batch) await client.del(one as string);
      }
    }
    await client.quit();
  }
});

function record(userId: string, topic: string): StoredWalletSession {
  return {
    version: 1,
    userId,
    topic,
    caip2: "moi:14",
    address: "0xabc",
    sessionData: { topic },
    createdAt: new Date(0).toISOString(),
  };
}

describe.runIf(REDIS_UP)("RedisWalletSessionStore", () => {
  it("round-trips a session", async () => {
    if (!available || !client) return;
    const store = new RedisWalletSessionStore(client);
    await store.set(record("alice", "topic-a"));
    expect((await store.get("alice"))?.topic).toBe("topic-a");
    expect(await store.get("nobody")).toBeUndefined();
  });

  it("keeps users apart", async () => {
    if (!available || !client) return;
    const store = new RedisWalletSessionStore(client);
    await store.set(record("alice", "topic-a"));
    await store.set(record("bob", "topic-b"));

    expect((await store.get("alice"))?.topic).toBe("topic-a");
    expect((await store.get("bob"))?.topic).toBe("topic-b");
    expect((await store.findByTopic("topic-b"))?.userId).toBe("bob");

    // Removing one leaves the other reachable, which is the property that
    // stops one user's disconnect from logging everyone else out.
    await store.delete("alice");
    expect(await store.get("alice")).toBeUndefined();
    expect((await store.get("bob"))?.topic).toBe("topic-b");
  });

  it("drops the old topic index when a user re-pairs", async () => {
    if (!available || !client) return;
    const store = new RedisWalletSessionStore(client);
    await store.set(record("carol", "topic-old"));
    await store.set(record("carol", "topic-new"));

    // A relay event for the dead topic must not resolve back to carol.
    expect(await store.findByTopic("topic-old")).toBeUndefined();
    expect((await store.findByTopic("topic-new"))?.userId).toBe("carol");
  });

  it("survives the process that wrote it going away", async () => {
    if (!available || !client) return;
    await new RedisWalletSessionStore(client).set(record("dave", "topic-d"));

    // A completely separate connection, standing in for a replacement process.
    const second = await connectRedis(URL);
    try {
      const seen = await new RedisWalletSessionStore(second).get("dave");
      expect(seen?.topic).toBe("topic-d");
    } finally {
      await second.quit();
    }
  });

  it("skips an unreadable record instead of failing every lookup", async () => {
    if (!available || !client) return;
    const store = new RedisWalletSessionStore(client);
    await store.set(record("erin", "topic-e"));
    await client.set("moi:session:garbage", "{not json");

    const all = await store.list();
    expect(all.some((r) => r.userId === "erin")).toBe(true);
    await client.del("moi:session:garbage");
  });
});

describe.runIf(REDIS_UP)("RedisKeyValueStorage", () => {
  it("satisfies the shape WalletConnect asks for", async () => {
    if (!available || !client) return;
    const kv = new RedisKeyValueStorage(client);

    await kv.setItem("wc@2:core:keychain", { a: "1" });
    expect(await kv.getItem("wc@2:core:keychain")).toEqual({ a: "1" });
    expect(await kv.getKeys()).toContain("wc@2:core:keychain");
    expect(await kv.getEntries()).toContainEqual(["wc@2:core:keychain", { a: "1" }]);

    await kv.removeItem("wc@2:core:keychain");
    expect(await kv.getItem("wc@2:core:keychain")).toBeUndefined();
  });

  it("hands SDK state to a different connection", async () => {
    if (!available || !client) return;
    await new RedisKeyValueStorage(client).setItem("wc@2:client:session", [{ topic: "t" }]);

    const second = await connectRedis(URL);
    try {
      expect(await new RedisKeyValueStorage(second).getItem("wc@2:client:session")).toEqual([
        { topic: "t" },
      ]);
    } finally {
      await second.quit();
    }
  });
});
