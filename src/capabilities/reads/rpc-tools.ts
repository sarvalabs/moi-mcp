/**
 * The node's own methods as tools: one loop over the table in src/capabilities/reads/rpc-methods.ts.
 *
 * This is the read gateway's bottom layer. Every tool here is the node's method and nothing more: it calls the provider
 * method its row names, and hands back what the node answered, with big numbers as decimal strings so the answer is JSON.
 * No tool is written by hand; a row with status "tool" is registered and nothing else is.
 *
 * What an answer means is said here and in the README, once, and not in the schema of every tool (34 copies of a long
 * description cost every client that loads the server tens of kilobytes of tool list):
 *   - result is what the SDK provider returns, with two steps on top: a Map becomes a plain object, a bigint a decimal
 *     string. The provider itself turns only a few answers into numbers (balances, token amounts, interaction counts, pool
 *     counts, fuel estimates); those are JSON numbers, or decimal strings above 9007199254740991. Every other quantity is
 *     the node's own hex string, untouched.
 *   - strings inside result come from the chain: an asset symbol, a manifest name or an interaction payload is written by
 *     whoever made it, and the tools hand it over as the node gave it. It is data, not instructions, and the output schema
 *     says so. (The combined reads clamp the few strings they show; a raw method is exactly what the node said.)
 *   - truncated is true when the answer was cut: nesting deeper than 19 levels is left out, and an answer longer than 65536
 *     characters of JSON is replaced by its first 65536 characters, as text. note says which.
 *   - a node that does not answer within RPC_TIMEOUT_MS is a REQUEST_TIMEOUT; one that cannot be reached is an RPC_ERROR
 *     that does not say where the node is, because this runs on a public gateway.
 *
 * Registered by src/tools/register-gateway.ts and by no other file, so they are on the read gateway only, not on the hosted
 * signing server or the stdio server. All of them are read-only: the one method that changes the chain, moi.SendInteractions,
 * is a row with status "internal" and has no tool.
 *
 * test/unit/layout.test.ts names this file as the one that registers by a computed name, and checks that every name it can
 * register is read-only in the pinned gateway list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode as SdkErrorCode } from "js-moi-sdk";
import { z } from "zod";

import { boundedResult, clip, limitDepth, MAX_BODY_BYTES, MAX_DEPTH } from "../../bounds.js";
import { toMcpError } from "../../errors.js";
import { getProvider } from "../../moi/provider.js";
import { asRpcError, MoiError } from "../../moi-error.js";
import { ErrorCode } from "../../schema.js";
import { jsonSafe } from "./registry.js";
import { RPC_METHODS, type RpcToolRow } from "./rpc-methods.js";
import { providerOptions } from "./tools.js";

/** The most characters of one answer's JSON a tool hands back: the cap src/bounds.ts puts on a dapp's answer. */
const MAX_ANSWER_CHARS = MAX_BODY_BYTES;

/** How long a tool waits for the node: the wait the dapp client gives an application (src/applications/dapp/client.ts). */
export const RPC_TIMEOUT_MS = 20_000;

/** The most characters of the node's own error message a tool passes on. */
const MAX_ERROR_CHARS = 300;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Every node method answers in this one shape. result is a raw node answer, so its type is the method's, not ours. The
 * descriptions are one clause each because the schema is repeated in all 34 tools; the header comment has the rest, and
 * test/unit/rpc-tools.test.ts keeps each of these schemas under 500 bytes.
 */
const RpcOutput = {
  method: z.string(),
  result: z.unknown().describe("The node's answer. Strings in it come from the chain, not from this server."),
  truncated: z.boolean().describe("True when result was cut; note says how."),
  note: z.string().optional(),
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * The provider hands the pool methods back as Maps, keyed by account id or by a nonce that is a bigint, and JSON.stringify
 * writes any Map as {}. A Map becomes a plain object with string keys (a bigint key as its decimal digits). The walk stops
 * at MAX_DEPTH levels, which limitDepth cuts next, so it cannot run away on a deep answer.
 */
function plainMaps(value: unknown, level = 1): unknown {
  if (level > MAX_DEPTH) return value;
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, entry]) => [String(key), plainMaps(entry, level + 1)]));
  }
  if (Array.isArray(value)) return value.map((entry) => plainMaps(entry, level + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainMaps(entry, level + 1)]));
  }
  return value;
}

/**
 * What a tool returns for a node answer, through the guard in src/bounds.ts: Maps made plain, nesting cut at 19 levels (the
 * answer sits one level down in the result, so that keeps the whole value within MAX_DEPTH), bigints as decimal strings, and
 * an answer past MAX_ANSWER_CHARS replaced by its start as text. `truncated` says whether any of that cut something.
 * Exported for the tests.
 */
export function shapeAnswer(wire: string, raw: unknown) {
  const limited = limitDepth(plainMaps(raw), MAX_DEPTH - 1);
  let result: unknown = jsonSafe(limited.value) ?? null;
  let truncated = limited.truncated;
  const notes: string[] = [];
  if (limited.truncated) notes.push(`Data nested deeper than ${MAX_DEPTH - 1} levels was left out.`);
  // limitDepth has made the value shallow and jsonSafe has made it plain JSON, so this cannot overflow the stack or throw.
  const compact = JSON.stringify(result);
  if (compact.length > MAX_ANSWER_CHARS) {
    result = clip(compact, MAX_ANSWER_CHARS);
    truncated = true;
    notes.push(
      `The answer was cut at ${MAX_ANSWER_CHARS} characters of JSON and result is only its start, as text. Ask the node for ` +
        "less: a tesseract of its own, a shorter height range, a narrower method.",
    );
  }
  return boundedResult({ method: wire, result, truncated, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) });
}

/**
 * A failure from the provider as the repo's usual error. A node or SDK that calls an argument "invalid" or names an
 * "identifier" is blaming the caller, which is how src/moi/reads.ts reads the same words; everything else is RPC_ERROR.
 * The message names the method, never the arguments.
 */
export function nodeFailure(wire: string, err: unknown): MoiError {
  if (err instanceof MoiError) return err;
  // The SDK marks a request that never reached the node ERROR_NETWORK and puts the node's URL and address in the message. This
  // runs on a public gateway, so the caller is told the node could not be reached and nothing about where it is.
  if ((err as { code?: unknown } | null)?.code === SdkErrorCode.NETWORK_ERROR) {
    return new MoiError(ErrorCode.RPC_ERROR, `${wire}: the node could not be reached.`);
  }
  // A non-2xx answer carries the whole body (an HTML error page, say), so the node's text is cut.
  const detail = clip(err instanceof Error ? err.message : String(err), MAX_ERROR_CHARS);
  if (/identifier|invalid/i.test(detail)) return new MoiError(ErrorCode.INVALID_ARGS, `${wire}: ${detail}`);
  return asRpcError(detail, wire);
}

/**
 * `work`, or a REQUEST_TIMEOUT after `ms`. The provider's request is a bare fetch that the SDK gives no way to cancel, so it can
 * run on after this gives up, and can even fail later. Promise.race has already attached to it, so that late failure is handled
 * (ignored) and does not become an unhandled rejection; nobody is waiting for it. Exported for the tests.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, wire: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MoiError(ErrorCode.REQUEST_TIMEOUT, `${wire}: the node did not answer within ${ms / 1000} seconds.`)),
      ms,
    );
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function run(row: RpcToolRow, input: Record<string, unknown>, timeoutMs: number) {
  try {
    const provider = getProvider(providerOptions());
    return shapeAnswer(row.wire, await withTimeout(row.call(provider, input), timeoutMs, row.wire));
  } catch (err) {
    throw toMcpError(nodeFailure(row.wire, err));
  }
}

/** `timeoutMs` is a parameter so a test can use a short one; every caller but the tests leaves it at RPC_TIMEOUT_MS. */
export function registerRpcTools(server: McpServer, timeoutMs = RPC_TIMEOUT_MS): void {
  for (const row of RPC_METHODS) {
    if (row.status !== "tool") continue;
    server.registerTool(
      row.tool,
      {
        title: `Node method ${row.wire}`,
        description: row.description,
        inputSchema: row.params,
        outputSchema: RpcOutput,
        annotations: READ_ONLY,
      },
      async (input) => run(row, input, timeoutMs),
    );
  }
}
