/**
 * compareSigned: what the phone signed against the interaction that was previewed. Pure, so no node, wallet or config here;
 * the write path's use of it is pinned in signed-check-write.test.ts.
 */
import { createHash } from "node:crypto";

import { AssetStandard, createParticipantId, deriveAssetId, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  buildCreateAsset,
  buildTransfer,
  toPoloHex,
  toWireJson,
  type SenderInfo,
  type UnsignedInteraction,
} from "../../src/moi/ix-builder.js";
import { compareSigned } from "../../src/moi/signed-check.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const recipient = createParticipantId({ fingerprint: new Uint8Array(24).fill(9), variant: 0, tag: ParticipantTagV0 });
const other = createParticipantId({ fingerprint: new Uint8Array(24).fill(5), variant: 0, tag: ParticipantTagV0 });
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

const transfer = (to = recipient, amount = 1000n, from: SenderInfo = SENDER) =>
  buildTransfer(from, { to: to.toHex(), assetId: asset.toHex(), amount }, { fuelPrice: 50, fuelLimit: 200_000 });
const create = (supply = 1000n) =>
  buildCreateAsset(SENDER, {
    symbol: "MCPTEST", supply, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
  });

/** What an honest wallet returns for an interaction it was handed as JSON: those same bytes, re-encoded. */
const wireForm = (ix: UnsignedInteraction) => toPoloHex(toWireJson(ix) as never);
/** What a wallet that revives integers as bigints returns. Encoded from a copy, as the check does. */
const fullWidthForm = (ix: UnsignedInteraction) => toPoloHex(structuredClone(ix));

const bigintReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? `${value}n` : value);

describe("an honest answer", () => {
  it("matches both forms for an interaction with no bigint in it, because they are the same bytes", () => {
    const ix = transfer();
    expect(wireForm(ix)).toBe(fullWidthForm(ix));
    const result = compareSigned(wireForm(ix), ix);
    expect(result.matched).toEqual(["wire", "full-width"]);
    expect(result.answerLength).toBe(wireForm(ix).length);
    expect(result.expectedLength).toEqual({ wire: wireForm(ix).length, "full-width": wireForm(ix).length });
  });

  it("tells the two forms apart when the interaction carries a bigint, and accepts either", () => {
    const ix = create();
    // The guard that keeps the second candidate from becoming dead code: if the SDK ever stops writing a bigint and a
    // number differently, this fails and the check can be simplified to one form.
    expect(wireForm(ix)).not.toBe(fullWidthForm(ix));

    expect(compareSigned(wireForm(ix), ix).matched).toEqual(["wire"]);
    expect(compareSigned(fullWidthForm(ix), ix).matched).toEqual(["full-width"]);
    expect(compareSigned(wireForm(ix), ix).expectedLength).toEqual({
      wire: wireForm(ix).length,
      "full-width": fullWidthForm(ix).length,
    });
  });

  it("accepts the full-width form alone when the wire form cannot be encoded", () => {
    // Beyond 2^53 the wire form carries the supply as a decimal string, which POLO refuses. The form that stays is the one
    // a wallet reviving integers as bigints would sign.
    const ix = create(2n ** 60n);
    expect(() => wireForm(ix)).toThrow();
    const result = compareSigned(fullWidthForm(ix), ix);
    expect(result.matched).toEqual(["full-width"]);
    expect(result.expectedLength).toEqual({ "full-width": fullWidthForm(ix).length });
  });

  it("ignores the case of the hex, which is the same bytes", () => {
    const ix = transfer();
    expect(compareSigned(wireForm(ix).toUpperCase(), ix).matched).toEqual(["wire", "full-width"]);
  });

  it("is pinned to a literal digest, so a change in the SDK's encoding is seen by a person and not absorbed by both sides at once", () => {
    // The fakes and the check both use toPoloHex. This is the one place that does not: sender, recipient, asset, amount,
    // sequence and fuel are fixed, and the encoding's digest is written down. If it changes after an SDK upgrade, compare the
    // new encoding with a real phone's before updating it.
    const digest = createHash("sha256").update(wireForm(transfer())).digest("hex");
    expect(digest).toBe("628554377f2938cf7bfeb68efa7d886dd6de858cd064f5ec54211f1d24c9380b");
  });
});

describe("an answer that is not the previewed interaction", () => {
  const ix = transfer();

  it.each<[string, () => string]>([
    ["a different recipient", () => wireForm(transfer(other))],
    ["a different amount", () => wireForm(transfer(recipient, 1001n))],
    ["fuel_limit one higher", () => wireForm({ ...ix, fuel_limit: ix.fuel_limit + 1 })],
    ["fuel_price one higher", () => wireForm({ ...ix, fuel_price: ix.fuel_price + 1 })],
    ["the next sequence number", () => wireForm(transfer(recipient, 1000n, { ...SENDER, sequence: SENDER.sequence + 1 }))],
    ["another key id", () => wireForm({ ...ix, sender: { ...ix.sender, key_id: 1 } })],
    ["another sender", () => wireForm({ ...ix, sender: { ...ix.sender, id: other.toHex() } })],
    ["an operation added", () => wireForm({ ...ix, ix_operations: [...ix.ix_operations, ...ix.ix_operations] })],
    ["an operation missing", () => wireForm({ ...ix, ix_operations: [] })],
    ["a byte added at the end", () => `${wireForm(ix)}00`],
    ["the last byte cut", () => wireForm(ix).slice(0, -2)],
    ["a 0x prefix on the right bytes, which the hub refuses before it gets here", () => `0x${wireForm(ix)}`],
    ["an empty answer", () => ""],
    ["text", () => "zz"],
    ["hex that is not POLO of an interaction", () => "1111111111111111"],
  ])("matches neither form: %s", (_name, answer) => {
    const hex = answer();
    const result = compareSigned(hex, ix);
    expect(result.matched).toEqual([]);
    expect(result.answerLength).toBe(hex.length);
    // The expected lengths are still reported, so the log can say how far off the answer was.
    expect(result.expectedLength.wire).toBe(wireForm(ix).length);
  });

  it("does not throw for an answer that is not a string", () => {
    expect(compareSigned(undefined as never, ix)).toEqual({
      matched: [],
      answerLength: 0,
      expectedLength: { wire: wireForm(ix).length, "full-width": wireForm(ix).length },
    });
  });

  it("does not throw for an interaction the SDK cannot encode, and has no length to report", () => {
    expect(compareSigned("0e5f03", {} as never)).toEqual({ matched: [], answerLength: 6, expectedLength: {} });
  });
});

describe("what the comparison hands back and leaves alone", () => {
  it("carries only form names and lengths, never the bytes", () => {
    const ix = create();
    const answer = wireForm({ ...ix, fuel_limit: ix.fuel_limit + 1 });
    const result = compareSigned(answer, ix);
    expect(Object.keys(result).sort()).toEqual(["answerLength", "expectedLength", "matched"]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(answer.slice(0, 24));
    expect(text).not.toContain(wireForm(ix).slice(0, 24));
  });

  it("does not change the interaction it is given, though toPoloHex rewrites participants in place on what it is handed", () => {
    // A create has no participants until something derives them. Encoding the interaction itself would add the key.
    const ix = create();
    expect("participants" in ix).toBe(false);
    const before = JSON.stringify(ix, bigintReplacer);
    compareSigned(wireForm(ix), ix);
    expect(JSON.stringify(ix, bigintReplacer)).toBe(before);
    expect("participants" in ix).toBe(false);

    const withParticipants = transfer();
    const beforeTransfer = JSON.stringify(withParticipants, bigintReplacer);
    compareSigned(wireForm(withParticipants), withParticipants);
    expect(JSON.stringify(withParticipants, bigintReplacer)).toBe(beforeTransfer);
  });
});
