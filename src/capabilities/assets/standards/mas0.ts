/**
 * MAS0: the fungible standard, and the one kind of asset this server can create. Eleven write routines; the nine reads
 * (Symbol, BalanceOf, Creator, Manager, Decimals, MaxSupply, CirculatingSupply, GetStaticMetadata, GetDynamicMetadata)
 * need no description, because a read changes nothing.
 *
 * Checked against a real MAS0 manifest (PIXEL, voyage devnet, 1 October 2026): every routine below is a write routine
 * in it with the inputs listed here, and a test walks the fixture to keep it so. The participants are the SDK's
 * (MAS0AssetLogic in js-moi-asset) and a test compares them with the SDK's own class for every routine. What Lockup and
 * Release do on chain is not confirmed beyond the SDK's parameter names, so their wording restates the arguments and
 * claims nothing about the chain's rules. The unit of `expires_at` is not confirmed either (describeExpiry).
 */

import { clampChainText } from "../../../moi/reads.js";
import {
  amountDetails,
  amountText,
  assetLabel,
  describeExpiry,
  idArg,
  intArg,
  mapSize,
  mutate,
  noLock,
  nonEmptyKey,
  positiveAmount,
  quoted,
  SARGA,
  shorten,
  textArg,
  type RoutineContext,
  type RoutineSpec,
  type StandardFile,
} from "./common.js";

/** The text `prepareMint` uses for the same failure, so the shortcut and this path say the same thing. */
export const MINT_HINT = "Minting requires you to be the asset's manager, and the new total cannot exceed its maximum supply.";

const A = (c: RoutineContext): string => c.assetId;
const B = (c: RoutineContext): string => idArg(c, "beneficiary");
const F = (c: RoutineContext): string => idArg(c, "benefactor");

const metadataSetter = (kind: "static" | "dynamic"): RoutineSpec => ({
  inputs: { key: "string", value: "bytes" },
  check: nonEmptyKey(),
  summary: (c) => `Set the ${kind} metadata ${quoted(textArg(c, "key"))} of ${assetLabel(c)}`,
  details: (c) => ({ Key: clampChainText(textArg(c, "key"), 200), Value: shorten(textArg(c, "value"), 200) }),
  participants: () => [],
  hint: "Only the asset's manager can set metadata.",
});

export const mas0File: StandardFile = {
  standard: "MAS0",
  routines: {
    Transfer: {
      inputs: { beneficiary: "identifier", amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Transfer ${amountText(c, "amount")} to ${B(c)}`,
      details: (c) => ({ To: B(c), ...amountDetails(c, "amount") }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    TransferFrom: {
      inputs: { benefactor: "identifier", beneficiary: "identifier", amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Spend an approval: move ${amountText(c, "amount")} from ${F(c)} to ${B(c)}`,
      details: (c) => ({ From: F(c), To: B(c), ...amountDetails(c, "amount") }),
      participants: (c) => [mutate(B(c)), mutate(F(c)), noLock(A(c))],
      hint: "TransferFrom needs an approval from the benefactor to the account that signs, for at least this amount and not yet expired.",
    },
    Mint: {
      inputs: { beneficiary: "identifier", amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Mint ${amountText(c, "amount")} to ${B(c)}`,
      details: (c) => ({ To: B(c), ...amountDetails(c, "amount") }),
      participants: (c) => [mutate(A(c)), mutate(B(c))],
      hint: MINT_HINT,
    },
    MintWithMetadata: {
      inputs: { beneficiary: "identifier", amount: "int", static_metadata: "metadata" },
      check: positiveAmount(),
      summary: (c) => `Mint ${amountText(c, "amount")} to ${B(c)} with ${mapSize(c, "static_metadata")} metadata entries`,
      details: (c) => ({
        To: B(c),
        ...amountDetails(c, "amount"),
        "Metadata entries": String(mapSize(c, "static_metadata")),
      }),
      participants: (c) => [mutate(A(c)), mutate(B(c))],
      hint: MINT_HINT,
    },
    Burn: {
      inputs: { amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Burn ${amountText(c, "amount")}`,
      details: (c) => amountDetails(c, "amount"),
      participants: (c) => [mutate(A(c))],
      hint: "You can only burn what the signing account holds.",
    },
    Lockup: {
      inputs: { beneficiary: "identifier", amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Lock up ${amountText(c, "amount")} with ${B(c)} as the beneficiary`,
      details: (c) => ({ Beneficiary: B(c), ...amountDetails(c, "amount") }),
      participants: (c) => [mutate(B(c)), noLock(A(c)), mutate(SARGA)],
    },
    Release: {
      inputs: { benefactor: "identifier", beneficiary: "identifier", amount: "int" },
      check: positiveAmount(),
      summary: (c) => `Release ${amountText(c, "amount")} locked up by ${F(c)} for ${B(c)}`,
      details: (c) => ({ "Locked up by": F(c), Beneficiary: B(c), ...amountDetails(c, "amount") }),
      participants: (c) => [mutate(B(c)), mutate(F(c)), noLock(A(c))],
    },
    Approve: {
      inputs: { beneficiary: "identifier", amount: "int", expires_at: "int" },
      summary: (c) =>
        `Approve ${B(c)} to spend up to ${amountText(c, "amount")} until ${describeExpiry(intArg(c, "expires_at"))}`,
      details: (c) => ({
        Beneficiary: B(c),
        ...amountDetails(c, "amount", "Spending cap"),
        "Expires at (as given)": String(intArg(c, "expires_at")),
      }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    Revoke: {
      inputs: { beneficiary: "identifier" },
      summary: (c) => `Revoke the approval given to ${B(c)}`,
      details: (c) => ({ Beneficiary: B(c) }),
      participants: (c) => [mutate(B(c)), noLock(A(c))],
    },
    SetStaticMetadata: metadataSetter("static"),
    SetDynamicMetadata: metadataSetter("dynamic"),
  },
};
