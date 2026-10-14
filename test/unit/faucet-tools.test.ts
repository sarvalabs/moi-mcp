/**
 * moi_faucet through a real McpServer over an in-memory transport, against the mock node (for the one balance read) and a
 * fake faucet on loopback. Only the pairing store is faked, and it is the only thing the tool is handed: no hub, no journal.
 * The key never leaking is test/unit/faucet-secret.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { FaucetClient } from "../../src/applications/faucet/client.js";
import {
  FAUCET_CLAIMS_PER_WINDOW,
  FAUCET_WINDOW_MS,
  faucetDepsFor,
  type FaucetDeps,
} from "../../src/applications/faucet/tools.js";
import { SlidingWindow } from "../../src/auth/rate-limit.js";
import type { Network } from "../../src/schema.js";
import type { StoredWalletSession } from "../../src/wc/store.js";
import {
  closedPortOrigin,
  connectFaucet,
  FAUCET_KEY,
  FAUCET_PATH,
  faucetClientFor,
  faucetDeps,
  SAID,
  startFakeFaucet,
  type FakeFaucet,
  type FaucetMode,
} from "../helpers/faucet.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { authFor, fakeStore, session, structured, USER } from "../helpers/hosted.js";
import { ACCOUNT, KMOI, OTHER, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let fake: FakeFaucet;

beforeAll(async () => {
  node = await startMockNode();
  fake = await startFakeFaucet();
});
afterAll(async () => {
  await fake.close();
  await node.close();
});

/** The pairings the fake store holds, by user. Rebuilt for every test. */
let records: Map<string, StoredWalletSession>;
const wallets = () => ({ store: fakeStore(records) });

beforeEach(() => {
  applyEnv(node.url, tempHome(), { MOI_NETWORK: "voyage" });
  node.reset();
  node.state.kmoiBalance = 12_500_000_000n;
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

type Called = Awaited<ReturnType<Client["callTool"]>>;

/** Calls the tool; listTools first so the client validates the answer against the tool's output schema too. */
async function claim(client: Client, args: Record<string, unknown> = {}): Promise<Called> {
  await client.listTools();
  return client.callTool({ name: "moi_faucet", arguments: args });
}

const textOf = (r: Called): string =>
  ((r.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

type Claimed = { claimed: true; address: string; faucetSays?: string; balanceKmoi?: string; note: string };

/** Everything a person or model could read from one answer. */
const everything = (r: Called): string => `${textOf(r)}\n${JSON.stringify(r.structuredContent ?? null)}`;

const tduCalls = () => node.calls.filter((c) => c.method === "moi.TDU");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The lines written to stderr while `fn` runs, at the given log level. */
async function stderrAt(level: string, fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const lines: string[] = [];
  const before = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = level;
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
    if (before === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = before;
  }
  return lines;
}

describe("a claim", () => {
  it("claims for the paired wallet and reports the faucet's words and the balance read once afterwards", async () => {
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));

    expect(result.isError).toBeFalsy();
    const value = structured<Claimed>(result);
    expect(value.claimed).toBe(true);
    expect(value.address).toBe(ACCOUNT);
    expect(value.faucetSays).toBe(`"${SAID}"`);
    expect(value.balanceKmoi).toBe("12.5");
    expect(value.note).toMatch(/can take a moment to arrive/);
    expect(value.note).toMatch(/moi_get_account/);

    const text = textOf(result);
    expect(text).toContain(ACCOUNT);
    expect(text).toContain(`The faucet says: "${SAID}"`);
    expect(text).toContain("12.5 KMOI");
    expect(text).toContain(value.note);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toEqual({ address: ACCOUNT });
  });

  it("says the faucet accepted the request when it sent no words", async () => {
    fake.state.mode = "null_message";
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(structured<Claimed>(result).faucetSays).toBeUndefined();
    expect(textOf(result)).toContain("The faucet accepted the request.");
  });

  it("takes no arguments: the input schema is empty, and an address argument is ignored, so the faucet gets the paired wallet's address", async () => {
    const client = await connectFaucet(faucetDeps(fake, wallets()));
    const listed = (await client.listTools()).tools.find((t) => t.name === "moi_faucet")!;
    expect(listed.inputSchema.properties ?? {}).toEqual({});
    expect(listed.inputSchema.required ?? []).toEqual([]);
    expect(JSON.stringify(listed.inputSchema)).not.toMatch(/confirm|address/i);

    const result = await claim(client, { address: OTHER, confirm: "x" });
    expect(result.isError).toBeFalsy();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toEqual({ address: ACCOUNT });
    expect(structured<Claimed>(result).address).toBe(ACCOUNT);
  });

  it("reads the balance once, after the claim, and not at all when the claim fails", async () => {
    const seenAtRead: number[] = [];
    node.on("moi.TDU", () => {
      seenAtRead.push(fake.requests.length);
      return [{ asset_id: KMOI, token_id: "0x0", amount: "0x" + (12_500_000_000n).toString(16) }];
    });
    await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(tduCalls()).toHaveLength(1);
    // When the node was asked, the faucet had already been asked: the read came after the claim.
    expect(seenAtRead).toEqual([1]);

    node.reset();
    fake.state.mode = "cooldown";
    const refused = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(refused.isError).toBe(true);
    expect(tduCalls()).toHaveLength(0);
  });

  it("a balance that cannot be read does not undo the claim, and the note does not guess", async () => {
    node.on("moi.TDU", () => {
      throw new RpcFailure("secret-node-detail");
    });
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));

    expect(result.isError).toBeFalsy();
    const value = structured<Claimed>(result);
    expect(value.claimed).toBe(true);
    expect(value.balanceKmoi).toBeUndefined();
    expect(value.note).toMatch(/balance could not be read just now/);
    expect(value.note).toMatch(/isRegistered/);
    expect(value.note).toMatch(/moi_get_account/);
    expect(value.note).toMatch(/documentation does not say whether it can fund an address that is not registered/);
    expect(value.note).not.toContain("until the funds land");
    expect(everything(result)).not.toContain("secret-node-detail");
    expect(textOf(result)).not.toMatch(/KMOI balance of that wallet/);
  });

  it("a balance read that hangs is given up on after balanceTimeoutMs, and the claim still stands", async () => {
    node.on("moi.TDU", async () => {
      await sleep(600);
      return [];
    });
    const started = Date.now();
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets(), { balanceTimeoutMs: 50 })));
    expect(Date.now() - started).toBeLessThan(550);
    expect(result.isError).toBeFalsy();
    expect(structured<Claimed>(result).balanceKmoi).toBeUndefined();
    expect(structured<Claimed>(result).claimed).toBe(true);
  });

  it("needs nothing but the pairing store: it works with deps that hold no hub and no journal", async () => {
    const store = fakeStore(records);
    const deps = faucetDeps(fake, { store });
    expect(Object.keys(deps.wallets)).toEqual(["store"]);

    const result = await claim(await connectFaucet(deps));
    expect(result.isError).toBeFalsy();
    expect(structured<Claimed>(result).claimed).toBe(true);
    expect(store.get).toHaveBeenCalledWith(USER);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("has the annotations of an outside action that is not a read", async () => {
    const client = await connectFaucet(faucetDeps(fake, wallets()));
    const listed = (await client.listTools()).tools.find((t) => t.name === "moi_faucet")!;
    expect(listed.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe("who may call it", () => {
  it("refuses a caller who is not signed in, before anything else", async () => {
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets()), null));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\[WALLET_NOT_CONNECTED\] Sign in to this connector/);
    expect(fake.requests).toHaveLength(0);
  });

  it("needs a paired wallet", async () => {
    records.clear();
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\[WALLET_NOT_CONNECTED\] No wallet paired/);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a wallet paired on another chain as NETWORK_MISMATCH", async () => {
    records.set(USER, session({ caip2: "moi:custom" }));
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\[NETWORK_MISMATCH\]/);
    expect(fake.requests).toHaveLength(0);
  });

  it("on a server that is not on the devnet it refuses even though it is registered, and the faucet is not asked", async () => {
    restoreEnv();
    applyEnv(node.url, tempHome(), { MOI_NETWORK: "custom" });
    records.set(USER, session({ caip2: "moi:custom" }));
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\[FAUCET_ERROR\].*devnet/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the per-person limit", () => {
  /** A window with the real numbers and a clock the test moves. */
  function clock() {
    const t = { now: 1_000_000 };
    const limiter = new SlidingWindow({ windowMs: FAUCET_WINDOW_MS, max: FAUCET_CLAIMS_PER_WINDOW, now: () => t.now });
    return { t, limiter };
  }

  it("pins the numbers: 3 claims in 60 minutes", () => {
    expect(FAUCET_CLAIMS_PER_WINDOW).toBe(3);
    expect(FAUCET_WINDOW_MS).toBe(3_600_000);
  });

  it("refuses the call after the limit, with the wait in minutes, and the faucet is not asked again", async () => {
    // The text prints FAUCET_CLAIMS_PER_WINDOW, not the injected window's own setting (the limiter's options are private),
    // so the injected window uses the real numbers.
    const { limiter } = clock();
    const client = await connectFaucet(faucetDeps(fake, wallets(), { limiter }));
    for (let i = 0; i < 3; i++) expect((await claim(client)).isError, `claim ${i + 1}`).toBeFalsy();

    const fourth = await claim(client);
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/\[FAUCET_ERROR\]/);
    expect(textOf(fourth)).toMatch(/3 times/);
    expect(textOf(fourth)).toMatch(/about 60 minutes/);
    expect(fake.requests).toHaveLength(3);
  });

  it("counts per person: another signed-in person still claims", async () => {
    const { limiter } = clock();
    records.set("user-b", session({ userId: "user-b", caip2: "moi:14" }));
    const deps = faucetDeps(fake, wallets(), { limiter });
    const a = await connectFaucet(deps, authFor(USER));
    const b = await connectFaucet(deps, authFor("user-b"));
    for (let i = 0; i < 3; i++) await claim(a);
    expect((await claim(a)).isError).toBe(true);

    expect((await claim(b)).isError).toBeFalsy();
    expect(fake.requests).toHaveLength(4);
  });

  it("a person who is not signed in or not paired is not charged", async () => {
    const { limiter } = clock();
    const deps = faucetDeps(fake, wallets(), { limiter });
    const anonymous = await connectFaucet(deps, null);
    for (let i = 0; i < 6; i++) expect((await claim(anonymous)).isError).toBe(true);

    records.clear();
    const unpaired = await connectFaucet(deps);
    for (let i = 0; i < 6; i++) expect(textOf(await claim(unpaired))).toMatch(/No wallet paired/);

    records.set(USER, session({ caip2: "moi:14" }));
    const paired = await connectFaucet(deps);
    for (let i = 0; i < 3; i++) expect((await claim(paired)).isError, `claim ${i + 1}`).toBeFalsy();
    expect(fake.requests).toHaveLength(3);
  });

  it("a failed claim is charged too", async () => {
    const { limiter } = clock();
    fake.state.mode = "server_error";
    const client = await connectFaucet(faucetDeps(fake, wallets(), { limiter }));
    for (let i = 0; i < 3; i++) expect(textOf(await claim(client))).toMatch(/server error/);

    const fourth = await claim(client);
    expect(textOf(fourth)).toMatch(/3 times/);
    expect(fake.requests).toHaveLength(3);
  });

  it("frees the person when the window has passed", async () => {
    const { t, limiter } = clock();
    const client = await connectFaucet(faucetDeps(fake, wallets(), { limiter }));
    for (let i = 0; i < 3; i++) await claim(client);
    expect((await claim(client)).isError).toBe(true);

    t.now += FAUCET_WINDOW_MS + 1;
    expect((await claim(client)).isError).toBeFalsy();
    expect(fake.requests).toHaveLength(4);
  });

  it("the default limiter is shared by every registration, as the hosted server needs", async () => {
    // The hosted server registers its tools on every request, so a window made inside faucetTool would be empty each time.
    // Only this test uses the default limiter, with a user of its own, because the default is module state.
    const user = `user-default-limit-${Math.random().toString(36).slice(2)}`;
    records.set(user, session({ userId: user, caip2: "moi:14" }));
    const deps = faucetDeps(fake, wallets(), { limiter: undefined });
    const first = await connectFaucet(deps, authFor(user));
    const second = await connectFaucet(deps, authFor(user));

    expect((await claim(first)).isError).toBeFalsy();
    expect((await claim(first)).isError).toBeFalsy();
    expect((await claim(second)).isError).toBeFalsy();
    const fourth = await claim(first);
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/3 times/);
    expect(fake.requests).toHaveLength(3);
  });
});

describe("what the model is told when the faucet says no", () => {
  const MODES: Array<[FaucetMode, RegExp]> = [
    ["cooldown", /did not hand out funds \(HTTP 429\)/],
    ["bad_key", /did not accept this server's key \(HTTP 401\)/],
    ["server_error", /server error \(HTTP 500\)/],
    ["bad_gateway", /server error \(HTTP 502\)/],
    ["success_false", /did not hand out funds \(HTTP 200\)/],
    ["redirect", /redirect \(HTTP 302\)/],
    ["plain_ok", /in a form this server does not understand/],
    ["huge_length", /larger than the 8 KB/],
    ["hangup", /connection to the faucet broke/],
  ];

  it.each(MODES)("%s is an isError result with its own text, and the node gets no balance read", async (mode, sentence) => {
    fake.state.mode = mode;
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(result.isError).toBe(true);
    // Unanchored: the SDK renders a thrown error as "MCP error -32603: [FAUCET_ERROR] ...", as the Launchpad tests expect.
    expect(textOf(result)).toMatch(/\[FAUCET_ERROR\] /);
    expect(textOf(result)).toMatch(sentence);
    expect(textOf(result)).not.toMatch(/Nothing was claimed/);
    expect(tduCalls()).toHaveLength(0);
  });

  it("a closed port says nothing was claimed, and no other outcome does", async () => {
    const client = faucetClientFor({ url: `${await closedPortOrigin()}${FAUCET_PATH}` });
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets(), { client })));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\[FAUCET_ERROR\] /);
    expect(textOf(result)).toMatch(/could not be reached\. Nothing was claimed/);
    expect(tduCalls()).toHaveLength(0);
  });

  it("a faucet that never answers is a timeout with a check-the-balance sentence", async () => {
    fake.state.mode = "hang";
    const client = faucetClientFor(fake, { timeoutMs: 100 });
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets(), { client })));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/did not answer in time/);
    expect(textOf(result)).toMatch(/moi_get_account/);
    expect(textOf(result)).not.toMatch(/Nothing was claimed/);
    expect(tduCalls()).toHaveLength(0);
  });

  it("an address the faucet does not take is refused before anything is sent", async () => {
    records.set(USER, session({ caip2: "moi:14", address: "0x1234" }));
    const result = await claim(await connectFaucet(faucetDeps(fake, wallets())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/nothing was sent to the faucet/);
    expect(fake.requests).toHaveLength(0);
  });

  it("writes one info line per call that got past the wallet check, with the user and the outcome only", async () => {
    const limiter = new SlidingWindow({ windowMs: FAUCET_WINDOW_MS, max: 2 });
    const deps = faucetDeps(fake, wallets(), { limiter });
    const anonymous = await connectFaucet(deps, null);
    const client = await connectFaucet(deps);
    const stranger = await connectFaucet(faucetDeps(fake, { store: fakeStore(new Map()) }));

    const lines = await stderrAt("info", async () => {
      await claim(client); // claimed
      fake.state.mode = "cooldown";
      await claim(client); // declined
      await claim(client); // rate limited, the third call in a window of two
      await claim(anonymous); // not signed in: no line
      await claim(stranger); // not paired: no line
    });

    const mine = lines.filter((l) => l.includes("faucet:"));
    expect(mine).toEqual([
      "[moi-mcp] info: faucet: user user-a -> claimed\n",
      "[moi-mcp] info: faucet: user user-a -> declined\n",
      "[moi-mcp] info: faucet: user user-a -> rate_limited\n",
    ]);
    const all = lines.join("");
    for (const secret of [ACCOUNT, SAID, "already claimed", FAUCET_KEY, fake.origin]) expect(all, secret).not.toContain(secret);
  });
});

describe("faucetDepsFor", () => {
  const URL = "https://faucet.example.test/devnet/v2/faucet";
  const store = () => ({ store: fakeStore(records) });
  const KEY = FAUCET_KEY;

  it.each([
    ["neither", {}],
    ["blank strings", { MOI_FAUCET_URL: "", MOI_FAUCET_KEY: "" }],
  ])("is absent, and silent, when %s is set", async (_label, hosted) => {
    const lines = await stderrAt("debug", () => expect(faucetDepsFor(hosted, "voyage", store())).toBeUndefined());
    expect(lines).toEqual([]);
  });

  it.each([
    ["the address only", { MOI_FAUCET_URL: URL }],
    ["the key only", { MOI_FAUCET_KEY: KEY }],
  ])("is absent when %s is set, with one error line holding neither value", async (_label, hosted) => {
    const lines = await stderrAt("error", () => expect(faucetDepsFor(hosted, "voyage", store())).toBeUndefined());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/MOI_FAUCET_URL and MOI_FAUCET_KEY must both be set/);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).not.toContain("faucet.example.test");
  });

  it.each<Network>(["mainnet", "custom"])("is absent off the devnet (%s), with one fixed error line that names the network", async (network) => {
    const lines = await stderrAt("error", () =>
      expect(faucetDepsFor({ MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: KEY }, network, store())).toBeUndefined(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`MOI_NETWORK is ${network}`);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).not.toContain("faucet.example.test");
  });

  it("is present on voyage with both set, keeps the wallets it was given, and logs that it is on without the host or the key", async () => {
    const given = store();
    let deps: FaucetDeps | undefined;
    const lines = await stderrAt("info", () => {
      deps = faucetDepsFor({ MOI_FAUCET_URL: URL, MOI_FAUCET_KEY: KEY }, "voyage", given);
    });
    expect(deps).toBeDefined();
    expect(deps!.client).toBeInstanceOf(FaucetClient);
    expect(deps!.wallets).toBe(given);
    expect(lines).toEqual(["[moi-mcp] info: faucet: the devnet faucet tool is on.\n"]);
  });

  it.each([
    ["an http address", "http://example.test/x", KEY],
    ["a localhost address", "https://localhost/x", KEY],
    ["an IP address", "https://127.0.0.1/x", KEY],
    ["a non-URL", "not a url", KEY],
    ["an address with a query", "https://faucet.example.test/x?k=needle-q", KEY],
    ["an address with credentials", "https://needle-u:needle-p@faucet.example.test/x", KEY],
    ["a key of one dot", URL, "."],
    ["a key of two dots", URL, ".."],
    ["a key of 300 characters", URL, "k".repeat(300)],
  ])("a value the client refuses (%s) leaves the tool off and says so, without the value", async (_label, url, key) => {
    let deps: FaucetDeps | undefined = {} as FaucetDeps;
    const lines = await stderrAt("error", () => {
      deps = faucetDepsFor({ MOI_FAUCET_URL: url, MOI_FAUCET_KEY: key }, "voyage", store());
    });
    expect(deps).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/was refused/);
    expect(lines[0]).toMatch(/the faucet tool is off/);
    for (const value of [url, key.length > 2 ? key : "needle-none", "needle-q", "needle-u", "needle-p", "faucet.example.test", "127.0.0.1"]) {
      expect(lines[0], value).not.toContain(value);
    }
  });
});

describe("registration", () => {
  it("lists moi_faucet, and the description says devnet, no arguments, the cooldown, the hourly limit, moi_get_account and to call it only when asked, and holds neither the key nor the address", async () => {
    const client = await connectFaucet(faucetDeps(fake, wallets()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["moi_faucet"]);
    const listed = tools[0]!;
    expect(listed.title).toBe("Claim devnet test KMOI");

    const description = listed.description ?? "";
    expect(description).toMatch(/devnet/i);
    expect(description).toMatch(/no arguments/);
    expect(description).toMatch(/cooldown/);
    expect(description).toMatch(/3 claims an hour/);
    expect(description).toMatch(/moi_get_account/);
    expect(description).toMatch(/only when the person has asked/);
    for (const secret of [FAUCET_KEY, fake.origin, fake.url, ACCOUNT]) expect(JSON.stringify(listed), secret).not.toContain(secret);
  });
});
