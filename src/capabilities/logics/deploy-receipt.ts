/**
 * What a deploy's receipt says, and the result moi_deploy_logic gives back once the interaction is broadcast.
 *
 * The receipt is read strictly and fails closed. A new logic's id is reported only from a receipt that is exactly what
 * the SDK's own processReceipt reads for a clean deploy (the interaction's status 0, every operation listed with status 0,
 * one operation of type LOGIC_DEPLOY with no error and an id of 0x and 64 hex characters), and, when the address the
 * funding transfer paid is known, an id equal to it. A receipt that is there and is anything else is "failed" (the
 * interaction's status is not 0) or "unsure", and a value that is not a receipt is "pending". Nothing is defaulted: the
 * repo's toBigInt turns a missing or garbled field into 0, which here would read as success.
 *
 * The result tells the model plainly whether a logic exists (`deployed`: "yes", "no" or "unknown"), because `status:
 * "sent"` says only that the interaction was broadcast, and tells it not to deploy again until the receipt has been read:
 * a second call creates a second logic and moves another 10 KMOI.
 *
 * Pure apart from the receipt reader's node call. Imports nothing from src/tools, src/wc or the journal.
 */

import { ManifestCoder, OpType } from "js-moi-sdk";

import { asKmoi, decodeErrorHex, DEFAULT_STORAGE_FUND, quoteChainText } from "../../moi/ix-builder.js";
import { withTimeout } from "../../moi/reads.js";

/** How long one look at the receipt may take, and never more than what is left of the wait. */
const RECEIPT_LOOK_TIMEOUT_MS = 3_000;

const LOGIC_ID_RE = /^0x[0-9a-fA-F]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export type DeployOutcome =
  | { kind: "created"; logicId: string }
  /** The receipt is there and its status says the interaction failed. */
  | { kind: "failed"; status: number; detail?: string }
  /** The receipt is there and is not a clean success: unreadable, contradictory, or without a usable id. `why` is a sentence chosen here, `detail` quoted chain text. */
  | { kind: "unsure"; why: string; detail?: string }
  /** No receipt was read: none yet, or none looked for. */
  | { kind: "pending" };

/** A whole number from a number, a bigint, a 0x hex string or a decimal string, or undefined for anything else. Never a default. */
function whole(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number.NaN;
  else if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) n = Number(v);
  else return undefined;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** The reason an operation's error field gives, as text the model may be shown, or undefined for none. */
function errorText(data: Record<string, unknown>): string | undefined {
  const error = String(data["error"] ?? "0x");
  if (error === "0x" || error === "") return undefined;
  try {
    const exception = ManifestCoder.decodeException(error);
    if (exception) return quoteChainText(`${exception.class}: ${exception.error}`);
  } catch {
    /* not an exception: try it as text */
  }
  return decodeErrorHex(error);
}

const unsure = (why: string, detail?: string): DeployOutcome => ({ kind: "unsure", why, ...(detail ? { detail } : {}) });

/**
 * What a receipt says about a deploy, read strictly: a created logic is reported only from a receipt whose status is a
 * well-formed 0, whose operations are all listed with a status of 0, which has exactly one LOGIC_DEPLOY operation without
 * an error and with an id of 0x and 64 hex characters, and, when `funded` is given, whose id is the address the funding
 * transfer paid. Anything else that is there but not that is "unsure" or "failed", and nothing is defaulted: a missing or
 * garbled field is not a 0. A value that is not a receipt at all is "pending".
 */
export function outcomeOf(receipt: unknown, funded?: string): DeployOutcome {
  if (!isObject(receipt) || (receipt["status"] === undefined && receipt["ix_operations"] === undefined)) return { kind: "pending" };
  const status = whole(receipt["status"]);
  if (status === undefined) return unsure("Its receipt has no readable status.");
  const rawOps = receipt["ix_operations"];
  const ops = Array.isArray(rawOps) ? rawOps : [];
  const deploys = ops.filter((op) => isObject(op) && whole(op["tx_type"]) === OpType.LOGIC_DEPLOY) as Array<Record<string, unknown>>;
  const data = deploys.length === 1 && isObject(deploys[0]?.["data"]) ? (deploys[0]["data"] as Record<string, unknown>) : {};
  const detail = errorText(data);

  if (status !== 0) return { kind: "failed", status, ...(detail ? { detail } : {}) };
  if (!Array.isArray(rawOps)) return unsure("Its receipt does not list its operations.");
  for (const op of ops) {
    if (!isObject(op) || whole(op["status"]) === undefined || whole(op["tx_type"]) === undefined) return unsure("Its receipt lists an operation this server cannot read.");
    if (whole(op["status"]) !== 0) return unsure("Its receipt says the interaction succeeded, but one of its operations did not.");
  }
  if (deploys.length !== 1) return unsure("Its receipt does not list exactly one deploy operation.");
  if (detail) return unsure("Its deploy operation reports an error.", detail);
  const id = data["logic_id"];
  if (typeof id !== "string" || !LOGIC_ID_RE.test(id)) return unsure("Its receipt carries no usable logic id.");
  if (funded !== undefined && id.toLowerCase() !== funded.toLowerCase()) {
    return unsure(`The logic id in its receipt (${id}) is not the address the KMOI was sent to (${funded}).`);
  }
  return { kind: "created", logicId: id };
}

/**
 * Look at the deploy's receipt for the new logic's id, for up to `waitMs` after the broadcast: a look at once, then one every
 * `pollMs`. A wait of 0 does not look at all: the stdio server returns the hash at once, because a receipt right after a
 * broadcast is rarely there yet and the person's tap has already used most of the client's 60 second budget. Each look is
 * cut off at `lookTimeoutMs` and at what is left of the wait, so the whole takes `waitMs` and no more. Never throws: an
 * interaction already on chain must not fail on this, so a node that errors or does not answer reads as no receipt yet.
 */
export async function readDeployOutcome(
  provider: { getInteractionReceipt: (hash: string) => Promise<unknown> },
  hash: string,
  waitMs: number,
  funded?: string,
  options: { pollMs?: number; lookTimeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeployOutcome> {
  const pollMs = options.pollMs ?? 3_000;
  const lookTimeoutMs = options.lookTimeoutMs ?? RECEIPT_LOOK_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { kind: "pending" };
    let outcome: DeployOutcome;
    try {
      outcome = outcomeOf(await withTimeout(provider.getInteractionReceipt(hash), Math.min(lookTimeoutMs, left), "moi.InteractionReceipt"), funded);
    } catch {
      outcome = { kind: "pending" };
    }
    if (outcome.kind !== "pending") return outcome;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

const NO_RETRY =
  `Do not call moi_deploy_logic again for this manifest until the receipt has been read: a second call would create a second logic and move another ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI.`;
const WHERE_TO_LOOK = "moi_get_interaction with the hash shows the whole receipt.";

/**
 * The result of a sent deploy: what runWrite returned, with `summary` rewritten to what is known, `deployed` saying so
 * plainly ("yes", "no" or "unknown"), and the id or a note. runWrite's own summary is the preview's sentence, which is
 * true only of a deploy that landed, and `status: "sent"` says only that the interaction was broadcast.
 */
export function deployResult(sent: Record<string, unknown>, outcome: DeployOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "created":
      return {
        ...sent,
        summary: `Deployed a new logic. Its id is ${outcome.logicId}. ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI moved into it.`,
        deployed: "yes",
        logicId: outcome.logicId,
      };
    case "failed":
      return {
        ...sent,
        summary: "The interaction was broadcast and included, but its receipt says it failed, so the logic should not exist.",
        deployed: "no",
        note:
          `The receipt says the interaction failed (status ${outcome.status})${outcome.detail ? `: ${outcome.detail}` : ""}. An interaction is applied ` +
          "all or nothing, so no logic should have been created and the KMOI should not have moved, but this server has not checked. " +
          `The fuel was still charged. ${WHERE_TO_LOOK} ${NO_RETRY}`,
      };
    case "unsure":
      return {
        ...sent,
        summary: "The interaction was broadcast, and it is not known whether a logic was created.",
        deployed: "unknown",
        note:
          `The interaction was included, but this server cannot say a logic exists. ${outcome.why}${outcome.detail ? ` ${outcome.detail}` : ""} ` +
          `The ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI may have moved. ${WHERE_TO_LOOK} ${NO_RETRY}`,
      };
    case "pending":
      return {
        ...sent,
        summary: "The interaction was broadcast, and it is not known whether a logic was created.",
        deployed: "unknown",
        note:
          "No receipt was read before this returned, so the new logic's id is not known. Call moi_get_interaction with this hash in a moment: once the " +
          "interaction has landed, its receipt lists the operations in order, the first is the deploy (type LOGIC_DEPLOY, tx_type 0xb), and that " +
          `operation's data.logic_id is the new logic's id. ${NO_RETRY}`,
      };
  }
}
