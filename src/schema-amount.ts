/**
 * The two amount primitives the tool inputs share, split out of src/schema.ts (which re-exports them) so that a schema file
 * of its own, such as src/schema-create-asset.ts, can use them without importing src/schema.ts back.
 */

import { z } from "zod";

/** Human-readable amount as string to avoid float drift. e.g. "12.5" */
export const Amount = z.string().regex(/^\d+(\.\d+)?$/, "decimal string");

/**
 * An amount as it arrives over the wire.
 *
 * Amounts are decimal STRINGS internally so that values beyond 2^53 survive,
 * but an MCP client handed a numeric-looking field sends a JSON number — and
 * a string-only schema then rejects it with no value able to satisfy both.
 * Accept a number too, and normalise it to the canonical string.
 *
 * A number above Number.MAX_SAFE_INTEGER is refused rather than silently
 * rounded; those callers must send a string.
 */
export const WireAmount = z
  .union([Amount, z.number()])
  .transform((value, ctx) => {
    if (typeof value === "string") return value;
    if (!Number.isFinite(value) || value < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be a non-negative number" });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(value) && !Number.isInteger(value)) {
      // A non-integer is fine (1.5); an unsafe integer is not.
      return String(value);
    }
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `amount ${value} exceeds the safe integer range — pass it as a string to keep full precision`,
      });
      return z.NEVER;
    }
    return String(value);
  });
