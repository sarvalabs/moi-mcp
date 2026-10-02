/**
 * Call a logic routine that changes state: encode the call, build the interaction, measure fuel, simulate. The read-only
 * call is in view.ts. Moved from src/tools/write-core.ts.
 *
 * Two entry points, because two kinds of caller. prepareLogicCall is moi_call_logic's: the operation is the one the SDK built
 * for the routine, which it chooses from the kind the manifest declares, so an invoke routine is a LOGIC_INVOKE and an enlist
 * routine a LOGIC_ENLIST (enlist.ts). prepareLogicInvoke is for callers that name a routine of their own and put their own
 * words on the result (the agent registry): it sends an invoke routine and refuses anything else, so those words are never
 * attached to another operation. A deploy routine is refused by both, with a pointer to moi_deploy_logic.
 */

import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { MoiError } from "../../moi-error.js";
import { assertSendable, buildLogicInvoke, encodeLogicCall, quoteChainText } from "../../moi/ix-builder.js";
import { getReadOnlySigner } from "../../moi/provider.js";
import { CallLogicInput, ErrorCode } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  asWriteResult, assertWillSucceed, ok, providerOptions, senderFor, withMeasuredFuel, type PreparedWrite,
} from "../../tools/write-core.js";
import { prepareLogicEnlist } from "./enlist.js";
import { viewLogicCall } from "./view.js";

type LogicCall = Omit<z.infer<typeof CallLogicInput>, "kind">;
type EncodedCall = Awaited<ReturnType<typeof encodeLogicCall>>;

/** Encode the call with the SDK's logic driver: one manifest read, which says what the routine is sent as. */
const encode = (params: LogicCall): Promise<EncodedCall> =>
  encodeLogicCall(getReadOnlySigner(providerOptions()), params.logicId, params.routine, params.args ?? []);

/** A routine the manifest declares as invoke: build it as a LOGIC_INVOKE, measure fuel, simulate. */
async function prepareInvoke(account: string, params: LogicCall, payload: EncodedCall): Promise<PreparedWrite> {
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

/**
 * Prepare an invoke routine of a logic: build, measure fuel, simulate. A routine the manifest declares as enlist is refused,
 * not sent as an invoke and not as an enlistment, because the callers here (the agent registry) describe the call in their own
 * words, which would then be on an operation the person was not told about.
 */
export async function prepareLogicInvoke(account: string, params: LogicCall): Promise<PreparedWrite> {
  const payload = await encode(params);
  if (payload.kind !== "invoke") {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `${quoteChainText(params.routine, 64)} is an enlist routine of logic ${params.logicId}, and this call sends invoke routines only. Nothing was sent to your wallet.`,
      { logicId: params.logicId, callsite: params.routine, kind: payload.kind },
    );
  }
  return prepareInvoke(account, params, payload);
}

/**
 * Prepare moi_call_logic's state-changing call: the operation is the one the SDK built for the routine. An invoke routine is
 * prepared as before; an enlist routine is prepared by prepareLogicEnlist.
 */
export async function prepareLogicCall(account: string, params: LogicCall): Promise<PreparedWrite> {
  const payload = await encode(params);
  if (payload.kind === "enlist") return prepareLogicEnlist(account, { ...params, calldata: payload.calldata });
  return prepareInvoke(account, params, payload);
}

export function callLogicTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a MOI logic. kind=view reads and needs no wallet, no preview, no confirm. kind=invoke changes state and nothing happens until the user taps Send on their phone. " +
        "If the routine moves value for accounts other than the user (a swap against a pool owner, a payout), list them in `participants`; the node refuses undeclared ones at execution. " +
        "The logic's manifest says what a routine is sent as, and moi_get_logic shows each routine's kind: an invoke routine is a logic call, and an enlist routine enlists the user's account in the logic, " +
        "which the protocol docs describe as setting up storage for that logic in the account and running the logic's setup routine. " +
        "The docs list that operation as reserved, not yet active, so the node may refuse it, and this tool cannot send an enlist routine any other way; a refusal arrives before the phone is asked. " +
        "A deploy routine cannot be called here: moi_deploy_logic deploys a logic." +
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
      return runWrite(deps, auth, "call_logic", call, confirm, (s) => prepareLogicCall(s.address, call));
    },
  );
}
