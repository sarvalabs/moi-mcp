/**
 * Read a compiled manifest for deployment: check it, encode it to POLO, read it back, and say what it holds.
 *
 * moi_deploy_logic (src/capabilities/logics/deploy.ts) takes a logic's manifest, and moi_create_asset (standard MASX,
 * src/capabilities/assets/create-masx.ts) takes an asset's, each as the JSON object `coco compile` writes. The
 * encoder it is sent with, the SDK's ManifestCoder, validates almost nothing (a manifest with no syntax, engine or kind
 * encodes), so the checks are here. Then the encoded bytes are decoded again and everything the preview says, the routine
 * count, the routine names, the deploy routines and their inputs, is read from the decoded copy: what the chain will
 * receive, not what the caller's JSON claims. Nothing else of the file reaches the person or the model: a `name` key, for
 * one, is dropped by the encoder (a logic has no name on chain) and is never read.
 *
 * A routine name is shown to the person, so every callable must have a plain identifier for a name and no two may share
 * one: the SDK's LogicFactory.deploy takes the first deploy routine with a name while the coder encodes against the last,
 * so with a repeated name the preview could describe one routine while the chain runs the other. The compiler cannot write
 * either, so a manifest that has them was not compiled.
 *
 * This file also holds the pieces of planning a deploy that a MASX create shares with a logic deploy, so that neither has to
 * import the other: choosing the deploy routine, encoding its inputs, and the preview line that describes the manifest.
 * They take the words that differ between a logic and an asset (when the routine runs, what the manifest has no name for)
 * as parameters, and their defaults are the logic's, so moi_deploy_logic says what it always said.
 *
 * Pure: no node, no wallet. Imports nothing from src/tools, src/wc or the journal.
 */

import { createHash } from "node:crypto";

import { ManifestCoder, ManifestCoderFormat } from "js-moi-sdk";

import { MoiError } from "../../moi-error.js";
import { clampChainText } from "../../moi/reads.js";
import { ErrorCode } from "../../schema.js";
import { coerceArgs, encodeCalldata, showValue, type Field } from "../assets/codec.js";
import { PREVIEW_ARGS_CHARS } from "../assets/invoke.js";
import { MAX_FIELDS, NAME_RE, usableFields } from "../assets/routines.js";
import { invalid, shorten } from "../assets/standards/common.js";

/**
 * Characters of JSON in the manifest the tool accepts. Checked before anything is encoded, so a huge object never reaches
 * the encoder. The real compiled manifests found (flipper, lock-ledger, tokenledger, the agent market) are 1.5 to 4.4 KB.
 */
export const MAX_MANIFEST_JSON_CHARS = 131_072;
/**
 * Bytes of POLO the manifest may encode to: 32 KiB, against 0.5 to 2.8 KB for the real ones found. The whole manifest
 * goes to the phone as hex inside JSON through the WalletConnect relay, and the model has to send it again, identical,
 * on the confirm call, so the cap is set near what real manifests need and not near the node's own limit (an
 * interaction over 128 KB). Whether the relay or the wallet takes a payload near it is not known: a person's first
 * deploy measures that.
 */
export const MAX_MANIFEST_BYTES = 32_768;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface DeployRoutine {
  name: string;
  /** The inputs in the shape the asset codec takes, or undefined when this server cannot read them (too many, or a label or type that is not plain). */
  accepts: readonly Field[] | undefined;
}

export interface DeployManifest {
  /** What the LOGIC_DEPLOY payload carries: 0x and the POLO hex of the manifest. */
  hex: string;
  bytes: number;
  /** SHA-256 of those bytes, in hex: what a person can compare with the manifest bytes in the interaction or on chain. */
  digest: string;
  /** Built from the decoded manifest, so calldata is encoded against what the chain will hold. */
  coder: ManifestCoder;
  counts: { total: number; deploy: number; invoke: number; enlist: number; internal: number; other: number };
  /** Names of the routines callable from outside (not the internal ones), in manifest order. All plain identifiers. */
  names: string[];
  /** The manifest's deploy routines, in manifest order. A Map, so a routine named "constructor" is just a key. */
  deploys: ReadonlyMap<string, DeployRoutine>;
}

function reason(err: unknown): string {
  return clampChainText(err instanceof Error ? err.message : String(err), 160);
}

/**
 * Check, encode and read back a manifest. Pure: no node, no wallet. Throws only INVALID_ARGS refusals that say what is
 * wrong and end "Nothing was sent to your wallet."
 *
 * `expected` is the kind the caller needs: "logic" for moi_deploy_logic (the default, so every logic caller is as it was) and
 * "asset" for a MASX create. The encoder writes whatever kind it is given, so the check is here, and a manifest of the other
 * kind is sent to the tool that takes it.
 */
export function readDeployManifest(manifest: Record<string, unknown>, expected: "logic" | "asset" = "logic"): DeployManifest {
  let jsonChars: number;
  try {
    jsonChars = JSON.stringify(manifest).length;
  } catch {
    throw invalid("The manifest could not be read as JSON.");
  }
  if (jsonChars > MAX_MANIFEST_JSON_CHARS) {
    throw invalid(
      `The manifest is too large: ${jsonChars} characters of JSON, and this tool takes at most ${MAX_MANIFEST_JSON_CHARS}. ` +
        "A manifest compiled from ordinary Coco is a few thousand.",
    );
  }

  const kind = manifest["kind"];
  if (expected === "logic" && kind === "asset") {
    throw invalid(
      'This manifest is for an asset (its kind is "asset"), not a logic. moi_deploy_logic deploys logics; an asset is created ' +
        "with moi_create_asset (standard MASX takes a compiled asset manifest).",
    );
  }
  if (expected === "asset" && kind === "logic") {
    throw invalid(
      'This manifest is for a logic (its kind is "logic"), not an asset. A MASX asset is created from the manifest of a `coco asset` ' +
        'module (kind "asset"). To deploy a logic use moi_deploy_logic.',
    );
  }
  if (kind !== expected) {
    throw invalid(
      `The manifest's kind must be "${expected}", as a compiled ${expected} manifest says; ${kind === undefined ? "it has no kind" : `got ${JSON.stringify(clampChainText(kind, 40))}`}.`,
    );
  }
  const engine = manifest["engine"];
  if (
    typeof manifest["syntax"] !== "number" ||
    !Number.isSafeInteger(manifest["syntax"]) ||
    !isObject(engine) ||
    typeof engine["kind"] !== "string" ||
    engine["kind"] === ""
  ) {
    throw invalid("The manifest needs a whole-number `syntax` and an `engine` object with a `kind`, as `coco compile` writes them.");
  }
  const given = manifest["elements"];
  if (!Array.isArray(given) || given.length === 0) {
    throw invalid(`The manifest has no \`elements\` list, or an empty one; a compiled ${expected} manifest has syntax, engine, kind and elements.`);
  }

  let hex: string;
  try {
    hex = ManifestCoder.encodeManifest(manifest as never);
  } catch (err) {
    throw invalid(`The manifest could not be encoded: ${reason(err)}. Pass the JSON object coco compile writes, unchanged.`);
  }
  const bytes = (hex.length - 2) / 2;
  if (bytes > MAX_MANIFEST_BYTES) {
    throw invalid(
      `The manifest is too large: it encodes to ${bytes} bytes, and this tool takes at most ${MAX_MANIFEST_BYTES}. ` +
        "A manifest compiled from ordinary Coco is a few thousand bytes.",
    );
  }

  // Everything below is read from the decoded copy, which is what the chain will hold.
  let decoded: Record<string, unknown>;
  try {
    decoded = ManifestCoder.decodeManifest(hex, ManifestCoderFormat.JSON) as unknown as Record<string, unknown>;
  } catch (err) {
    throw invalid(`The manifest encodes but does not read back: ${reason(err)}, so it is not sent.`);
  }
  const elements = decoded["elements"];
  if (
    decoded["kind"] !== expected ||
    decoded["syntax"] !== manifest["syntax"] ||
    !Array.isArray(elements) ||
    elements.length !== given.length
  ) {
    throw invalid("The manifest does not read back the way it was given (its kind, syntax or number of elements changed in encoding), so it is not sent.");
  }
  let coder: ManifestCoder;
  try {
    // The coder builds the SDK's ElementDescriptor over the elements, which throws on a null or malformed element.
    coder = new ManifestCoder(decoded as never);
  } catch {
    throw invalid("The manifest's elements could not be read, so it is not sent.");
  }

  const counts = { total: 0, deploy: 0, invoke: 0, enlist: 0, internal: 0, other: 0 };
  const names: string[] = [];
  const deploys = new Map<string, DeployRoutine>();
  const pointers = new Set<unknown>();
  const seen = new Set<string>();
  for (const el of elements) {
    if (!isObject(el)) throw invalid("The manifest has an element that is not an object, so it is not sent.");
    // The coder finds an element by its pointer, so two elements with one pointer would hide each other.
    if (pointers.has(el["ptr"])) {
      throw invalid("The manifest has two elements with the same `ptr`, which a compiled manifest never has, so it is not sent.");
    }
    pointers.add(el["ptr"]);
    if (el["kind"] !== "callable" || !isObject(el["data"])) continue;

    const data = el["data"];
    const name = data["name"];
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw invalid(
        "The manifest has a routine whose name is not a plain identifier (letters, digits and underscores, up to 64 characters), " +
          "which a compiled manifest never has, so it is not sent.",
      );
    }
    if (seen.has(name)) {
      throw invalid(`The manifest has two routines named "${name}", which a compiled manifest never has: the chain could run either, so it is not sent.`);
    }
    seen.add(name);

    const routineKind = data["kind"];
    counts.total++;
    if (routineKind === "deploy" || routineKind === "invoke" || routineKind === "enlist" || routineKind === "internal") counts[routineKind]++;
    else counts.other++;
    if (routineKind !== "internal") names.push(name);
    if (routineKind === "deploy") deploys.set(name, { name, accepts: usableFields(data["accepts"]) });
  }

  return {
    hex,
    bytes,
    digest: createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex"),
    coder,
    counts,
    names,
    deploys,
  };
}

// ---------------------------------------------------------------------------
// Planning a deploy routine's call, shared by moi_deploy_logic and a MASX create
// ---------------------------------------------------------------------------

/** Routine names listed in the preview before it says how many more there are. */
const MAX_NAMES_SHOWN = 12;

/** What the preview says a compiled logic manifest has no name for. A MASX create names the asset by its symbol instead. */
const NO_NAME_CLOSING = "no name, because a compiled manifest carries none and the chain stores none";

export function unavailable(message: string, available: string[]): MoiError {
  return new MoiError(ErrorCode.LOGIC_ROUTINE_NOT_FOUND, `${message} Nothing was sent to your wallet.`, { available });
}

export function routinesWord(n: number): string {
  return `${n} routine${n === 1 ? "" : "s"}`;
}

/**
 * The deploy routine the call runs: the one named, or the only one there is. Never a guess between several.
 * `when` completes the sentence that asks for a name when there are several: "at deployment" for a logic, and "when the
 * asset is created" for a MASX asset. A manifest with no deploy routine is the caller's to handle before this: a logic
 * deploy refuses it, a MASX create does not.
 */
export function pickRoutine(
  m: DeployManifest,
  wanted: string | undefined,
  when = "at deployment",
): { routine: DeployRoutine; only: boolean } {
  const names = [...m.deploys.keys()];
  if (names.length === 0) {
    throw invalid(
      "The manifest has no deploy routine. This tool deploys a logic by running one of its deploy routines: whether the chain " +
        "accepts a deploy with nothing to run is documented only in the SDK's own comments, and has not been run, so it is not offered.",
    );
  }
  if (wanted !== undefined) {
    const found = m.deploys.get(wanted);
    if (found) return { routine: found, only: false };
    // Offered, never applied: the preview must show the exact name that will run.
    const close = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
    throw unavailable(
      `The manifest has no deploy routine "${clampChainText(wanted, 64)}"${close ? ` (did you mean "${close}"?)` : ""}. ` +
        `Its deploy routines are: ${names.join(", ")}.`,
      names,
    );
  }
  if (names.length === 1) return { routine: m.deploys.get(names[0] as string) as DeployRoutine, only: true };
  throw invalid(`The manifest has ${names.length} deploy routines: ${names.join(", ")}. Pass routine to say which one runs ${when}.`);
}

/**
 * The preview line that says what the manifest holds, read from the decoded copy: the routine count by kind, the names,
 * the encoded size and the SHA-256 of the encoded bytes. `closing` ends it with what the manifest has no name for.
 */
export function manifestLine(m: DeployManifest, closing = NO_NAME_CLOSING): string {
  const c = m.counts;
  const parts = (
    [
      ["deploy", c.deploy],
      ["invoke", c.invoke],
      ["enlist", c.enlist],
      ["internal", c.internal],
      ["other", c.other],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`);
  const shown = m.names.slice(0, MAX_NAMES_SHOWN);
  const more = m.names.length - shown.length;
  return (
    `${routinesWord(c.total)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}` +
    `${shown.length > 0 ? `: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}` : ""}; ` +
    `${m.bytes} bytes encoded; SHA-256 of those bytes ${m.digest}; ${closing}`
  );
}

/**
 * Validate and encode a deploy routine's inputs against the decoded manifest, and write the preview line for them.
 * `calldata` is 0x and the hex of the encoded inputs, or undefined for a routine that takes none. The line lists the inputs
 * in the manifest's order, whatever order the caller gave them in, so the same call in any key order gives the same text,
 * which the confirm step compares.
 */
export function encodeDeployInputs(
  m: DeployManifest,
  routine: DeployRoutine,
  args: Record<string, unknown>,
): { calldata: string | undefined; argsLine: string } {
  if (!routine.accepts) {
    throw invalid(
      `The deploy routine ${routine.name} has inputs this server cannot read (more than ${MAX_FIELDS}, or a label or type that is not plain).`,
    );
  }
  // An asset has decimals and a logic does not: 0, so no message talks about whole tokens.
  const coerced = coerceArgs(routine.name, routine.accepts, args, { decimals: 0 });
  const encoded = encodeCalldata(m.coder, routine.name, routine.accepts, coerced);
  const argsLine =
    routine.accepts.length === 0
      ? "none"
      : shorten(
          JSON.stringify(Object.fromEntries(routine.accepts.map((f) => [f.label, showValue(coerced.get(f.label) as never)]))),
          PREVIEW_ARGS_CHARS,
        );
  return { calldata: encoded === undefined ? undefined : `0x${encoded}`, argsLine };
}
