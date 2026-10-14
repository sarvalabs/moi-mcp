/**
 * The MASX half of planning a create: read the caller's compiled asset manifest, choose the deploy routine that runs when the
 * asset is created, and encode its inputs. Pure: no node, no wallet. Imports nothing from src/tools, src/wc or the journal.
 *
 * A MASX asset is the one standard made from a manifest the caller supplies, so a create is read the way moi_deploy_logic
 * reads a logic (src/capabilities/logics/deploy-manifest.ts, which does the work for both): the manifest is checked,
 * encoded to POLO, decoded again, and everything the preview says is read from the decoded copy. What differs from a logic
 * deploy follows the SDK's AssetFactory.create (node_modules/js-moi-asset, asset-factory.js):
 *
 * - A manifest that defines no deploy routine is created as it is, with no callsite and no calldata in the payload. The node
 *   runs nothing and a callsite would be rejected, so `routine` and `args` are refused for such a manifest.
 * - A manifest that defines one or more deploy routines needs the callsite of one of them (the node rejects an empty or an
 *   unmatched one), and the calldata only when that routine takes inputs.
 */

import type { MasxCreate } from "../../moi/ix-builder.js";
import { encodeDeployInputs, manifestLine, pickRoutine, readDeployManifest } from "../logics/deploy-manifest.js";
import { invalid } from "./standards/common.js";

export interface MasxPlan {
  /** What buildCreateAsset takes: the manifest as 0x hex, and the callsite and calldata only when there is a routine to run. */
  payload: MasxCreate;
  /** Routines in the manifest, internal ones included. */
  routines: number;
  /** The deploy routine, or undefined when the manifest has none. */
  callsite: string | undefined;
  /** The preview lines read from the manifest and the inputs. Deterministic for a given input: the confirm step compares them. */
  deployLine: string;
  argsLine: string;
  manifestLine: string;
  /** SHA-256 of the encoded manifest in hex, and its size in bytes. */
  digest: string;
  bytes: number;
}

/** What the preview says a compiled manifest has no name for: a MASX asset has its symbol, which the preview shows above. */
const ASSET_NAME_CLOSING = "the symbol above is the asset's only name, because a compiled manifest carries none";

const NO_ROUTINE_LINE =
  "none: the manifest has no deploy routine, so nothing runs when the asset is created and no callsite is sent";

export function planMasx(input: { manifest: Record<string, unknown>; routine?: string; args?: Record<string, unknown> }): MasxPlan {
  const m = readDeployManifest(input.manifest, "asset");
  const lines = { routines: m.counts.total, digest: m.digest, bytes: m.bytes, manifestLine: manifestLine(m, ASSET_NAME_CLOSING) };
  const given = input.args !== undefined && Object.keys(input.args).length > 0;

  if (m.deploys.size === 0) {
    if (input.routine !== undefined || given) {
      throw invalid(
        "The manifest has no deploy routine, so nothing runs when the asset is created and no callsite is sent. Leave `routine` and `args` out.",
      );
    }
    return { payload: { manifest: m.hex }, callsite: undefined, deployLine: NO_ROUTINE_LINE, argsLine: "none", ...lines };
  }

  const { routine, only } = pickRoutine(m, input.routine, "when the asset is created");
  const { calldata, argsLine } = encodeDeployInputs(m, routine, input.args ?? {});
  return {
    payload: { manifest: m.hex, callsite: routine.name, ...(calldata ? { calldata } : {}) },
    callsite: routine.name,
    deployLine: `${routine.name}${only ? " (the only deploy routine in the manifest)" : ""}`,
    argsLine,
    ...lines,
  };
}
