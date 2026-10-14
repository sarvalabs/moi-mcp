/**
 * What an asset create's receipt says, and the result moi_create_asset gives back once the interaction is broadcast.
 *
 * `status: "sent"` says only that the interaction was broadcast. The new asset's id is in the receipt, on the ASSET_CREATE
 * operation, and the result reports it only from a receipt that is exactly a clean create, read by the same strict reader
 * moi_deploy_logic uses for a deploy (readReceipt in src/capabilities/logics/deploy-receipt.ts): the interaction's status is a
 * well-formed 0, every operation is listed with a status of 0, exactly one is an ASSET_CREATE without an error and with an id
 * of 0x and 64 hex characters, and the id is the address the funding transfer paid. Anything else that is there is "failed"
 * or "unsure", and a value that is not a receipt is "pending". The predicted id is never reported by itself.
 *
 * The result says plainly whether an asset exists (`created`: "yes", "no" or "unknown") and tells the model not to create
 * again until the receipt has been read: a second call would make a second asset and move more KMOI.
 *
 * Pure apart from the receipt reader's node call. Imports nothing from src/tools, src/wc or the journal.
 */

import { OpType } from "js-moi-sdk";

import { asKmoi } from "../../moi/ix-builder.js";
import { noRetry, pollReceipt, readReceipt, WHERE_TO_LOOK, type ReceiptKind } from "../logics/deploy-receipt.js";

export const CREATE_RECEIPT: ReceiptKind = { opType: OpType.ASSET_CREATE, operation: "create", idKey: "asset_id", idWord: "asset id" };

export type CreateOutcome =
  | { kind: "created"; assetId: string }
  /** The receipt is there and its status says the interaction failed. */
  | { kind: "failed"; status: number; detail?: string }
  /** The receipt is there and is not a clean success: unreadable, contradictory, or without a usable id. `why` is a sentence chosen here, `detail` quoted chain text. */
  | { kind: "unsure"; why: string; detail?: string }
  /** No receipt was read: none yet, or none looked for. */
  | { kind: "pending" };

/** What a receipt says about an asset create. `predicted` is the address the funding transfer paid. */
export function createOutcomeOf(receipt: unknown, predicted?: string): CreateOutcome {
  const read = readReceipt(receipt, CREATE_RECEIPT, predicted);
  return read.kind === "created" ? { kind: "created", assetId: read.id } : read;
}

/** Look at the create's receipt for the new asset's id, for up to `waitMs` after the broadcast. See pollReceipt. */
export async function readCreateOutcome(
  provider: { getInteractionReceipt: (hash: string) => Promise<unknown> },
  hash: string,
  waitMs: number,
  predicted?: string,
  options: { pollMs?: number; lookTimeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CreateOutcome> {
  return pollReceipt(provider, hash, waitMs, (receipt) => createOutcomeOf(receipt, predicted), { kind: "pending" }, options);
}

/**
 * The result of a sent create: what runWrite returned, with `summary` rewritten to what is known, `created` saying so
 * plainly and the id or a note. runWrite's own summary is the preview's sentence, true only of a create that landed.
 * Fixed text and the symbol, standard, id and fund, nothing from the chain but a quoted reason.
 */
export function createResult(
  sent: Record<string, unknown>,
  outcome: CreateOutcome,
  info: { symbol: string; standard: string; fund: bigint },
): Record<string, unknown> {
  const retry = noRetry({ tool: "moi_create_asset", subject: "asset", noun: "asset", fund: info.fund });
  switch (outcome.kind) {
    case "created":
      return {
        ...sent,
        summary: `Created asset ${info.symbol} (${info.standard}). Its id is ${outcome.assetId}. ${asKmoi(info.fund)} KMOI moved into it to pay for its storage.`,
        created: "yes",
        assetId: outcome.assetId,
      };
    case "failed":
      return {
        ...sent,
        summary: "The interaction was broadcast and included, but its receipt says it failed, so the asset should not exist.",
        created: "no",
        note:
          `The receipt says the interaction failed (status ${outcome.status})${outcome.detail ? `: ${outcome.detail}` : ""}. An interaction is applied ` +
          "all or nothing, so no asset should have been created and the KMOI should not have moved, but this server has not checked. " +
          `The fuel was still charged. ${WHERE_TO_LOOK} ${retry}`,
      };
    case "unsure":
      return {
        ...sent,
        summary: "The interaction was broadcast, and it is not known whether an asset was created.",
        created: "unknown",
        note:
          `The interaction was included, but this server cannot say an asset exists. ${outcome.why}${outcome.detail ? ` ${outcome.detail}` : ""} ` +
          `The ${asKmoi(info.fund)} KMOI may have moved. ${WHERE_TO_LOOK} ${retry}`,
      };
    case "pending":
      return {
        ...sent,
        summary: "The interaction was broadcast, and it is not known whether an asset was created.",
        created: "unknown",
        note:
          "No receipt was read before this returned, so the new asset's id is not known. Call moi_get_interaction with this hash in a moment: once the " +
          "interaction has landed, its receipt lists the operations in order, the first is the create (ASSET_CREATE, tx_type 0x4), and that " +
          `operation's data.asset_id is the new asset's id. ${retry}`,
      };
  }
}
