/**
 * buildAssetInvoke, the builder behind moi_asset_invoke. In its own file because ix-builder.test.ts is at the 500 line
 * limit; the "every builder POLO-encodes" list there carries assetInvoke too.
 */

import {
  AssetStandard,
  createParticipantId,
  deriveAssetId,
  LockType,
  OpType,
  ParticipantTagV0,
} from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { buildAssetInvoke, type SenderInfo } from "../../src/moi/ix-builder.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);

const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

describe("buildAssetInvoke", () => {
  const ASSET = asset.toHex();

  it("emits one ASSET_INVOKE operation with the asset, the callsite and the calldata", () => {
    const ix = buildAssetInvoke(SENDER, { assetId: ASSET, callsite: "Burn", calldata: "0d2f06" });
    expect(ix.ix_operations).toEqual([
      { type: OpType.ASSET_INVOKE, payload: { asset_id: ASSET, callsite: "Burn", calldata: "0d2f06" } },
    ]);
    expect(ix.sender).toEqual({ id: SENDER.id, sequence: 3, key_id: 0 });
  });

  it("strips a 0x prefix so the payload matches what buildTransfer emits", () => {
    const ix = buildAssetInvoke(SENDER, { assetId: ASSET, callsite: "Burn", calldata: "0x0d2f06" });
    expect(ix.ix_operations[0]!.payload["calldata"]).toBe("0d2f06");
  });

  it("leaves calldata out when there is none or it is empty, as the SDK does", () => {
    for (const calldata of [undefined, "", "0x"]) {
      const ix = buildAssetInvoke(SENDER, { assetId: ASSET, callsite: "Symbol", ...(calldata === undefined ? {} : { calldata }) });
      expect(ix.ix_operations[0]!.payload).toEqual({ asset_id: ASSET, callsite: "Symbol" });
    }
  });

  it("maps mutate, read and none to the chain's lock types and keeps the caller's spelling of an id", () => {
    const ix = buildAssetInvoke(SENDER, {
      assetId: ASSET,
      callsite: "Transfer",
      participants: [
        { id: "0xABCdef", lock: "mutate" },
        { id: "0x0123", lock: "read" },
        { id: ASSET, lock: "none" },
      ],
    });
    expect(ix.participants).toEqual([
      { id: "0xABCdef", lock_type: LockType.MUTATE_LOCK },
      { id: "0x0123", lock_type: LockType.READ_LOCK },
      { id: ASSET, lock_type: LockType.NO_LOCK },
    ]);
  });

  it("names the same id once, with its first spelling and the strongest lock", () => {
    const ix = buildAssetInvoke(SENDER, {
      assetId: ASSET,
      callsite: "Transfer",
      participants: [
        { id: "0xOWNER", lock: "none" },
        { id: "0xowner", lock: "mutate" },
        { id: "0xOwner", lock: "read" },
      ],
    });
    expect(ix.participants).toEqual([{ id: "0xOWNER", lock_type: LockType.MUTATE_LOCK }]);
  });

  it("carries no participants key when none are given, and adds none of its own", () => {
    expect(buildAssetInvoke(SENDER, { assetId: ASSET, callsite: "Symbol" })).not.toHaveProperty("participants");
    expect(buildAssetInvoke(SENDER, { assetId: ASSET, callsite: "Symbol", participants: [] })).not.toHaveProperty("participants");
  });
});
