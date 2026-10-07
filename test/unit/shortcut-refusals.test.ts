/**
 * The refusals of moi_transfer and moi_mint for the standards they cannot build. Each names moi_asset_invoke as the way
 * (MAS1 and MAS2 transfers take a token id there, a MAS1 mint takes a beneficiary and no amount), except for the native asset,
 * which nothing can mint. No token id was added to the shortcuts, and the allow-lists did not move. The older tests in
 * tools-writes.test.ts pin the first half of each message and are not edited; these pin the new half.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertStandardSupported } from "../../src/capabilities/assets/shortcuts.js";
import { isMoiError } from "../../src/moi-error.js";
import { TransferInput } from "../../src/schema.js";
import { fakeWallet, installWallet, seedSession, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { KMOI, MAS0_ASSET, MAS1_ASSET, MAS2_ASSET, MASX_ASSET, OTHER, startMockNode, UNKNOWN_STANDARD_ASSET, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet);
  seedSession(h.home);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

const NOTHING = /Nothing was sent to your wallet\.$/;
const OWN = (routine: string) =>
  `A MASX asset defines its own ${routine}, and this tool does not know its shape. List its routines with moi_asset_routines and call the one you want with moi_asset_invoke.`;
const UNRECOGNISED =
  "This tool does not recognise that standard. If the node has a manifest for the asset, moi_asset_routines lists what it can do and moi_asset_invoke calls a routine.";

describe("every transfer refusal names moi_asset_invoke", () => {
  it.each([
    ["MAS1", MAS1_ASSET],
    ["MAS2", MAS2_ASSET],
    ["MASX", MASX_ASSET],
    ["UNKNOWN(9)", UNKNOWN_STANDARD_ASSET],
    ["unreadable", OTHER],
  ])("%s", async (standard, assetId) => {
    const result = await h.call("moi_transfer", { to: OTHER, assetId, amount: "1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(result.text).toContain(`its standard is ${standard}`);
    expect(result.text).toContain("moi_asset_invoke");
    expect(result.text).toMatch(NOTHING);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).toEqual(["moi.AssetInfoByAssetID"]);
  });

  it("the MAS1 refusal says token id and beneficiary, and the MAS2 one adds amount", async () => {
    const mas1 = await h.call("moi_transfer", { to: OTHER, assetId: MAS1_ASSET, amount: "1" });
    expect(mas1.text).toContain(
      "A MAS1 transfer names a token id, which this tool has no argument for. To move a token of this asset, call moi_asset_invoke with the routine Transfer, " +
        "which takes a token_id and a beneficiary; it is previewed and approved like any other write.",
    );
    const mas2 = await h.call("moi_transfer", { to: OTHER, assetId: MAS2_ASSET, amount: "1" });
    expect(mas2.text).toContain(
      "A MAS2 transfer names a token id, which this tool has no argument for. To move a token of this asset, call moi_asset_invoke with the routine Transfer, " +
        "which takes a token_id, a beneficiary and an amount; it is previewed and approved like any other write.",
    );
  });

  it("the MASX and unrecognised refusals send the model to the routine list first", async () => {
    expect((await h.call("moi_transfer", { to: OTHER, assetId: MASX_ASSET, amount: "1" })).text).toContain(OWN("Transfer"));
    expect((await h.call("moi_transfer", { to: OTHER, assetId: UNKNOWN_STANDARD_ASSET, amount: "1" })).text).toContain(UNRECOGNISED);
    expect((await h.call("moi_transfer", { to: OTHER, assetId: OTHER, amount: "1" })).text).toContain(UNRECOGNISED);
  });
});

describe("every mint refusal about a standard names moi_asset_invoke", () => {
  it.each([
    ["MAS1", MAS1_ASSET],
    ["MASX", MASX_ASSET],
    ["UNKNOWN(9)", UNKNOWN_STANDARD_ASSET],
    ["unreadable", OTHER],
  ])("%s, without ever saying token id", async (standard, assetId) => {
    const result = await h.call("moi_mint", { assetId, amount: "1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`its standard is ${standard}`);
    expect(result.text).toContain("moi_asset_invoke");
    expect(result.text).not.toMatch(/token id/);
    expect(result.text).toMatch(NOTHING);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).toEqual(["moi.AssetInfoByAssetID"]);
  });

  it("the MAS1 refusal says beneficiary and no amount", async () => {
    const result = await h.call("moi_mint", { assetId: MAS1_ASSET, amount: "1" });
    expect(result.text).toContain(
      "A MAS1 Mint takes only a recipient and no amount, so the call this tool builds does not fit it. " +
        "Call moi_asset_invoke with the routine Mint and the input beneficiary, and no amount.",
    );
  });

  it("the MASX and unrecognised refusals send the model to the routine list first", async () => {
    expect((await h.call("moi_mint", { assetId: MASX_ASSET, amount: "1" })).text).toContain(OWN("Mint"));
    expect((await h.call("moi_mint", { assetId: UNKNOWN_STANDARD_ASSET, amount: "1" })).text).toContain(UNRECOGNISED);
  });
});

describe("the native asset", () => {
  it("is refused with moi_asset_invoke named only to say it cannot mint it either, and is otherwise unchanged", async () => {
    const result = await h.call("moi_mint", { assetId: KMOI, amount: "1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[INVALID_ARGS\] moi_mint cannot mint /);
    expect(result.text).toMatch(/native asset \(standard MASN\)/);
    expect(result.text).toMatch(/reserves minting it for the protocol/);
    expect(result.text).toContain("moi_asset_invoke cannot mint it either.");
    expect(result.text).not.toMatch(/call moi_asset_invoke/);
    expect(result.text).toMatch(NOTHING);
  });
});

describe("the allow-lists did not move, and no token id was added", () => {
  const asset = (assetId: string, standard: string) => ({ assetId, symbol: "TST", standard });
  const refused = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch (err) {
      expect(isMoiError(err)).toBe(true);
      return true;
    }
  };

  it("MAS0, MASN and KMOI still transfer; MAS1, MAS2 and MASX still do not", () => {
    for (const standard of ["MAS0", "MASN"]) expect(refused(() => assertStandardSupported("moi_transfer", asset(MAS0_ASSET, standard)))).toBe(false);
    expect(refused(() => assertStandardSupported("moi_transfer", asset(KMOI, "MASN")))).toBe(false);
    for (const standard of ["MAS1", "MAS2", "MASX"]) expect(refused(() => assertStandardSupported("moi_transfer", asset(MAS0_ASSET, standard)))).toBe(true);
  });

  it("MAS0 and MAS2 still mint; MAS1 and MASX still do not", () => {
    for (const standard of ["MAS0", "MAS2"]) expect(refused(() => assertStandardSupported("moi_mint", asset(MAS0_ASSET, standard)))).toBe(false);
    for (const standard of ["MAS1", "MASX"]) expect(refused(() => assertStandardSupported("moi_mint", asset(MAS0_ASSET, standard)))).toBe(true);
  });

  it("the transfer tool still has no token id argument", () => {
    expect(Object.keys(TransferInput.shape).sort()).toEqual(["amount", "assetId", "memo", "to"]);
  });
});
