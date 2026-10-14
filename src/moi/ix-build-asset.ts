/**
 * The operations of an asset creation, for MAS0, MAS1, MAS2 and MASX, and the id the new asset will get. Split out of
 * src/moi/ix-builder.ts, which re-exports everything public here (buildCreateAsset there wraps the operations in the
 * interaction's sender and fuel). No MCP imports and no keys, like the file it came from.
 *
 * This file imports only types from ix-builder.ts, which the build erases, so the two files do not depend on each
 * other at run time.
 */

import { AssetStandard, buildTransferPayload, deriveAssetId, KMOI_ASSET_ID, OpType } from "js-moi-sdk";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import type { SenderInfo, UnsignedInteraction } from "./ix-builder.js";

/**
 * The standards buildCreateAsset builds, by name. Own keys only, and a list of its own: the SDK's AssetStandard enum also
 * answers a number written as text ("0") and MASN, which cannot be created, so a lookup through it would build a create
 * for something no tool offers. MASX joins the three built-in standards because AssetFactory builds it.
 */
const CREATABLE_CODES: Readonly<Record<string, number>> = {
  MAS0: AssetStandard.MAS0,
  MAS1: AssetStandard.MAS1,
  MAS2: AssetStandard.MAS2,
  MASX: AssetStandard.MASX,
};

/** The names of the standards buildCreateAsset builds. A test keeps it equal to the schema's list. */
export const BUILDABLE_STANDARDS: readonly string[] = Object.keys(CREATABLE_CODES);

function creatableCode(standard: string): number {
  if (Object.hasOwn(CREATABLE_CODES, standard)) return CREATABLE_CODES[standard] as number;
  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `Unknown asset standard "${standard}". Expected one of MAS0, MAS1, MAS2, MASX.`,
    { standard },
  );
}

/**
 * The id an asset created by this sender at this sequence will get. It depends on the standard (the standard's code is
 * part of the id), and so does the address the funding transfer pays. deriveAssetId mirrors the chain's own derivation: a
 * wrong prediction sends the funds to an account that will never exist.
 */
export function predictAssetId(sender: SenderInfo, standard: string): string {
  return deriveAssetId(
    { id: sender.id as `0x${string}`, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    creatableCode(standard),
  ).toHex();
}

/**
 * The logic payload of a MASX create, as AssetFactory.create puts it: the manifest as ManifestCoder.encodeManifest returns
 * it (0x and hex), and the callsite and calldata only when the manifest has a deploy routine to run and that routine takes
 * inputs. A manifest with no deploy routine sends the manifest alone, with no callsite key.
 */
export interface MasxCreate {
  manifest: string;
  callsite?: string;
  calldata?: string;
}

/** What MAS1 and MAS2 send as their logic payload: no manifest, because the chain has the standard's manifest built in. */
const INIT_PAYLOAD = { manifest: "0x", callsite: "Init" } as const;

function refuse(message: string): never {
  throw new MoiError(ErrorCode.INVALID_ARGS, message);
}

/** What a create is built from. The caller has already planned it (src/capabilities/assets/create-plan.ts); the builder checks it again. */
export interface CreateAssetParams {
  symbol: string;
  /** In base units. Required for MAS0, MAS2 and MASX, refused for MAS1. */
  supply?: bigint;
  /** MAS0 and MAS2 only (default 0). MAS1 and MASX send no decimals and refuse one. */
  decimals?: number;
  dimension: number;
  standard: string;
  isStateful: boolean;
  isFungible: boolean;
  /** KMOI to fund the new asset with. Too little and storage fails. */
  storageFund?: bigint;
  /** MASX only: the manifest and the deploy routine's call. Required for MASX, refused for every other standard. */
  masx?: MasxCreate;
}

/**
 * The operations of an asset creation, for MAS0, MAS1, MAS2 or MASX. Each standard's payload is the one the SDK builds for it
 * (MAS0AssetLogic.create, MAS1AssetLogic.create, MAS2AssetLogic.create and AssetFactory.create in js-moi-asset), field by
 * field, and test/unit/ix-builder-create-asset.test.ts compares the bytes.
 *
 * - MAS0: symbol, max_supply, decimals, dimension, standard, enable_events and manager. No logic payload.
 * - MAS1: single-unit, so max_supply is the number 1 and there is no decimals key. The logic payload is the standard's
 *   built-in Init: an empty manifest and the callsite "Init".
 * - MAS2: as MAS0, plus the same built-in Init payload.
 * - MASX: as MAS0 without decimals, plus the caller's manifest and, when it has a deploy routine, its callsite and calldata.
 *
 * Whatever the SDK would not send is refused here too (a supply for MAS1, decimals for MAS1 or MASX, a manifest for a
 * built-in standard), so this is the last gate and not the only one: the tool refuses the same cases first, in plain words.
 *
 * A bare ASSET_CREATE operation does NOT work: MOI makes a new asset self-pay
 * for its storage the moment it is created, and a freshly derived asset
 * account holds no KMOI. The create must be bundled with a transfer funding
 * the asset id it is about to produce, which means predicting that id, with
 * predictAssetId, before it exists.
 *
 * Symptom if you skip it: the ASSET_CREATE operation reports success and
 * returns a valid asset_id while the interaction as a whole fails with
 * status 1 and no diagnostic.
 */
export function buildCreateAssetOperations(
  sender: SenderInfo,
  params: CreateAssetParams,
  /** KMOI base units that fund the new asset's account; the caller picks the default. */
  fund: bigint,
): UnsignedInteraction["ix_operations"] {
  const standardCode = creatableCode(params.standard);
  const { standard, symbol, supply, decimals, masx } = params;

  if (standard !== "MASX" && masx !== undefined) refuse(`A ${standard} create takes no manifest: only MASX is made from one.`);
  if (standard === "MASX" && masx === undefined) refuse("A MASX create needs its manifest.");
  if (standard === "MAS1" && (supply !== undefined || decimals !== undefined)) {
    refuse("A MAS1 create takes no supply and no decimals: MAS1 is single-unit and the SDK sends neither.");
  }
  if (standard === "MASX" && decimals !== undefined) refuse("A MASX create sends no decimals: the SDK's asset factory has no such field.");
  if (standard !== "MAS1" && supply === undefined) refuse(`A ${standard} create needs a supply.`);

  const common = {
    symbol,
    dimension: params.dimension,
    standard: standardCode,
    enable_events: params.isStateful,
    manager: sender.id,
  };
  // Field names and types come from js-moi-sdk's AssetCreatePayload. max_supply must be a number|bigint: a decimal string
  // fails POLO serialisation inside the wallet with "Failed to sign interaction", and there is no `supply` field at all.
  let payload: Record<string, unknown>;
  switch (standard) {
    case "MAS0":
      payload = { max_supply: supply, decimals: decimals ?? 0, ...common };
      break;
    case "MAS1":
      // The number 1, not 1n: the SDK writes max_supply: 1, and the two POLO-encode differently in full width.
      payload = { ...common, max_supply: 1, logic_payload: { ...INIT_PAYLOAD } };
      break;
    case "MAS2":
      payload = { max_supply: supply, decimals: decimals ?? 0, ...common, logic_payload: { ...INIT_PAYLOAD } };
      break;
    default:
      payload = {
        ...common,
        max_supply: supply,
        logic_payload: {
          manifest: (masx as MasxCreate).manifest,
          ...((masx as MasxCreate).callsite ? { callsite: (masx as MasxCreate).callsite } : {}),
          ...((masx as MasxCreate).calldata ? { calldata: (masx as MasxCreate).calldata } : {}),
        },
      };
  }

  const funding = buildTransferPayload(
    KMOI_ASSET_ID as `0x${string}`,
    predictAssetId(sender, standard) as `0x${string}`,
    fund <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fund) : fund,
  ) as unknown as Record<string, unknown>;

  return [
    { type: OpType.ASSET_CREATE, payload },
    // Without this the ASSET_CREATE operation succeeds and the interaction
    // still fails: the new asset has no KMOI to pay its own storage.
    {
      type: OpType.ASSET_INVOKE,
      payload: {
        ...funding,
        calldata: String(funding["calldata"] ?? "").replace(/^0x/, ""),
      },
    },
  ];
}
