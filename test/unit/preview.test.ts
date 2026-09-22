/**
 * The preview step. A hosted write is shown in the chat before it reaches
 * the phone, and nothing reaches the phone without a token proving it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fingerprint, PreviewRegistry } from "../../src/tools/preview.js";
import { KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";
import { fakeWallet, installWallet, startHarness, type Harness } from "../helpers/harness.js";
import {
  connect,
  deps,
  fakeHub,
  fakeJournal,
  fakeStore,
  send,
  session,
  structured,
  USER,
} from "../helpers/hosted.js";

type Preview = {
  status: string;
  confirm: string;
  summary: string;
  details: Record<string, string>;
  note?: string;
};

describe("PreviewRegistry", () => {
  const key = { userId: "u", kind: "transfer", fingerprint: fingerprint({ amount: "1", to: "0x1" }) };

  it("redeems a token once, for the same user, tool and arguments", () => {
    const r = new PreviewRegistry();
    const { token } = r.issue({ ...key, details: { Amount: "1" } });
    expect(r.redeem(token, key)?.details).toEqual({ Amount: "1" });
    expect(r.redeem(token, key)).toBeUndefined();
  });

  it("refuses another user's token and leaves it intact for its owner", () => {
    const r = new PreviewRegistry();
    const { token } = r.issue({ ...key, details: {} });
    expect(r.redeem(token, { ...key, userId: "someone-else" })).toBeUndefined();
    expect(r.redeem(token, key)).toBeDefined();
  });

  it("refuses a different tool or different arguments", () => {
    const r = new PreviewRegistry();
    const { token } = r.issue({ ...key, details: {} });
    expect(r.redeem(token, { ...key, kind: "mint" })).toBeUndefined();
    expect(r.redeem(token, { ...key, fingerprint: fingerprint({ amount: "2", to: "0x1" }) })).toBeUndefined();
    expect(r.redeem(token, key)).toBeDefined();
  });

  it("refuses after expiry and forgets the entry", () => {
    let t = 1000;
    const r = new PreviewRegistry({ ttlMs: 100, now: () => t });
    const { token, expiresAt } = r.issue({ ...key, details: {} });
    expect(expiresAt).toBe(1100);
    t = 1100;
    expect(r.redeem(token, key)).toBeUndefined();
    expect(r.size).toBe(0);
  });

  it("keeps only the newest few per user", () => {
    let t = 0;
    const r = new PreviewRegistry({ maxPerUser: 2, now: () => t++ });
    const first = r.issue({ ...key, details: {} }).token;
    r.issue({ ...key, details: {} });
    const third = r.issue({ ...key, details: {} }).token;
    expect(r.redeem(first, key)).toBeUndefined();
    expect(r.redeem(third, key)).toBeDefined();
  });

  it("fingerprints the same arguments the same way however they are written", () => {
    expect(fingerprint({ a: 1, b: undefined, c: [1, { y: 2, x: 1 }] })).toBe(
      fingerprint({ c: [1, { x: 1, y: 2 }], a: 1 }),
    );
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("a hosted write is previewed before it touches the phone", () => {
  let node: MockNode;
  let h: Harness;
  const TRANSFER = { to: OTHER, assetId: KMOI, amount: "10" };
  const soon = () => Math.floor(Date.now() / 1000) + 600;

  beforeEach(async () => {
    node = await startMockNode();
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());
  });

  afterEach(async () => {
    await h.close();
    await node.close();
  });

  it("the first call returns what the phone will show and touches nothing", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: soon() })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal));

    const r = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const out = structured<Preview>(r);

    expect(out.status).toBe("preview");
    expect(out.confirm).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(out.summary).toMatch(/^Transfer 10 KMOI to 0x/);
    expect(out.details).toMatchObject({
      Operation: "Transfer",
      Amount: "10",
      "Amount in base units": "10",
      To: OTHER,
    });
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain("Nothing has been sent to the phone");

    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
    // A once-only pairing is not spent by looking.
    expect(records.has(USER)).toBe(true);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("the confirm token sends exactly what was previewed, and only once", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const preview = structured<Preview>(await client.callTool({ name: "moi_transfer", arguments: TRANSFER }));
    const sent = structured<{ status: string; hash?: string; summary?: string }>(
      await client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm: preview.confirm } }),
    );
    expect(sent.status).toBe("sent");
    expect(sent.hash).toBe(SENT_HASH);
    expect(sent.summary).toBe(preview.summary);
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);

    const again = structured<Preview>(
      await client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm: preview.confirm } }),
    );
    expect(again.status).toBe("preview");
    expect(again.note).toMatch(/did not match/);
    expect(again.confirm).not.toBe(preview.confirm);
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });

  it("a token is bound to the arguments it previewed", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const preview = structured<Preview>(await client.callTool({ name: "moi_transfer", arguments: TRANSFER }));
    const swapped = structured<Preview>(
      await client.callTool({
        name: "moi_transfer",
        arguments: { ...TRANSFER, amount: "20", confirm: preview.confirm },
      }),
    );
    expect(swapped.status).toBe("preview");
    expect(swapped.note).toMatch(/did not match/);
    expect(swapped.details["Amount"]).toBe("20");
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  it("a made-up token gets a preview, not a transaction", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<Preview>(
      await client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm: "nope" } }),
    );
    expect(out.status).toBe("preview");
    expect(out.note).toMatch(/did not match/);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  it("when the numbers move between preview and confirm, the user sees them again", async () => {
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const hub = fakeHub();
    const client = await connect(deps(store, hub));
    const CREATE = { symbol: "TST", supply: "1000" };
    const fundOf = (p: Preview) => p.details[Object.keys(p.details).find((k) => k.startsWith("Storage fund"))!];

    // Rich enough for the default storage fund at preview time...
    node.state.kmoiBalance = 50_000_000_000n; // 50 KMOI: covers the default
    const preview = structured<Preview>(await client.callTool({ name: "moi_create_asset", arguments: CREATE }));
    expect(preview.status).toBe("preview");

    // ...then the balance drops, so the fund the asset would get is smaller.
    node.state.kmoiBalance = 9_500_000_000n; // 9.5 KMOI: only the floor fits
    const changed = structured<Preview>(
      await client.callTool({ name: "moi_create_asset", arguments: { ...CREATE, confirm: preview.confirm } }),
    );
    expect(changed.status).toBe("preview");
    expect(changed.note).toMatch(/numbers changed/);
    expect(fundOf(changed)).not.toBe(fundOf(preview));
    expect(hub.signInteractionFor).not.toHaveBeenCalled();

    // The fresh token, with the numbers now stable, goes through.
    const sent = structured<{ status: string }>(
      await client.callTool({ name: "moi_create_asset", arguments: { ...CREATE, confirm: changed.confirm } }),
    );
    expect(sent.status).toBe("sent");
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });

  it("with no wallet paired, the preview itself says so", async () => {
    const hub = fakeHub();
    const client = await connect(deps(fakeStore(new Map()), hub));
    const out = structured<{ status: string; reason?: string }>(await send(client, "moi_transfer", TRANSFER));
    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });

  it("a balance shortfall is reported at preview time, before anyone is asked for a yes", async () => {
    const hub = fakeHub();
    const client = await connect(deps(fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]])), hub));
    node.state.kmoiBalance = 5n;
    const r = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/^\[INSUFFICIENT_BALANCE\]/);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });
});
