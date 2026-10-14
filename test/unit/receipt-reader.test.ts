/**
 * readReceipt, the strict receipt reader a deploy and an asset create share, and the poller and the retry sentence beside it.
 * The existing logic-deploy-receipt.test.ts pins that a deploy reads as it always did; this shows that the nouns come from the
 * kind it is given and the checks do not.
 */

import { describe, expect, it } from "vitest";

import { DEPLOY_RECEIPT, noRetry, pollReceipt, readReceipt, type ReceiptKind } from "../../src/capabilities/logics/deploy-receipt.js";
import { CREATE_RECEIPT } from "../../src/capabilities/assets/create-receipt.js";
import { createReceipt, predictedAssetId } from "../helpers/asset-create-fixtures.js";
import { deployReceipt, PREDICTED_LOGIC_ID } from "../helpers/logic-fixtures.js";

/** A third thing that makes an account: another operation type, another id field, other nouns. */
const MADE_UP: ReceiptKind = { opType: 9, operation: "create", idKey: "asset_id", idWord: "asset id" };

describe("readReceipt", () => {
  it("reads a deploy receipt as a deploy and an asset receipt as a create, and neither as the other", () => {
    const id = predictedAssetId("MAS2");
    expect(readReceipt(deployReceipt({ logicId: PREDICTED_LOGIC_ID }), DEPLOY_RECEIPT)).toEqual({ kind: "created", id: PREDICTED_LOGIC_ID });
    expect(readReceipt(createReceipt({ assetId: id }), CREATE_RECEIPT)).toEqual({ kind: "created", id });
    expect(readReceipt(createReceipt({ assetId: id }), DEPLOY_RECEIPT)).toEqual({ kind: "unsure", why: "Its receipt does not list exactly one deploy operation." });
    expect(readReceipt(deployReceipt({ logicId: PREDICTED_LOGIC_ID }), CREATE_RECEIPT)).toEqual({ kind: "unsure", why: "Its receipt does not list exactly one create operation." });
  });

  it("takes its nouns from the kind and its checks from nowhere else", () => {
    const receipt = { status: 0, ix_operations: [{ tx_type: "0x9", status: 0, data: { asset_id: "0x12", error: "0x" } }] };
    expect(readReceipt(receipt, MADE_UP)).toEqual({ kind: "unsure", why: "Its receipt carries no usable asset id." });
    const clean = { status: 0, ix_operations: [{ tx_type: "0x9", status: 0, data: { asset_id: predictedAssetId("MAS0"), error: "0x" } }] };
    expect(readReceipt(clean, MADE_UP)).toEqual({ kind: "created", id: predictedAssetId("MAS0") });
    expect(readReceipt(clean, MADE_UP, predictedAssetId("MAS1"))).toMatchObject({
      kind: "unsure",
      why: `The asset id in its receipt (${predictedAssetId("MAS0")}) is not the address the KMOI was sent to (${predictedAssetId("MAS1")}).`,
    });
    // The same receipt under the deploy kind finds no deploy operation.
    expect(readReceipt(clean, DEPLOY_RECEIPT)).toMatchObject({ kind: "unsure" });
  });

  it("fails closed for every kind: a failed status, an unreadable one and something that is not a receipt", () => {
    for (const kind of [DEPLOY_RECEIPT, CREATE_RECEIPT, MADE_UP]) {
      expect(readReceipt({ status: 1, ix_operations: [] }, kind)).toEqual({ kind: "failed", status: 1 });
      expect(readReceipt({ status: "?", ix_operations: [] }, kind)).toEqual({ kind: "unsure", why: "Its receipt has no readable status." });
      expect(readReceipt(null, kind)).toEqual({ kind: "pending" });
    }
  });
});

describe("pollReceipt", () => {
  it("interprets each look with the function it is given and returns the pending value when the wait ends", async () => {
    let looks = 0;
    const p = { getInteractionReceipt: async () => ({ n: ++looks }) };
    const interpret = (r: unknown) => ((r as { n: number }).n < 3 ? { kind: "pending" as const } : { kind: "done" as const, n: (r as { n: number }).n });
    const slept: number[] = [];
    expect(await pollReceipt(p, "0xabc", 60_000, interpret as never, { kind: "pending" }, { pollMs: 7, sleep: async (ms) => void slept.push(ms) })).toEqual({ kind: "done", n: 3 });
    expect(slept).toEqual([7, 7]);
    expect(await pollReceipt(p, "0xabc", 0, interpret as never, { kind: "pending" })).toEqual({ kind: "pending" });
  });
});

describe("noRetry", () => {
  it("is the sentence both tools end their notes with, with the tool, the subject, the noun and the fund", () => {
    expect(noRetry({ tool: "moi_deploy_logic", subject: "manifest", noun: "logic", fund: 10_000_000_000n })).toBe(
      "Do not call moi_deploy_logic again for this manifest until the receipt has been read: a second call would create a second logic and move another 10 KMOI.",
    );
    expect(noRetry({ tool: "moi_create_asset", subject: "asset", noun: "asset", fund: 7_000_000_000n })).toBe(
      "Do not call moi_create_asset again for this asset until the receipt has been read: a second call would create a second asset and move another 7 KMOI.",
    );
  });
});
