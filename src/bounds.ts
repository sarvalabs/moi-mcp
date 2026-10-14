/**
 * Limits on what comes back from a dapp, and on what a tool hands to a model.
 *
 * Two halves. The readers (readCapped, readWhole) count bytes as a body arrives
 * and stop reading at the cap, so a dapp that streams without end costs the
 * server a bounded amount of memory and a closed socket, not a hung request.
 * The serialisation guard (limitDepth, boundedResult) keeps a body that nests
 * thousands of levels deep from becoming a text block of tens of millions of
 * characters, because pretty-printing indents every level.
 *
 * No MCP imports: this stays usable from src/moi and src/applications/dapp.
 */

import { MoiError } from "./moi-error.js";
import { ErrorCode } from "./schema.js";

/** The most UTF-8 bytes of a dapp's answer handed to a model. */
export const MAX_BODY_BYTES = 64 * 1024;
/** How many levels of nesting a result may have; the typed shapes in schema.ts are all far shallower. */
export const MAX_DEPTH = 20;
/**
 * The cap on a tool's text block. A full 64 KiB text body can be six characters a byte once it is JSON-escaped (a
 * control byte becomes \u0001: 65,536 of them stringify to 393,218 characters), and 8 KiB covers the rest of the
 * result, so a maximum-size legitimate body is never cut in the text block.
 */
export const MAX_TEXT_CHARS = 6 * MAX_BODY_BYTES + 8 * 1024;

const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`);

/** The first `max` characters, never ending on half a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The body as text, read at most `maxBytes` bytes deep. `truncated` is true only when a byte beyond the cap was seen,
 * so a body of exactly maxBytes is whole and one byte more is cut. The stream is cancelled at the cap, which frees the
 * socket. The declared Content-Length is not consulted: a prefix is still wanted here, and a header is never the limit.
 * `what` names the origin for an error, never the body.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
  what: string,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (err) {
      // A hung-up or timed-out stream names the origin, as request() does for a failed connect.
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `Could not read the answer from ${what}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (step.done) break;
    const room = maxBytes - kept;
    if (step.value.byteLength > room) {
      if (room > 0) {
        chunks.push(step.value.subarray(0, room));
        kept += room;
      }
      truncated = true;
      break;
    }
    chunks.push(step.value);
    kept += step.value.byteLength;
  }
  if (truncated) await reader.cancel().catch(() => undefined);
  // stream: true makes the decoder drop a character cut in half instead of writing U+FFFD or half a surrogate pair.
  return { text: new TextDecoder().decode(Buffer.concat(chunks, kept), { stream: truncated }), truncated };
}

/**
 * The whole body, or a LAUNCHPAD_ERROR that names the size. For bodies that are useless or dangerous when cut: a cut
 * JSON document mis-parses, and a cut installer script must never reach a browser. The message never holds any of the
 * body (the setup script carries a private key).
 */
export async function readWhole(res: Response, maxBytes: number, what: string, advice = ""): Promise<string> {
  const tooLarge = () =>
    new MoiError(
      ErrorCode.LAUNCHPAD_ERROR,
      `${what} is too large: it is over ${sizeLabel(maxBytes)}, the most this connector reads.${advice ? ` ${advice}` : ""}`,
      { limitBytes: maxBytes },
    );
  // A declared length over the cap saves reading the cap to find out. A missing or odd header falls through to the
  // streamed count below, which is the real limit.
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const { text, truncated } = await readCapped(res, maxBytes, what);
  if (truncated) throw tooLarge();
  return text;
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * `value` with anything nested more than `maxDepth` levels replaced by a short placeholder string. Only arrays and plain
 * objects are walked; scalars, dates, byte arrays and class instances pass through. The original reference comes back
 * when nothing below it changed, so every shallow typed result is returned identical. The walk never goes more than
 * maxDepth + 1 frames deep, so it cannot overflow the stack, and a cyclic value is cut rather than thrown on.
 */
export function limitDepth(value: unknown, maxDepth = MAX_DEPTH): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, level: number): unknown => {
    if (!Array.isArray(v) && !isPlain(v)) return v;
    if (level > maxDepth) {
      truncated = true;
      return `[omitted: nested more than ${maxDepth} levels deep]`;
    }
    if (Array.isArray(v)) {
      let next: unknown[] | undefined;
      for (let i = 0; i < v.length; i++) {
        const child = walk(v[i], level + 1);
        if (!next && child !== v[i]) next = v.slice(0, i);
        next?.push(child);
      }
      return next ?? v;
    }
    let next: Array<[string, unknown]> | undefined;
    const entries = Object.entries(v);
    for (let i = 0; i < entries.length; i++) {
      const [key, old] = entries[i]!;
      const child = walk(old, level + 1);
      if (!next && child !== old) next = entries.slice(0, i);
      next?.push([key, child]);
    }
    // fromEntries, not out[key] = x: an own "__proto__" key from a parsed hostile body would set the prototype and vanish.
    return next ? Object.fromEntries(next) : v;
  };
  const out = walk(value, 1);
  return { value: out, truncated };
}

/** The text cut to `maxChars` with a note saying so and what to do about it. */
function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = clip(text, maxChars);
  return `${kept}\n[Output cut: ${kept.length} of ${text.length} characters shown. Ask for less: a narrower query, a smaller page, fewer fields.]`;
}

/**
 * The one shape a tool hands back: depth-limited, with a text block that is pretty JSON when that fits, compact JSON
 * when only that fits, and cut with a marker otherwise. `text`, when given, replaces the JSON and is only cut. The
 * structured copy is depth-limited but never width-clipped: clipping typed fields could fail an outputSchema.
 */
export function boundedResult<T extends Record<string, unknown>>(value: T, text?: string, maxChars = MAX_TEXT_CHARS) {
  const safe = limitDepth(value).value as T;
  let shown: string;
  if (text !== undefined) {
    shown = fit(text, maxChars);
  } else {
    // Compact first: at 20 levels the pretty form can be about 21 times larger than the compact one.
    const compact = JSON.stringify(safe);
    if (compact.length > maxChars) {
      shown = fit(compact, maxChars);
    } else {
      const pretty = JSON.stringify(safe, null, 2);
      shown = pretty.length <= maxChars ? pretty : compact;
    }
  }
  return { content: [{ type: "text" as const, text: shown }], structuredContent: safe };
}
