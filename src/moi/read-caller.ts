/**
 * What to tell a person when the node cannot find an account while running a read-only logic call.
 *
 * No MCP imports here, so the registry reads, the asset reads and the logic view can all use it. The node simulates a
 * read as some caller and refuses one it has never seen: "failed to fetch acc meta info: account not found". With the
 * placeholder caller (see getReadOnlySigner) that is every read on a network that enforces it. It used to be reported
 * as an empty registry, which is how a live registry holding 153 agents was once declared gone; now it is named.
 *
 * The node's text names no account, so the caller is only one possible cause: a routine that reads another account
 * named in its arguments gives the same text when that account does not exist. The message says so and quotes the
 * node's own words, so a different cause stays visible.
 */

import { clip } from "../bounds.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import { readCallerFromEnv } from "./provider.js";

/**
 * The narrow text on purpose: a bare "account not found" also comes from reasons that are not the caller (a missing
 * participant argument, a missing logic account), and relabelling those would send an operator after the wrong setting.
 */
export const CALLER_REJECTED = /acc meta info: account not found/i;

/**
 * The error for a rejected read caller. A class of its own, and not a flag in `data` (which reaches the client), so that
 * code which treats a missing account as an empty registry can tell it from the node's own text: the message quotes
 * that text, "account not found" among it, and must never be read as "nobody has registered an agent".
 */
export class ReadCallerRejected extends MoiError {
  constructor(message: string) {
    super(ErrorCode.RPC_ERROR, message);
  }
}

/** The most characters of the node's own text that the message quotes. */
export const MAX_NODE_TEXT = 300;

export function isCallerRejected(err: unknown): boolean {
  return CALLER_REJECTED.test(err instanceof Error ? err.message : String(err));
}

function nodeText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return clip(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), MAX_NODE_TEXT);
}

/**
 * The error to throw for a rejected read caller. The value of MOI_READ_CALLER is named only when the read-only signer
 * would actually use it, which is when it is a valid participant id. A value that is set but invalid is not echoed (it
 * may be anything someone pasted) and the message says it is ignored, because the signer falls back to the placeholder.
 */
export function callerRejected(err: unknown, env: NodeJS.ProcessEnv = process.env): ReadCallerRejected {
  const caller = readCallerFromEnv(env);
  const head = "The node could not find an account while running this read, so the read did not run.";
  const fix =
    "MOI_READ_CALLER must be set, in the server's environment, to a participant that exists on this network (any funded account will do), and the server restarted by whoever runs it.";
  const tail = `The same error also appears when an account named in the call's arguments does not exist, so check the addresses in the call as well. The node said: "${nodeText(err)}".`;

  let body: string;
  if (caller) {
    body = `This server runs read-only calls as MOI_READ_CALLER (${caller}). If that participant does not exist on this network, ${fix}`;
  } else {
    const ignored = env["MOI_READ_CALLER"]
      ? " MOI_READ_CALLER is set but is not a valid participant id, so it is ignored."
      : "";
    body = `This server runs read-only calls as a placeholder caller when MOI_READ_CALLER is not set to a valid participant id, and some networks reject that caller. If that is the cause, ${fix}${ignored}`;
  }
  return new ReadCallerRejected(`${head} ${body} ${tail}`);
}

/**
 * The MoiError to throw when `err` is a rejected read caller, or undefined when it is anything else (including a
 * MoiError, which is already worded for the person). A call site is one line:
 * `throw rejectedCallerError(err) ?? err`.
 */
export function rejectedCallerError(err: unknown, env: NodeJS.ProcessEnv = process.env): MoiError | undefined {
  if (err instanceof MoiError || !isCallerRejected(err)) return undefined;
  return callerRejected(err, env);
}
