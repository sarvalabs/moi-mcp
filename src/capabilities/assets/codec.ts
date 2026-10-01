/**
 * Arguments in, results out, for one asset routine.
 *
 * The SDK's ManifestCoder validates nothing: a malformed identifier, an undefined, a negative amount, a fraction all
 * encode, to garbage or to a value the person never meant. So the validation is here, and it has two layers. coerceArgs
 * checks every value against the type the manifest declares and turns it into one canonical JavaScript value. Then
 * encodeCalldata encodes, decodes what it just encoded, and compares it with the values that were validated. That
 * second layer is what catches what a type check cannot see, for example a string that is "0x" plus hex digits, which
 * the coder silently turns into the bytes without the prefix.
 *
 * Sign and size are checked up front and not left to the round trip: a negative u256 encodes and decodes back to the
 * same negative number, and the coder's own message for 2^64 ("byte array longer than desired length") tells a model
 * nothing.
 *
 * This file knows no standard and no routine name. It imports nothing from src/tools, src/wc or the journal.
 */

import { bytesToHex, type ManifestCoder } from "js-moi-sdk";

import { clip } from "../../bounds.js";
import { clampChainText } from "../../moi/reads.js";
import { MoiError } from "../../moi-error.js";
import { ErrorCode } from "../../schema.js";

/** One input or output of a routine, as the manifest lists it. */
export interface Field {
  slot: number;
  label: string;
  type: string;
}

/** POLO integers carry 64 bits: 2^64 - 1 encodes and 2^64 fails inside the SDK's writer (measured). */
export const MAX_POLO_INTEGER = 2n ** 64n - 1n;
/** Array elements and map entries accepted in an argument. */
export const MAX_ENTRIES = 256;
/** Characters in a string argument. */
export const MAX_TEXT = 4096;
/** Hex characters in a bytes argument. */
export const MAX_BYTES_HEX = 16384;
/** Array elements and map entries handed back in a result. */
export const MAX_OUT_ENTRIES = 100;
/** Characters in a string or hex result. */
export const MAX_OUT_TEXT = 1024;

/** A validated argument: the one canonical value each type is reduced to before it is encoded. */
export type Coerced = bigint | string | boolean | Coerced[] | Map<string, Coerced>;

export type TypeNode =
  | { kind: "int"; signed: boolean }
  | { kind: "identifier" }
  | { kind: "bytes" }
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "array"; of: TypeNode }
  | { kind: "map"; of: TypeNode }; // map keys are strings only

/**
 * The shape of a manifest type string, or undefined for any type this server does not encode. Hand-written rather than
 * built on Schema.extractArrayDataType and extractMapDataType, which throw a plain Error for odd types (isMap is just
 * startsWith("map")). Every type accepted here is one the SDK's Schema.parseDataType also accepts.
 */
export function parseType(type: string): TypeNode | undefined {
  if (typeof type !== "string" || type.length > 200) return undefined;
  switch (type) {
    case "identifier":
    case "bytes":
    case "string":
    case "bool":
      return { kind: type };
    case "u64":
    case "u256":
      return { kind: "int", signed: false };
    case "i64":
    case "i256":
    case "bigint":
      return { kind: "int", signed: true };
  }
  if (type.startsWith("[]")) {
    const of = parseType(type.slice(2));
    return of ? { kind: "array", of } : undefined;
  }
  if (type.startsWith("map[string]")) {
    const of = parseType(type.slice("map[string]".length));
    return of ? { kind: "map", of } : undefined;
  }
  return undefined;
}

/** "beneficiary (identifier), amount (u256)", or "no inputs". */
export function acceptsLine(accepts: readonly Field[]): string {
  return accepts.length === 0 ? "no inputs" : accepts.map((f) => `${f.label} (${f.type})`).join(", ");
}

function refuse(message: string): MoiError {
  return new MoiError(ErrorCode.INVALID_ARGS, `${message} Nothing was sent to your wallet.`);
}

/** A value as it appears in a message: JSON, cut short. */
function shown(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  return clip(text ?? String(value), 40);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const ID_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL_RE = /^-?\d+$/;

function coerceInt(signed: boolean, value: unknown, path: string, decimals: number): bigint {
  let n: bigint | undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && DECIMAL_RE.test(value)) n = BigInt(value);
  if (n === undefined) {
    const scale =
      decimals > 0
        ? ` This asset has ${decimals} decimals, so one whole token is 10^${decimals} base units; the preview shows both.`
        : "";
    const unsafe =
      typeof value === "number" && Number.isInteger(value)
        ? " Numbers above 9007199254740991 lose precision in JSON: send the value as a decimal string."
        : "";
    throw refuse(
      `Input "${path}" must be a whole number in base units (a number or a decimal string), got ${shown(value)}.${scale}${unsafe}`,
    );
  }
  if (!signed && n < 0n) throw refuse(`Input "${path}" cannot be negative.`);
  if ((n < 0n ? -n : n) > MAX_POLO_INTEGER) {
    throw refuse(
      `Input "${path}" is too large: this server encodes integers up to 18446744073709551615 (64 bits), the most the wire encoding carries.`,
    );
  }
  return n;
}

function coerceValue(node: TypeNode, value: unknown, path: string, decimals: number): Coerced {
  switch (node.kind) {
    case "int":
      return coerceInt(node.signed, value, path, decimals);
    case "identifier":
      if (typeof value !== "string" || !ID_RE.test(value)) {
        throw refuse(`Input "${path}" must be a MOI identifier: 0x followed by 64 hex characters.`);
      }
      return value;
    case "bytes":
      if (typeof value !== "string" || !BYTES_RE.test(value) || value.length - 2 > MAX_BYTES_HEX) {
        throw refuse(
          `Input "${path}" must be bytes: 0x followed by an even number of hex characters (at most ${MAX_BYTES_HEX}).`,
        );
      }
      return value;
    case "string":
      // No special case for a leading 0x: the round trip in encodeCalldata refuses a string the coder would trim.
      if (typeof value !== "string" || value.length > MAX_TEXT) {
        throw refuse(`Input "${path}" must be text of at most ${MAX_TEXT} characters.`);
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") throw refuse(`Input "${path}" must be true or false.`);
      return value;
    case "array": {
      if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
        throw refuse(`Input "${path}" must be a list of at most ${MAX_ENTRIES} entries.`);
      }
      return value.map((v, i) => coerceValue(node.of, v, `${path}[${i}]`, decimals));
    }
    case "map": {
      if (!isPlainObject(value) || Object.keys(value).length > MAX_ENTRIES) {
        throw refuse(`Input "${path}" must be an object with at most ${MAX_ENTRIES} entries.`);
      }
      const out = new Map<string, Coerced>();
      for (const [k, v] of Object.entries(value)) {
        out.set(k, coerceValue(node.of, v, `${path}.${clampChainText(k, 40)}`, decimals));
      }
      return out;
    }
  }
}

/**
 * The caller's inputs, validated against the manifest's input list and reduced to canonical values by label. A Map, so
 * a label named __proto__ or constructor is just a key. An input the routine does not list is refused (this is what
 * turns an amount passed to a MAS1 routine into an error), and so is a missing one.
 */
export function coerceArgs(
  routine: string,
  accepts: readonly Field[],
  raw: Record<string, unknown>,
  asset: { decimals: number },
): Map<string, Coerced> {
  const labels = new Set(accepts.map((f) => f.label));
  for (const key of Object.keys(raw)) {
    if (!labels.has(key)) {
      throw refuse(`${routine} has no input "${clampChainText(key, 40)}". It takes: ${acceptsLine(accepts)}.`);
    }
  }
  // Own properties only, so a label named __proto__ is not found on the prototype.
  for (const f of accepts) {
    if (!Object.hasOwn(raw, f.label) || raw[f.label] === undefined) {
      throw refuse(`Missing input "${f.label}" (${f.type}) for ${routine}. ${routine} takes: ${acceptsLine(accepts)}.`);
    }
  }
  const out = new Map<string, Coerced>();
  for (const f of accepts) {
    const node = parseType(f.type);
    if (!node) throw refuse(`Input "${f.label}" has type ${f.type}, which this server cannot encode yet.`);
    out.set(f.label, coerceValue(node, raw[f.label], f.label, asset.decimals));
  }
  return out;
}

const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * What the coder takes. POLO writes a JavaScript number compactly and a bigint full-width, so 5 and 5n are different
 * bytes. The SDK's own asset classes pass a number wherever it fits, and so do buildTransfer and buildMint; matching
 * that is what keeps this path byte-identical to them.
 */
function toCoder(value: Coerced | undefined): unknown {
  if (typeof value === "bigint") return value >= SAFE_MIN && value <= SAFE_MAX ? Number(value) : value;
  if (Array.isArray(value)) return value.map(toCoder);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, toCoder(v)]));
  return value;
}

/** A value for a message or a preview, as JSON-ready data: bigint as a decimal string, bytes as hex, Map keys sorted. */
function display(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${bytesToHex(value)}`;
  if (Array.isArray(value)) return value.map(display);
  if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => [String(k), display(v)] as [string, unknown]);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // fromEntries, not assignment: an own "__proto__" key would otherwise set the prototype and vanish.
    return Object.fromEntries(entries);
  }
  return value;
}

/** A validated argument as JSON-ready data. The same call in another key order gives the same text. */
export function showValue(value: Coerced): unknown {
  return display(value);
}

function same(node: TypeNode, given: Coerced | undefined, got: unknown): boolean {
  switch (node.kind) {
    case "int":
      if (typeof given !== "bigint") return false;
      try {
        return (typeof got === "number" || typeof got === "bigint") && BigInt(got) === given;
      } catch {
        return false;
      }
    case "identifier":
    case "bytes":
      return typeof given === "string" && got instanceof Uint8Array && `0x${bytesToHex(got)}` === given.toLowerCase();
    case "string":
    case "bool":
      return got === given;
    case "array":
      return (
        Array.isArray(given) &&
        Array.isArray(got) &&
        given.length === got.length &&
        given.every((g, i) => same(node.of, g, got[i]))
      );
    case "map":
      return (
        given instanceof Map &&
        got instanceof Map &&
        given.size === got.size &&
        [...given].every(([k, v]) => got.has(k) && same(node.of, v, got.get(k)))
      );
  }
}

/**
 * The calldata for a routine, hex without a 0x prefix, or undefined for a routine that takes no inputs (the SDK leaves
 * calldata out for those, and the node refuses an empty one). Encodes, decodes the result and compares it with the
 * validated values; any difference refuses the call, so what the person approved is what reaches the chain.
 */
export function encodeCalldata(
  coder: ManifestCoder,
  routine: string,
  accepts: readonly Field[],
  coerced: ReadonlyMap<string, Coerced>,
): string | undefined {
  if (accepts.length === 0) return undefined;
  // The coder indexes its arguments by slot, not by position.
  const args: unknown[] = [];
  for (const f of accepts) args[f.slot] = toCoder(coerced.get(f.label));

  let calldata: string;
  let decoded: unknown;
  try {
    calldata = coder.encodeArguments(routine, ...args);
    decoded = coder.decodeArguments(routine, calldata);
  } catch (err) {
    throw refuse(
      `Could not encode the inputs of ${routine}: ${clampChainText(err instanceof Error ? err.message : String(err), 160)}.`,
    );
  }

  // Fail closed: anything but one decoded value per input is a mismatch.
  if (!Array.isArray(decoded) || decoded.length !== accepts.length) {
    throw refuse(`The encoded call for ${routine} does not decode back to its inputs, so it is not sent.`);
  }
  accepts.forEach((f, i) => {
    const node = parseType(f.type);
    const given = coerced.get(f.label);
    if (!node || !same(node, given, decoded[i])) {
      throw refuse(
        `Input "${f.label}" would not reach the chain as given: you gave ${clip(JSON.stringify(display(given)) ?? "undefined", 80)} ` +
          `but the encoded call carries ${clip(JSON.stringify(display(decoded[i])) ?? "undefined", 80)}.`,
      );
    }
  });
  return calldata.replace(/^0x/, "");
}

/**
 * A routine's decoded outputs, shaped by the type the manifest declares and bounded in width: integers as decimal
 * strings, bytes as hex, text clamped (it comes from a contract, so it is data and not an instruction), lists and maps
 * cut. `truncated` says something was cut. Never throws for a shape decodeOutput produces.
 */
export function shapeOutputs(
  returns: readonly Field[],
  decoded: unknown,
): { outputs: Record<string, unknown>; truncated: boolean } {
  let truncated = false;

  const text = (raw: string, max: number): string => {
    const clamped = clampChainText(raw, max);
    if (raw.length > max && clamped.length > max) truncated = true;
    return clamped;
  };

  const shape = (node: TypeNode, v: unknown): unknown => {
    switch (node.kind) {
      case "int":
        try {
          return typeof v === "number" || typeof v === "bigint" ? BigInt(v).toString() : text(String(v), MAX_OUT_TEXT);
        } catch {
          return text(String(v), MAX_OUT_TEXT);
        }
      case "identifier":
      case "bytes": {
        const hex = v instanceof Uint8Array ? `0x${bytesToHex(v)}` : String(v);
        if (hex.length > MAX_OUT_TEXT) truncated = true;
        return clip(hex, MAX_OUT_TEXT);
      }
      case "string":
        return text(String(v), MAX_OUT_TEXT);
      case "bool":
        return typeof v === "boolean" ? v : text(String(v), MAX_OUT_TEXT);
      case "array": {
        if (!Array.isArray(v)) return text(String(v), MAX_OUT_TEXT);
        if (v.length > MAX_OUT_ENTRIES) truncated = true;
        return v.slice(0, MAX_OUT_ENTRIES).map((e) => shape(node.of, e));
      }
      case "map": {
        if (!(v instanceof Map)) return text(String(v), MAX_OUT_TEXT);
        if (v.size > MAX_OUT_ENTRIES) truncated = true;
        const entries = [...v].slice(0, MAX_OUT_ENTRIES).map(([k, e]) => [clampChainText(k, 64), shape(node.of, e)] as [string, unknown]);
        return Object.fromEntries(entries);
      }
    }
  };

  const entries: Array<[string, unknown]> = [];
  if (decoded !== null && typeof decoded === "object") {
    for (const f of returns) {
      const node = parseType(f.type);
      if (!node || !Object.hasOwn(decoded, f.label)) continue;
      entries.push([f.label, shape(node, (decoded as Record<string, unknown>)[f.label])]);
    }
  }
  return { outputs: Object.fromEntries(entries), truncated };
}
