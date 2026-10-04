/**
 * Builds unsigned MOI interactions. No MCP imports, and — by construction — no
 * keys: everything here stops at the unsigned InteractionObject.
 *
 * Two encodings exist and are easy to confuse:
 *
 *   1. WalletConnect (dapp -> MOI Wallet). The wallet is handed the plain
 *      InteractionObject positionally: `params: [ixObject]`. Evidenced by
 *      sarvalabs/wallet-connect-dapp src/contexts/JsonRpcContext.tsx, which
 *      calls `request({ method: "moi.sendInteractions", params: [assetContext] })`
 *      where assetContext is `await builder.ixData(...)`, typed InteractionObject.
 *
 *   2. Node JSON-RPC (wallet -> MOI node). `moi.SendInteractions` takes
 *      `{ ix_args, signatures }` where ix_args is POLO-encoded hex. That is what
 *      js-moi-wallet's signInteraction produces:
 *      `ix_args: bytesToHex(serializeIxObject(ixObject))`.
 *
 * We are case 1. `toPoloHex` implements case 2 anyway — without keys — so the
 * encoding is switchable if the wallet turns out to want it (PLAN open Q1).
 */

import {
  AssetStandard,
  DEFAULT_FUEL_PRICE as SDK_DEFAULT_FUEL_PRICE,
  DEFAULT_STORAGE_FUND as SDK_DEFAULT_STORAGE_FUND,
  bytesToHex,
  buildTransferPayload,
  deriveAssetId,
  deriveLogicId,
  KMOI_ASSET_ID,
  ixObjectSchema,
  LockType,
  OpType,
  toRawInteractionObject,
} from "js-moi-sdk";
import { Polorizer } from "js-polo";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

/** The node rejects interactions carrying more than three operations. */
export const MAX_OPERATIONS = 3;

/**
 * Fuel price, taken from the SDK rather than written down here.
 *
 * This was a hardcoded 1. Simulation accepted it, every test passed, and the
 * node's mempool then refused to broadcast: "interaction underpriced". The
 * chain's floor moved with the September 2026 upgrade and the SDK's default
 * moved with it, to 50. A copy here would drift the same way again.
 */
export const DEFAULT_FUEL_PRICE = Number(SDK_DEFAULT_FUEL_PRICE);

/**
 * Fallback ceiling, used only when estimation fails.
 *
 * Deliberately not a tight number: it is a MAXIMUM, and the point of the
 * fallback is that we could not measure. Real estimates are ~300 fuel for a
 * transfer, so anything we build normally uses estimateFuelFor() below —
 * a fuel_limit three orders of magnitude above the real cost is alarming on
 * the wallet's approval screen, which is the one place a human is checking.
 */
export const DEFAULT_FUEL_LIMIT = 200_000;

/** Headroom over the measured estimate, for state that shifts between
 *  estimation and execution. */
export const FUEL_MARGIN = 1.5;

export interface SenderInfo {
  /** Participant id of the account that will sign — the paired wallet. */
  id: string;
  /** Interaction count for that account. */
  sequence: number;
  keyId?: number;
}

export interface BuildOptions {
  fuelPrice?: number;
  fuelLimit?: number;
}

export interface UnsignedInteraction {
  sender: { id: string; sequence: number; key_id: number };
  fuel_price: number;
  fuel_limit: number;
  ix_operations: Array<{ type: number; payload: Record<string, unknown> }>;
  participants?: Array<{ id: string; lock_type: number; notary?: boolean }>;
  /** bigint, not a decimal string — POLO rejects strings here. */
  funds?: Array<{ asset_id: string; amount: bigint }>;
}

/**
 * Scale a human decimal string up into the asset's base units.
 * parseAmount("1.5", 6) === 1500000n
 */
export function parseAmount(amount: string, dimension: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Amount must be a decimal string, got "${amount}"`, {
      amount,
    });
  }
  const scale = Math.max(0, Math.trunc(dimension || 0));
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > scale) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Amount ${amount} has ${fraction.length} decimal places but the asset's dimension is ${scale}.`,
      { amount, dimension: scale },
    );
  }
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

function base(sender: SenderInfo, options: BuildOptions): Omit<UnsignedInteraction, "ix_operations"> {
  return {
    sender: { id: sender.id, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    fuel_price: options.fuelPrice ?? DEFAULT_FUEL_PRICE,
    fuel_limit: options.fuelLimit ?? DEFAULT_FUEL_LIMIT,
  };
}

/** Weight the chain gives a single controlling key; the SDK and the docs both use 1000. */
export const SINGLE_KEY_WEIGHT = 1000;

/**
 * Register a participant that does not exist yet and fund it with KMOI in
 * the same operation. Shape matched against js-moi-interactions'
 * ParticipantCreate builder: the key list, the funding transfer as a
 * callsite plus calldata, and only the asset declared as a participant.
 * The new account is not declared; it does not exist until this lands.
 */
export function buildCreateAccount(
  sender: SenderInfo,
  params: { id: string; publicKey: string; amount: bigint },
  options: BuildOptions = {},
): UnsignedInteraction {
  const amount =
    params.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(params.amount) : params.amount;
  const funding = buildTransferPayload(
    KMOI_ASSET_ID as `0x${string}`,
    params.id as `0x${string}`,
    amount,
  ) as { calldata?: string };
  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.PARTICIPANT_CREATE,
        payload: {
          id: params.id,
          keys_payload: [{ public_key: params.publicKey, weight: SINGLE_KEY_WEIGHT, signature_algorithm: 0 }],
          value: { asset_id: KMOI_ASSET_ID, callsite: "Transfer", calldata: String(funding.calldata ?? "") },
        },
      },
    ],
    participants: [{ id: KMOI_ASSET_ID, lock_type: LockType.NO_LOCK }],
  };
}

/** Asset transfer. The recipient must be declared as a participant. */
export function buildTransfer(
  sender: SenderInfo,
  params: { to: string; assetId: string; amount: bigint },
  options: BuildOptions = {},
): UnsignedInteraction {
  // POLO encodes a bigint full-width but a number compactly, so `1n` and `1`
  // produce different calldata for the same value. The SDK's own builder
  // passes a number; match it wherever the amount fits one.
  const amount =
    params.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(params.amount) : params.amount;

  const payload = buildTransferPayload(
    params.assetId as `0x${string}`,
    params.to as `0x${string}`,
    amount,
  );

  // Shape matched against js-moi-sdk's own MAS0AssetLogic().transfer().ixData(),
  // which is what the reference dapp sends. Three things differ from the
  // obvious hand-rolled version and all of them matter:
  //   - no `funds` block; the transfer amount lives in the calldata
  //   - the ASSET is declared as a second, NO_LOCK participant
  //   - calldata carries no 0x prefix
  const calldata = String((payload as { calldata?: string }).calldata ?? "").replace(/^0x/, "");

  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...(payload as unknown as Record<string, unknown>), calldata },
      },
    ],
    participants: [
      { id: params.to, lock_type: LockType.MUTATE_LOCK },
      { id: params.assetId, lock_type: LockType.NO_LOCK },
    ],
  };
}

/**
 * KMOI's decimals, for turning base units into something a person can read.
 * Fixed at 9 on MOI networks and confirmed live against voyage devnet.
 */
export const KMOI_DECIMALS = 9;

/** Base units as KMOI, for error text only: 6072387694n -> "6.072387694". */
export function asKmoi(baseUnits: bigint): string {
  const s = baseUnits.toString().padStart(KMOI_DECIMALS + 1, "0");
  const whole = s.slice(0, -KMOI_DECIMALS);
  const frac = s.slice(-KMOI_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Storage fund sent with a new asset so it can pay for its own storage, in
 * KMOI BASE UNITS.
 *
 * Taken from the SDK rather than written down here, because the number moved
 * by four orders of magnitude when KMOI gained 9 decimals in the September
 * 2026 upgrade, and a stale copy is exactly what broke asset creation: the
 * old 1,000,000 is 0.001 KMOI on the upgraded chain, far below the floor.
 */
export const DEFAULT_STORAGE_FUND = BigInt(SDK_DEFAULT_STORAGE_FUND);

/**
 * The smallest storage fund the chain accepted for a new asset when it was
 * measured, in KMOI base units: 6,082,031,250, about 6.08 KMOI. A measurement,
 * not a computation. The refusal text quotes it (as about 6.1 KMOI), a unit
 * test keeps MIN_STORAGE_FUND within 110 to 130 percent of it, and the nightly
 * chain canary (test/e2e/chain-canary.test.ts) watches it. How much a create is
 * actually funded with is decided by MIN_STORAGE_FUND and DEFAULT_STORAGE_FUND.
 *
 * What was measured, where and when. Binary search on voyage devnet, after the
 * September 2026 chain upgrade, on the receipt status of a simulated create: a
 * fund the chain accepts simulates to status 0, a smaller one to status 1. The
 * result was recorded on 22 September 2026 (commit 9e73772): 6,072,387,694 for
 * a short symbol and 6,082,031,250 for the 12-character maximum, so the floor
 * moves with the length of the symbol and this constant is the larger figure.
 * That figure is exactly 1557/256 KMOI, a round binary fraction, so it may be
 * where a bisection stopped and not the true floor: read it as an upper bound.
 * The figures are for a create like the canary's (MAS0, not stateful, decimals
 * 0, dimension 0). The record does not say whether another shape costs more.
 *
 * Why it is not read from the node. getStoragePricing (moi.StoragePricing)
 * answers a price per byte, a multiplier and a second per-byte figure. It does
 * not say how many bytes a new asset account takes or how the three combine,
 * and js-moi-sdk says in its own comments that a client cannot know what a
 * create's storage costs (js-moi-constants, storage.ts). A formula built on
 * those numbers would be a guess, and a wrong guess lowers the floor without
 * anyone noticing, where a stale constant fails loudly: assertWillSucceed
 * (src/tools/write-core.ts) refuses the create at its simulation.
 *
 * What watches it. The canary simulates a create funded 5 percent above this
 * constant (it must pass) and one funded 10 percent below it (it must fail), and
 * checks that the storage pricing still equals the three raw strings read from
 * devnet on 2 October 2026. That is when the pricing began to be watched, ten
 * days after the floor was recorded.
 *
 * To re-measure, when one of those fails. There is no script, so write a
 * throwaway one: build the canary's create with a 1-character and a 12-character
 * symbol, simulate it with provider.call over a range of storageFund, and
 * bisect on receipt.status === 0 down to one base unit (about 35 simulations
 * per symbol, nothing is signed, no fuel is spent). Then, in one commit: set
 * this constant to the larger result, keep MIN_STORAGE_FUND within 110 to 130
 * percent of it, copy getStoragePricing's three raw strings into
 * PRICING_WHEN_FLOOR_MEASURED in the canary, and correct the figure the docs
 * quote (docs/local-testing.md and docs/testing-plan.md say about 6.1 KMOI).
 */
export const MEASURED_STORAGE_FLOOR = 6_082_031_250n;

/**
 * What a create is funded with when the caller gives no storageFund and the
 * balance cannot carry DEFAULT_STORAGE_FUND, in KMOI base units: the measured
 * floor plus about 15 percent, so that a small repricing does not turn every
 * automatic create into a failure. This is this server's margin, not the
 * chain's floor, and no message may present it as the chain's.
 */
export const MIN_STORAGE_FUND = 7_000_000_000n;

/**
 * Held back in KMOI base units so the interaction can still pay its own fuel.
 *
 * Measured: an asset create burns 3,404 fuel. At the SDK's price of 50 that is
 * 170,200 base units, so 1,000,000 (0.001 KMOI) leaves ample margin.
 */
export const FUEL_RESERVE = 1_000_000n;

/**
 * Choose a storage fund the caller can actually afford, in KMOI base units.
 *
 * Nobody creating a token should have to reason about storage funding, and
 * the failure when it is wrong is opaque: the ASSET_CREATE operation reports
 * success while the interaction reports status 1. So: prefer the SDK default,
 * fall back to the floor when the balance cannot carry it, and refuse clearly
 * only when even the floor is out of reach.
 */
export function chooseStorageFund(balance: bigint): bigint {
  const affordable = balance > FUEL_RESERVE ? balance - FUEL_RESERVE : 0n;
  if (affordable < MIN_STORAGE_FUND) {
    throw new MoiError(
      ErrorCode.INSUFFICIENT_BALANCE,
      `Creating an asset needs at least ${MIN_STORAGE_FUND} base units of KMOI ` +
        `(${asKmoi(MIN_STORAGE_FUND)} KMOI) to fund its storage, plus ${FUEL_RESERVE} ` +
        `(${asKmoi(FUEL_RESERVE)} KMOI) held back for fuel, but this account holds ` +
        `${balance} (${asKmoi(balance)} KMOI). Fund the account from the faucet. ` +
        `storageFund is denominated in base units, not whole KMOI.`,
      { balance: balance.toString(), minimum: MIN_STORAGE_FUND.toString() },
    );
  }
  // Fund the default when the account can clearly carry it. Otherwise fund the
  // minimum rather than everything affordable: handing the asset the entire
  // balance above the fuel reserve is how creating a 100-supply test token ate
  // half an account. The money is not burned, it sits in the asset's own
  // account, but it is no longer spendable from yours.
  if (affordable >= DEFAULT_STORAGE_FUND) return DEFAULT_STORAGE_FUND;
  return MIN_STORAGE_FUND;
}

/**
 * Build an asset creation.
 *
 * A bare ASSET_CREATE operation does NOT work: MOI makes a new asset self-pay
 * for its storage the moment it is created, and a freshly derived asset
 * account holds no KMOI. The create must be bundled with a transfer funding
 * the asset id it is about to produce — which means predicting that id, via
 * deriveAssetId, before it exists.
 *
 * Symptom if you skip it: the ASSET_CREATE operation reports success and
 * returns a valid asset_id while the interaction as a whole fails with
 * status 1 and no diagnostic.
 */
export function buildCreateAsset(
  sender: SenderInfo,
  params: {
    symbol: string;
    supply: bigint;
    decimals: number;
    dimension: number;
    standard: string;
    isStateful: boolean;
    isFungible: boolean;
    /** KMOI to fund the new asset with. Too little and storage fails. */
    storageFund?: bigint;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const standardCode = (AssetStandard as unknown as Record<string, number>)[params.standard];
  if (standardCode === undefined) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Unknown asset standard "${params.standard}". Expected one of MAS0, MAS1, MAS2, MASX.`,
      { standard: params.standard },
    );
  }

  // Predict the asset id this create will produce so the funding transfer can
  // address it. deriveAssetId mirrors the chain's own derivation — a wrong
  // prediction sends the funds to an account that will never exist.
  const assetId = deriveAssetId(
    { id: sender.id as `0x${string}`, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    standardCode,
  ).toHex();

  const fund = params.storageFund ?? DEFAULT_STORAGE_FUND;
  const funding = buildTransferPayload(
    KMOI_ASSET_ID as `0x${string}`,
    assetId as `0x${string}`,
    fund <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fund) : fund,
  ) as unknown as Record<string, unknown>;

  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_CREATE,
        // Field names and types come from js-moi-sdk's AssetCreatePayload.
        // max_supply must be a number|bigint — a decimal string fails POLO
        // serialisation inside the wallet with "Failed to sign interaction",
        // and there is no `supply` field at all.
        payload: {
          symbol: params.symbol,
          max_supply: params.supply,
          decimals: params.decimals,
          dimension: params.dimension,
          standard: standardCode,
          enable_events: params.isStateful,
          manager: sender.id,
        },
      },
      // Without this the ASSET_CREATE operation succeeds and the interaction
      // still fails: the new asset has no KMOI to pay its own storage.
      {
        type: OpType.ASSET_INVOKE,
        payload: {
          ...funding,
          calldata: String(funding["calldata"] ?? "").replace(/^0x/, ""),
        },
      },
    ],
  };
}

/**
 * Mint tokens of an existing asset.
 *
 * Delegates the calldata to the SDK's own MAS0AssetLogic.mint(). Hand-rolling
 * the POLO encoding produces a plain struct where the runtime expects a
 * document, and the node rejects it with "missing data for 'beneficiary'".
 *
 * Cannot be bundled into the create: the asset account does not exist until
 * that interaction commits, so declaring it as a participant fails with
 * "account not found". Minting is always a second interaction.
 */
export async function buildMint(
  signer: unknown,
  sender: SenderInfo,
  params: { assetId: string; to: string; amount: bigint },
  options: BuildOptions = {},
): Promise<UnsignedInteraction> {
  const { MAS0AssetLogic } = await import("js-moi-sdk");
  const amount = params.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(params.amount) : params.amount;

  let payload: Record<string, unknown> | undefined;
  try {
    const logic = new MAS0AssetLogic(params.assetId, signer as never) as unknown as {
      mint: (to: string, amt: number | bigint) => { ctx?: { payload?: Record<string, unknown> } };
    };
    payload = logic.mint(params.to, amount).ctx?.payload;
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not build a mint for ${params.assetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode a mint for ${params.assetId}.`);
  }

  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...payload, calldata: String(payload["calldata"] ?? "").replace(/^0x/, "") },
      },
    ],
    // Matches MAS0AssetLogic.mint(): the asset and the beneficiary, both MUTATE.
    participants: [
      { id: params.assetId, lock_type: LockType.MUTATE_LOCK },
      { id: params.to, lock_type: LockType.MUTATE_LOCK },
    ],
  };
}

/** How a tool-level lock name maps onto the chain's lock types. */
export const LOCK_BY_NAME: Record<"mutate" | "read" | "none", number> = {
  mutate: LockType.MUTATE_LOCK,
  read: LockType.READ_LOCK,
  none: LockType.NO_LOCK,
};

/**
 * A logic call declares the logic itself and, when the caller says so, the
 * other accounts and assets the routine moves value for. The node executes
 * on the declared set: a routine that transfers an undeclared asset fails
 * with "actor not found" at execution, not at simulation, so the caller has
 * to know. Nothing is added for the sender; the SDK does that.
 */
export function buildLogicInvoke(
  sender: SenderInfo,
  params: {
    logicId: string;
    callsite: string;
    calldata?: string;
    participants?: Array<{ id: string; lock: "mutate" | "read" | "none" }>;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const extra = params.participants ?? [];
  const declared = new Map<string, number>();
  for (const p of extra) {
    const lock = LOCK_BY_NAME[p.lock];
    const id = p.id.toLowerCase();
    // The strongest lock wins if the same id is named twice.
    declared.set(id, Math.min(lock, declared.get(id) ?? lock));
  }
  if (extra.length > 0 && !declared.has(params.logicId.toLowerCase())) {
    // A routine that moves value changes the logic's own records too.
    declared.set(params.logicId.toLowerCase(), LockType.MUTATE_LOCK);
  }
  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.LOGIC_INVOKE,
        payload: {
          logic_id: params.logicId,
          callsite: params.callsite,
          ...(params.calldata ? { calldata: params.calldata } : {}),
        },
      },
    ],
    ...(declared.size > 0
      ? { participants: [...declared.entries()].map(([id, lock_type]) => ({ id, lock_type })) }
      : {}),
  };
}

/**
 * One asset routine call: a single ASSET_INVOKE operation, the shape the SDK's own AssetDriver and asset classes
 * produce. `calldata` is what ManifestCoder.encodeArguments returned for the routine's inputs; it is left out for a
 * routine that takes none, as the SDK does (it refuses an empty one), and a 0x prefix is stripped so the payload is
 * byte-identical to what buildTransfer and buildMint emit. The same id named twice keeps its first spelling and the
 * strongest lock. The order given is not the order signed: js-moi-providers rebuilds the list asset-first when the
 * interaction is estimated, called or encoded (processParticipants). Nothing is added for the sender or the asset
 * here; that normalisation does it.
 */
export function buildAssetInvoke(
  sender: SenderInfo,
  params: {
    assetId: string;
    callsite: string;
    calldata?: string;
    participants?: Array<{ id: string; lock: "mutate" | "read" | "none" }>;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const declared = new Map<string, { id: string; lock_type: number }>();
  for (const p of params.participants ?? []) {
    const key = p.id.toLowerCase();
    const lock = LOCK_BY_NAME[p.lock];
    const seen = declared.get(key);
    if (!seen) declared.set(key, { id: p.id, lock_type: lock });
    else if (lock < seen.lock_type) seen.lock_type = lock; // MUTATE 0 < READ 1 < NO_LOCK 2: the strongest wins
  }
  const calldata = (params.calldata ?? "").replace(/^0x/, "");
  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { asset_id: params.assetId, callsite: params.callsite, ...(calldata ? { calldata } : {}) },
      },
    ],
    ...(declared.size > 0 ? { participants: [...declared.values()] } : {}),
  };
}

/**
 * The id a logic deployed by this sender at this sequence will get. deriveLogicId mirrors the chain's own derivation, and
 * the id depends on the exact sequence, so it changes if another interaction from the sender lands first.
 */
export function predictLogicId(sender: SenderInfo): string {
  return deriveLogicId({
    id: sender.id as `0x${string}`,
    sequence: sender.sequence,
    key_id: sender.keyId ?? 0,
  }).toHex();
}

/**
 * Deploy a logic: one LOGIC_DEPLOY operation and, bundled with it, a KMOI transfer of the SDK's default storage fund
 * (10 KMOI) to the logic's own account.
 *
 * A new logic pays for its own account-creation storage the moment it is created and a freshly derived logic account holds
 * no KMOI, so a bare LOGIC_DEPLOY reverts. The SDK's LogicFactory.deploy bundles the same funding operation
 * (node_modules/js-moi-logic, logic-base.ts, createIxObject) and this builder is checked against it byte for byte
 * (test/unit/ix-builder-deploy.test.ts). The funding names the id the deploy will produce, derived by predictLogicId: a
 * wrong prediction sends the funds to an account that never exists. The amount is not a parameter: a deploy always funds
 * the default, so no caller can move more of the person's KMOI into code the caller wrote.
 *
 * `manifest` is the POLO hex ManifestCoder.encodeManifest returns, 0x prefix included, and `calldata` is the encoded
 * input of the deploy routine, left out for a routine that takes none; both go into the payload as they are, as the SDK's
 * LogicFactory puts them. `callsite` is the deploy routine's name. The new logic is never declared as a participant: it
 * does not exist yet, and declaring an account that does not exist fails with "account not found". KMOI is declared by the
 * funding operation (the SDK's processParticipants adds it). Participants the caller names are kept as they are named: the
 * same id twice keeps its first spelling and the strongest lock, as buildAssetInvoke does.
 */
export function buildLogicDeploy(
  sender: SenderInfo,
  params: {
    manifest: string;
    callsite: string;
    calldata?: string;
    participants?: Array<{ id: string; lock: "mutate" | "read" | "none" }>;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const funding = buildTransferPayload(
    KMOI_ASSET_ID as `0x${string}`,
    predictLogicId(sender) as `0x${string}`,
    DEFAULT_STORAGE_FUND <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(DEFAULT_STORAGE_FUND) : DEFAULT_STORAGE_FUND,
  ) as unknown as Record<string, unknown>;

  const declared = new Map<string, { id: string; lock_type: number }>();
  for (const p of params.participants ?? []) {
    const key = p.id.toLowerCase();
    const lock = LOCK_BY_NAME[p.lock];
    const seen = declared.get(key);
    if (!seen) declared.set(key, { id: p.id, lock_type: lock });
    else if (lock < seen.lock_type) seen.lock_type = lock; // MUTATE 0 < READ 1 < NO_LOCK 2: the strongest wins
  }

  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.LOGIC_DEPLOY,
        payload: {
          manifest: params.manifest,
          callsite: params.callsite,
          ...(params.calldata ? { calldata: params.calldata } : {}),
        },
      },
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...funding, calldata: String(funding["calldata"] ?? "").replace(/^0x/, "") },
      },
    ],
    ...(declared.size > 0 ? { participants: [...declared.values()] } : {}),
  };
}

/**
 * A node quantity as a non-negative integer that fits a number, or undefined when it cannot be read as one. The node sends
 * quantities as numbers or as 0x-hex or decimal strings, and the SDK may hand over a bigint; anything else (missing, null,
 * empty, text, a float, a negative, an object, an array, a value past 2^53) is unreadable. Never throws: BigInt("abc") does.
 */
function readQuantity(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  let value: bigint;
  if (typeof raw === "bigint") value = raw;
  else if (typeof raw === "string" && /^(0x[0-9a-f]+|[0-9]+)$/i.test(raw)) value = BigInt(raw);
  else return undefined;
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/** Why a dry run that gave no usable receipt status is a failure: it is not known to succeed. */
const NO_READABLE_STATUS = "the node's dry run came back with no readable receipt status, so it is not known to succeed";

/**
 * Dry-run an interaction against the node before a human is asked to approve it.
 *
 * `provider.call` executes the interaction in simulation and returns a receipt.
 * A receipt status other than 0 means it would revert on chain — burning fuel
 * and achieving nothing. Catching that here means the user is never shown an
 * approval for an interaction that cannot succeed.
 *
 * Fails closed: only a status that reads as 0 passes. A call that throws, a reply with no receipt, and a receipt whose
 * status is missing, null, empty or unreadable all come back ok: false, never as a pass and never as a throw. `status` is
 * undefined in those cases, which is how a caller tells "the node said no" from "the node said nothing usable".
 */
export async function simulate(
  caller: { call: (ix: unknown) => Promise<unknown> },
  ix: UnsignedInteraction,
): Promise<{ ok: boolean; status?: number; fuelUsed?: number; detail?: string }> {
  let receipt: unknown;
  try {
    const response = (await caller.call(ix)) as { receipt?: unknown } | null | undefined;
    receipt = response?.receipt;
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }

  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    return { ok: false, detail: NO_READABLE_STATUS };
  }
  const fields = receipt as Record<string, unknown>;
  const status = readQuantity(fields["status"]);
  if (status === undefined) return { ok: false, detail: NO_READABLE_STATUS };
  const fuelUsed = readQuantity(fields["fuel_used"]);
  if (status === 0) return { ok: true, status, fuelUsed };

  // Surface any per-operation error the node bothered to fill in. The error
  // arrives POLO-encoded ("0x0e7f06…"); best-effort extract the printable
  // strings inside so the user reads "builtin.AssetError insufficient funds"
  // rather than a hex blob.
  const ops = Array.isArray(fields["ix_operations"]) ? (fields["ix_operations"] as unknown[]) : [];
  const opDetail = ops
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
    .map((o) => {
      const data = (o["data"] ?? {}) as Record<string, unknown>;
      const err = String(data["error"] ?? "");
      if (err && err !== "0x") return decodeErrorHex(err) ?? err;
      return `op status ${String(o["status"])}`;
    })
    .join("; ");

  return { ok: false, status, fuelUsed, detail: opDetail };
}

/** Pull printable ASCII runs (≥4 chars) out of a POLO-encoded error blob. */
export function decodeErrorHex(hex: string): string | undefined {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length < 8) return undefined;
  const runs: string[] = [];
  let current = "";
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (byte >= 0x20 && byte < 0x7f) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 4) runs.push(current);
      current = "";
    }
  }
  if (current.length >= 4) runs.push(current);
  return runs.length ? quoteChainText(runs.join(" ")) : undefined;
}

/**
 * Text that came from the chain or a node, made safe to put in front of a
 * model: control characters stripped, whitespace collapsed, length capped,
 * and wrapped in quotes so it reads as something that was said, not an
 * instruction. A revert reason is data, whoever wrote it.
 */
export function quoteChainText(text: string, max = 240): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const capped = clean.length > max ? clean.slice(0, max - 1) + "\u2026" : clean;
  return `"${capped}"`;
}

/**
 * Measure the fuel an interaction needs, with headroom.
 *
 * Falls back to DEFAULT_FUEL_LIMIT when the node cannot simulate — asset
 * creation currently reverts during estimation on devnet, and refusing to
 * build the interaction over that would be worse than overestimating.
 */
export async function estimateFuelFor(
  estimator: { estimateFuel: (ix: unknown) => Promise<number | bigint> },
  ix: UnsignedInteraction,
): Promise<{ fuelLimit: number; estimated: boolean; reason?: string }> {
  try {
    const raw = await estimator.estimateFuel(ix);
    const measured = Number(raw);
    if (!Number.isFinite(measured) || measured <= 0) {
      return { fuelLimit: DEFAULT_FUEL_LIMIT, estimated: false, reason: "node returned no usable estimate" };
    }
    return { fuelLimit: Math.ceil(measured * FUEL_MARGIN), estimated: true };
  } catch (err) {
    return {
      fuelLimit: DEFAULT_FUEL_LIMIT,
      estimated: false,
      reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
    };
  }
}

/** Reject anything the node would reject anyway, with a clearer message. */
export function assertSendable(ix: UnsignedInteraction): void {
  if (ix.ix_operations.length === 0) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Interaction has no operations.");
  }
  if (ix.ix_operations.length > MAX_OPERATIONS) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `An interaction may carry at most ${MAX_OPERATIONS} operations, got ${ix.ix_operations.length}.`,
    );
  }
}

/**
 * Render an interaction as JSON-safe values for the WalletConnect wire.
 *
 * The two encodings disagree about numbers. POLO requires number|bigint for
 * amounts; JSON cannot represent a bigint at all — JSON.stringify throws
 * "Do not know how to serialize a BigInt", which the relay surfaces as an
 * opaque request failure. So we keep bigint internally (toPoloHex needs it)
 * and convert only at the transport boundary.
 *
 * Values beyond Number.MAX_SAFE_INTEGER become decimal strings rather than
 * silently losing precision — MOI supplies can exceed 2^53.
 */
export function toWireJson(ix: UnsignedInteraction): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(ix, (_key, value: unknown) =>
      typeof value === "bigint"
        ? value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value.toString()
        : value,
    ),
  ) as Record<string, unknown>;
}

/**
 * POLO-encode to the node-level `ix_args` hex. Mirrors js-moi-wallet's
 * serializeIxObject using only public exports — and without a key, since
 * encoding and signing are separate steps.
 *
 * Returns UNPREFIXED hex. js-moi-wallet sets `ix_args: bytesToHex(ixData)`,
 * and the node's documented payload is bare hex too. Do not add "0x".
 */
export function toPoloHex(ix: UnsignedInteraction): string {
  try {
    const polorizer = new Polorizer();
    polorizer.polorize(toRawInteractionObject(ix as never), ixObjectSchema);
    return bytesToHex(polorizer.bytes());
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not POLO-encode the interaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Logic call encoding
// ---------------------------------------------------------------------------

interface RoutineCtx {
  ctx?: { opType?: number; payload?: Record<string, unknown> };
}

/** What the SDK's logic driver can say about a manifest's callables: the kind declared for each name (the last declaration of a name wins). */
export interface CallsiteReader {
  getCallsites?: () => Map<string, { kind?: string }>;
}

/**
 * Refuse a call to a routine the manifest declares as a deploy routine, and say where a deploy goes. The SDK's driver offers
 * only invoke and enlist routines, so a deploy routine would otherwise read as a name the logic does not have. It runs once,
 * when a logic is deployed (protocol docs, logics.md, "Endpoint Qualifiers"). Call it only for a name the driver does not
 * offer: for one it offers, the SDK has already decided what the call is, and logicCallKind follows that.
 */
export function assertNotDeployRoutine(driver: CallsiteReader, logicId: string, name: string): void {
  if (driver.getCallsites?.().get(name)?.kind !== "deploy") return;
  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `${quoteChainText(name, 64)} is a deploy routine of logic ${logicId}. A deploy routine runs once, when a logic is deployed, and cannot be called on a ` +
      "logic that already exists. To deploy a new logic from its compiled manifest use moi_deploy_logic. Nothing was sent to your wallet.",
    { logicId, callsite: name, kind: "deploy" },
  );
}

/**
 * What a logic call is sent as, from the operation type the SDK built for it: LOGIC_INVOKE or LOGIC_ENLIST, nothing else. The
 * driver chooses the type from the routine's declared kind (js-moi-logic, logic-base.ts, getTxType). A second lookup of the
 * kind by name, in the driver's callsite map, disagrees with it when a manifest declares one name twice, so this reads the
 * request instead, and an SDK that stops saying fails closed.
 */
export function logicCallKind(opType: number | undefined, callsite: string): "invoke" | "enlist" {
  if (opType === OpType.LOGIC_INVOKE) return "invoke";
  if (opType === OpType.LOGIC_ENLIST) return "enlist";
  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `Could not tell which operation a call to ${quoteChainText(callsite, 64)} is sent as. Nothing was sent to your wallet.`,
    { callsite, opType: opType ?? null },
  );
}

/**
 * Ask the SDK's logic driver to encode a routine call, rather than
 * hand-rolling POLO calldata. Calling `driver.routines.X(...args)` returns a
 * request whose `ctx.payload` is exactly the payload we need: `{ logic_id, callsite, calldata }`. The same shape serves
 * LOGIC_INVOKE and LOGIC_ENLIST (js-moi-providers, LogicActionPayload); `kind` says which one the request's `ctx.opType` is.
 * The driver offers invoke and enlist routines only; a deploy routine is refused by name (assertNotDeployRoutine).
 */
export async function encodeLogicCall(
  signer: unknown,
  logicId: string,
  callsite: string,
  args: unknown[],
): Promise<{ logic_id: string; callsite: string; calldata?: string; kind: "invoke" | "enlist" }> {
  const { getLogicDriver } = await import("js-moi-sdk");
  let driver: CallsiteReader & { routines: Record<string, (...a: unknown[]) => Promise<RoutineCtx>> };
  try {
    driver = (await getLogicDriver(logicId, signer as never)) as never;
  } catch (err) {
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `Could not load logic ${logicId}: ${err instanceof Error ? err.message : String(err)}`,
      { logicId },
    );
  }

  // Own properties only: `routines` is a plain object, so a name like "constructor" is a function on it that the manifest never
  // declared, and calling that with arguments shaped like a request would make the caller's object the request.
  const routine = Object.hasOwn(driver.routines, callsite) ? driver.routines[callsite] : undefined;
  if (typeof routine !== "function") {
    assertNotDeployRoutine(driver, logicId, callsite);
    const available = Object.keys(driver.routines ?? {}).join(", ");
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Logic ${logicId} has no routine "${callsite}". Available: ${available || "(none)"}.`,
      { logicId, callsite, available },
    );
  }

  const request = await routine(...args);
  const payload = request.ctx?.payload;
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode a call to ${callsite}.`);
  }
  return {
    ...(payload as { logic_id: string; callsite: string; calldata?: string }),
    kind: logicCallKind(request.ctx?.opType, callsite),
  };
}
