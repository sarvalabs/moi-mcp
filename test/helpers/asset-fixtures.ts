/**
 * Asset manifests for tests, and the helpers that build the node's answers around them.
 *
 * Two of the manifests are real: MAS0_MANIFEST (PIXEL) and MASN_MANIFEST (KMOI, the native asset) were captured from
 * voyage devnet on 1 October 2026 with moi.LogicManifest(assetId, JSON), and live in test/fixtures/assets as received.
 * Everything else here is synthetic, written for a test: MAS1_MANIFEST and MAS2_MANIFEST are built from the label
 * tables of the SDK's own mas1-schema and mas2-schema and its asset classes, and MASX_MANIFEST is a made-up custom
 * asset. NO MAS1, MAS2 or MASX asset has been seen on any node, so the types the real chain picks for their inputs
 * (token_id may be u64 or u256, beneficiary may be identifier) are guesses, and the read outputs are invented.
 *
 * This file imports nothing from mock-node.ts, which imports it.
 */

import { Schema, bytesToHex } from "js-moi-sdk";
import { documentEncode } from "js-polo";

import mas0Fixture from "../fixtures/assets/mas0-manifest.json";
import masnFixture from "../fixtures/assets/masn-kmoi-manifest.json";

export type ManifestLike = {
  syntax: number;
  engine: { kind: string; flags: string[]; version: string };
  kind: string;
  elements: Array<Record<string, unknown>>;
};

interface Fixture {
  captured: string;
  asset_id: string;
  asset_info: Record<string, unknown>;
  manifest: ManifestLike;
}

export const MAS0_FIXTURE = mas0Fixture as unknown as Fixture;
export const MASN_FIXTURE = masnFixture as unknown as Fixture;

/** The PIXEL asset of the MAS0 fixture: an ordinary MAS0 asset with 0 decimals. */
export const PIXEL: string = MAS0_FIXTURE.asset_id;
export const PIXEL_INFO: Record<string, unknown> = MAS0_FIXTURE.asset_info;
export const MAS0_MANIFEST: ManifestLike = MAS0_FIXTURE.manifest;
/** The native asset's manifest (KMOI, standard MASN): no Mint, MintWithMetadata, Burn or metadata setters. */
export const MASN_MANIFEST: ManifestLike = MASN_FIXTURE.manifest;

type Pair = [label: string, type: string];

/** One callable element. Slots are the array indexes, as in a real manifest. */
export function callable(
  ptr: number,
  name: string,
  mode: string,
  accepts: Pair[],
  returns: Pair[] = [],
  kind = "invoke",
): Record<string, unknown> {
  const fields = (list: Pair[]) => list.map(([label, type], slot) => ({ slot, label, type }));
  return {
    ptr,
    deps: [],
    kind: "callable",
    data: {
      name,
      mode,
      kind,
      accepts: fields(accepts),
      returns: fields(returns),
      executes: { hex: "", asm: [] },
      catches: [],
    },
  };
}

/** A manifest around the given elements, closed by the trailing `asset` element a real one carries. */
export function syntheticManifest(callables: Array<Record<string, unknown>>): ManifestLike {
  const last = callables.reduce((max, el) => Math.max(max, Number(el["ptr"] ?? 0)), -1);
  return {
    syntax: 1,
    engine: { kind: "PISA", flags: [], version: "0.8.0" },
    kind: "asset",
    elements: [...callables, { ptr: last + 1, deps: [], kind: "asset", data: { engine: "1.0.0" } }],
  };
}

/**
 * The thirteen write routines the SDK's MAS1 and MAS2 classes have (they differ only by the amount) and the reads of
 * each, as a manifest. Types follow the guess in the header comment. Synthetic: see there.
 */
function tokenIdManifest(withAmounts: boolean): ManifestLike {
  const amount: Pair[] = withAmounts ? [["amount", "u256"]] : [];
  const tid: Pair = ["token_id", "u64"];
  const to: Pair = ["beneficiary", "identifier"];
  const from: Pair = ["benefactor", "identifier"];
  const kv: Pair[] = [["key", "string"], ["value", "bytes"]];
  const writes: Array<[string, Pair[]]> = [
    ["Transfer", [tid, to, ...amount]],
    ["TransferFrom", [tid, from, to, ...amount]],
    ["Mint", [to, ...amount]],
    ["MintWithMetadata", [to, ...amount, ["static_metadata", "map[string]bytes"]]],
    ["Burn", [tid, ...amount]],
    ["Lockup", [tid, to, ...amount]],
    ["Release", [tid, from, to, ...amount]],
    ["Approve", [tid, to, ...amount, ["expires_at", "u64"]]],
    ["Revoke", [tid, to]],
    ["SetStaticMetadata", kv],
    ["SetDynamicMetadata", kv],
    ["SetStaticTokenMetadata", [tid, ...kv]],
    ["SetDynamicTokenMetadata", [tid, ...kv]],
  ];
  const reads: Array<[string, Pair[], Pair[]]> = [
    ["Symbol", [], [["symbol", "string"]]],
    withAmounts
      ? ["BalanceOf", [tid, ["address", "identifier"]], [["balance", "u256"]]]
      : ["IsOwner", [tid, ["address", "identifier"]], [["is_owner", "bool"]]],
    ["Creator", [], [["creator", "identifier"]]],
    ["Manager", [], [["manager", "identifier"]]],
    ["GetStaticMetadata", [["key", "string"]], [["value", "bytes"]]],
    ["GetDynamicMetadata", [["key", "string"]], [["value", "bytes"]]],
    ["GetStaticTokenMetadata", [tid, ["key", "string"]], [["value", "bytes"]]],
    ["GetDynamicTokenMetadata", [tid, ["key", "string"]], [["value", "bytes"]]],
  ];
  let ptr = 0;
  return syntheticManifest([
    ...writes.map(([name, accepts]) => callable(ptr++, name, "dynamic", accepts)),
    ...reads.map(([name, accepts, returns]) => callable(ptr++, name, "static", accepts, returns)),
  ]);
}

export const MAS1_MANIFEST: ManifestLike = tokenIdManifest(false);
export const MAS2_MANIFEST: ManifestLike = tokenIdManifest(true);

/** A made-up custom asset: two writes it alone defines and three reads, one of them a long string and one a list. */
export const MASX_MANIFEST: ManifestLike = syntheticManifest([
  callable(0, "Deposit", "dynamic", [["amount", "u256"]]),
  callable(1, "Swap", "dynamic", [["asset", "identifier"], ["amount", "u256"]]),
  callable(2, "Total", "static", [], [["total", "u256"]]),
  callable(3, "Tags", "static", [], [["tags", "[]string"]]),
  callable(4, "Note", "static", [], [["text", "string"]]),
]);

/** The inputs and outputs of one callable, exactly as the manifest lists them. Throws when there is no such callable. */
export function fieldsOf(
  manifest: ManifestLike,
  name: string,
): { accepts: Array<{ slot: number; label: string; type: string }>; returns: Array<{ slot: number; label: string; type: string }> } {
  const el = manifest.elements.find((e) => e["kind"] === "callable" && (e["data"] as { name: string }).name === name);
  const data = el?.["data"] as { accepts: never[]; returns: never[] } | undefined;
  if (!data) throw new Error(`no callable ${name} in the manifest`);
  return { accepts: data.accepts, returns: data.returns };
}

/** What moi.LogicManifest answers: the manifest's JSON as hex bytes. */
export function manifestHex(manifest: unknown): string {
  return `0x${Buffer.from(JSON.stringify(manifest), "utf8").toString("hex")}`;
}

export type PoloField =
  | { kind: "integer" | "string" | "bytes" | "bool" }
  | { kind: "array"; fields: { values: PoloField } };

/** Encode a routine's outputs the way the node returns them, so a test can hand them to moi.Call. */
export function encodeOutputs(fields: Record<string, PoloField>, values: Record<string, unknown>): string {
  const encoded = documentEncode(values, { kind: "struct", fields } as never);
  return `0x${bytesToHex(encoded.bytes())}`;
}

/** An exception as a node encodes it in a receipt's `error`. */
export function encodeException(e: { class: string; error: string }): string {
  const encoded = documentEncode({ ...e, revert: false, trace: [] }, Schema.PISA_EXCEPTION_SCHEMA as never);
  return `0x${bytesToHex(encoded.bytes())}`;
}

/** A moi.Call receipt for one ASSET_INVOKE operation. */
export function callReceipt(o: { status?: number; outputs?: string; error?: string } = {}): Record<string, unknown> {
  const status = o.status ?? 0;
  return {
    status,
    fuel_used: "0x12b",
    ix_operations: [{ tx_type: "0x5", status, data: { outputs: o.outputs ?? "0x", error: o.error ?? "0x" } }],
  };
}
