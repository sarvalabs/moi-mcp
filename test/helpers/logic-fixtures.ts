/**
 * Logic manifests for the deploy tests, and the node's answers around them.
 *
 * Two are real: LOCK_LEDGER and FLIPPER are compiler output copied unchanged from the SDK's own repository
 * (packages/js-moi-manifest/manifests), and live in test/fixtures/logics. LOCK_LEDGER has one deploy routine, Seed(name,
 * symbol, supply), an enlist routine and two invokes. FLIPPER has two deploy routines, Init() and Seed(initial), and an
 * internal routine, which is a kind the SDK's types do not know. Neither carries a `name`: no manifest, compiled or
 * served by a node, does.
 *
 * The rest are synthetic, built with the callable() helper of asset-fixtures.ts, for the cases a real manifest does not
 * show. Their bytecode is empty, which the encoder accepts and a node would not run.
 *
 * Imports asset-fixtures.ts and mock-node.ts; neither imports this file.
 */

import { deriveLogicId } from "js-moi-sdk";

import flipperFixture from "../fixtures/logics/flipper.json";
import lockLedgerFixture from "../fixtures/logics/lock-ledger.json";
import { callable, type ManifestLike } from "./asset-fixtures.js";
import { ACCOUNT, SENT_HASH } from "./mock-node.js";

export const LOCK_LEDGER: ManifestLike = lockLedgerFixture.manifest as unknown as ManifestLike;
export const FLIPPER: ManifestLike = flipperFixture.manifest as unknown as ManifestLike;

const isDeploy = (el: Record<string, unknown>): boolean =>
  el["kind"] === "callable" && (el["data"] as { kind?: string }).kind === "deploy";

/** FLIPPER without its two deploy routines: a manifest that defines none. */
export const NO_DEPLOY: ManifestLike = { ...FLIPPER, elements: FLIPPER.elements.filter((el) => !isDeploy(el)) };

/** A logic manifest around the given elements, as `coco compile` writes one. `extra` adds top-level keys, such as a name. */
export function logicManifest(elements: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): ManifestLike {
  return {
    syntax: 1,
    engine: { kind: "PISA", flags: [], version: "0.5.0" },
    kind: "logic",
    ...extra,
    elements,
  } as ManifestLike;
}

export { callable };

/** A deploy routine taking one u64, an invoke and a read: the counter of the Coco docs. */
export const COUNTER: ManifestLike = logicManifest([
  callable(0, "Seed", "dynamic", [["initial_value", "u64"]], [], "deploy"),
  callable(1, "Increment", "dynamic", []),
  callable(2, "GetCount", "static", [], [["current_count", "u64"]]),
]);

/**
 * The id a deploy from ACCOUNT will have on the mock node: moi.PendingInteractionCount answers 5 for every account, so the
 * interaction is built at sequence 5, and the id is derived from the sender and that sequence.
 */
export const PREDICTED_LOGIC_ID: string = deriveLogicId({ id: ACCOUNT as `0x${string}`, sequence: 5, key_id: 0 }).toHex();

/**
 * What moi.InteractionReceipt answers for a deploy: the deploy operation first, then the funding transfer. The operations
 * take the interaction's status unless told otherwise, so a failed interaction lists both as failed.
 */
export function deployReceipt(
  o: { status?: number; opStatus?: number; fundStatus?: number; logicId?: string; error?: string } = {},
): Record<string, unknown> {
  const status = o.status ?? 0;
  return {
    ix_hash: SENT_HASH,
    from: ACCOUNT,
    status,
    fuel_used: "0x12b",
    ix_operations: [
      { tx_type: "0xb", status: o.opStatus ?? status, data: { ...(o.logicId ? { logic_id: o.logicId } : {}), error: o.error ?? "0x" } },
      { tx_type: "0x5", status: o.fundStatus ?? status, data: { error: "0x" } },
    ],
  };
}
