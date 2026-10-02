/**
 * Call a logic routine that only reads, against the node directly, with no wallet. The call that changes state is in
 * invoke.ts. Moved from src/tools/write-core.ts.
 */

import type { z } from "zod";

import { MoiError } from "../../moi-error.js";
import { getReadOnlySigner } from "../../moi/provider.js";
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
  const driver = (await getLogicDriver(params.logicId, signer as never)) as unknown as {
    routines: Record<string, (...a: unknown[]) => Promise<{ call: () => Promise<{ result: () => unknown }> }>>;
  };
  const fn = driver.routines[params.routine];
  if (typeof fn !== "function") {
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Logic ${params.logicId} has no routine "${params.routine}". Available: ${Object.keys(driver.routines ?? {}).join(", ")}.`,
    );
  }
  const response = await (await fn(...(params.args ?? []))).call();
  const outputs = unwrapRoutineResult(await response.result(), `${params.routine} on ${params.logicId}`);
  return {
    routine: params.routine,
    outputs: (jsonSafe(outputs) ?? {}) as Record<string, unknown>,
  };
}
