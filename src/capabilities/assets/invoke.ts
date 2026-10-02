/**
 * Resolve one asset routine call and plan it. Pure: no node, no wallet, no clock.
 *
 * resolveFromManifest picks the routine out of a manifest view (an unknown name is refused with the names the manifest
 * does have), and planAssetCall turns the caller's inputs into everything a write needs: the encoded calldata, the
 * accounts the routine locks, the sentence a person reads, the labelled values the preview shows and a hint for a failed
 * simulation. Everything that touches the node or the write path lives in src/capabilities/assets/execute.ts, which is the
 * only file that calls these.
 *
 * This file contains no standard name and no routine name: what a routine means is the standard files' business.
 * Imports nothing from src/tools, src/wc or the journal.
 */

import { clampChainText } from "../../moi/reads.js";
import { MoiError } from "../../moi-error.js";
import { ErrorCode } from "../../schema.js";
import { coerceArgs, encodeCalldata, parseType, showValue } from "./codec.js";
import type { AssetRef, Callable, ManifestView } from "./routines.js";
import { assetLabel, invalid, shorten } from "./standards/common.js";
import {
  specFor,
  standardFileFor,
  type ParticipantLock,
  type RoutineContext,
  type RoutineSpec,
  type StandardFile,
} from "./standards/index.js";

export interface AssetCallInput {
  assetId: string;
  routine: string;
  args: Record<string, unknown>;
  participants?: Array<{ id: string; lock: "mutate" | "read" | "none" }>;
}

export interface ResolvedAssetCall {
  asset: AssetRef;
  view: ManifestView;
  callable: Callable;
  file: StandardFile | undefined;
  /** Only for a write routine this server describes; a read needs none and an undescribed write has none. */
  spec: RoutineSpec | undefined;
}

export interface AssetCallPlan {
  /** Hex without 0x, or undefined for a routine that takes no inputs. */
  calldata: string | undefined;
  participants: ParticipantLock[];
  /** One line a person reads, also sent to the wallet as the description. */
  description: string;
  /** Labelled values for the preview. Deterministic for a given input and chain state: the confirm step compares them. */
  details: Record<string, string>;
  hint?: string;
}

/** The same figure as PREVIEW_BODY_CHARS in src/tools/preview.ts; written again so this file imports nothing from src/tools. */
export const PREVIEW_ARGS_CHARS = 2000;

/** Names listed when a routine is not found. */
const MAX_NAMES_SHOWN = 40;

export function resolveFromManifest(asset: AssetRef, view: ManifestView, routine: string): ResolvedAssetCall {
  // A Map, so "constructor" and "__proto__" are ordinary names that are simply not there.
  const callable = view.callables.get(routine);
  if (!callable) {
    const names = [...view.callables.keys()];
    const shown = names.slice(0, MAX_NAMES_SHOWN).join(", ") + (names.length > MAX_NAMES_SHOWN ? `, and ${names.length - MAX_NAMES_SHOWN} more` : "");
    // Offered, never applied: the preview must show the exact name that will be called.
    const close = names.find((n) => n.toLowerCase() === routine.toLowerCase());
    const more =
      view.unlisted > 0
        ? ` ${view.unlisted} further routine${view.unlisted === 1 ? "" : "s"} in the manifest ${view.unlisted === 1 ? "is" : "are"} not usable by this server.`
        : "";
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Asset ${asset.assetId} (${asset.standard || "unreadable standard"}) has no routine "${clampChainText(routine, 64)}"` +
        `${close ? ` (did you mean "${close}"?)` : ""}. Its routines are: ${shown || "(none)"}.${more} moi_asset_routines lists their inputs.`,
      { assetId: asset.assetId, routine, available: names },
    );
  }
  const file = standardFileFor(asset.standard);
  return { asset, view, callable, file, spec: callable.access === "write" ? specFor(file, callable) : undefined };
}

export function planAssetCall(target: ResolvedAssetCall, input: AssetCallInput): AssetCallPlan {
  const { asset, view, callable, spec } = target;
  const name = callable.name;
  const standard = asset.standard || "unreadable";
  const args = coerceArgs(name, callable.accepts, input.args, asset);

  if (callable.access === "read") {
    if (input.participants !== undefined) {
      throw invalid(`${name} only reads, so it takes no participants. Remove them.`);
    }
    for (const out of callable.returns) {
      if (!parseType(out.type)) {
        throw invalid(`${name} returns "${out.label}" as ${out.type}, which this server cannot decode yet.`);
      }
    }
    const calldata = encodeCalldata(view.coder, name, callable.accepts, args);
    return { calldata, participants: [], description: `Read ${name} of ${asset.symbol || asset.assetId}`, details: {} };
  }

  const ctx: RoutineContext = {
    assetId: asset.assetId,
    symbol: asset.symbol,
    decimals: asset.decimals,
    standard: asset.standard,
    routine: name,
    args,
  };
  spec?.check?.(ctx);
  if (!spec && input.participants === undefined) {
    throw invalid(
      `This server has no description for ${name} on a ${standard} asset, so it does not know which accounts the routine locks. ` +
        "Pass `participants` (an empty list if it touches only the asset and your own account); an account the routine moves value for " +
        "and that is not declared fails at execution, after fuel is spent.",
    );
  }
  const calldata = encodeCalldata(view.coder, name, callable.accepts, args);
  const participants = [...(spec ? spec.participants(ctx) : []), ...(input.participants ?? [])];
  const assetLine = `${asset.symbol || "(no symbol)"} ${asset.assetId}`;
  const others: Record<string, string> =
    input.participants && input.participants.length > 0
      ? { "Other participants": input.participants.map((p) => `${p.id} (${p.lock})`).join(", ") }
      : {};

  if (spec) {
    return {
      calldata,
      participants,
      description: spec.summary(ctx),
      details: { Operation: name, Asset: assetLine, ...spec.details?.(ctx), ...others },
      ...(spec.hint ? { hint: spec.hint } : {}),
    };
  }

  // The manifest's order, and Map keys sorted by showValue: the same call in any key order gives the same text, which
  // the confirm step compares against the preview.
  const shownArgs = JSON.stringify(
    Object.fromEntries(callable.accepts.map((f) => [f.label, showValue(args.get(f.label) as never)])),
  );
  return {
    calldata,
    participants,
    description: `Call ${name} on asset ${assetLabel(ctx)}`,
    details: {
      Operation: "Invoke asset routine",
      Asset: assetLine,
      Standard: standard,
      Routine: name,
      Arguments: shorten(shownArgs, PREVIEW_ARGS_CHARS),
      Description:
        `This server has no description for the routine ${name} on a ${standard} asset. ` +
        "The values above are the arguments after validation; nothing here says what the routine does.",
      ...others,
    },
    hint: "Check that `participants` lists every account and asset the routine moves value for.",
  };
}
