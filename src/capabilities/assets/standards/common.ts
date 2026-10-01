/**
 * What the standard files share: the shapes they fill in, the helpers that write a preview line, and the one factory
 * that builds both token-id standards (MAS1 and MAS2), which differ only by an amount.
 *
 * A standard file holds, for each routine this server knows, the sentence a person reads before approving, the checks
 * on its inputs, and the accounts it locks. The manifest says what a routine takes; it does not say who it touches, and
 * a routine that moves value for an account that is not declared fails at execution, after fuel is spent. So the
 * participants come from the SDK's own asset classes (node_modules/js-moi-asset), and a routine with no entry here is
 * not described: the caller declares the participants and the preview says plainly that this server cannot describe it.
 *
 * Imports nothing from src/tools, src/wc or the journal.
 */

import { SARGA_ADDRESS } from "js-moi-sdk";

import { clip } from "../../../bounds.js";
import { normalizeAmount, clampChainText } from "../../../moi/reads.js";
import { MoiError } from "../../../moi-error.js";
import { ErrorCode } from "../../../schema.js";
import type { Coerced } from "../codec.js";

export type LockName = "mutate" | "read" | "none";
export interface ParticipantLock {
  id: string;
  lock: LockName;
}
export const mutate = (id: string): ParticipantLock => ({ id, lock: "mutate" });
export const noLock = (id: string): ParticipantLock => ({ id, lock: "none" });
/** The account Lockup also locks, as the SDK's asset classes list it. */
export const SARGA: string = SARGA_ADDRESS;

/** What kind of value an input is, which is all a description needs to know about its manifest type. */
export type InputKind = "int" | "identifier" | "string" | "bytes" | "metadata";

/** The kind of a manifest type string, or undefined for any other type. */
export function kindOf(type: string): InputKind | undefined {
  switch (type) {
    case "u64":
    case "u256":
    case "i64":
    case "i256":
    case "bigint":
      return "int";
    case "identifier":
    case "string":
    case "bytes":
      return type;
    case "map[string]bytes":
      return "metadata";
    default:
      return undefined;
  }
}

/** Everything a spec may look at. `args` are the validated inputs by manifest label. */
export interface RoutineContext {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly standard: string;
  readonly routine: string;
  /** ints are bigint, identifiers and bytes are 0x strings, metadata is a Map of key to 0x string. */
  readonly args: ReadonlyMap<string, Coerced>;
}

export interface RoutineSpec {
  /**
   * The inputs this description was written for, label to kind. The manifest's inputs must equal this set or the
   * routine is undescribed: a description written for another shape of call would say something untrue.
   */
  readonly inputs: Readonly<Record<string, InputKind>>;
  /** One line a person reads, also sent to the wallet as the description. */
  summary(c: RoutineContext): string;
  /** Labelled values for the preview beyond Operation and Asset. */
  details?(c: RoutineContext): Record<string, string>;
  /** Throws MoiError(INVALID_ARGS) for a call that is wrong for this routine; runs after the inputs are validated. */
  check?(c: RoutineContext): void;
  /** The accounts the routine locks, the asset included, as the SDK's own asset class lists them. */
  participants(c: RoutineContext): ParticipantLock[];
  /** Appended to the refusal when the simulation fails. */
  hint?: string;
}

export interface StandardFile {
  readonly standard: string;
  /** Run first, on the raw inputs and for any routine name: a message refuses the call before the manifest is fetched. */
  refusal?(routine: string, args: Readonly<Record<string, unknown>>): string | undefined;
  /** Own-property lookups only (Object.hasOwn): a routine named "constructor" must not find Object's. */
  readonly routines: Readonly<Record<string, RoutineSpec>>;
}

export function invalid(message: string): MoiError {
  return new MoiError(ErrorCode.INVALID_ARGS, `${message} Nothing was sent to your wallet.`);
}

// ---------------------------------------------------------------------------
// Reading the validated inputs. A spec is only used on a routine whose kinds were matched (specFor), so these throw
// only if that guarantee is broken.
// ---------------------------------------------------------------------------

function wrong(label: string): MoiError {
  return new MoiError(ErrorCode.INVALID_ARGS, `internal: input "${label}" is missing or is not the kind this description expects.`);
}

export function intArg(c: RoutineContext, label: string): bigint {
  const v = c.args.get(label);
  if (typeof v !== "bigint") throw wrong(label);
  return v;
}

export function idArg(c: RoutineContext, label: string): string {
  const v = c.args.get(label);
  if (typeof v !== "string") throw wrong(label);
  return v;
}

/** The text of a `string` or `bytes` input (bytes as 0x hex). */
export function textArg(c: RoutineContext, label: string): string {
  const v = c.args.get(label);
  if (typeof v !== "string") throw wrong(label);
  return v;
}

export function mapSize(c: RoutineContext, label: string): number {
  const v = c.args.get(label);
  if (!(v instanceof Map)) throw wrong(label);
  return v.size;
}

// ---------------------------------------------------------------------------
// Preview wording
// ---------------------------------------------------------------------------

export const assetLabel = (c: RoutineContext): string => c.symbol || c.assetId;
export const amountOnly = (c: RoutineContext, label: string): string => normalizeAmount(intArg(c, label), c.decimals);
export const amountText = (c: RoutineContext, label: string): string => `${amountOnly(c, label)} ${assetLabel(c)}`;
/** The amount in whole tokens and in base units: the phone shows base units, a person thinks in tokens. */
export const amountDetails = (c: RoutineContext, label: string, title = "Amount"): Record<string, string> => ({
  [title]: amountOnly(c, label),
  [`${title} in base units`]: String(intArg(c, label)),
});
export const tokenText = (c: RoutineContext): string => `token #${intArg(c, "token_id")}`;

export function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${clip(text, max)}…`;
}

/** Text a caller chose, for a summary: control characters out, cut short, quoted. */
export const quoted = (text: string, max = 80): string => `"${clampChainText(text, max)}"`;

/**
 * An expiry as a preview shows it. The unit of `expires_at` (seconds or nanoseconds) is not confirmed on chain, so the
 * raw value comes first and the one reading offered is labelled as a reading. A value too large to be a date in
 * seconds, nanoseconds for one, gets no reading, because an invalid Date must never reach toISOString.
 */
export function describeExpiry(v: bigint): string {
  const ms = Number(v) * 1000;
  const date = new Date(ms);
  if (v >= 0n && Number.isFinite(ms) && !Number.isNaN(date.getTime())) {
    return `${v} (as unix seconds that is ${date.toISOString()}; the unit is not confirmed)`;
  }
  return `${v} (the unit is not confirmed)`;
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

/** A zero amount moves nothing and costs a tap and fuel, so it is refused for the routines that move or make value. */
export const positiveAmount =
  (label = "amount") =>
  (c: RoutineContext): void => {
    if (intArg(c, label) === 0n) {
      throw invalid(`${c.routine} with an amount of 0 moves nothing. Give an amount of at least 1 base unit.`);
    }
  };

export const nonEmptyKey = () => (c: RoutineContext): void => {
  if (textArg(c, "key") === "") throw invalid(`${c.routine} needs a non-empty key.`);
};

// ---------------------------------------------------------------------------
// MAS1 and MAS2: the token-id standards
// ---------------------------------------------------------------------------

/**
 * The thirteen routines of both token-id standards, from one table. They differ only by the amount input (MAS2 has
 * one, MAS1 does not: each token is whole), and their participants are the same in the SDK's two asset classes.
 * Written from the SDK's schemas and classes, not run against a node: see mas1.ts and mas2.ts.
 */
export function tokenIdStandard(name: "MAS1" | "MAS2", withAmounts: boolean): StandardFile {
  const amount: Record<string, InputKind> = withAmounts ? { amount: "int" } : {};
  const checkAmount = withAmounts ? positiveAmount() : undefined;
  const amountPair = (c: RoutineContext, title = "Amount"): Record<string, string> =>
    withAmounts ? amountDetails(c, "amount", title) : {};
  const tokenId = (c: RoutineContext): Record<string, string> => ({ "Token id": String(intArg(c, "token_id")) });
  /** "5 of token #12 of SYM" for MAS2, "token #12 of SYM" for MAS1. */
  const unit = (c: RoutineContext): string =>
    withAmounts
      ? `${amountOnly(c, "amount")} of ${tokenText(c)} of ${assetLabel(c)}`
      : `${tokenText(c)} of ${assetLabel(c)}`;
  const expiry = (c: RoutineContext): Record<string, string> => ({
    "Expires at (as given)": String(intArg(c, "expires_at")),
  });
  const A = (c: RoutineContext) => c.assetId;
  const B = (c: RoutineContext) => idArg(c, "beneficiary");
  const F = (c: RoutineContext) => idArg(c, "benefactor");
  const mint = (c: RoutineContext): string =>
    withAmounts ? `Mint ${amountOnly(c, "amount")} of ${assetLabel(c)} to ${B(c)}` : `Mint a token of ${assetLabel(c)} to ${B(c)}`;
  const mintDetails = (c: RoutineContext): Record<string, string> => ({
    ...(withAmounts ? {} : { "Token id": "not part of the call" }),
    To: B(c),
    ...amountPair(c),
  });
  const setter = (kind: "static" | "dynamic", perToken: boolean): RoutineSpec => ({
    inputs: { ...(perToken ? { token_id: "int" as const } : {}), key: "string", value: "bytes" },
    check: nonEmptyKey(),
    summary: (c) =>
      `Set the ${kind} metadata ${quoted(textArg(c, "key"))} of ${perToken ? `${tokenText(c)} of ` : ""}${assetLabel(c)}`,
    details: (c) => ({
      ...(perToken ? tokenId(c) : {}),
      Key: clampChainText(textArg(c, "key"), 200),
      Value: shorten(textArg(c, "value"), 200),
    }),
    participants: () => [],
  });

  const routines: Record<string, RoutineSpec> = {
    Transfer: {
      inputs: { token_id: "int", beneficiary: "identifier", ...amount },
      check: checkAmount,
      summary: (c) => `Transfer ${unit(c)} to ${B(c)}`,
      details: (c) => ({ ...tokenId(c), To: B(c), ...amountPair(c) }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    TransferFrom: {
      inputs: { token_id: "int", benefactor: "identifier", beneficiary: "identifier", ...amount },
      check: checkAmount,
      summary: (c) => `Spend an approval: move ${unit(c)} from ${F(c)} to ${B(c)}`,
      details: (c) => ({ ...tokenId(c), From: F(c), To: B(c), ...amountPair(c) }),
      participants: (c) => [mutate(B(c)), mutate(F(c)), noLock(A(c))],
    },
    Mint: {
      inputs: { beneficiary: "identifier", ...amount },
      check: checkAmount,
      summary: mint,
      details: mintDetails,
      participants: (c) => [mutate(A(c)), mutate(B(c))],
    },
    MintWithMetadata: {
      inputs: { beneficiary: "identifier", ...amount, static_metadata: "metadata" },
      check: checkAmount,
      summary: (c) => `${mint(c)} with ${mapSize(c, "static_metadata")} metadata entries`,
      details: (c) => ({ ...mintDetails(c), "Metadata entries": String(mapSize(c, "static_metadata")) }),
      participants: (c) => [mutate(A(c)), mutate(B(c))],
    },
    Burn: {
      inputs: { token_id: "int", ...amount },
      check: checkAmount,
      summary: (c) => `Burn ${unit(c)}`,
      details: (c) => ({ ...tokenId(c), ...amountPair(c) }),
      participants: (c) => [mutate(A(c))],
    },
    Lockup: {
      inputs: { token_id: "int", beneficiary: "identifier", ...amount },
      check: checkAmount,
      summary: (c) => `Lock up ${unit(c)} with ${B(c)} as the beneficiary`,
      details: (c) => ({ ...tokenId(c), Beneficiary: B(c), ...amountPair(c) }),
      participants: (c) => [mutate(B(c)), noLock(A(c)), mutate(SARGA)],
    },
    Release: {
      inputs: { token_id: "int", benefactor: "identifier", beneficiary: "identifier", ...amount },
      check: checkAmount,
      summary: (c) => `Release ${unit(c)} locked up by ${F(c)} for ${B(c)}`,
      details: (c) => ({ ...tokenId(c), "Locked up by": F(c), Beneficiary: B(c), ...amountPair(c) }),
      participants: (c) => [mutate(B(c)), mutate(F(c)), noLock(A(c))],
    },
    Approve: {
      inputs: { token_id: "int", beneficiary: "identifier", ...amount, expires_at: "int" },
      summary: (c) =>
        withAmounts
          ? `Approve ${B(c)} to move up to ${amountOnly(c, "amount")} of ${tokenText(c)} of ${assetLabel(c)} until ${describeExpiry(intArg(c, "expires_at"))}`
          : `Approve ${B(c)} to move ${tokenText(c)} of ${assetLabel(c)} until ${describeExpiry(intArg(c, "expires_at"))}`,
      details: (c) => ({ ...tokenId(c), Beneficiary: B(c), ...amountPair(c, "Spending cap"), ...expiry(c) }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    Revoke: {
      inputs: { token_id: "int", beneficiary: "identifier" },
      summary: (c) => `Revoke the approval of ${tokenText(c)} of ${assetLabel(c)} given to ${B(c)}`,
      details: (c) => ({ ...tokenId(c), Beneficiary: B(c) }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    SetStaticMetadata: setter("static", false),
    SetDynamicMetadata: setter("dynamic", false),
    SetStaticTokenMetadata: setter("static", true),
    SetDynamicTokenMetadata: setter("dynamic", true),
  };
  return { standard: name, routines };
}
