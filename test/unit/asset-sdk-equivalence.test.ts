/**
 * Every routine of every standard file, built the generic way and the SDK's way, and compared.
 *
 * The SDK's own asset classes (js-moi-asset: MAS0AssetLogic, MASNAssetLogic, MAS1AssetLogic, MAS2AssetLogic) are the
 * reference for two things the manifest does not say: how a routine's inputs are encoded, and which accounts it locks.
 * A row here is one routine: the inputs the tool takes, and the SDK method that makes the same call. The calldata must
 * be byte-identical and the participants must be the same set. The order of participants is not compared: the SDK
 * rebuilds the list asset-first when an interaction is estimated, called or encoded (processParticipants), so the order
 * given is not the order signed.
 *
 * MAS0 and MASN run against the real manifests captured from devnet. MAS1 and MAS2 run against synthetic manifests
 * built from the SDK's own schemas: no MAS1 or MAS2 asset has been seen on any node, so what they prove is that the
 * description files agree with the SDK, not that a node agrees with either.
 */

import { MAS0AssetLogic, MAS1AssetLogic, MAS2AssetLogic, MASNAssetLogic, hexToBytes } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { planAssetCall, resolveFromManifest } from "../../src/capabilities/assets/invoke.js";
import { readManifest, type AssetRef } from "../../src/capabilities/assets/routines.js";
import { standardFileFor } from "../../src/capabilities/assets/standards/index.js";
import { LOCK_BY_NAME } from "../../src/moi/ix-builder.js";
import { MAS0_MANIFEST, MAS1_MANIFEST, MAS2_MANIFEST, MASN_MANIFEST, PIXEL, type ManifestLike } from "../helpers/asset-fixtures.js";
import { ACCOUNT, KMOI, MAS1_ASSET, MAS2_ASSET, OTHER } from "../helpers/mock-node.js";

const B = ACCOUNT;
const F = OTHER;
const K = 12;
const AMOUNT = 5;
const EXPIRES = 1893456000;
const META = { k: "0x0102" };
const META_SDK = { k: hexToBytes("0x0102") };
const BYTES = "0x0102";
const BYTES_SDK = hexToBytes("0x0102");

/** What the SDK's InteractionContext exposes publicly: the payload and the participants. */
interface SdkCall {
  payload(): { asset_id: string; callsite: string; calldata?: string };
  participants(): Array<{ id: string; lock_type: number }>;
}
type Logic = Record<string, (...args: unknown[]) => SdkCall>;

interface Row {
  routine: string;
  /** The inputs the tool takes. */
  args: Record<string, unknown>;
  /** The SDK method that makes the same call, and the arguments it takes. */
  method: string;
  sdk: unknown[];
}

interface Group {
  standard: string;
  manifest: ManifestLike;
  asset: AssetRef;
  logic: Logic;
  rows: Row[];
}

const ref = (assetId: string, standard: string): AssetRef => ({ assetId, symbol: "SYM", standard, decimals: 0 });

const MAS0_ROWS: Row[] = [
  { routine: "Transfer", args: { beneficiary: B, amount: AMOUNT }, method: "transfer", sdk: [B, AMOUNT] },
  { routine: "TransferFrom", args: { benefactor: F, beneficiary: B, amount: AMOUNT }, method: "transferFrom", sdk: [F, B, AMOUNT] },
  { routine: "Mint", args: { beneficiary: B, amount: AMOUNT }, method: "mint", sdk: [B, AMOUNT] },
  { routine: "MintWithMetadata", args: { beneficiary: B, amount: AMOUNT, static_metadata: META }, method: "mintWithMetadata", sdk: [B, AMOUNT, META_SDK] },
  { routine: "Burn", args: { amount: AMOUNT }, method: "burn", sdk: [AMOUNT] },
  { routine: "Lockup", args: { beneficiary: B, amount: AMOUNT }, method: "lockup", sdk: [B, AMOUNT] },
  { routine: "Release", args: { benefactor: F, beneficiary: B, amount: AMOUNT }, method: "release", sdk: [F, B, AMOUNT] },
  { routine: "Approve", args: { beneficiary: B, amount: AMOUNT, expires_at: EXPIRES }, method: "approve", sdk: [B, AMOUNT, EXPIRES] },
  { routine: "Revoke", args: { beneficiary: B }, method: "revoke", sdk: [B] },
  { routine: "SetStaticMetadata", args: { key: "k", value: BYTES }, method: "SetStaticMetadata", sdk: ["k", BYTES_SDK] },
  { routine: "SetDynamicMetadata", args: { key: "k", value: BYTES }, method: "SetDynamicMetadata", sdk: ["k", BYTES_SDK] },
];

const MASN_ROWS: Row[] = [
  { routine: "Transfer", args: { beneficiary: B, amount: AMOUNT }, method: "transfer", sdk: [B, AMOUNT] },
  { routine: "TransferFrom", args: { benefactor: F, beneficiary: B, amount: AMOUNT }, method: "transferFrom", sdk: [F, B, AMOUNT] },
  { routine: "Lockup", args: { beneficiary: B, amount: AMOUNT }, method: "lockup", sdk: [B, AMOUNT] },
  { routine: "Release", args: { benefactor: F, beneficiary: B, amount: AMOUNT }, method: "release", sdk: [F, B, AMOUNT] },
  { routine: "Approve", args: { beneficiary: B, amount: AMOUNT, expires_at: EXPIRES }, method: "approve", sdk: [B, AMOUNT, EXPIRES] },
  { routine: "Revoke", args: { beneficiary: B }, method: "revoke", sdk: [B] },
];

const MAS1_ROWS: Row[] = [
  { routine: "Transfer", args: { token_id: K, beneficiary: B }, method: "transfer", sdk: [K, B] },
  { routine: "TransferFrom", args: { token_id: K, benefactor: F, beneficiary: B }, method: "transferFrom", sdk: [K, F, B] },
  { routine: "Mint", args: { beneficiary: B }, method: "mint", sdk: [B] },
  { routine: "MintWithMetadata", args: { beneficiary: B, static_metadata: META }, method: "mintWithMetadata", sdk: [B, META_SDK] },
  { routine: "Burn", args: { token_id: K }, method: "burn", sdk: [K] },
  { routine: "Lockup", args: { token_id: K, beneficiary: B }, method: "lockup", sdk: [K, B] },
  { routine: "Release", args: { token_id: K, benefactor: F, beneficiary: B }, method: "release", sdk: [K, F, B] },
  { routine: "Approve", args: { token_id: K, beneficiary: B, expires_at: EXPIRES }, method: "approve", sdk: [K, B, EXPIRES] },
  { routine: "Revoke", args: { token_id: K, beneficiary: B }, method: "revoke", sdk: [K, B] },
  { routine: "SetStaticMetadata", args: { key: "k", value: BYTES }, method: "SetStaticMetadata", sdk: ["k", BYTES_SDK] },
  { routine: "SetDynamicMetadata", args: { key: "k", value: BYTES }, method: "SetDynamicMetadata", sdk: ["k", BYTES_SDK] },
  { routine: "SetStaticTokenMetadata", args: { token_id: K, key: "k", value: BYTES }, method: "SetStaticTokenMetadata", sdk: [K, "k", BYTES_SDK] },
  { routine: "SetDynamicTokenMetadata", args: { token_id: K, key: "k", value: BYTES }, method: "SetDynamicTokenMetadata", sdk: [K, "k", BYTES_SDK] },
];

const MAS2_ROWS: Row[] = [
  { routine: "Transfer", args: { token_id: K, beneficiary: B, amount: AMOUNT }, method: "transfer", sdk: [K, B, AMOUNT] },
  { routine: "TransferFrom", args: { token_id: K, benefactor: F, beneficiary: B, amount: AMOUNT }, method: "transferFrom", sdk: [K, F, B, AMOUNT] },
  { routine: "Mint", args: { beneficiary: B, amount: AMOUNT }, method: "mint", sdk: [B, AMOUNT] },
  { routine: "MintWithMetadata", args: { beneficiary: B, amount: AMOUNT, static_metadata: META }, method: "mintWithMetadata", sdk: [B, AMOUNT, META_SDK] },
  { routine: "Burn", args: { token_id: K, amount: AMOUNT }, method: "burn", sdk: [K, AMOUNT] },
  { routine: "Lockup", args: { token_id: K, beneficiary: B, amount: AMOUNT }, method: "lockup", sdk: [K, B, AMOUNT] },
  { routine: "Release", args: { token_id: K, benefactor: F, beneficiary: B, amount: AMOUNT }, method: "release", sdk: [K, F, B, AMOUNT] },
  { routine: "Approve", args: { token_id: K, beneficiary: B, amount: AMOUNT, expires_at: EXPIRES }, method: "approve", sdk: [K, B, AMOUNT, EXPIRES] },
  { routine: "Revoke", args: { token_id: K, beneficiary: B }, method: "revoke", sdk: [K, B] },
  { routine: "SetStaticMetadata", args: { key: "k", value: BYTES }, method: "SetStaticMetadata", sdk: ["k", BYTES_SDK] },
  { routine: "SetDynamicMetadata", args: { key: "k", value: BYTES }, method: "SetDynamicMetadata", sdk: ["k", BYTES_SDK] },
  { routine: "SetStaticTokenMetadata", args: { token_id: K, key: "k", value: BYTES }, method: "SetStaticTokenMetadata", sdk: [K, "k", BYTES_SDK] },
  { routine: "SetDynamicTokenMetadata", args: { token_id: K, key: "k", value: BYTES }, method: "SetDynamicTokenMetadata", sdk: [K, "k", BYTES_SDK] },
];

const GROUPS: Group[] = [
  { standard: "MAS0", manifest: MAS0_MANIFEST, asset: ref(PIXEL, "MAS0"), logic: new MAS0AssetLogic(PIXEL, {} as never) as unknown as Logic, rows: MAS0_ROWS },
  { standard: "MASN", manifest: MASN_MANIFEST, asset: ref(KMOI, "MASN"), logic: new MASNAssetLogic({} as never) as unknown as Logic, rows: MASN_ROWS },
  { standard: "MAS1", manifest: MAS1_MANIFEST, asset: ref(MAS1_ASSET, "MAS1"), logic: new MAS1AssetLogic(MAS1_ASSET, {} as never) as unknown as Logic, rows: MAS1_ROWS },
  { standard: "MAS2", manifest: MAS2_MANIFEST, asset: ref(MAS2_ASSET, "MAS2"), logic: new MAS2AssetLogic(MAS2_ASSET, {} as never) as unknown as Logic, rows: MAS2_ROWS },
];

const strip = (hex: string | undefined): string => (hex ?? "").replace(/^0x/, "");
/** Entries as comparable pairs, sorted: the set, since the order is normalised by the SDK. */
const asSet = (entries: Array<[string, number]>): Array<[string, number]> =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function planRow(group: Group, row: Row, decimals = 0) {
  const asset = { ...group.asset, decimals };
  const target = resolveFromManifest(asset, readManifest(group.manifest, asset), row.routine);
  return { target, plan: planAssetCall(target, { assetId: asset.assetId, routine: row.routine, args: row.args }) };
}

const sdkCall = (group: Group, row: Row): SdkCall => {
  const method = group.logic[row.method];
  if (typeof method !== "function") throw new Error(`${group.standard}AssetLogic has no method ${row.method}`);
  return method.call(group.logic, ...row.sdk);
};

const ROWS = GROUPS.flatMap((g) => g.rows.map((row) => [`${g.standard} ${row.routine}`, g, row] as const));

describe("every routine of every standard file, against the SDK's own asset class", () => {
  it("covers 43 routines", () => {
    expect(ROWS).toHaveLength(43);
  });

  it.each(ROWS)("%s: same calldata, same participants", (_label, group, row) => {
    const { target, plan } = planRow(group, row);
    const sdk = sdkCall(group, row);

    // The file is what is under test: a routine with no spec would pass nothing through it.
    expect(target.spec, "no spec for this routine").toBeDefined();
    expect(strip(plan.calldata)).toBe(strip(sdk.payload().calldata));
    expect(sdk.payload().callsite).toBe(row.routine);
    expect(sdk.payload().asset_id.toLowerCase()).toBe(group.asset.assetId.toLowerCase());

    const ours = plan.participants.map((p) => [p.id.toLowerCase(), LOCK_BY_NAME[p.lock]] as [string, number]);
    const theirs = sdk.participants().map((p) => [p.id.toLowerCase(), p.lock_type] as [string, number]);
    expect(asSet(ours)).toEqual(asSet(theirs));
  });

  it("has a row for every routine its file describes, so a routine added to a file without a row fails", () => {
    for (const group of GROUPS) {
      const file = standardFileFor(group.standard);
      expect(group.rows.map((r) => r.routine).sort(), group.standard).toEqual(Object.keys(file?.routines ?? {}).sort());
    }
  });

  it("decodes every row's calldata back to the inputs the row gave, so the round trip is in the path", () => {
    for (const [label, group, row] of ROWS) {
      const { target, plan } = planRow(group, row);
      const accepts = target.callable.accepts;
      const decoded = target.view.coder.decodeArguments<unknown[]>(row.routine, `0x${plan.calldata ?? ""}`);
      expect(decoded, label).toHaveLength(accepts.length);
      accepts.forEach((f, i) => {
        const given = row.args[f.label];
        const got = decoded?.[i];
        if (typeof given === "number") expect(Number(got), `${label} ${f.label}`).toBe(given);
        else if (got instanceof Uint8Array) expect(`0x${Buffer.from(got).toString("hex")}`, `${label} ${f.label}`).toBe(String(given).toLowerCase());
        else if (got instanceof Map) expect([...got.keys()], `${label} ${f.label}`).toEqual(Object.keys(given as object));
        else expect(got, `${label} ${f.label}`).toBe(given);
      });
    }
  });

  it("writes the same calldata for an asset with decimals: decimals change only the preview", () => {
    const group = GROUPS[0]!;
    for (const row of group.rows) {
      expect(planRow(group, row, 9).plan.calldata, row.routine).toBe(planRow(group, row, 0).plan.calldata);
    }
    const transfer = group.rows[0]!;
    expect(planRow(group, transfer, 9).plan.description).not.toBe(planRow(group, transfer, 0).plan.description);
  });
});
