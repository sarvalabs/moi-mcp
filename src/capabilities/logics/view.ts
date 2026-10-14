/**
 * Call a logic routine that only reads, against the node directly, with no wallet. The call that changes state is in
 * invoke.ts. Moved from src/tools/write-core.ts.
 */

import type { z } from "zod";

import { MoiError } from "../../moi-error.js";
import { assertNotDeployRoutine, type CallsiteReader } from "../../moi/ix-builder.js";
import { getReadOnlySigner } from "../../moi/provider.js";
import { rejectedCallerError } from "../../moi/read-caller.js";
import { ErrorCode, type CallLogicInput, type CallLogicViewOutput } from "../../schema.js";
import { providerOptions } from "../../tools/write-core.js";
import { jsonSafe, unwrapRoutineResult } from "../reads/registry.js";

/**
 * View-only logic call: run against the node directly, no wallet needed.
 */
export async function viewLogicCall(
  params: z.infer<typeof CallLogicInput>,
): Promise<z.infer<typeof CallLogicViewOutput>> {
  const signer = getReadOnlySigner(providerOptions());
  const { getLogicDriver } = await import("js-moi-sdk");
  const driver = (await getLogicDriver(params.logicId, signer as never)) as unknown as CallsiteReader & {
    routines: Record<string, (...a: unknown[]) => Promise<{ call: () => Promise<{ result: () => unknown }> }>>;
  };
  // Own properties only, as in encodeLogicCall: "constructor" is a function on any plain object and is not a routine.
  const fn = Object.hasOwn(driver.routines, params.routine) ? driver.routines[params.routine] : undefined;
  if (typeof fn !== "function") {
    // A deploy routine is not one this driver offers; say where it goes instead of calling it a name the logic lacks.
    assertNotDeployRoutine(driver, params.logicId, params.routine);
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Logic ${params.logicId} has no routine "${params.routine}". Available: ${Object.keys(driver.routines ?? {}).join(", ")}.`,
    );
  }
  let raw: unknown;
  try {
    const response = await (await fn(...(params.args ?? []))).call();
    raw = await response.result();
  } catch (err) {
    // The node refusing the placeholder caller says which setting fixes it (src/moi/read-caller.ts); any other failure passes through.
    throw rejectedCallerError(err) ?? err;
  }
  const outputs = unwrapRoutineResult(raw, `${params.routine} on ${params.logicId}`);
  return {
    routine: params.routine,
    outputs: (jsonSafe(outputs) ?? {}) as Record<string, unknown>,
  };
}
