/**
 * The faucet's key is part of its address, so the address is a secret too. This file runs every way the client and the tool
 * can fail, makes the fake faucet repeat the key back in the ways an API plausibly does (as sent, percent-encoded, in upper
 * case, split by a zero-width character or a line break, behind a bidi override), and searches everything a person, a model
 * or a log could see: error messages, stacks, JSON, inspect output, tool results, structured copies, stderr.
 *
 * What is claimed is "the whole key, in these forms", not "no failure path leaks": a faucet that echoes a MASKED part of the
 * key, or transforms it (reverses it, base64s it), is not covered, and no test here pretends otherwise (see the header of
 * src/applications/faucet/client.ts).
 *
 * The search is done on a folded copy of each output, with this file's own fold (not the implementation's), so a test checks
 * the outcome and not the implementation's spelling of it.
 */
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FaucetClient, FaucetError, MAX_FAUCET_MESSAGE_CHARS } from "../../src/applications/faucet/client.js";
import { faucetDepsFor, faucetTool } from "../../src/applications/faucet/tools.js";
import { SlidingWindow } from "../../src/auth/rate-limit.js";
import type { StoredWalletSession } from "../../src/wc/store.js";
import {
  ANSWER_MODES,
  AWKWARD_KEY,
  claimUrlOf,
  closedPortOrigin,
  connectFaucet,
  ECHO_STYLES,
  FAUCET_KEY,
  FAUCET_PATH,
  faucetClientFor,
  faucetDeps,
  startFakeFaucet,
  WORDS_MODES,
  type EchoStyle,
  type FakeFaucet,
  type FaucetMode,
} from "../helpers/faucet.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { authFor, fakeStore, session, USER } from "../helpers/hosted.js";
import { ACCOUNT, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let fake: FakeFaucet;
let records: Map<string, StoredWalletSession>;

beforeAll(async () => {
  node = await startMockNode();
  fake = await startFakeFaucet();
});
afterAll(async () => {
  await fake.close();
  await node.close();
});
beforeEach(() => {
  applyEnv(node.url, tempHome(), { MOI_NETWORK: "voyage" });
  node.reset();
  fake.requests.length = 0;
  fake.state.mode = "ok";
  fake.state.message = undefined;
  fake.state.echo = "none";
  records = new Map([[USER, session({ caip2: "moi:14" })]]);
});
afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

const KEYS = [
  ["plain key", FAUCET_KEY],
  ["awkward key", AWKWARD_KEY],
] as const;

/** Compatibility forms folded, lower case, every control, format, space and separator character removed. */
const fold = (text: string): string => text.normalize("NFKC").replace(/[\p{C}\p{Z}\s]+/gu, "").toLowerCase();

/**
 * What must not appear in anything a person could see, folded: the key, its percent-encoded form, the whole claim address,
 * the host (with its port), and the path word. `bareHost` adds the host without its port, which only the client-level
 * tests can check: the mock node a tool test reads the balance from is on the same loopback address.
 */
function forbidden(key: string, base: string, bareHost = false): string[] {
  const url = new URL(base);
  const list = [key, encodeURIComponent(key), `${base.replace(/\/+$/, "")}/${encodeURIComponent(key)}/claim`, url.host, "/claim"];
  if (bareHost) list.push(url.hostname);
  return [...new Set(list.map(fold))];
}

function expectNoSecret(label: string, outputs: ReadonlyArray<readonly [string, string]>, needles: readonly string[]): void {
  for (const [what, text] of outputs) {
    const folded = fold(text);
    for (const needle of needles) {
      expect(folded.includes(needle), `${label}: ${what} holds "${needle}"`).toBe(false);
    }
  }
}

/** Everything a thrown FaucetError shows. */
function errorOutputs(err: unknown): Array<readonly [string, string]> {
  const e = err as FaucetError;
  return [
    ["message", e.message],
    ["stack", e.stack ?? ""],
    ["JSON.stringify(error)", JSON.stringify(e)],
    ["JSON.stringify(error.data)", JSON.stringify(e.data)],
    ["util.inspect(error)", inspect(e, { depth: 6 })],
  ];
}

/** Runs `fn` with the log level at debug and stderr captured, so a line at any level is seen. */
async function observe<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; stderr: string }> {
  const lines: string[] = [];
  const before = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = "debug";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  try {
    const value = await fn();
    return { value, stderr: lines.join("") };
  } catch (error) {
    return { error, stderr: lines.join("") };
  } finally {
    spy.mockRestore();
    if (before === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = before;
  }
}

/** The client itself, as anything that logs or serialises an object would see it. */
function clientOutputs(client: FaucetClient): Array<readonly [string, string]> {
  return [
    ["util.inspect(client)", inspect(client, { depth: 8, showHidden: true })],
    ["JSON.stringify(client)", JSON.stringify(client)],
    ["String(client)", String(client)],
  ];
}

/** The text blocks of a tool answer. callTool's result type is a union, so this takes what it is given and looks for content. */
const textOf = (result: unknown): string =>
  (((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

describe("through the client", () => {
  const rows = WORDS_MODES.flatMap((mode) =>
    ECHO_STYLES.flatMap((style) => KEYS.map(([label, key]) => [mode, style, label, key] as [FaucetMode, EchoStyle, string, string])),
  );

  it.each(rows)("%s answer with the key echoed as %s (%s): no answer repeats the key, and the words are withheld whole", async (mode, style, label, key) => {
    fake.state.mode = mode;
    fake.state.echo = style;
    const client = faucetClientFor(fake, { key });
    const seen = await observe(() => client.claim(ACCOUNT));

    // The fake had the key to repeat: without this a row could pass because nothing was ever echoed.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.keySeen).toBe(key);

    const needles = forbidden(key, fake.url, true);
    if (seen.error !== undefined) {
      expect(seen.error).toBeInstanceOf(FaucetError);
      expectNoSecret(label, [...errorOutputs(seen.error), ["stderr", seen.stderr]], needles);
      // Withheld whole, not patched: not a word of the faucet's survives next to a marker.
      expect((seen.error as FaucetError).message).not.toContain("It says");
    } else {
      // A success whose words repeat the key still claims, and says nothing of its own.
      expect(seen.value!.said).toBeUndefined();
      expectNoSecret(label, [["stderr", seen.stderr]], needles);
    }
    expectNoSecret(label, clientOutputs(client), needles);
  });

  it.each(KEYS.flatMap(([label, key]) => (["bad_key", "forbidden"] as const).map((mode) => [mode, label, key] as const)))(
    "%s always echoes the key raw, and shows none of the faucet's words (%s)",
    async (mode, label, key) => {
      fake.state.mode = mode;
      const client = faucetClientFor(fake, { key });
      const seen = await observe(() => client.claim(ACCOUNT));

      expect(fake.requests[0]!.keySeen).toBe(key);
      expect(seen.error).toBeInstanceOf(FaucetError);
      expect((seen.error as FaucetError).outcome).toBe("key_refused");
      expectNoSecret(label, [...errorOutputs(seen.error), ["stderr", seen.stderr]], forbidden(key, fake.url, true));
      expect((seen.error as FaucetError).message).not.toMatch(/Invalid|may not claim/);
    },
  );

  it.each(KEYS)(
    "a closed port, a hung-up connection, a timeout, a guard refusal, a redirect and an oversize answer leak nothing (%s)",
    async (label, key) => {
      const closedBase = `${await closedPortOrigin()}${FAUCET_PATH}`;
      const guardBase = "https://faucet.example.test/devnet/v2/faucet";
      const cases: Array<{ name: string; base: string; client: FaucetClient; mode: FaucetMode; outcome: string }> = [
        { name: "closed port", base: closedBase, client: faucetClientFor({ url: closedBase }, { key }), mode: "ok", outcome: "unreachable" },
        { name: "hangup", base: fake.url, client: faucetClientFor(fake, { key }), mode: "hangup", outcome: "interrupted" },
        { name: "timeout", base: fake.url, client: faucetClientFor(fake, { key, timeoutMs: 100 }), mode: "hang", outcome: "timeout" },
        {
          name: "guard refusal",
          base: guardBase,
          client: new FaucetClient({ baseUrl: guardBase, key, resolve: async () => [{ address: "127.0.0.1", family: 4 }] }),
          mode: "ok",
          outcome: "refused_host",
        },
        // The redirect's Location carries the key; it is never read.
        { name: "redirect", base: fake.url, client: faucetClientFor(fake, { key }), mode: "redirect", outcome: "redirected" },
        { name: "declared oversize", base: fake.url, client: faucetClientFor(fake, { key }), mode: "huge_length", outcome: "too_large" },
        { name: "streamed oversize", base: fake.url, client: faucetClientFor(fake, { key }), mode: "huge_stream", outcome: "too_large" },
      ];
      for (const c of cases) {
        fake.state.mode = c.mode;
        const seen = await observe(() => c.client.claim(ACCOUNT));
        expect(seen.error, c.name).toBeInstanceOf(FaucetError);
        expect((seen.error as FaucetError).outcome, c.name).toBe(c.outcome);
        const needles = forbidden(key, c.base, true);
        expectNoSecret(`${label} / ${c.name}`, [...errorOutputs(seen.error), ["stderr", seen.stderr], ...clientOutputs(c.client)], needles);
      }
    },
  );

  it.each(KEYS.flatMap(([label, key]) => ECHO_STYLES.map((style) => [label, key, style] as const)))(
    "a success whose words repeat the key shows no words at all, and still claims (%s, %s)",
    async (label, key, style) => {
      fake.state.echo = style;
      const { said } = await faucetClientFor(fake, { key }).claim(ACCOUNT);
      expect(said, label).toBeUndefined();
    },
  );

  it.each(KEYS)("the key anywhere in the message withholds the whole message: at the start, in the middle, across the cut, and past it (%s)", async (_label, key) => {
    const filler = (n: number) => "a".repeat(n);
    const messages: Array<[string, string]> = [
      ["at the start", `${key} ${filler(195)}`],
      ["in the middle", `${filler(195)}${key}${filler(195)}`],
      // The key starts at character 195, so the 200 character cut falls inside it.
      ["straddling the cut", `${filler(195)}${key}${filler(50)}`],
      ["past the cut", `${filler(300)}${key}`],
    ];
    for (const [where, message] of messages) {
      fake.state.message = message;
      expect((await faucetClientFor(fake, { key }).claim(ACCOUNT)).said, where).toBeUndefined();
    }

    // A message that does not repeat the key is shown, however long: cut, not withheld.
    for (const length of [195, 300]) {
      fake.state.message = filler(length);
      const { said } = await faucetClientFor(fake, { key }).claim(ACCOUNT);
      expect(said, `length ${length}`).toBeDefined();
      expect(said!.length).toBeLessThanOrEqual(MAX_FAUCET_MESSAGE_CHARS + 2);
    }
  });

  it("the client object serialises to nothing, and so do the deps that hold it", () => {
    for (const [, key] of KEYS) {
      const client = faucetClientFor(fake, { key });
      expect(JSON.stringify(client)).toBe("{}");
      expect(Object.keys(client)).toEqual([]);
      const deps = faucetDeps(fake, { store: fakeStore(records) }, { client });
      const needles = forbidden(key, fake.url, true);
      expectNoSecret("client", clientOutputs(client), needles);
      expectNoSecret("deps", [["util.inspect(deps)", inspect(deps, { depth: 8, showHidden: true })], ["JSON.stringify(deps)", JSON.stringify(deps)]], needles);
    }
  });
});

describe("through the tool", () => {
  type Row = readonly [FaucetMode, string, string];
  const modeRows: Row[] = ANSWER_MODES.flatMap((mode) => KEYS.map(([label, key]) => [mode, label, key] as const));

  /** Echo styles only matter for the modes that build their words; the others are run once. */
  const stylesFor = (mode: FaucetMode): readonly EchoStyle[] => (WORDS_MODES.includes(mode) ? ECHO_STYLES : ["none"]);

  it.each(modeRows)("%s (%s): every outcome's text, structured copy and log lines are free of the key and the address", async (mode, label, key) => {
    for (const style of stylesFor(mode)) {
      fake.requests.length = 0;
      fake.state.mode = mode;
      fake.state.echo = style;
      const deps = faucetDeps(fake, { store: fakeStore(records) }, { client: faucetClientFor(fake, { key }) });
      const client = await connectFaucet(deps);
      const seen = await observe(async () => {
        await client.listTools();
        return client.callTool({ name: "moi_faucet", arguments: {} });
      });
      expect(seen.error, `${mode}/${style}`).toBeUndefined();
      const result = seen.value!;
      if (fake.requests.length > 0) expect(fake.requests[0]!.keySeen).toBe(key);

      expectNoSecret(
        `${label} / ${mode} / ${style}`,
        [
          ["result text", textOf(result)],
          ["structuredContent", JSON.stringify(result.structuredContent ?? null)],
          ["stderr", seen.stderr],
        ],
        forbidden(key, fake.url),
      );
    }
  });

  it.each(KEYS)("a closed port leaks nothing through the tool (%s)", async (label, key) => {
    const base = `${await closedPortOrigin()}${FAUCET_PATH}`;
    const deps = faucetDeps(fake, { store: fakeStore(records) }, { client: faucetClientFor({ url: base }, { key }) });
    const client = await connectFaucet(deps);
    const seen = await observe(async () => {
      await client.listTools();
      return client.callTool({ name: "moi_faucet", arguments: {} });
    });
    const result = seen.value!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Nothing was claimed/);
    expectNoSecret(
      label,
      [
        ["result text", textOf(result)],
        ["structuredContent", JSON.stringify(result.structuredContent ?? null)],
        ["stderr", seen.stderr],
      ],
      forbidden(key, base),
    );
  });

  it("a success whose words repeat the key claims, and the tool says the faucet accepted the request, in the answer's text and not in its structure", async () => {
    for (const style of ECHO_STYLES) {
      fake.state.echo = style;
      const client = await connectFaucet(faucetDeps(fake, { store: fakeStore(records) }));
      const result = await client.callTool({ name: "moi_faucet", arguments: {} });
      expect(result.isError, style).toBeFalsy();
      expect(textOf(result), style).toContain("The faucet accepted the request.");
      expect((result.structuredContent as Record<string, unknown>)["faucetSays"], style).toBeUndefined();
    }
  });

  it("not signed in, not paired, wrong chain, wrong network and rate limited leak nothing", async () => {
    const needles = forbidden(FAUCET_KEY, fake.url);
    const callOnce = async (deps: ReturnType<typeof faucetDeps>, who: ReturnType<typeof authFor> | null) => {
      const client = await connectFaucet(deps, who);
      const seen = await observe(async () => {
        await client.listTools();
        return client.callTool({ name: "moi_faucet", arguments: {} });
      });
      return seen;
    };
    const check = (what: string, seen: Awaited<ReturnType<typeof callOnce>>) => {
      expect(seen.error, what).toBeUndefined();
      expect(seen.value!.isError, what).toBe(true);
      expectNoSecret(what, [["text", textOf(seen.value!)], ["structured", JSON.stringify(seen.value!.structuredContent ?? null)], ["stderr", seen.stderr]], needles);
    };

    check("not signed in", await callOnce(faucetDeps(fake, { store: fakeStore(records) }), null));
    check("not paired", await callOnce(faucetDeps(fake, { store: fakeStore(new Map()) }), authFor(USER)));
    check(
      "wrong chain",
      await callOnce(faucetDeps(fake, { store: fakeStore(new Map([[USER, session({ caip2: "moi:custom" })]])) }), authFor(USER)),
    );

    const limited = faucetDeps(fake, { store: fakeStore(records) }, { limiter: new SlidingWindow({ windowMs: 60_000, max: 1 }) });
    await callOnce(limited, authFor(USER));
    check("rate limited", await callOnce(limited, authFor(USER)));

    restoreEnv();
    applyEnv(node.url, tempHome(), { MOI_NETWORK: "custom" });
    check("wrong network", await callOnce(faucetDeps(fake, { store: fakeStore(new Map([[USER, session()]])) }), authFor(USER)));
    expect(fake.requests).toHaveLength(1); // only the one claim that the limiter allowed
  });

  it("the tool definition and the tools/list entry carry neither the key nor the address", async () => {
    for (const [label, key] of KEYS) {
      const deps = faucetDeps(fake, { store: fakeStore(records) }, { client: faucetClientFor(fake, { key }) });
      const needles = forbidden(key, fake.url, true);
      const def = faucetTool(deps, authFor(USER));
      expectNoSecret(
        label,
        [
          ["JSON.stringify(definition)", JSON.stringify(def.config)],
          ["util.inspect(definition)", inspect(def, { depth: 8, showHidden: true })],
        ],
        needles,
      );
      const listed = (await (await connectFaucet(deps)).listTools()).tools;
      expectNoSecret(label, [["tools/list", JSON.stringify(listed)]], needles);
    }
  });
});

describe("faucetDepsFor", () => {
  const URL = "https://faucet.example.test/devnet/v2/faucet";

  it("logs fixed text: none of its lines holds the key, the address or the host, in any branch", async () => {
    const store = { store: fakeStore(records) };
    const cases: Array<[string, { MOI_FAUCET_URL?: string; MOI_FAUCET_KEY?: string }, "voyage" | "mainnet" | "custom"]> = [
      ["neither", {}, "voyage"],
      ["address only", { MOI_FAUCET_URL: URL }, "voyage"],
      ["key only", { MOI_FAUCET_KEY: FAUCET_KEY }, "voyage"],
      ["mainnet", { MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: FAUCET_KEY }, "mainnet"],
      ["custom", { MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: FAUCET_KEY }, "custom"],
      ["on", { MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: FAUCET_KEY }, "voyage"],
      ["http address", { MOI_FAUCET_URL: "http://faucet.example.test/needle-path", MOI_FAUCET_KEY: FAUCET_KEY }, "voyage"],
      ["credentials", { MOI_FAUCET_URL: "https://needle-user:needle-pass@faucet.example.test/x", MOI_FAUCET_KEY: FAUCET_KEY }, "voyage"],
      ["query", { MOI_FAUCET_URL: `${URL}?token=needle-query`, MOI_FAUCET_KEY: FAUCET_KEY }, "voyage"],
      ["dots key", { MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: ".." }, "voyage"],
      ["long key", { MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: "k".repeat(300) }, "voyage"],
    ];
    const secrets = [FAUCET_KEY, URL, "faucet.example.test", "needle-", "k".repeat(300)];
    for (const [name, hosted, network] of cases) {
      const seen = await observe(async () => faucetDepsFor(hosted, network, store));
      expect(seen.error, name).toBeUndefined();
      for (const secret of secrets) expect(fold(seen.stderr).includes(fold(secret)), `${name}: stderr holds ${secret}`).toBe(false);
    }
  });
});
