/**
 * What the asset-create tests share: the compiled MASX manifests, the manifests built from them for the shapes a real one
 * does not show, the id a create from ACCOUNT will get on the mock node, and the receipt a create leaves.
 *
 * Two manifests are real compiler output (Coco 0.9.0, PISA 0.8.0, test/fixtures/assets): TAXTOKEN, a `coco asset` module with
 * one deploy routine, Init(treasury_addr, bps, initial_supply), and a dynamic Transfer; and PLAIN_ASSET, one with no deploy
 * routine at all. The rest are built from those with the helpers the other asset tests use (asset-fixtures.ts,
 * logic-fixtures.ts), for the cases no compiled one shows: two deploy routines, a deploy routine with no inputs, and a
 * manifest of the wrong kind. Their bytecode is not run by anything here.
 *
 * Imports asset-fixtures.ts, logic-fixtures.ts and mock-node.ts; none of them imports this file.
 */

import { deriveAssetId } from "js-moi-sdk";

import plainFixture from "../fixtures/assets/plain-masx.json";
import taxFixture from "../fixtures/assets/taxtoken-masx.json";
import { callable, syntheticManifest, type ManifestLike } from "./asset-fixtures.js";
import { LOCK_LEDGER } from "./logic-fixtures.js";
import { ACCOUNT, SENT_HASH } from "./mock-node.js";

export const TAXTOKEN: ManifestLike = taxFixture.manifest as unknown as ManifestLike;
/** A real compiled asset manifest that defines no deploy routine. */
export const PLAIN_ASSET: ManifestLike = plainFixture.manifest as unknown as ManifestLike;

/** TAXTOKEN with a second deploy routine, so a call has to say which one runs. */
export const TWO_DEPLOYS_ASSET: ManifestLike = {
  ...TAXTOKEN,
  elements: [...TAXTOKEN.elements.slice(0, -1), callable(5, "Reinit", "dynamic", [["bps", "u64"]], [], "deploy"), TAXTOKEN.elements.at(-1) as Record<string, unknown>],
};

/** An asset manifest whose one deploy routine takes no inputs. */
export const NO_INPUT_DEPLOY_ASSET: ManifestLike = syntheticManifest([
  callable(0, "Init", "dynamic", [], [], "deploy"),
  callable(1, "Ping", "dynamic", []),
]);

/** TAXTOKEN with its kind changed or taken away. */
export const LOGIC_KIND: ManifestLike = { ...TAXTOKEN, kind: "logic" };
export const BOGUS_KIND: ManifestLike = { ...TAXTOKEN, kind: "bogus" };
export const NO_KIND: Record<string, unknown> = Object.fromEntries(Object.entries(TAXTOKEN).filter(([k]) => k !== "kind"));
/** A real compiled logic manifest, for the refusal that sends a logic to moi_deploy_logic. */
export { LOCK_LEDGER };

/** TaxToken's Init(treasury_addr, bps, initial_supply), with the account on the mock node as the treasury. */
export const TAX_ARGS = { treasury_addr: ACCOUNT, bps: 300, initial_supply: "1000000" };

/** A valid MASX call to moi_create_asset: the compiled TaxToken, its one deploy routine, and its inputs. */
export const TAX_CREATE = { symbol: "TAX", standard: "MASX", supply: "1000000", manifest: TAXTOKEN, args: TAX_ARGS };

export const STANDARD_CODES = { MAS0: 0, MAS1: 1, MAS2: 2, MASX: 0xffff } as const;

/**
 * The id a create from ACCOUNT will get on the mock node: moi.PendingInteractionCount answers 5 for every account, so the
 * interaction is built at sequence 5, and the id is derived from the sender, that sequence and the standard.
 */
export function predictedAssetId(standard: keyof typeof STANDARD_CODES, sequence = 5): string {
  return deriveAssetId({ id: ACCOUNT as `0x${string}`, sequence, key_id: 0 }, STANDARD_CODES[standard]).toHex();
}

/**
 * What moi.InteractionReceipt answers for an asset create: the ASSET_CREATE operation first, then the funding transfer. The
 * operations take the interaction's status unless told otherwise, so a failed interaction lists both as failed.
 */
export function createReceipt(
  o: { status?: number; opStatus?: number; fundStatus?: number; assetId?: string; error?: string } = {},
): Record<string, unknown> {
  const status = o.status ?? 0;
  return {
    ix_hash: SENT_HASH,
    from: ACCOUNT,
    status,
    fuel_used: "0x12b",
    ix_operations: [
      { tx_type: "0x4", status: o.opStatus ?? status, data: { ...(o.assetId ? { asset_id: o.assetId } : {}), error: o.error ?? "0x" } },
      { tx_type: "0x5", status: o.fundStatus ?? status, data: { error: "0x" } },
    ],
  };
}
