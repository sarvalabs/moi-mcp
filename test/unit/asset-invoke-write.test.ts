/**
 * moi_asset_invoke on a routine that changes state: the one write path (simulate, preview, confirm token, phone,
 * journal), with the node and the phone faked. The handlers are the hosted ones run with the stdio adapters, so a write
 * is two calls: h.call is the first (a preview, or a refusal), h.send is both.
 */

import { MAS0AssetLogic } from "js-moi-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PIXEL, PIXEL_INFO } from "../helpers/asset-fixtures.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, session, structured, USER, TOPIC } from "../helpers/hosted.js";
import {
  fakeWallet,
  installWallet,
  journalLines,
  seedSession,
  signatureFor,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";
import { ACCOUNT, KMOI, MAS0_ASSET, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

type Op = { type: number; payload: Record<string, unknown> };

function signedIx(index = 0): Record<string, unknown> {
  const req = wallet.requests[index];
  expect(req, `expected a wallet request #${index}`).toBeDefined();
  expect(req!.request.method).toBe("moi.signInteraction");
  return req!.request.params[0] as Record<string, unknown>;
}
const opsOf = (ix: Record<string, unknown>) => ix["ix_operations"] as Op[];

/** The operations the node was asked to dry-run in the last moi.Call. */
function simulatedOps(): Array<{ type: number; payload: string }> {
  const call = node.calls.findLast((c) => c.method === "moi.Call");
  expect(call, "expected a moi.Call simulation").toBeDefined();
  return (call!.params["ix_args"] as { ix_operations: Array<{ type: number; payload: string }> }).ix_operations;
}

const BURN = { assetId: PIXEL, routine: "Burn", args: { amount: "5" } };
const holding = (assetId: string) => () => [{ asset_id: assetId, token_id: "0x0", amount: "0x64" }];
const sdkCalldata = (hex: unknown) => String(hex).replace(/^0x/, "");

describe("the same bytes as the shortcuts, through the tools", () => {
  it("Transfer is what moi_transfer signs", async () => {
    seedSession(h.home);
    node.on("moi.TDU", holding(PIXEL));
    await h.send("moi_transfer", { to: OTHER, assetId: PIXEL, amount: "5" });
    const generic = await h.send("moi_asset_invoke", { assetId: PIXEL, routine: "Transfer", args: { beneficiary: OTHER, amount: "5" } });
    expect(generic.structuredContent?.["status"]).toBe("sent");
    expect(wallet.requests).toHaveLength(2);
    expect(opsOf(signedIx(1))).toEqual(opsOf(signedIx(0)));
    expect(signedIx(1)["participants"]).toEqual(signedIx(0)["participants"]);
  });

  it("Mint is what moi_mint signs", async () => {
    seedSession(h.home);
    await h.send("moi_mint", { assetId: PIXEL, to: OTHER, amount: "5" });
    const generic = await h.send("moi_asset_invoke", { assetId: PIXEL, routine: "Mint", args: { beneficiary: OTHER, amount: "5" } });
    expect(generic.structuredContent?.["status"]).toBe("sent");
    expect(opsOf(signedIx(1))).toEqual(opsOf(signedIx(0)));
    expect(signedIx(1)["participants"]).toEqual(signedIx(0)["participants"]);
  });
});

describe("a burn, end to end", () => {
  it("previews first, in whole tokens and base units, and sends nothing to the phone", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_asset_invoke", BURN);
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: "Burn 5 PIXEL",
      details: { Operation: "Burn", Asset: `PIXEL ${PIXEL}`, Amount: "5", "Amount in base units": "5" },
    });
    expect(typeof preview.structuredContent?.["confirm"]).toBe("string");
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).toContain("moi.Call"); // simulated before the person is asked
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("then signs on the phone once, broadcasts the signed bytes, and journals every step as asset_invoke", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_asset_invoke", BURN);
    expect(sent.structuredContent).toEqual({
      status: "sent",
      summary: "Burn 5 PIXEL",
      hash: SENT_HASH,
      explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
    });
    expect(wallet.request).toHaveBeenCalledTimes(1);

    const ix = signedIx();
    const ops = opsOf(ix);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe(5);
    expect(ops[0]!.payload["callsite"]).toBe("Burn");
    expect(ops[0]!.payload["asset_id"]).toBe(PIXEL);
    const sdk = new MAS0AssetLogic(PIXEL, {} as never).burn(5);
    expect(ops[0]!.payload["calldata"]).toBe(sdkCalldata(sdk.payload().calldata));
    expect(String(ops[0]!.payload["calldata"])).not.toMatch(/^0x/);
    expect(ix["participants"]).toEqual([{ id: PIXEL, lock_type: 0, notary: false }]);

    expect(node.calls.find((c) => c.method === "moi.SendInteractions")?.params).toEqual(signatureFor(wallet.requests[0]!));
    const lines = journalLines(h.home);
    expect(lines.map((l) => l["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    for (const line of lines) expect(line).toMatchObject({ kind: "asset_invoke", userId: "local" });
  });

  it("simulates the interaction that is signed, in this order: reads, nonce, estimate, simulate, phone, broadcast", async () => {
    seedSession(h.home);
    await h.send("moi_asset_invoke", BURN);
    const simulated = simulatedOps();
    expect(simulated).toHaveLength(1);
    expect(simulated[0]!.type).toBe(5);
    expect(simulated[0]!.payload).toContain(String(opsOf(signedIx())[0]!.payload["calldata"]));
    const methods = node.methods();
    expect(methods.indexOf("moi.LogicManifest")).toBeGreaterThan(methods.indexOf("moi.AssetInfoByAssetID"));
    expect(methods.indexOf("moi.PendingInteractionCount")).toBeGreaterThan(methods.indexOf("moi.LogicManifest"));
    expect(methods.indexOf("moi.FuelEstimate")).toBeGreaterThan(methods.indexOf("moi.PendingInteractionCount"));
    expect(methods.indexOf("moi.Call")).toBeGreaterThan(methods.indexOf("moi.FuelEstimate"));
    expect(methods.indexOf("moi.SendInteractions")).toBe(methods.length - 1);
  });

  it("says Approve with the cap and the expiry as given", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_asset_invoke", {
      assetId: PIXEL,
      routine: "Approve",
      args: { beneficiary: OTHER, amount: 10, expires_at: 1893456000 },
    });
    expect(preview.structuredContent?.["summary"]).toBe(
      `Approve ${OTHER} to spend up to 10 PIXEL until 1893456000 (as unix seconds that is 2030-01-01T00:00:00.000Z; the unit is not confirmed)`,
    );
    expect(preview.structuredContent?.["details"]).toMatchObject({ "Expires at (as given)": "1893456000", "Spending cap": "10" });
  });

  it("takes base units for an asset with decimals, shows whole tokens, and refuses a fraction", async () => {
    seedSession(h.home);
    node.on("moi.AssetInfoByAssetID", () => ({ ...PIXEL_INFO, decimals: "0x9" }));
    const ok = await h.call("moi_asset_invoke", { ...BURN, args: { amount: "1500000000" } });
    expect(ok.structuredContent).toMatchObject({
      summary: "Burn 1.5 PIXEL",
      details: { Amount: "1.5", "Amount in base units": "1500000000" },
    });
    node.reset();
    node.on("moi.AssetInfoByAssetID", () => ({ ...PIXEL_INFO, decimals: "0x9" }));
    const fraction = await h.call("moi_asset_invoke", { ...BURN, args: { amount: "1.5" } });
    expect(fraction.isError).toBe(true);
    expect(fraction.text).toMatch(/^\[INVALID_ARGS\] /);
    expect(fraction.text).toMatch(/This asset has 9 decimals, so one whole token is 10\^9 base units/);
    expect(node.methods()).not.toContain("moi.PendingInteractionCount");
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("the preview is bound to the call", () => {
  const token = (r: { structuredContent?: Record<string, unknown> }) => String(r.structuredContent?.["confirm"]);

  it("a confirm with changed arguments gets a fresh preview and a note, and nothing reaches the phone", async () => {
    seedSession(h.home);
    const first = await h.call("moi_asset_invoke", BURN);
    const again = await h.call("moi_asset_invoke", { ...BURN, args: { amount: "6" }, confirm: token(first) });
    expect(again.structuredContent).toMatchObject({ status: "preview", summary: "Burn 6 PIXEL" });
    expect(String(again.structuredContent?.["note"])).toMatch(/did not match this call/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("accepts the token when the same arguments come in another key order, for a described routine", async () => {
    seedSession(h.home);
    const first = await h.call("moi_asset_invoke", { assetId: PIXEL, routine: "Transfer", args: { beneficiary: OTHER, amount: "5" } });
    const sent = await h.call("moi_asset_invoke", {
      confirm: token(first),
      args: { amount: "5", beneficiary: OTHER },
      routine: "Transfer",
      assetId: PIXEL,
    });
    expect(sent.structuredContent?.["status"]).toBe("sent");
    expect(wallet.request).toHaveBeenCalledTimes(1);
  });

  it("accepts it for metadata given as {b, a} on the preview and {a, b} on the confirm", async () => {
    seedSession(h.home);
    const args = (static_metadata: Record<string, string>) => ({ beneficiary: OTHER, amount: "5", static_metadata });
    const first = await h.call("moi_asset_invoke", { assetId: MAS0_ASSET, routine: "MintWithMetadata", args: args({ b: "0x02", a: "0x01" }) });
    expect(first.structuredContent).toMatchObject({ status: "preview", details: { "Metadata entries": "2" } });
    const sent = await h.call("moi_asset_invoke", {
      assetId: MAS0_ASSET,
      routine: "MintWithMetadata",
      args: args({ a: "0x01", b: "0x02" }),
      confirm: token(first),
    });
    expect(sent.structuredContent?.["status"]).toBe("sent");
  });
});

describe("guard order", () => {
  it("unpaired: asks the node for the asset and its manifest, then stops before anything is simulated, built or signed", async () => {
    const result = await h.call("moi_asset_invoke", BURN);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).toEqual(["moi.AssetInfoByAssetID", "moi.LogicManifest"]);
  });

  it("on another network, or with an expired pairing, is refused as moi_transfer refuses it", async () => {
    seedSession(h.home, { network: "voyage", chainId: "moi:14" });
    const other = await h.call("moi_asset_invoke", BURN);
    expect(other.structuredContent).toMatchObject({ status: "rejected", reason: "network_mismatch" });

    seedSession(h.home, { expiry: Math.floor(Date.now() / 1000) - 10 });
    const expired = await h.call("moi_asset_invoke", BURN);
    expect(expired.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });
});

describe("a call the node says would fail", () => {
  it("is refused with the node's status and never reaches the phone", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    const result = await h.call("moi_asset_invoke", BURN);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[INVALID_ARGS\] /);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/You can only burn what the signing account holds/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("carries the manager hint for a Mint, and previews a Mint that would succeed", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    const failed = await h.call("moi_asset_invoke", { assetId: MAS0_ASSET, routine: "Mint", args: { beneficiary: OTHER, amount: "5" } });
    expect(failed.text).toMatch(/Minting requires you to be the asset's manager/);

    node.state.callStatus = 0;
    const ok = await h.call("moi_asset_invoke", { assetId: MAS0_ASSET, routine: "Mint", args: { beneficiary: ACCOUNT, amount: "5" } });
    // The mock reports the symbol KMOI for every asset id.
    expect(ok.structuredContent).toMatchObject({ status: "preview", summary: `Mint 5 KMOI to ${ACCOUNT}` });
  });
});

describe("what the phone and the network can do", () => {
  it("a refusal on the phone is rejected/user_rejected, and nothing is broadcast", async () => {
    seedSession(h.home);
    wallet.request.mockRejectedValueOnce({ code: 5000, message: "User rejected the request" });
    const result = await h.send("moi_asset_invoke", BURN);
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "user_rejected" });
    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(journalLines(h.home).map((l) => l["state"])).toEqual(["proposed", "failed"]);
  });

  it("a broadcast that fails after the tap is an error, not a rejection", async () => {
    seedSession(h.home);
    node.on("moi.SendInteractions", () => {
      throw new Error("ixpool full");
    });
    const result = await h.send("moi_asset_invoke", BURN);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/approved the interaction but broadcasting it failed/);
  });
});

describe("the native asset", () => {
  it("previews a Transfer by symbol and signs the same participants as the SDK's own class", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_asset_invoke", { assetId: KMOI, routine: "Transfer", args: { beneficiary: OTHER, amount: "10" } });
    expect(sent.structuredContent).toMatchObject({ status: "sent", summary: `Transfer 10 KMOI to ${OTHER}` });
    // The SDK's normalised order: the asset first, then the recipient, each stamped notary:false.
    expect(signedIx()["participants"]).toEqual([
      { id: KMOI, lock_type: 2, notary: false },
      { id: OTHER, lock_type: 0, notary: false },
    ]);
  });
});

describe("on the hosted server", () => {
  it("a write goes through the user's own pairing: one request to their topic, one journal entry of its kind", async () => {
    const store = fakeStore(new Map([[USER, session()], ["user-b", session({ userId: "user-b", topic: "topic-b" })]]));
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal));
    try {
      const first = await client.callTool({ name: "moi_asset_invoke", arguments: BURN });
      expect(structured(first)).toMatchObject({ status: "preview" });
      expect(hub.signInteractionFor).not.toHaveBeenCalled();
      const confirm = (structured(first) as { confirm: string }).confirm;
      const sent = await client.callTool({ name: "moi_asset_invoke", arguments: { ...BURN, confirm } });
      expect(structured(sent)).toMatchObject({ status: "sent", hash: SENT_HASH });
      expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
      expect(hub.signInteractionFor.mock.calls[0]![0]).toBe(TOPIC);
      expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ kind: "asset_invoke", userId: USER }));
      expect(store.delete).not.toHaveBeenCalled(); // neither user's pairing was touched
    } finally {
      await client.close();
    }
  });
});
