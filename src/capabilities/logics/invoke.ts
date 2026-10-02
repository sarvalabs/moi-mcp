/**
 * Call a logic routine that changes state: encode the call, build the interaction, measure fuel, simulate. The read-only
 * call is in view.ts. Moved from src/tools/write-core.ts.
 */

import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { assertSendable, buildLogicInvoke, encodeLogicCall } from "../../moi/ix-builder.js";
import { getReadOnlySigner } from "../../moi/provider.js";
import { CallLogicInput } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  asWriteResult, assertWillSucceed, ok, providerOptions, senderFor, withMeasuredFuel, type PreparedWrite,
} from "../../tools/write-core.js";
import { viewLogicCall } from "./view.js";

/**
 * Prepare logic invocation: build, measure fuel, simulate.
 */
export async function prepareLogicInvoke(
  account: string,
  params: Omit<z.infer<typeof CallLogicInput>, "kind">,
): Promise<PreparedWrite> {
  const payload = await encodeLogicCall(
    getReadOnlySigner(providerOptions()),
    params.logicId,
    params.routine,
    params.args ?? [],
  );
  const ix = await withMeasuredFuel(
    buildLogicInvoke(await senderFor(account), {
      logicId: params.logicId,
      callsite: params.routine,
      ...(payload.calldata ? { calldata: payload.calldata } : {}),
      ...(params.participants ? { participants: params.participants } : {}),
    }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix);

  return {
    ix,
    description: `Call ${params.routine} on logic ${params.logicId}`,
    details: {
      Operation: "Invoke logic routine",
      Logic: params.logicId,
      Routine: params.routine,
      Arguments: JSON.stringify(params.args ?? [], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ...(params.participants && params.participants.length > 0
        ? {
            // Shown so the person sees whose funds the routine may move before
            // the phone asks. The phone renders the same list.
            "Other participants": params.participants.map((p) => `${p.id} (${p.lock})`).join(", "),
          }
        : {}),
    },
  };
}

export function callLogicTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a MOI logic. kind=view reads and needs no wallet, no preview, no confirm. kind=invoke changes state and nothing happens until the user taps Send on their phone. " +
        "If the routine moves value for accounts other than the user (a swap against a pool owner, a payout), list them in `participants`; the node refuses undeclared ones at execution." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CallLogicInput.shape, confirm: ConfirmArg },
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async ({ confirm, kind, ...call }) => {
      // A view runs against the node directly — no wallet, no approval, no
      // signed interaction, and so nothing for the journal to track.
      if (kind === "view") {
        try {
          const value = await viewLogicCall({ ...call, kind: "view" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        } catch (err) {
          return ok(asWriteResult(err));
        }
      }
      return runWrite(deps, auth, "call_logic", call, confirm, (s) => prepareLogicInvoke(s.address, call));
    },
  );
}
