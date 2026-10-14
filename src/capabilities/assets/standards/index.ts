/**
 * The standard files, one per built-in asset standard, and the lookup that decides whether a routine is described.
 *
 * A test walks the SDK's AssetStandard list and fails if a built-in standard has no file here, so a standard the SDK
 * adds cannot go unnoticed. Adding one is a file in this folder, a line below and a row in the SDK-equivalence test.
 */

import { kindOf, type RoutineSpec, type StandardFile } from "./common.js";
import { mas0File } from "./mas0.js";
import { mas1File } from "./mas1.js";
import { mas2File } from "./mas2.js";
import { masnFile } from "./masn.js";

export type { ParticipantLock, RoutineContext, RoutineSpec, StandardFile } from "./common.js";

/** The SDK's AssetStandard names that have a file. */
export const STANDARD_FILES: Readonly<Record<string, StandardFile>> = {
  MAS0: mas0File,
  MAS1: mas1File,
  MAS2: mas2File,
  MASN: masnFile,
};

/** Standards the SDK names that need no file: a MASX asset's routines come from its own manifest. A test fails if this list grows. */
export const NO_FILE_NEEDED: readonly string[] = ["MASX"];

/** Own-property lookup, so a name like "constructor" or "__proto__" finds nothing. */
export function standardFileFor(name: string): StandardFile | undefined {
  return Object.hasOwn(STANDARD_FILES, name) ? STANDARD_FILES[name] : undefined;
}

/**
 * The spec for a manifest routine, or undefined when this server has none or the manifest's inputs differ from the ones
 * the spec was written for. Labels alone are not enough (an `amount` typed as a string would match, be coerced to text
 * and break the sentence), and exact types would make a routine undescribed whenever a real manifest picks u256 where
 * the SDK says integer. So the comparison is by label and kind. A mismatch makes the routine undescribed, never wrong.
 */
export function specFor(
  file: StandardFile | undefined,
  callable: { name: string; accepts: ReadonlyArray<{ label: string; type: string }> },
): RoutineSpec | undefined {
  if (!file || !Object.hasOwn(file.routines, callable.name)) return undefined;
  const spec = file.routines[callable.name];
  if (!spec) return undefined;
  if (callable.accepts.length !== Object.keys(spec.inputs).length) return undefined;
  const matches = callable.accepts.every((a) => Object.hasOwn(spec.inputs, a.label) && kindOf(a.type) === spec.inputs[a.label]);
  return matches ? spec : undefined;
}
