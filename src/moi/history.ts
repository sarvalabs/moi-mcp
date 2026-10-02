/**
 * Recent history of one account, read a height at a time.
 *
 * No node method lists an account's interactions. A tesseract belongs to one account, though, and moi.Tesseract takes an
 * account and a height and returns the interactions at that height, so the newest heights can be read by starting at the
 * account's latest height (moi.AccountMetaInfo) and going down one at a time. Devnet answers this way: heights 39 and 38 of
 * one account each returned their interaction. Each height costs one node call, so the walk is capped, and the answer says
 * how far it went. Anything older, or in bulk, needs an indexer, which does not exist yet.
 *
 * No MCP imports and no config, like the rest of src/moi: the tool layer passes the explorer link builder in.
 */

import { ErrorCode as SdkErrorCode, type JsonRpcProvider } from "js-moi-sdk";
import { z } from "zod";

import { clip } from "../bounds.js";
import { asRpcError, MoiError } from "../moi-error.js";
import { ErrorCode, GetHistoryOutput, HISTORY_DEFAULT_HEIGHTS, HISTORY_MAX_HEIGHTS } from "../schema.js";
import { clampChainText, invalidId, opTypeName, toBigInt, withTimeout } from "./reads.js";

type Provider = JsonRpcProvider;
export type History = z.infer<typeof GetHistoryOutput>;
type HeightEntry = History["heights"][number];

/** The most interactions shown for one height. The height's interactionCount says how many the node listed. */
export const MAX_IXNS_PER_HEIGHT = 10;
/** The most operation types shown for one interaction. Its operationCount says how many it has. */
export const MAX_OPS_PER_IX = 8;
/** How long one whole read may take, the call for the latest height included. */
export const HISTORY_TIMEOUT_MS = 20_000;

/** How the node says it has no such account. Devnet words it "failed to fetch acc meta info: account not found". */
const NO_SUCH_ACCOUNT = /account not found/i;

/** An interaction hash worth showing and linking: 0x and hex, bounded. */
const HASH = /^0x[0-9a-fA-F]{1,128}$/;

/** What an error message may say of the node's own words: the node-method tools cut it at the same length. */
const MAX_ERROR_CHARS = 300;

export interface HistoryOptions {
  /** How many heights to read at most; clamped to 1..HISTORY_MAX_HEIGHTS, and HISTORY_DEFAULT_HEIGHTS when absent. */
  limit?: number | undefined;
  /** The explorer page for an interaction hash. */
  explorerUrl: (hash: string) => string;
  /** The longest the whole read may take, in milliseconds. Defaults to HISTORY_TIMEOUT_MS; only tests change it. */
  timeoutMs?: number;
}

/**
 * A failed node call as the error to throw. A request that never reached the node says where the node is in the SDK's own
 * message, and this runs on a public gateway, so that case only says the node could not be reached; any other message is cut,
 * as nodeFailure in src/capabilities/reads/rpc-tools.ts does (this file cannot import it: that file imports the read tools).
 */
function failure(err: unknown, context: string): MoiError {
  if (err instanceof MoiError) return err;
  if ((err as { code?: unknown } | null)?.code === SdkErrorCode.NETWORK_ERROR) {
    return new MoiError(ErrorCode.RPC_ERROR, `${context}: the node could not be reached.`);
  }
  return asRpcError(clip(err instanceof Error ? err.message : String(err), MAX_ERROR_CHARS), context);
}

/** A node quantity (hex string, decimal string, number or bigint) as a decimal string, or undefined when it is none of those. */
function quantity(raw: unknown): string | undefined {
  if (typeof raw === "bigint") return raw >= 0n ? raw.toString() : undefined;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : undefined;
  if (typeof raw === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(raw.trim())) return toBigInt(raw).toString();
  return undefined;
}

function heightOf(raw: unknown): number | undefined {
  const text = quantity(raw);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

function unknownAccount(address: string): History {
  return {
    address,
    isRegistered: false,
    heights: [],
    olderHeightsExist: false,
    truncated: false,
    note: "The node has no account with this id, so there is no history to read.",
  };
}

/**
 * An operation's type as a name. A numeric type goes through opTypeName, as in moi_get_interaction. Text that is not numeric is
 * a name the node already gave, and is kept: opTypeName reads any text as the number 0 and would answer INVALID_IX for it. A
 * number that is not finite (JSON.parse reads 1e400 as Infinity) names nothing and would make BigInt throw, so it reads as
 * unknown, like an absent type.
 */
function operationType(op: Record<string, unknown>): string {
  const raw = op["type"] ?? op["tx_type"];
  if (typeof raw === "number" && !Number.isFinite(raw)) return "unknown";
  const named = typeof raw === "string" && raw.trim() !== "" && !/^(0x[0-9a-fA-F]+|\d+)$/.test(raw.trim());
  return clampChainText(named ? raw : opTypeName(raw), 40);
}

/** One height of the walk, from the tesseract the node returned for it. */
function readHeight(
  tesseract: Record<string, unknown>,
  height: number,
  explorerUrl: (hash: string) => string,
): { entry: HeightEntry; truncated: boolean } {
  const listed: unknown[] = Array.isArray(tesseract["ixns"]) ? (tesseract["ixns"] as unknown[]) : [];
  let truncated = listed.length > MAX_IXNS_PER_HEIGHT;
  const interactions: HeightEntry["interactions"] = [];
  for (const item of listed.slice(0, MAX_IXNS_PER_HEIGHT)) {
    const ix = (item ?? {}) as Record<string, unknown>;
    const hash = ix["hash"];
    // Not shown, and still counted in interactionCount: a hash that is not hex cannot be linked.
    if (typeof hash !== "string" || !HASH.test(hash)) continue;
    const rawOps = ix["ix_operations"] ?? ix["operations"];
    const ops: unknown[] = Array.isArray(rawOps) ? (rawOps as unknown[]) : [];
    if (ops.length > MAX_OPS_PER_IX) truncated = true;
    interactions.push({
      hash,
      operationTypes: ops.slice(0, MAX_OPS_PER_IX).map((op) => operationType((op ?? {}) as Record<string, unknown>)),
      operationCount: ops.length,
      explorerUrl: explorerUrl(hash),
    });
  }
  const timeStamp = quantity(tesseract["time_stamp"]);
  return {
    entry: {
      height,
      ...(timeStamp !== undefined ? { timeStamp } : {}),
      interactionCount: listed.length,
      interactions,
    },
    truncated,
  };
}

/** The sentences of `note`: what was read, why it stopped if it stopped early, what was not read, and why. */
function describeWalk(walk: {
  latest: number;
  oldest: number;
  count: number;
  /** The highest height not read, or -1 when the walk reached height 0. */
  next: number;
  stopped: string | undefined;
  truncated: boolean;
}): string {
  const span = walk.count === 1 ? `height ${walk.latest}` : `heights ${walk.latest} down to ${walk.oldest}`;
  const parts = [`Read ${span} of this account, newest first, with one node call for each height.`];
  if (walk.stopped) parts.push(`The walk stopped early because ${walk.stopped}.`);
  if (walk.next >= 0) {
    parts.push(
      `${walk.next === 0 ? "Height 0 exists and was" : `Heights 0 to ${walk.next} exist and were`} not read. ` +
        "This tool walks one height per call and reads only recent history; older or bulk history is not available until an indexer exists.",
    );
  } else {
    parts.push("There is nothing older.");
  }
  if (walk.truncated) parts.push("Some lists were cut: interactionCount and operationCount give the full numbers.");
  return parts.join(" ");
}

/**
 * The newest heights of an account, newest first. Throws INVALID_ARGS for an id the node refuses, and RPC_ERROR or
 * REQUEST_TIMEOUT when the node will not give the latest height or the first height; an account the node does not have is an
 * answer, not an error.
 */
export async function getHistory(provider: Provider, address: string, options: HistoryOptions): Promise<History> {
  const asked = options.limit;
  const limit =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), HISTORY_MAX_HEIGHTS)
      : HISTORY_DEFAULT_HEIGHTS;
  // One deadline for the whole read, and each node call is raced against what is left of it, so a call that never answers
  // ends the read too, which a check between calls could not do.
  const deadline = Date.now() + (options.timeoutMs ?? HISTORY_TIMEOUT_MS);
  const within = <T>(work: Promise<T>, what: string): Promise<T> => withTimeout(work, Math.max(deadline - Date.now(), 1), what);

  let meta: Record<string, unknown>;
  try {
    meta = (await within(provider.getAccountMetaInfo(address), `moi.AccountMetaInfo(${address})`)) as unknown as Record<string, unknown>;
  } catch (err) {
    // A request that did not get an answer from the node, or ran out of time, says nothing about the id the caller gave. The SDK
    // words a node that answers 200 with a body that is not JSON as "invalid json response body at <node url>", which the test
    // for an invalid id below would take for a refused id, tell the caller their id is wrong, and print where the node is.
    if (err instanceof MoiError || (err as { code?: unknown } | null)?.code === SdkErrorCode.NETWORK_ERROR) {
      throw failure(err, `moi.AccountMetaInfo(${address})`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    // The node's words are cut here as everywhere else in this file.
    if (/identifier|invalid/i.test(detail)) throw invalidId("participant", address, new Error(clip(detail, MAX_ERROR_CHARS)));
    if (NO_SUCH_ACCOUNT.test(detail)) return unknownAccount(address);
    throw failure(err, `moi.AccountMetaInfo(${address})`);
  }
  // state_exists is the flag getAccount reads, so isRegistered means the same in both tools.
  if (meta?.["state_exists"] === false) return unknownAccount(address);
  const latest = heightOf(meta?.["height"]);
  if (latest === undefined) {
    throw new MoiError(ErrorCode.RPC_ERROR, `moi.AccountMetaInfo(${address}): the node did not report the account's latest height.`);
  }

  const heights: HeightEntry[] = [];
  let truncated = false;
  let stopped: string | undefined;
  let above: string | undefined;
  // `next` is the height about to be read; after the loop it is the highest height not read, or -1 when height 0 was read.
  let next = latest;
  for (; next >= 0 && heights.length < limit; next--) {
    const what = `moi.Tesseract(${address}, height ${next})`;
    let tesseract: Record<string, unknown>;
    try {
      tesseract = (await within(provider.getTesseract(address, true, false, { tesseract_number: next }), what)) as unknown as Record<
        string,
        unknown
      >;
    } catch (err) {
      // Nothing read yet: the node is not answering at all, and an empty answer would hide that.
      if (heights.length === 0) throw failure(err, what);
      stopped = `the node did not return the tesseract at height ${next}`;
      break;
    }
    // Two heights of one account are two tesseracts. The same hash twice means the node ignored the height it was asked for,
    // and an entry labelled with a height it did not come from would be wrong, so the walk stops here.
    const hash = typeof tesseract?.["hash"] === "string" ? tesseract["hash"] : undefined;
    if (hash !== undefined && hash === above) {
      stopped = `the node returned the same tesseract at height ${next} as at the height above it`;
      break;
    }
    above = hash;
    const read = readHeight(tesseract, next, options.explorerUrl);
    if (read.truncated) truncated = true;
    heights.push(read.entry);
  }

  const oldest = heights[heights.length - 1]?.height;
  return {
    address,
    isRegistered: true,
    latestHeight: latest,
    ...(oldest !== undefined ? { oldestHeightRead: oldest } : {}),
    heights,
    olderHeightsExist: next >= 0,
    truncated,
    note: describeWalk({ latest, oldest: oldest ?? latest, count: heights.length, next, stopped, truncated }),
  };
}
