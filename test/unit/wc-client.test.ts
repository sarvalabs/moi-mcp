import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoiError } from "../../src/moi-error.js";
import {
  accountsFrom,
  extractHash,
  paramStyle,
  toSession,
  translateWcError,
  WalletConnectClient,
  WC_NAMESPACE,
  type SignClientLike,
  type WcConfig,
} from "../../src/wc/client.js";
import { loadSession } from "../../src/wc/session.js";

const homes: string[] = [];
function cfg(overrides: Partial<WcConfig> = {}): WcConfig {
  const home = mkdtempSync(join(tmpdir(), "moi-wc-"));
  homes.push(home);
  return { projectId: "p", home, network: "voyage", requestTimeoutMs: 500, ...overrides };
}
afterEach(() => { for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true }); });

const APPROVED = {
  topic: "topic-1",
  pairingTopic: "pair-1",
  expiry: Math.floor(Date.now() / 1000) + 3600,
  peer: { metadata: { name: "MOI Wallet", url: "https://wallet.moi.technology" } },
  namespaces: { moi: { accounts: ["moi:14:0xabc123"] } },
};

/** Lets a test decide exactly when the "user scanned the QR" moment happens. */
function deferredApproval() {
  let approve: () => void = () => {};
  const scanned = new Promise<void>((r) => { approve = r; });
  return { approve, approval: async () => { await scanned; return APPROVED; } };
}

function fakeClient(over: Partial<SignClientLike> = {}, gate?: { approval: () => Promise<unknown> }): SignClientLike {
  return {
    connect: vi.fn(async () => ({
      uri: "wc:abc@2?relay-protocol=irn",
      approval: gate?.approval ?? (async () => APPROVED),
    })),
    request: vi.fn(async () => "0xfeed01"),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    session: { keys: [], get: () => undefined },
    ...over,
  } as SignClientLike;
}

describe("pairing", () => {
  it("requests the moi namespace with the network's CAIP-2 chain", async () => {
    const client = fakeClient();
    const wc = new WalletConnectClient(cfg(), async () => client);
    await wc.pair();
    const args = (client.connect as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      optionalNamespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
      requiredNamespaces?: unknown;
    };
    // requiredNamespaces is deprecated; WalletConnect moves it to optional anyway.
    expect(args.requiredNamespaces).toBeUndefined();
    const ns = args.optionalNamespaces[WC_NAMESPACE]!;
    expect(ns.chains).toEqual(["moi:14"]);
    expect(ns.methods).toEqual(["moi.signInteraction", "moi.sendInteractions", "moi.sign"]);
    expect(ns.events).toEqual(["accountsChanged", "chainChanged"]);
  });

  it("returns the URI immediately and persists the session only after approval", async () => {
    const c = cfg();
    const gate = deferredApproval();
    const wc = new WalletConnectClient(c, async () => fakeClient({}, gate));

    const { uri, approval } = await wc.pair();
    expect(uri).toMatch(/^wc:/);
    // The QR is out but nobody has scanned it: nothing may be written yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(loadSession(c.home)).toBeUndefined();

    gate.approve();
    await approval;
    expect(loadSession(c.home)?.account).toBe("0xabc123");
  });

  it("subscribes to session_delete and session_expire", async () => {
    const client = fakeClient();
    await new WalletConnectClient(cfg(), async () => client).init();
    const events = (client.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("session_delete");
    expect(events).toContain("session_expire");
  });

  it("surfaces a relay failure as RELAY_UNAVAILABLE", async () => {
    const wc = new WalletConnectClient(cfg(), async () => { throw new Error("getaddrinfo ENOTFOUND relay"); });
    await expect(wc.pair()).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
  });
});

describe("toSession", () => {
  it("takes the account from the CAIP-10 tail", () => {
    expect(toSession(APPROVED, "voyage", "moi:14").account).toBe("0xabc123");
  });

  it("refuses a session with no usable account instead of storing a broken one", () => {
    const bad = { ...APPROVED, namespaces: { moi: { accounts: [] } } };
    expect(() => toSession(bad, "voyage", "moi:14")).toThrow(MoiError);
  });
});

describe("sendInteraction", () => {
  const ix = { sender: { id: "0xa", sequence: 0, key_id: 0 }, fuel_price: 1, fuel_limit: 1, ix_operations: [] };

  async function paired(client: SignClientLike) {
    const c = cfg();
    const wc = new WalletConnectClient(c, async () => client);
    const { approval } = await wc.pair();
    return { wc, session: await approval };
  }

  it("sends the plain InteractionObject positionally, as the reference dapp does", async () => {
    const client = fakeClient();
    const { wc, session } = await paired(client);
    await wc.sendInteraction(session, ix as never);
    const req = (client.request as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      topic: string; chainId: string; request: { method: string; params: unknown[] };
    };
    expect(req.request.method).toBe("moi.sendInteractions");
    expect(req.chainId).toBe("moi:14");
    expect(req.request.params).toEqual([ix.sender.id, ix]); // [accountId, ixObject]
    expect(req.request.params[1]).not.toHaveProperty("ix_args");
  });

  it("maps a user rejection to USER_REJECTED", async () => {
    const err = Object.assign(new Error("User rejected."), { code: 5000 });
    const { wc, session } = await paired(fakeClient({ request: vi.fn(async () => { throw err; }) as never }));
    await expect(wc.sendInteraction(session, ix as never)).rejects.toMatchObject({ code: "USER_REJECTED" });
  });

  it("maps a 4001 rejection too", async () => {
    const err = Object.assign(new Error("nope"), { code: 4001 });
    const { wc, session } = await paired(fakeClient({ request: vi.fn(async () => { throw err; }) as never }));
    await expect(wc.sendInteraction(session, ix as never)).rejects.toMatchObject({ code: "USER_REJECTED" });
  });

  it("times out when the phone is ignored", async () => {
    const { wc, session } = await paired(fakeClient({ request: vi.fn(() => new Promise(() => {})) as never }));
    await expect(wc.sendInteraction(session, ix as never)).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("tracks in-flight requests so status can report them", async () => {
    let release: (v: string) => void = () => {};
    const client = fakeClient({ request: vi.fn(() => new Promise<string>((r) => { release = r; })) as never });
    const { wc, session } = await paired(client);
    const inFlight = wc.sendInteraction(session, ix as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(wc.pendingRequests).toBe(1);
    release("0xfeed02");
    await inFlight;
    expect(wc.pendingRequests).toBe(0);
  });

  it("clears the local session on disconnect", async () => {
    const c = cfg();
    const wc = new WalletConnectClient(c, async () => fakeClient());
    await (await wc.pair()).approval;
    expect(loadSession(c.home)).toBeDefined();
    expect(await wc.disconnect()).toBe(true);
    expect(loadSession(c.home)).toBeUndefined();
  });
});

describe("extractHash", () => {
  it("accepts a bare hash string — the shape the reference dapp assumes", () => {
    expect(extractHash("0xabc")).toBe("0xabc");
  });

  it("accepts an object under any of the plausible field names", () => {
    for (const key of ["hash", "ix_hash", "interaction_hash", "txHash", "result"]) {
      expect(extractHash({ [key]: "0xdef" })).toBe("0xdef");
    }
  });

  it("fails loudly rather than inventing a hash", () => {
    for (const bad of [null, {}, "not-hex", { hash: 12 }]) {
      expect(() => extractHash(bad)).toThrow(MoiError);
    }
  });
});

describe("translateWcError", () => {
  it("recognises rejection wording without a code", () => {
    expect(translateWcError(new Error("User declined the request")).code).toBe("USER_REJECTED");
  });

  it("maps a dead session to WALLET_NOT_CONNECTED", () => {
    expect(translateWcError(new Error("No matching key. session topic doesn't exist")).code)
      .toBe("WALLET_NOT_CONNECTED");
  });

  it("falls back to RPC_ERROR", () => {
    expect(translateWcError(new Error("something else")).code).toBe("RPC_ERROR");
  });

  it("passes a MoiError through untouched", () => {
    const e = new MoiError("REQUEST_TIMEOUT" as never, "x");
    expect(translateWcError(e)).toBe(e);
  });
});

describe("paramStyle", () => {
  it("defaults to positional", () => {
    expect(paramStyle({})).toBe("positional");
  });

  it("switches to ix_args on request, without a code change", () => {
    expect(paramStyle({ MOI_WC_PARAM_STYLE: "ix_args" })).toBe("ix_args");
  });
});

describe("@walletconnect/sign-client interop", () => {
  // Guards an ESM/CJS trap: the default export is a module object of
  // constants whose .init is undefined, so a default import compiles but
  // dies at runtime with "SignClient.init is not a function".
  it("exposes SignClient.init via the named export", async () => {
    const mod = await import("@walletconnect/sign-client");
    expect(typeof mod.SignClient?.init).toBe("function");
  });
});

describe("wire-shape validation (schema.ts §4)", () => {
  const good = {
    sender: { id: "0xabc", sequence: 0, key_id: 0 },
    fuel_price: 1,
    fuel_limit: 200,
    ix_operations: [{ type: 5, payload: { callsite: "Transfer" } }],
  };

  async function paired(client: SignClientLike, envStyle?: string) {
    const prev = process.env["MOI_WC_PARAM_STYLE"];
    if (envStyle) process.env["MOI_WC_PARAM_STYLE"] = envStyle;
    else delete process.env["MOI_WC_PARAM_STYLE"];
    const wc = new WalletConnectClient(cfg(), async () => client);
    const session = await (await wc.pair()).approval;
    return { wc, session, restore: () => {
      if (prev === undefined) delete process.env["MOI_WC_PARAM_STYLE"];
      else process.env["MOI_WC_PARAM_STYLE"] = prev;
    } };
  }

  it("sends the positional InteractionObject by default", async () => {
    const client = fakeClient();
    const { wc, session, restore } = await paired(client);
    await wc.sendInteraction(session, good as never);
    const req = (client.request as ReturnType<typeof vi.fn>).mock.calls[0]![0] as
      { request: { params: unknown[] } };
    expect(req.request.params).toEqual([good.sender.id, good]);
    restore();
  });

  it("sends the POLO ix_args form when MOI_WC_PARAM_STYLE=ix_args", async () => {
    const client = fakeClient();
    const { wc, session, restore } = await paired(client, "ix_args");
    await wc.sendInteraction(session, good as never, { poloHex: "0e9f02ab", description: "Transfer 1 X" });
    const req = (client.request as ReturnType<typeof vi.fn>).mock.calls[0]![0] as
      { request: { params: Array<{ ix_args: string; accountId: string; meta?: { description?: string } }> } };
    expect(req.request.params[0]!.ix_args).toBe("0e9f02ab");
    expect((req.request.params[0] as unknown as { accountId: string }).accountId).toBe(good.sender.id);
    expect(req.request.params[0]!.meta?.description).toBe("Transfer 1 X");
    restore();
  });

  it("refuses a 0x-prefixed ix_args — the wallet expects bare POLO hex", async () => {
    const { wc, session, restore } = await paired(fakeClient(), "ix_args");
    await expect(
      wc.sendInteraction(session, good as never, { poloHex: "0x0e9f02ab" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    restore();
  });

  it("rejects a malformed interaction locally, before the relay sees it", async () => {
    const client = fakeClient();
    const { wc, session, restore } = await paired(client);
    const bad = { ...good, sender: { id: "not-hex", sequence: 0, key_id: 0 } };
    await expect(wc.sendInteraction(session, bad as never)).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
    // Nothing was sent to the phone.
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    restore();
  });

  it("explains itself when ix_args style is selected without an encoding", async () => {
    const { wc, session, restore } = await paired(fakeClient(), "ix_args");
    await expect(wc.sendInteraction(session, good as never)).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
    restore();
  });
});

describe("chain-keyed namespaces (real MOI Wallet response)", () => {
  /**
   * Captured verbatim from a real pairing on 2026-08-26. We request
   * `{ moi: {...} }`; the wallet grants `{ "moi:14": {...} }`. Reading only
   * `namespaces.moi` threw away a session the user had already approved.
   */
  const REAL_APPROVAL = {
    topic: "f44cf69d0e0e8891feeade02d81e11414d6ca115f654b66a30a3af4fc26a66d4",
    expiry: 1788325432,
    peer: { metadata: { name: "MOI Wallet", url: "https://moi.technology" } },
    namespaces: {
      "moi:14": {
        chains: ["moi:14"],
        methods: ["moi.sendInteractions", "moi.signInteraction", "moi.sign"],
        events: ["accountsChanged", "chainChanged"],
        accounts: ["moi:14:0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000"],
      },
    },
  };

  it("accepts a namespace keyed by the full CAIP-2 chain id", () => {
    const s = toSession(REAL_APPROVAL, "voyage", "moi:14");
    expect(s.account).toBe("0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000");
    expect(s.topic).toBe(REAL_APPROVAL.topic);
    expect(s.peer.name).toBe("MOI Wallet");
    expect(s.network).toBe("voyage");
  });

  it("still accepts the bare-namespace spelling", () => {
    const bare = { ...REAL_APPROVAL, namespaces: { moi: REAL_APPROVAL.namespaces["moi:14"] } };
    expect(toSession(bare, "voyage", "moi:14").account).toMatch(/^0x/);
  });

  it("prefers an account on the chain we asked for", () => {
    const mixed = {
      ...REAL_APPROVAL,
      namespaces: {
        "moi:99": { accounts: ["moi:99:0xbbb"] },
        "moi:14": { accounts: ["moi:14:0xaaa"] },
      },
    };
    expect(toSession(mixed, "voyage", "moi:14").account).toBe("0xaaa");
  });

  it("ignores namespaces belonging to other chains entirely", () => {
    expect(accountsFrom({ eip155: { accounts: ["eip155:1:0xdead"] } }, "moi:14")).toEqual([]);
  });

  it("still refuses a session that grants no moi account", () => {
    const empty = { ...REAL_APPROVAL, namespaces: { "moi:14": { accounts: [] } } };
    expect(() => toSession(empty, "voyage", "moi:14")).toThrow(MoiError);
  });
});
