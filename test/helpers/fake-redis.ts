/**
 * A stand-in for the node-redis client with just the calls the stores make,
 * recording the expiry each set was given. node-redis 4 yields keys one at a
 * time from scanIterator and 5 yields batches; both shapes are exercised.
 * `multi` is there for the wallet session store, which writes a record and its
 * topic index in one transaction.
 */
import type { RedisClientType } from "redis";
import { vi } from "vitest";

export interface FakeRedis {
  client: RedisClientType;
  data: Map<string, string>;
  ttls: Map<string, number>;
}

interface FakeMulti {
  set(key: string, value: string, opts?: { EX?: number }): FakeMulti;
  del(key: string): FakeMulti;
  exec(): Promise<unknown[]>;
}

export function fakeRedis(batched = false): FakeRedis {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const put = (key: string, value: string, opts?: { EX?: number }) => {
    data.set(key, value);
    if (opts?.EX !== undefined) ttls.set(key, opts.EX);
  };
  const client = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
      put(key, value, opts);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
    scanIterator: vi.fn(async function* (opts: { MATCH: string }) {
      const prefix = opts.MATCH.replace(/\*$/, "");
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix));
      if (batched) yield keys;
      else yield* keys;
    }),
    multi: vi.fn((): FakeMulti => {
      const queue: Array<() => void> = [];
      const chain: FakeMulti = {
        set(key, value, opts) {
          queue.push(() => put(key, value, opts));
          return chain;
        },
        del(key) {
          queue.push(() => void data.delete(key));
          return chain;
        },
        async exec() {
          for (const op of queue.splice(0)) op();
          return [];
        },
      };
      return chain;
    }),
  };
  return { client: client as unknown as RedisClientType, data, ttls };
}
