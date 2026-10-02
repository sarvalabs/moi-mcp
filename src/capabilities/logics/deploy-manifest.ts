/**
 * Read a logic manifest for deployment: check it, encode it to POLO, read it back, and say what it holds.
 *
 * moi_deploy_logic (src/capabilities/logics/deploy.ts) takes the manifest as the JSON object `coco compile` writes. The
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
 * Pure: no node, no wallet. Imports nothing from src/tools, src/wc or the journal.
 */

import { createHash } from "node:crypto";

import { ManifestCoder, ManifestCoderFormat } from "js-moi-sdk";

import { clampChainText } from "../../moi/reads.js";
import type { Field } from "../assets/codec.js";
import { NAME_RE, usableFields } from "../assets/routines.js";
import { invalid } from "../assets/standards/common.js";

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
 */
export function readDeployManifest(manifest: Record<string, unknown>): DeployManifest {
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
  if (kind === "asset") {
    throw invalid(
      'This manifest is for an asset (its kind is "asset"), not a logic. moi_deploy_logic deploys logics; an asset is created ' +
        "with moi_create_asset, which makes MAS0 assets only for now.",
    );
  }
  if (kind !== "logic") {
    throw invalid(
      `The manifest's kind must be "logic", as a compiled logic manifest says; ${kind === undefined ? "it has no kind" : `got ${JSON.stringify(clampChainText(kind, 40))}`}.`,
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
    throw invalid("The manifest has no `elements` list, or an empty one; a compiled logic manifest has syntax, engine, kind and elements.");
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
    decoded["kind"] !== "logic" ||
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
