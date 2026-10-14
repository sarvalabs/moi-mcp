/**
 * Enlist the paired account in a logic: what moi_call_logic sends for a routine its manifest declares with kind "enlist".
 *
 * There is no tool of its own. moi_call_logic already sends a state-changing call through the one write path; what changes
 * is the operation. The SDK's logic driver turns the kind a manifest declares for a routine into an operation type
 * (js-moi-logic, logic-base.ts, getTxType): invoke becomes LOGIC_INVOKE, enlist becomes LOGIC_ENLIST, and deploy becomes
 * LOGIC_DEPLOY, which is moi_deploy_logic's. prepareLogicCall (invoke.ts) reads the answer off the request the driver
 * built (encodeLogicCall, logicCallKind) and hands an enlist routine to prepareLogicEnlist here, so this server sends what the SDK
 * built. prepareLogicInvoke, which the agent registry calls, stays invoke-only and refuses an enlist routine.
 *
 * What enlisting means is taken from the protocol docs (learn/fundamentals/interactions.md, "LogicEnlist"; logics.md,
 * "Endpoint Qualifiers"; storage-cost.md): it subscribes an account to a deployed logic, allocates a storage area for that
 * logic inside the account's state, and runs a setup routine the logic defines. Storage in the user's own account is charged
 * to the user as collateral, KMOI that stays in the account and cannot be spent while the storage exists, and the operation
 * table lists nothing that removes an enlistment. The summary says that and no more. It does not say that an account must
 * enlist before it can store data: the Cocolang 0.9.2 docs say the opposite (see below).
 *
 * HONEST LIMIT. The protocol docs list LogicEnlist (type 13) as Reserved and call what they say about it a conceptual
 * design that may change before activation. The Cocolang 0.9.2 release notes say that MOI has no enlist interaction, that
 * the compiler no longer accepts `endpoint enlist`, and that an account that was never written reads every field as its
 * zero value; they tell authors to call such a routine with invoke. The JSON-RPC docs still list moi.LogicEnlisted, a read
 * that says whether a logic is enlisted to an account, which this server does not call. The installed SDK
 * (js-moi-sdk 0.9.0-rc2) still maps the kind and still serialises the operation, which is why it can be built here, but nothing
 * here has run against a node, and a node may refuse it. The simulation that every write goes through (assertWillSucceed) is where
 * that shows, before the person is asked anything, and the refusal says so. The mock node in the tests answers any simulation,
 * so no test shows that a chain accepts a LOGIC_ENLIST. Before this file existed a routine of kind enlist was sent as a
 * LOGIC_INVOKE; moi_call_logic has no input to choose that now, so a node that refuses the enlistment leaves no way to send the
 * routine through this tool.
 *
 * Two more logic operation types cannot be built here. LOGIC_UPGRADE and LOGIC_INTERACT are in the SDK's OpType enum, but the
 * installed SDK (js-moi-sdk 0.9.0-rc2) has no serialiser for them: toInteractionArgs and toRawInteractionObject throw
 * "Unsupported Ix type" for both (js-moi-providers, interaction.ts), and a server that never holds a key can only send what
 * the SDK can encode. The SDK numbers them 14 and 15 where the protocol docs number them 16 and 17, so hand-building them
 * would be a guess. They are not attempted, and nothing in this file or its tests builds one.
 */

import { OpType } from "js-moi-sdk";
import type { z } from "zod";

import { assertSendable, buildLogicInvoke, quoteChainText, type BuildOptions, type SenderInfo, type UnsignedInteraction } from "../../moi/ix-builder.js";
import { clampChainText } from "../../moi/reads.js";
import type { CallLogicInput } from "../../schema.js";
import { assertWillSucceed, senderFor, withMeasuredFuel, type PreparedWrite } from "../../tools/write-core.js";

/** What moi_call_logic was asked for, with the routine's encoded inputs: calldata is left out for a routine that takes none. */
export type EnlistCall = Omit<z.infer<typeof CallLogicInput>, "kind"> & { calldata?: string };

/**
 * Added to the refusal when the node's simulation says an enlist would fail. It says "may", because the node may have refused
 * for a reason of the routine's own (its arguments, an account that is already registered, a balance too small for the
 * storage collateral); the reason before it is the node's, when it gave one.
 */
export const ENLIST_REFUSAL_HINT =
  "If the reason above does not explain it, the node may be refusing the operation itself: the protocol docs list LogicEnlist as reserved, not yet active, " +
  "and the Cocolang 0.9.2 release notes say MOI has no enlist interaction and that the compiler no longer accepts enlist routines. " +
  "This server sends a routine the logic's manifest declares as enlist as an enlistment, as the SDK does; older versions sent it as a plain invoke, and moi_call_logic has no input to choose that now.";

/**
 * One LOGIC_ENLIST operation: the payload and the participants of a logic invoke, with the other operation type. The SDK's
 * logic driver builds both from one payload shape (LogicActionPayload) and derives the same participants for them: the logic,
 * locked to mutate, and none for the sender (js-moi-providers, interaction.ts, processParticipants). So this is buildLogicInvoke
 * with the type replaced, and a test compares the result to what the driver builds for an enlist routine, key for key.
 */
export function buildLogicEnlist(
  sender: SenderInfo,
  params: {
    logicId: string;
    callsite: string;
    calldata?: string;
    participants?: Array<{ id: string; lock: "mutate" | "read" | "none" }>;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const ix = buildLogicInvoke(sender, params, options);
  return { ...ix, ix_operations: ix.ix_operations.map((op) => ({ ...op, type: OpType.LOGIC_ENLIST })) };
}

/**
 * The words the person reads. runWrite sends the interaction alone (the hub drops the description), so the summary is the
 * only place the chat says what an enlistment is, and `details` is what runWrite compares between the preview and the confirm,
 * so nothing in it moves with the fuel estimate. A preview exists only after the node simulated the enlistment and accepted
 * it, so the summary says what the docs give as its consequences and leaves the question whether the operation is live to the
 * refusal. The routine's name is chain text: it is quoted and capped.
 */
export function describeEnlist(call: EnlistCall): { description: string; details: Record<string, string> } {
  const description =
    `Enlist your account in logic ${call.logicId} by running its enlist routine ${quoteChainText(call.routine, 64)}. ` +
    "The protocol docs describe enlisting as subscribing an account to a logic: it allocates a storage area for that logic inside your own account's state " +
    "and runs a setup routine the logic defines, with your account as the sender. This server cannot show what that routine does. " +
    "The protocol docs say storage in your own account is paid for by you, as collateral: the KMOI that backs it stays in your account but cannot be spent while the storage exists. " +
    "They list no operation that removes an enlistment, so do not assume it can be undone. " +
    "What MOI Wallet shows for an enlistment is not known, so this summary is where it is described.";
  const details: Record<string, string> = {
    Operation: "Enlist your account in a logic (LOGIC_ENLIST)",
    Logic: call.logicId,
    Routine: clampChainText(call.routine, 64),
    Arguments: JSON.stringify(call.args ?? [], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ...(call.participants && call.participants.length > 0
      ? { "Other participants": call.participants.map((p) => `${p.id} (${p.lock})`).join(", ") }
      : {}),
  };
  return { description, details };
}

/**
 * Build the enlistment, measure its fuel, simulate it, and say what it is. runWrite (src/tools/hosted-writes.ts) previews and
 * sends it, as it does every write. A refusal from the node arrives here, before the phone is asked.
 */
export async function prepareLogicEnlist(account: string, call: EnlistCall): Promise<PreparedWrite> {
  const ix = await withMeasuredFuel(
    buildLogicEnlist(await senderFor(account), {
      logicId: call.logicId,
      callsite: call.routine,
      ...(call.calldata ? { calldata: call.calldata } : {}),
      ...(call.participants ? { participants: call.participants } : {}),
    }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix, ENLIST_REFUSAL_HINT);
  return { ix, ...describeEnlist(call) };
}
