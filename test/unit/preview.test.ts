/**
 * The preview step. A hosted write is shown in the chat before it reaches
 * the phone, and nothing reaches the phone without a token proving it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cut, fingerprint, fingerprintDigest, PreviewRegistry, previewBlock, redeemOrIssue } from "../../src/tools/preview.js";
import {
  KMOI,
  MAS0_ASSET,
  MAS1_ASSET,
  MAS2_ASSET,
  MASX_ASSET,
  OTHER,
  SENT_HASH,
  startMockNode,
  type MockNode,
} from "../helpers/mock-node.js";
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

describe("redeemOrIssue, the gate for a call with no phone behind it", () => {
  const key = { userId: "u", kind: "dapp_call", fingerprint: fingerprintDigest({ op: "echo", body: { a: 1 } }) };

  it("issues a token with no note when there is no confirm", () => {
    const r = new PreviewRegistry();
    const out = redeemOrIssue(r, key, undefined)!;
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(out.note).toBeUndefined();
    expect(r.size).toBe(1);
  });

  it("lets a matching token through once, and spends it", () => {
    const r = new PreviewRegistry();
    const { token } = redeemOrIssue(r, key, undefined)!;
    expect(redeemOrIssue(r, key, token)).toBeUndefined();
    expect(r.size).toBe(0);
    // The same token again is a fresh preview with the note, and still sends nothing.
    const again = redeemOrIssue(r, key, token)!;
    expect(again.token).not.toBe(token);
    expect(again.note).toMatch(/did not match/);
  });

  it("gives a fresh preview and a note for a wrong, expired or other-user token, leaving the owner's alone", () => {
    let t = 1000;
    const r = new PreviewRegistry({ ttlMs: 100, now: () => t });
    const { token } = redeemOrIssue(r, key, undefined)!;
    expect(redeemOrIssue(r, key, "nope")!.note).toMatch(/did not match/);
    expect(redeemOrIssue(r, { ...key, userId: "someone-else" }, token)!.note).toMatch(/did not match/);
    expect(redeemOrIssue(r, { ...key, kind: "launchpad_create_agent" }, token)!.note).toMatch(/did not match/);
    expect(redeemOrIssue(r, { ...key, fingerprint: fingerprintDigest({ op: "echo", body: { a: 2 } }) }, token)!.note).toMatch(/did not match/);
    // None of those burned the owner's token.
    expect(redeemOrIssue(r, key, token)).toBeUndefined();

    const second = redeemOrIssue(r, key, undefined)!.token;
    t = 1100;
    expect(redeemOrIssue(r, key, second)!.note).toMatch(/did not match/);
  });

  it("says nothing was sent in the note, and never mentions the phone", () => {
    const r = new PreviewRegistry();
    const note = redeemOrIssue(r, key, "nope")!.note!;
    expect(note).toMatch(/Nothing was sent/);
    expect(note).not.toMatch(/phone/);
  });

  it("lets exactly one of two concurrent confirms with one token through", async () => {
    const r = new PreviewRegistry();
    const { token } = redeemOrIssue(r, key, undefined)!;
    const results = await Promise.all([0, 1].map(async () => redeemOrIssue(r, key, token)));
    expect(results.filter((x) => x === undefined)).toHaveLength(1);
  });

  it("digests the same arguments the same way and different ones differently, at a fixed size", () => {
    expect(fingerprintDigest({ b: 2, a: [1, { y: 2, x: 1 }] })).toBe(fingerprintDigest({ a: [1, { x: 1, y: 2 }], b: 2 }));
    expect(fingerprintDigest({ a: 1 })).not.toBe(fingerprintDigest({ a: 2 }));
    expect(fingerprintDigest({ big: "x".repeat(1_000_000) })).toMatch(/^[0-9a-f]{64}$/);
    // The last byte of a large value still moves it.
    expect(fingerprintDigest({ big: "x".repeat(1_000_000) + "a" })).not.toBe(fingerprintDigest({ big: "x".repeat(1_000_000) + "b" }));
  });

  it("cuts long text and says how much was left out", () => {
    expect(cut("abc", 3)).toBe("abc");
    expect(cut("abcdef", 3)).toBe("abc… (3 more characters)");
  });

  it("writes the preview block with the note first, the request, and the token to send back", () => {
    const text = previewBlock({
      what: "https://dapp.example",
      summary: "POST https://dapp.example/api/echo",
      details: { Request: "POST /api/echo", Body: "{}" },
      token: "tok123",
      expiresAt: Date.UTC(2026, 0, 1),
      note: "A note.",
    });
    expect(text.split("\n")[0]).toBe("A note.");
    expect(text).toContain("Nothing has been sent to https://dapp.example");
    expect(text).toContain("  Request: POST /api/echo");
    expect(text).toContain('confirm="tok123"');
    expect(text).toContain("2026-01-01T00:00:00.000Z");
    expect(text).not.toMatch(/phone/);
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

  // An asset standard the tools are not built for is refused where the preview is built, so no token is issued, the
  // phone is never asked and nothing is journalled. KMOI cannot be minted, so it belongs in the mint rows.
  it.each([
    ["moi_mint", "MAS1", MAS1_ASSET],
    ["moi_mint", "MASX", MASX_ASSET],
    ["moi_mint", "KMOI (MASN)", KMOI],
    ["moi_transfer", "MAS1", MAS1_ASSET],
    ["moi_transfer", "MAS2", MAS2_ASSET],
  ])("%s on a %s asset is refused at preview: no token, no phone, no journal entry", async (tool, _standard, assetId) => {
    const previews = new PreviewRegistry();
    const hub = fakeHub();
    const journal = fakeJournal();
    const records = new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]);
    const client = await connect(deps(fakeStore(records), hub, journal, previews));
    const args = tool === "moi_mint" ? { assetId, amount: "1" } : { to: OTHER, assetId, amount: "1" };
    const textOf = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>)[0]!.text;

    const first = await client.callTool({ name: tool, arguments: args });
    expect(first.isError).toBe(true);
    expect(structured<{ status: string; code: string }>(first)).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(textOf(first)).toMatch(new RegExp(`^\\[INVALID_ARGS\\] ${tool} (does not support|cannot mint) `));
    expect(textOf(first)).toContain(assetId);
    expect(previews.size).toBe(0);
    // The asset read is all the node saw: no balance, nonce, fuel estimate or simulation.
    expect(node.methods()).toEqual(["moi.AssetInfoByAssetID"]);

    // A made-up confirm gets the same refusal: the check runs before the token is looked at.
    const again = await client.callTool({ name: tool, arguments: { ...args, confirm: "anything" } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(textOf(first));
    expect(previews.size).toBe(0);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  // Changed on purpose with the standards moi_create_asset builds: MAS1, MAS2 and MASX are created now, so this sends a
  // standard that is none of the four (MAS9) and expects the schema's new message and its four-name list.
  it("moi_create_asset refuses another standard in the hosted schema, before the session is even read", async () => {
    const previews = new PreviewRegistry();
    const hub = fakeHub();
    const journal = fakeJournal();
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const client = await connect(deps(store, hub, journal, previews));

    const r = await client.callTool({
      name: "moi_create_asset",
      arguments: { symbol: "TST", supply: "1000", standard: "MAS9" },
    });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/standard must be one of MAS0, MAS1, MAS2 or MASX \(default MAS0\)\. MASN is reserved/);
    expect(store.get).not.toHaveBeenCalled();
    expect(previews.size).toBe(0);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);

    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === "moi_create_asset")!;
    const standard = (create.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties["standard"]!;
    expect(standard.enum).toEqual(["MAS0", "MAS1", "MAS2", "MASX"]);
  });

  it.each([
    ["MAS0", MAS0_ASSET],
    ["MAS2", MAS2_ASSET],
  ])("a mint of a %s asset is still previewed", async (_standard, assetId) => {
    const hub = fakeHub();
    const client = await connect(
      deps(fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]])), hub),
    );
    const out = structured<Preview>(await client.callTool({ name: "moi_mint", arguments: { assetId, amount: "1" } }));
    expect(out.status).toBe("preview");
    expect(out.confirm).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(out.details).toMatchObject({ Operation: "Mint" });
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });
});
