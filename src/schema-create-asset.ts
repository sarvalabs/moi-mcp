/**
 * The input of moi_create_asset, split out of src/schema.ts, which re-exports it and keeps the TOOLS map. This file imports
 * only zod and src/schema-amount.ts, so it and src/schema.ts do not depend on each other.
 */

import { z } from "zod";

import { WireAmount } from "./schema-amount.js";

/**
 * The standards moi_create_asset builds. MASN is the native asset's and cannot be created, so it is not here. A list
 * rather than a free string, because zod strips an unknown field silently and a request for a standard this server does
 * not build would otherwise create a MAS0 asset.
 */
export const CREATABLE_STANDARDS = ["MAS0", "MAS1", "MAS2", "MASX"] as const;
export type CreatableStandard = (typeof CREATABLE_STANDARDS)[number];

export const CreateAssetInput = z.object({
  symbol: z.string().min(1).max(12),
  /**
   * Optional in the schema because MAS1 has none: the standard decides whether it is needed, and the planning step
   * (src/capabilities/assets/create-plan.ts) refuses a missing or a forbidden one with the reason.
   */
  supply: WireAmount.optional().describe(
    "The most that can ever be minted, in whole tokens (scaled by decimals). Required for MAS0, MAS2 and MASX. MAS1 has no supply and refuses one.",
  ),
  /**
   * KMOI to fund the new asset with so it can pay its own storage, in BASE
   * UNITS. KMOI has 9 decimals, so 10000000000 is 10 KMOI. Omitted, the server
   * sizes it: 10 KMOI when the balance allows, 7 KMOI otherwise. Below about
   * 6.1 KMOI the chain refuses the create; more than you hold and the transfer fails.
   */
  storageFund: WireAmount.optional().describe(
    "KMOI base units, not whole KMOI. 10000000000 is 10 KMOI. Leave it out unless you have a reason. " +
      "Not accepted for MASX, which is always funded with exactly the SDK's default amount, as the preview states.",
  ),
  /**
   * How far amounts are scaled: 2 gives cents. Separate from `dimension`. No default: "left out" and "given" must differ,
   * because MAS1 and MASX send no decimals and refuse a value instead of dropping it.
   */
  decimals: z
    .number()
    .int()
    .min(0)
    .max(18)
    .optional()
    .describe("How far amounts are scaled: 2 gives cents. MAS0 and MAS2 only, default 0. MAS1 and MASX send none and refuse one."),
  /** The asset's kind. The chain accepts only 0 (Economic) or 1 (Possession). */
  dimension: z.union([z.literal(0), z.literal(1)]).default(0),
  standard: z
    .enum(CREATABLE_STANDARDS, {
      message:
        "standard must be one of MAS0, MAS1, MAS2 or MASX (default MAS0). MASN is reserved for the native asset and cannot be created.",
    })
    .default("MAS0")
    .describe(
      "Asset standard, fixed when the asset is created. MAS0: fungible units, one balance per holder (the default). " +
        "MAS1: one unit, identified by token id; no supply and no decimals. MAS2: fungible units under token ids. " +
        "MASX: a custom asset made from a compiled manifest.",
    ),
  isStateful: z.boolean().default(false),
  isFungible: z.boolean().default(true),
  manifest: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "MASX only. The compiled asset manifest, as the JSON object `coco compile` writes for a `coco asset` module: syntax, engine, " +
        "kind \"asset\" and elements. Pass exactly the one the user gave you, as an object and never as a string.",
    ),
  routine: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "MASX only. The manifest's deploy routine to run once, when the asset is created, by name. Leave it out when the manifest has " +
        "exactly one deploy routine (it is used); name one when it has several. Not allowed when the manifest has none.",
    ),
  // Its own z.record, shared with nothing: a shared instance makes the JSON Schema generator emit a $ref.
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "MASX only. The deploy routine's inputs keyed by the labels in the manifest, for example {\"bps\": 300}. Integers are whole " +
        "numbers, as a number or a decimal string, never a fraction. Identifiers are 0x plus 64 hex characters. Leave it out for a " +
        "routine that takes no inputs.",
    ),
});
