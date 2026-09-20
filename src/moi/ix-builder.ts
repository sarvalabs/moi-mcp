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
  bytesToHex,
  buildTransferPayload,
  deriveAssetId,
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

export const DEFAULT_FUEL_PRICE = 1;

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
 * Default KMOI sent to a newly created asset so it can pay for its own
 * storage. Mirrors js-moi-constants' DEFAULT_STORAGE_FUND.
 */
export const DEFAULT_STORAGE_FUND = 1_000_000n;

/**
 * Least KMOI that actually covers a new MAS0 asset's storage.
 *
 * Measured against voyage devnet by binary search: 6,093 is the exact floor,
 * and it does not move with symbol length (1 vs 12 chars) or dimension (0 vs
 * 18). Rounded up for margin against pricing changes.
 */
export const MIN_STORAGE_FUND = 10_000n;

/**
 * KMOI held back so the interaction can still pay its own fuel.
 *
 * Measured: an asset create costs 3,404 fuel and a mint 458. 10,000 leaves
 * ample margin without locking an account out of creating a second asset —
 * a 25,000 reserve made a 21,596 balance unusable despite being plenty.
 */
export const FUEL_RESERVE = 10_000n;

/**
 * Choose a storage fund the caller can actually afford.
 *
 * Nobody creating a token should have to reason about storage funding, but
 * the SDK's 1,000,000 default silently exceeds most devnet balances and the
 * resulting failure is opaque (the ASSET_CREATE operation reports success
 * while the interaction reports status 1). So: prefer the SDK default, fall
 * back to whatever the balance allows, and refuse clearly only when even the
 * floor is out of reach.
 */
export function chooseStorageFund(balance: bigint): bigint {
  const affordable = balance > FUEL_RESERVE ? balance - FUEL_RESERVE : 0n;
  if (affordable < MIN_STORAGE_FUND) {
    throw new MoiError(
      ErrorCode.INSUFFICIENT_BALANCE,
      `Creating an asset needs at least ${MIN_STORAGE_FUND} KMOI to fund its storage ` +
        `(plus ~${FUEL_RESERVE} held back for fuel), but this account holds ${balance}. ` +
        `Fund the account, or pass a smaller storageFund explicitly if you know better.`,
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

export function buildLogicInvoke(
  sender: SenderInfo,
  params: { logicId: string; callsite: string; calldata?: string },
  options: BuildOptions = {},
): UnsignedInteraction {
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
  };
}

/**
 * Dry-run an interaction against the node before a human is asked to approve it.
 *
 * `provider.call` executes the interaction in simulation and returns a receipt.
 * A receipt status other than 0 means it would revert on chain — burning fuel
 * and achieving nothing. Catching that here means the user is never shown an
 * approval for an interaction that cannot succeed.
 */
export async function simulate(
  caller: { call: (ix: unknown) => Promise<unknown> },
  ix: UnsignedInteraction,
): Promise<{ ok: boolean; status?: number; fuelUsed?: number; detail?: string }> {
  let receipt: Record<string, unknown>;
  try {
    const response = (await caller.call(ix)) as { receipt?: Record<string, unknown> };
    receipt = response?.receipt ?? {};
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }

  const status = Number(BigInt(String(receipt["status"] ?? 0)));
  const fuelUsed = Number(BigInt(String(receipt["fuel_used"] ?? 0)));
  if (status === 0) return { ok: true, status, fuelUsed };

  // Surface any per-operation error the node bothered to fill in. The error
  // arrives POLO-encoded ("0x0e7f06…"); best-effort extract the printable
  // strings inside so the user reads "builtin.AssetError insufficient funds"
  // rather than a hex blob.
  const ops = (receipt["ix_operations"] ?? []) as Array<Record<string, unknown>>;
  const opDetail = ops
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

/**
 * Ask the SDK's logic driver to encode a routine call, rather than
 * hand-rolling POLO calldata. Calling `driver.routines.X(...args)` returns a
 * request whose `ctx.payload` is exactly the LOGIC_INVOKE payload we need:
 * `{ logic_id, callsite, calldata }`.
 */
export async function encodeLogicCall(
  signer: unknown,
  logicId: string,
  callsite: string,
  args: unknown[],
): Promise<{ logic_id: string; callsite: string; calldata?: string }> {
  const { getLogicDriver } = await import("js-moi-sdk");
  let driver: { routines: Record<string, (...a: unknown[]) => Promise<RoutineCtx>> };
  try {
    driver = (await getLogicDriver(logicId, signer as never)) as never;
  } catch (err) {
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `Could not load logic ${logicId}: ${err instanceof Error ? err.message : String(err)}`,
      { logicId },
    );
  }

  const routine = driver.routines[callsite];
  if (typeof routine !== "function") {
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
  return payload as { logic_id: string; callsite: string; calldata?: string };
}
