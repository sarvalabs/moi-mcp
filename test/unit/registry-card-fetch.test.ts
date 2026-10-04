/**
 * Where an agent's card is read from. The card URL is written by whoever registered the agent, so it goes through the same
 * address guard as a dapp's (src/public-fetch.ts): https only, no redirect, and no connection to a private address. A card
 * that is refused or cannot be read never fails the lookup; cardNote says that it was not fetched, why, and what to do, in
 * fixed words.
 *
 * No test here resolves a real name or connects to a public address. A name is answered by a scripted resolver (or, for the
 * production default, by a mocked node:dns/promises), the only listener is on 127.0.0.1 (which the guard must never reach),
 * and a card on a "public" host is a stand-in fetch.
 */
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { primeRegistryDriverForTests, resetRegistryCache, resolveAgent } from "../../src/capabilities/reads/registry.js";
import { guardedLookup, publicFetch, type FetchLike, type Resolver } from "../../src/public-fetch.js";
import { ResolveAgentOutput } from "../../src/schema.js";

// What the production default resolves names with. A card host that answers with a loopback address must be refused, and a
// plain fetch, which does not use this module, would never call it.
const { systemLookup } = vi.hoisted(() => ({ systemLookup: vi.fn(async (_host: string, _opts: unknown) => [{ address: "127.0.0.1", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup: systemLookup }));

const LOGIC = "0x200000002f3e9469d94de695be18fc5839fb9535f543b381f903f7f800000000";
const OWNER_HEX = "0x00000000bfa45bc089945cf2befd0bd488e863562628cb47b14f3d1800000000";
const signer = {} as never;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
const walletOf = (n: number) => `0x${n.toString(16).padStart(8, "0")}${"ab".repeat(28)}`;

// The whole of what the model is told, written out here and not built from the source's own table, so a reworded or leaky
// note fails. Each is: why the card was not fetched, what to do about it, and what is left out.
const TAIL = " Its name and capabilities come from the card, so they are left out; the registry's own fields, including the card address in metadata.card_uri, are unaffected.";
const note = (why: string, next: string) => `The agent's card was not fetched: ${why}. ${next}${TAIL}`;
const NOT_HTTPS = note(
  "its address is not an https URL",
  "This server reads only https cards on public hosts, so the owner has to register the agent with an https card address.",
);
const NOT_PUBLIC = note(
  "its host is not a public internet address this server may reach (a local or private name, an IP address, or a name that did not resolve)",
  "This server reads only cards on public hosts, so the owner has to register a card address on a public name; if the name is public and working, try again in a minute, because a failed name lookup reads the same.",
);
const REDIRECTED = note(
  "it answered with a redirect, which this server does not follow",
  "The owner has to register the address the card is actually served from.",
);
const TOO_LARGE = note("it is over 64 KB", "The owner has to publish a card under 64 KB.");
const TIMED_OUT = note("it did not answer in time", "Try again in a minute; if it keeps happening, the card host is down or very slow.");
const UNREADABLE = note(
  "it could not be fetched, or what it returned is not a JSON card",
  "Try again in a minute; if it keeps happening, the card host is down or is serving something that is not a JSON object.",
);

type Routine = (...args: unknown[]) => Promise<{ call: () => Promise<{ result: () => Promise<unknown> }> }>;
const routine = (impl: (...args: unknown[]) => unknown): Routine =>
  vi.fn(async (...args: unknown[]) => ({ call: async () => ({ result: async () => impl(...args) }) }));

/** A registry whose agents are agent_1 to agent_n, agent i having the card URI cards[i - 1] (none when it is undefined). */
function prime(...cards: Array<string | undefined>) {
  const profile = (n: number) => ({
    agent_id: `agent_${n}`,
    owner: bytes(OWNER_HEX),
    agent_wallet: bytes(walletOf(n)),
    status: "ACTIVE",
    url: `https://agents.example/${n}`,
    ...(cards[n - 1] !== undefined ? { card_uri: cards[n - 1] } : {}),
    score: 0n,
    created_at: 1n,
    updated_at: 0n,
  });
  primeRegistryDriverForTests(LOGIC, {
    routines: {
      GetAllAgentIds: routine(() => ({
        output: { ids: cards.map((_, i) => `agent_${i + 1}`), total: BigInt(cards.length) },
        error: null,
      })),
      GetAgentProfile: routine((id) => {
        const n = Number(String(id).replace("agent_", ""));
        return { output: n >= 1 && n <= cards.length ? { profile: profile(n), found: true } : { profile: {}, found: false }, error: null };
      }),
    },
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const lookup = (query: string, cardFetch: FetchLike) => resolveAgent(signer, query, { logicId: LOGIC, cardFetch });
/** A fetch that must never be reached: the card was refused before it. */
const unreachable = () => vi.fn<FetchLike>(async () => json({ name: "Never Read" }));

/** A resolver that answers every lookup with `answer`. */
const answering = (...answer: string[]) =>
  vi.fn<Resolver>(async () => answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

/**
 * A fetch that runs the real address check on the card's host (guardedLookup, with the given resolver) and then answers from
 * memory instead of opening a socket: a public name has nothing a test may connect to.
 */
const checkedThenServed =
  (resolve: Resolver, body: unknown): FetchLike =>
  async (url) => {
    await new Promise<void>((done, fail) => guardedLookup(resolve)(new URL(url).hostname, { all: true }, (err) => (err ? fail(err) : done())));
    return json(body);
  };

/** A TCP listener that counts connections: a refused address must never get one. */
async function countingServer() {
  let connections = 0;
  const server = createNetServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetRegistryCache();
  systemLookup.mockClear();
});

describe("an agent's card on a public host", () => {
  it("is fetched, once, without following a redirect and with a time limit, and read as before", async () => {
    prime("https://cards.example/agent_1.json");
    const fetched = vi.fn<FetchLike>(async () => json({ name: "Rain Check", skills: [{ id: "forecast" }] }));
    const out = await lookup("agent_1", fetched);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0]!;
    expect(url).toBe("https://cards.example/agent_1.json");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(out.name).toBe("Rain Check");
    expect(out.capabilities).toEqual(["forecast"]);
    expect(out.metadata?.["card"]).toEqual({ name: "Rain Check", skills: [{ id: "forecast" }] });
    expect(out).not.toHaveProperty("cardNote");
  });

  it("passes the address check when its name resolves to public addresses only, and is then read", async () => {
    prime("https://cards.example/agent_1.json");
    const resolve = answering("93.184.216.34", "2606:2800:220:1::1");
    const out = await lookup("agent_1", checkedThenServed(resolve, { name: "Rain Check" }));
    expect(resolve).toHaveBeenCalledWith("cards.example");
    expect(out.name).toBe("Rain Check");
    expect(out).not.toHaveProperty("cardNote");
  });

  it("is looked for only when the agent has one", async () => {
    for (const none of [undefined, ""]) {
      prime(none);
      const fetched = unreachable();
      const out = await lookup("agent_1", fetched);
      expect(out.found).toBe(true);
      expect(out).not.toHaveProperty("cardNote");
      expect(fetched).not.toHaveBeenCalled();
    }
  });
});

describe("a card address that is not https", () => {
  it("is refused before anything is fetched, and the agent still comes back with the address it registered", async () => {
    for (const uri of [
      "http://cards.example/c.json",
      "ftp://cards.example/c",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ipfs://bafybeigdyrztcardcid",
      "cards.example/c.json",
      "not a url",
    ]) {
      prime(uri);
      const fetched = unreachable();
      const out = await lookup("agent_1", fetched);
      expect(out.found, uri).toBe(true);
      expect(out.agentId).toBe("agent_1");
      expect(out.endpoint).toBe("https://agents.example/1");
      expect(out.cardNote, uri).toBe(NOT_HTTPS);
      // The note points at metadata.card_uri, so the address that was refused is there to be seen.
      expect(out.metadata?.["card_uri"], uri).toBe(uri);
      expect(fetched, uri).not.toHaveBeenCalled();
    }
  });
});

describe("a card host that reads as local, or is an IP address", () => {
  it("is refused by its spelling, before any lookup, a public IP address included", async () => {
    for (const uri of [
      "https://127.0.0.1:8443/c",
      "https://[::1]/c",
      "https://10.0.0.5/c",
      "https://169.254.169.254/latest/meta-data/",
      "https://93.184.216.34/c.json",
      "https://[2606:4700::1111]/c.json",
      "https://localhost/c",
      "https://localhost./c",
      "https://intranet/c",
      "https://printer.local/c",
      "https://db.internal/c",
    ]) {
      prime(uri);
      const fetched = unreachable();
      const out = await lookup("agent_1", fetched);
      expect(out.found, uri).toBe(true);
      expect(out.cardNote, uri).toBe(NOT_PUBLIC);
      expect(fetched, uri).not.toHaveBeenCalled();
    }
  });
});

describe("a card host whose name points inside the network", () => {
  it("is refused at connect time, before a socket is opened, and the agent still comes back", async () => {
    const srv = await countingServer();
    try {
      for (const answer of [
        ["127.0.0.1"],
        ["10.0.0.5"],
        ["169.254.169.254"],
        ["192.168.1.9"],
        ["0.0.0.0"],
        ["::1"],
        ["fe80::1"],
        ["fd00::1"],
        ["::ffff:10.0.0.5"],
        ["93.184.216.34", "10.0.0.5"],
        ["93.184.216.34", "fd00::1"],
        [],
      ]) {
        prime(`https://rebind.example:${srv.port}/card.json`);
        const resolve = answering(...answer);
        const out = await lookup("agent_1", publicFetch(resolve));
        expect(resolve, JSON.stringify(answer)).toHaveBeenCalledWith("rebind.example");
        expect(out.found, JSON.stringify(answer)).toBe(true);
        expect(out.address).toBe(walletOf(1));
        expect(out.cardNote, JSON.stringify(answer)).toBe(NOT_PUBLIC);
        expect(ResolveAgentOutput.safeParse(out).success).toBe(true);
      }
      // A name that does not resolve at all, or whose resolver fails, is refused in the same words, so the answer says
      // nothing of what exists inside the network.
      for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
        prime(`https://gone.example:${srv.port}/card.json`);
        const failing = vi.fn<Resolver>(async (host) => {
          throw Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
        });
        expect((await lookup("agent_1", publicFetch(failing))).cardNote, code).toBe(NOT_PUBLIC);
      }
      expect(srv.connections()).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

describe("a card that answers with a redirect", () => {
  it("is not followed: the one request is the only one, and where it pointed is not requested or reported", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      prime("https://cards.example/agent_1.json");
      const fetched = vi.fn<FetchLike>(
        async () => new Response(null, { status, headers: { location: "https://169.254.169.254/latest/meta-data/" } }),
      );
      const out = await lookup("agent_1", fetched);
      expect(fetched, String(status)).toHaveBeenCalledTimes(1);
      expect(fetched.mock.calls[0]![1]?.redirect).toBe("manual");
      expect(out.found).toBe(true);
      expect(out.cardNote, String(status)).toBe(REDIRECTED);
      expect(out.cardNote).not.toMatch(/169\.254/);
      expect(out.metadata).not.toHaveProperty("card");
    }
  });

  it("is told apart from the other 3xx answers, which undici does not treat as redirects", async () => {
    for (const status of [300, 304, 305]) {
      prime("https://cards.example/agent_1.json");
      const out = await lookup("agent_1", async () => new Response(null, { status }));
      expect(out.cardNote, String(status)).toBe(UNREADABLE);
    }
  });
});

describe("a card that cannot be read", () => {
  it("says it could not be fetched, and none of the error's own words", async () => {
    const undiciFailure = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
    const answers: FetchLike[] = [
      ...[400, 404, 429, 500, 503].map((status): FetchLike => async () => new Response("down", { status })),
      async () => new Response("<html>not a card</html>", { status: 200 }),
      async () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:443");
      },
      async () => {
        throw undiciFailure(new Error("getaddrinfo ENOTFOUND cards.example"));
      },
    ];
    for (const answer of answers) {
      prime("https://cards.example/agent_1.json");
      const out = await lookup("agent_1", answer);
      expect(out.found).toBe(true);
      expect(out.cardNote).toBe(UNREADABLE);
      expect(out.cardNote).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|ENOTFOUND|fetch failed/);
    }
  });

  it("says a body that is JSON but not an object is not a card: there is no name in it to show", async () => {
    for (const body of ["null", "0", '"hello"', "true", "[]", '[{"name":"x"}]']) {
      prime("https://cards.example/agent_1.json");
      const out = await lookup("agent_1", async () => new Response(body));
      expect(out.found, body).toBe(true);
      expect(out.cardNote, body).toBe(UNREADABLE);
      expect(out.name, body).toBeUndefined();
      expect(out.metadata, body).not.toHaveProperty("card");
    }
  });

  it("says a card over 64 KB was too large", async () => {
    prime("https://cards.example/agent_1.json");
    const out = await lookup("agent_1", async () => json({ name: "Big", pad: "x".repeat(300_000) }));
    expect(out.found).toBe(true);
    expect(out.cardNote).toBe(TOO_LARGE);
  });

  it("says a card that never connects timed out, once the five seconds are up", async () => {
    prime("https://cards.example/agent_1.json");
    vi.useFakeTimers();
    // Nothing comes back until the request is aborted, as a connect that hangs does.
    const hanging: FetchLike = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))));
    const pending = lookup("agent_1", hanging);
    await vi.advanceTimersByTimeAsync(5001);
    const out = await pending;
    expect(out.found).toBe(true);
    expect(out.cardNote).toBe(TIMED_OUT);
  });
});

describe("a registry scan with cards that are refused", () => {
  it("finds an agent by its wallet with its card refused, and by a card name past two refused cards without fetching them", async () => {
    prime("http://insecure.example/c.json", "https://10.0.0.1/c.json", "https://cards.example/3.json");
    const fetched = vi.fn<FetchLike>(async () => json({ name: "Rain Check" }));

    const byWallet = await lookup(walletOf(1), fetched);
    expect(byWallet.agentId).toBe("agent_1");
    expect(byWallet.cardNote).toBe(NOT_HTTPS);
    expect(fetched).not.toHaveBeenCalled();

    // Two cards are refused on the way and are never fetched; the third is served and its name matches.
    const byName = await lookup("rain", fetched);
    expect(byName.agentId).toBe("agent_3");
    expect(byName.name).toBe("Rain Check");
    expect(byName).not.toHaveProperty("cardNote");
    expect(fetched).toHaveBeenCalledTimes(1);

    // A name nobody has, with every card refused or empty, is an ordinary not-found, not an error.
    prime("http://insecure.example/c.json", "https://10.0.0.1/c.json");
    expect(await lookup("nobody", unreachable())).toEqual({ found: false, capabilities: [] });
  });
});

describe("the card read in production, with no fetch injected", () => {
  // The seam above (cardFetch) is only for tests. This one runs the real default, so a lookup that went back to a plain
  // fetch, which asks the system's own resolver and not the guard, would fail here: the mocked node:dns/promises is the
  // guard's resolver and is never asked by anything else.
  it("resolves the host through the address guard, and refuses a name that points at a private address without connecting", async () => {
    const srv = await countingServer();
    try {
      prime(`https://rebind.example:${srv.port}/card.json`);
      const out = await resolveAgent(signer, "agent_1", { logicId: LOGIC });
      expect(systemLookup).toHaveBeenCalledWith("rebind.example", { all: true });
      expect(out.found).toBe(true);
      expect(out.address).toBe(walletOf(1));
      expect(out.cardNote).toBe(NOT_PUBLIC);
      expect(srv.connections()).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("does not look a name up for an address that is refused by its spelling", async () => {
    prime("http://cards.example/c.json", "https://10.0.0.5/c.json", "https://localhost/c.json");
    for (const id of ["agent_1", "agent_2", "agent_3"]) {
      const out = await resolveAgent(signer, id, { logicId: LOGIC });
      expect(out.found).toBe(true);
      expect(out.cardNote).toBeDefined();
    }
    expect(systemLookup).not.toHaveBeenCalled();
  });
});
