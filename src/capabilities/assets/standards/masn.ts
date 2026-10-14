/**
 * MASN: the native asset (KMOI). Its manifest has the same six write routines as MAS0 with the same inputs (checked
 * against the real manifest captured from voyage devnet on 1 October 2026), so those specs are MAS0's. Mint,
 * MintWithMetadata, Burn and the two metadata setters are not in it, and the chain reserves them for the protocol
 * (KMOI_RESERVED_ENDPOINTS in js-moi-providers): they are refused here, before the manifest is read, with a message
 * that says why instead of "no such routine".
 */

import { mas0File } from "./mas0.js";
import type { RoutineSpec, StandardFile } from "./common.js";

const KEPT = ["Transfer", "TransferFrom", "Lockup", "Release", "Approve", "Revoke"] as const;
const MINT_OR_BURN: readonly string[] = ["Mint", "MintWithMetadata", "Burn"];
const METADATA: readonly string[] = ["SetStaticMetadata", "SetDynamicMetadata"];

/** MAS0's specs for exactly the named routines. */
function pick(from: Readonly<Record<string, RoutineSpec>>, names: readonly string[]): Record<string, RoutineSpec> {
  const out: Array<[string, RoutineSpec]> = [];
  for (const name of names) {
    const spec = Object.hasOwn(from, name) ? from[name] : undefined;
    if (spec) out.push([name, spec]);
  }
  return Object.fromEntries(out);
}

export const masnFile: StandardFile = {
  standard: "MASN",
  refusal: (routine) => {
    if (MINT_OR_BURN.includes(routine)) {
      return `The native asset cannot be minted or burned: the chain reserves ${routine} for the protocol, and the asset's manifest has no such routine.`;
    }
    if (METADATA.includes(routine)) {
      return `The native asset's metadata cannot be changed: the chain reserves ${routine} for the protocol, and the asset's manifest has no such routine.`;
    }
    return undefined;
  },
  routines: pick(mas0File.routines, KEPT),
};
