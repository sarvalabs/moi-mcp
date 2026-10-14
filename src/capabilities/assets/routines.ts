/**
 * What an asset can do, read from its own manifest: the read half of the asset tools.
 *
 * The node returns an asset's manifest for the asset id (moi.LogicManifest, as the SDK's own asset driver asks for it).
 * Routines are found through the SDK's own ElementDescriptor, the table ManifestCoder encodes with, and never through a
 * table of this file's own: when a manifest gives two callables one name or one slot, the coder picks one, and a list
 * that picked differently would show a routine this server then encodes as another. Using the coder's table makes the
 * list, the preview and the encoding agree by construction.
 *
 * A manifest is chosen by whoever created the asset, so nothing in it is trusted. A name, a label or a type is accepted
 * only in a plain identifier-like shape (no spaces, quotes or control characters), which is what lets them go into a
 * preview, a message and a callsite without clamping, and means nothing a creator writes reaches the model as free
 * text. A routine that fails any rule is left out and counted in `unlisted`. A node that returns no usable manifest
 * gets a refusal and there is no fallback: this server does not guess what an asset can do.
 *
 * Imports nothing from src/tools, src/wc or the journal: the gateway serves this file.
 */

import { ElementDescriptor, ManifestCoder, type JsonRpcProvider } from "js-moi-sdk";
import type { z } from "zod";

import { clampChainText, getAsset } from "../../moi/reads.js";
import { MoiError } from "../../moi-error.js";
import { ErrorCode, type AssetRoutinesOutput } from "../../schema.js";
import type { Field } from "./codec.js";
import { specFor, standardFileFor } from "./standards/index.js";

/** The asset a call is about: what getAsset read, in the shape the rest of this folder takes. */
export interface AssetRef {
  assetId: string;
  symbol: string;
  standard: string;
  decimals: number;
  logicId?: string;
}

export interface Callable {
  name: string;
  /** read: the manifest says static. write: anything else, an unknown or missing mode included. */
  access: "read" | "write";
  accepts: readonly Field[];
  returns: readonly Field[];
}

export interface ManifestView {
  coder: ManifestCoder;
  /** Invokable routines in manifest order. A Map, so a routine named "constructor" or "__proto__" is just a key. */
  callables: ReadonlyMap<string, Callable>;
  /** Invokable routines left out: unsafe shape, too many fields, or a name or slot the coder resolves to another routine. */
  unlisted: number;
}

/** MAS0 has 20 routines; a custom asset's manifest is chosen by its creator. */
export const MAX_ROUTINES = 100;
/** Inputs or outputs of one routine; real asset routines take at most 4. */
export const MAX_FIELDS = 16;

/** Also the shape src/capabilities/logics/deploy-manifest.ts accepts for a routine's name. */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const TYPE_RE = /^[A-Za-z0-9_.[\]]{1,60}$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function noManifest(asset: AssetRef, detail?: string): MoiError {
  const backed = asset.logicId
    ? ` The asset is backed by logic ${clampChainText(asset.logicId, 80)}; this server asks the node for an asset's manifest by the asset id, as the SDK does, and does not look elsewhere.`
    : "";
  return new MoiError(
    ErrorCode.RPC_ERROR,
    `The node returned no usable manifest for asset ${asset.assetId} (standard ${asset.standard || "unreadable"})` +
      `${detail ? `: ${clampChainText(detail, 160)}` : ""}. This server reads an asset's routines from its manifest and ` +
      `has no fallback, so it cannot list them or build a call.${backed} Nothing was sent to your wallet.`,
    { assetId: asset.assetId },
  );
}

/** A field list this server can use, or undefined. An absent list is an empty one. Also read by src/capabilities/logics/deploy-manifest.ts, for a deploy routine. */
export function usableFields(list: unknown): Field[] | undefined {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_FIELDS) return undefined;
  const slots = new Set<number>();
  const labels = new Set<string>();
  const out: Field[] = [];
  for (const f of list) {
    if (!isObject(f)) return undefined;
    const { slot, label, type } = f;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= 64 || slots.has(slot)) return undefined;
    if (typeof label !== "string" || !LABEL_RE.test(label) || labels.has(label)) return undefined;
    if (typeof type !== "string" || !TYPE_RE.test(type)) return undefined;
    slots.add(slot);
    labels.add(label);
    out.push({ slot, label, type });
  }
  return out;
}

/** Read the invokable routines out of a manifest. Pure. Throws only noManifest errors. */
export function readManifest(manifest: unknown, asset: AssetRef): ManifestView {
  if (!isObject(manifest) || !Array.isArray(manifest["elements"])) {
    throw noManifest(asset, "the manifest has no element list");
  }
  let descriptor: ElementDescriptor;
  let coder: ManifestCoder;
  try {
    // A null element, or a state element with null data, makes the SDK throw; either means the manifest is unusable.
    descriptor = new ElementDescriptor(manifest["elements"] as never);
    coder = new ManifestCoder(manifest as never);
  } catch {
    throw noManifest(asset, "the manifest's elements could not be read");
  }

  const callables = new Map<string, Callable>();
  let unlisted = 0;
  for (const name of descriptor.getCallsites().keys()) {
    if (typeof name !== "string") {
      unlisted++;
      continue;
    }
    let element: unknown;
    try {
      element = descriptor.getRoutineElement(name);
    } catch {
      unlisted++;
      continue;
    }
    // The coder resolves a name to one element. When that element is not the callable the name belongs to (two
    // callables sharing a slot: the later one wins for both names), the name cannot be used safely.
    if (!isObject(element) || element["kind"] !== "callable" || !isObject(element["data"]) || element["data"]["name"] !== name) {
      unlisted++;
      continue;
    }
    const data = element["data"];
    // A deploy or enlist callable is not an asset routine; ASSET_INVOKE can only carry an invoke.
    if (data["kind"] !== "invoke") continue;
    const accepts = usableFields(data["accepts"]);
    const returns = usableFields(data["returns"]);
    if (!NAME_RE.test(name) || !accepts || !returns) {
      unlisted++;
      continue;
    }
    callables.set(name, { name, access: data["mode"] === "static" ? "read" : "write", accepts, returns });
  }
  return { coder, callables, unlisted };
}

/** Ask the node for the asset's manifest, by the asset id, and read it. */
export async function loadAssetManifest(provider: JsonRpcProvider, asset: AssetRef): Promise<ManifestView> {
  let answer: unknown;
  try {
    answer = await provider.getLogicManifest(asset.assetId, "JSON" as never);
  } catch (err) {
    throw noManifest(asset, err instanceof Error ? err.message : String(err));
  }
  let manifest = answer;
  if (typeof answer === "string") {
    try {
      manifest = JSON.parse(answer);
    } catch {
      throw noManifest(asset, "the answer is not a manifest");
    }
  }
  if (!isObject(manifest)) throw noManifest(asset, "the answer is empty");
  const view = readManifest(manifest, asset);
  // A manifest with nothing this server can call is as good as none, for the list and for a call alike.
  if (view.callables.size === 0) {
    throw noManifest(
      asset,
      view.unlisted > 0 ? `none of its ${view.unlisted} routines can be used by this server` : "it lists no invokable routines",
    );
  }
  return view;
}

/** The asset as the rest of this folder takes it. */
export function assetRef(asset: Awaited<ReturnType<typeof getAsset>>): AssetRef {
  return {
    assetId: asset.assetId,
    symbol: asset.symbol,
    standard: asset.standard,
    decimals: asset.decimals,
    ...(asset.logicId ? { logicId: asset.logicId } : {}),
  };
}

export async function getAssetRoutines(
  provider: JsonRpcProvider,
  assetId: string,
): Promise<z.infer<typeof AssetRoutinesOutput>> {
  // A malformed id is refused here, before any manifest is read.
  const asset = await getAsset(provider, assetId);
  const ref = assetRef(asset);
  const view = await loadAssetManifest(provider, ref);

  const file = standardFileFor(asset.standard);
  // The cut comes after the filtering, as it does in getLogic.
  const routines = [...view.callables.values()].slice(0, MAX_ROUTINES).map((callable) => ({
    name: callable.name,
    access: callable.access,
    inputs: callable.accepts.map(({ label, type }) => ({ label, type })),
    outputs: callable.returns.map(({ label, type }) => ({ label, type })),
    described: callable.access === "read" || specFor(file, callable) !== undefined,
  }));
  return {
    assetId,
    symbol: asset.symbol,
    standard: asset.standard,
    decimals: asset.decimals,
    routines,
    total: view.callables.size,
    unlisted: view.unlisted,
    truncated: view.callables.size > routines.length,
  };
}
