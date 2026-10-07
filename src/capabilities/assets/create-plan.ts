/**
 * Plan a create: which inputs each asset standard takes, the refusals for the rest, and the words the person reads.
 * Pure: no node, no wallet. Imports nothing from src/tools, src/wc or the journal (test/unit/gateway-imports.test.ts checks).
 *
 * moi_create_asset builds MAS0, MAS1, MAS2 and MASX. They take different inputs, and the schema cannot say which, so it
 * leaves `supply` and `decimals` optional and the check is here, before the wallet or the node is touched:
 *
 * - MAS0 and MAS2: a supply above zero, and decimals (default 0).
 * - MAS1: neither. Every MAS1 asset has a maximum supply of 1 and each unit is a whole token id, so a call that gives a
 *   supply or decimals is refused with the reason and not ignored.
 * - MASX: a supply above zero, a compiled asset manifest, and, when the manifest has deploy routines, the one to run and
 *   its inputs. No decimals and no storageFund (the SDK's factory sends no decimals, and the fund is fixed at its default).
 *
 * The plan also carries `binding`, the normalised values the confirm token is bound to: the token binds what will be sent,
 * not the spelling of the call, so a call without `decimals` and the same call with `decimals: 0` redeem each other.
 */

import type { z } from "zod";

import { asKmoi, DEFAULT_STORAGE_FUND, parseAmount } from "../../moi/ix-builder.js";
import type { CreatableStandard, CreateAssetInput } from "../../schema.js";
import { planMasx, type MasxPlan } from "./create-masx.js";
import { invalid } from "./standards/common.js";

export type CreateAssetValues = z.infer<typeof CreateAssetInput>;

export interface CreateAssetPlan {
  standard: CreatableStandard;
  symbol: string;
  /** In base units. Undefined for MAS1, which has no supply to choose (the builder sends 1). */
  supply: bigint | undefined;
  /** The supply as the caller wrote it, for the "Max supply" line. MAS0 and MAS2 only. */
  supplyAsGiven: string | undefined;
  /** Undefined when no decimals key is sent: MAS1 and MASX. */
  decimals: number | undefined;
  dimension: 0 | 1;
  isStateful: boolean;
  isFungible: boolean;
  /** The caller's storageFund in KMOI base units, as given. Never set for MASX. */
  storageFund: string | undefined;
  /** MASX only. */
  masx: MasxPlan | undefined;
  /** What the confirm token binds. */
  binding: Record<string, unknown>;
}

/** What the person reads about each standard, in this server's words and not the phone's. */
export const STANDARD_WORDS: Readonly<Record<CreatableStandard, string>> = {
  MAS0: "Fungible units, one balance per holder, no token ids. The standard cannot be changed after the asset is created.",
  MAS1:
    "One unit, identified by token id. Every unit is whole and is moved by its token id; there is no supply to choose and there are no decimals. " +
    "The standard cannot be changed after the asset is created.",
  MAS2:
    "Fungible units under token ids. A token id names a kind of token and each holder has an amount of it, scaled by decimals. " +
    "The standard cannot be changed after the asset is created.",
  MASX:
    "A custom asset. Its routines come from the manifest below and not from a built-in standard. " +
    "The standard cannot be changed after the asset is created.",
};

const given = (v: unknown): boolean => v !== undefined;

/** "`manifest`", "`manifest` and `routine`", "`manifest`, `routine` and `args`". */
function listed(names: string[]): string {
  const quoted = names.map((n) => `\`${n}\``);
  return quoted.length <= 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Check the call against its standard, in a fixed order that stops at the first mistake: inputs the standard refuses,
 * inputs it needs, the amounts, and for MASX the manifest. Throws INVALID_ARGS refusals that say what to change and end
 * "Nothing was sent to your wallet."
 */
export function planCreateAsset(input: CreateAssetValues): CreateAssetPlan {
  const { standard, symbol } = input;
  const argsGiven = input.args !== undefined && Object.keys(input.args).length > 0;

  // 1. Inputs the standard refuses.
  if (standard === "MAS1") {
    if (given(input.supply)) {
      throw invalid(
        "A MAS1 asset takes no supply. MAS1 is single-unit: every MAS1 asset is created with a fixed maximum supply of 1, and each unit is whole " +
          "and is moved by its token id, so there is nothing for a supply to set. Leave `supply` out.",
      );
    }
    if (given(input.decimals)) {
      throw invalid(
        "A MAS1 asset takes no decimals. A MAS1 unit is never divided: every MAS1 operation moves a whole token id, and the standard has no routine " +
          "that reads decimals back, so a value here would be written and never used. Leave `decimals` out.",
      );
    }
  }
  if (standard === "MASX" && given(input.decimals)) {
    throw invalid(
      "A MASX create sends no decimals: the SDK's asset factory has no such field, so `decimals` is refused instead of being dropped without a word. Leave it out.",
    );
  }
  if (standard !== "MASX") {
    const names = [
      ...(given(input.manifest) ? ["manifest"] : []),
      ...(given(input.routine) ? ["routine"] : []),
      ...(argsGiven ? ["args"] : []),
    ];
    if (names.length > 0) {
      throw invalid(
        `${listed(names)} only ${names.length === 1 ? "applies" : "apply"} to the MASX standard, which creates an asset from a compiled manifest. ` +
          `A ${standard} asset has its routines built in, so ${names.length === 1 ? "it is" : "they are"} refused instead of being ignored. ` +
          "Leave them out, or pass standard MASX.",
      );
    }
  }
  if (standard === "MASX" && given(input.storageFund)) {
    throw invalid(
      `A MASX create funds the new asset with exactly ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI, the SDK's default, as moi_deploy_logic funds a logic, and takes no \`storageFund\`: ` +
        "this server does not let a caller choose how much KMOI goes into an account that runs a manifest the caller supplied. Leave `storageFund` out.",
    );
  }

  // 2. Inputs the standard needs.
  if (standard !== "MAS1" && !given(input.supply)) {
    throw invalid(
      standard === "MASX"
        ? "A MASX asset needs a `supply`: the most that can ever be minted, in whole units (a MASX create sends no decimals)."
        : `A ${standard} asset needs a \`supply\`: the most that can ever be minted, in whole tokens, scaled by decimals.`,
    );
  }
  if (standard === "MASX" && !given(input.manifest)) {
    throw invalid(
      "A MASX asset is created from a compiled asset manifest. Pass `manifest`: the JSON object `coco compile` writes for a `coco asset` module, exactly as the user gave it to you.",
    );
  }

  // 3. The amounts. Decimals scale the supply for MAS0 and MAS2; a MASX supply is in whole units.
  let supply: bigint | undefined;
  let decimals: number | undefined;
  if (standard === "MAS0" || standard === "MAS2") decimals = input.decimals ?? 0;
  if (standard !== "MAS1") {
    supply = parseAmount(input.supply as string, decimals ?? 0);
    if (supply === 0n) {
      throw invalid(
        "A supply of 0 cannot be created: the chain needs a maximum supply above zero, and the SDK refuses to encode a create without one. Give a `supply` above zero.",
      );
    }
  }

  // 4. MASX: the manifest, the deploy routine and its inputs.
  const masx = standard === "MASX" ? planMasx({ manifest: input.manifest as Record<string, unknown>, routine: input.routine, args: input.args }) : undefined;

  return {
    standard,
    symbol,
    supply,
    supplyAsGiven: standard === "MAS1" || standard === "MASX" ? undefined : input.supply,
    decimals,
    dimension: input.dimension,
    isStateful: input.isStateful,
    isFungible: input.isFungible,
    storageFund: input.storageFund,
    masx,
    binding: {
      standard,
      symbol,
      supply: supply?.toString(),
      decimals,
      dimension: input.dimension,
      isStateful: input.isStateful,
      isFungible: input.isFungible,
      storageFund: input.storageFund,
      // The manifest is bound by the digest of its encoding, so the registry holds a short string and not a copy of it.
      ...(masx ? { manifestSha256: masx.digest, callsite: masx.callsite, calldata: masx.payload.calldata } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The words the person reads
// ---------------------------------------------------------------------------

const FUND_KEY = "Storage fund, KMOI base units (deposited into the asset's own account, not spent)";
const MEANING_KEY = "What this standard means (this server's words, not on the phone)";
const ID_KEY = "New asset's id, predicted (the funding below is paid to it)";
const MANIFEST_KEY = "Manifest, read by this server (the phone shows only its bytes)";
const FIXED = "The standard cannot be changed after the asset is created.";

function summaryOf(plan: CreateAssetPlan, fund: bigint, maxFee: bigint): string {
  const funded = `${asKmoi(fund)} KMOI`;
  const { symbol } = plan;
  switch (plan.standard) {
    case "MAS0":
      return `Create a MAS0 asset ${symbol} with a maximum supply of ${plan.supplyAsGiven}, and move ${funded} from your account into it to pay for its storage. ${FIXED}`;
    case "MAS1":
      return (
        `Create a MAS1 asset ${symbol}: one unit, identified by token id, with no supply and no decimals. ` +
        `${funded} moves from your account into it to pay for its storage. ${FIXED}`
      );
    case "MAS2":
      return (
        `Create a MAS2 asset ${symbol}: fungible units under token ids, with a maximum supply of ${plan.supplyAsGiven} and ${plan.decimals} decimals. ` +
        `${funded} moves from your account into it to pay for its storage. ${FIXED}`
      );
    default: {
      const masx = plan.masx as MasxPlan;
      const running = masx.callsite ? `running its deploy routine ${masx.callsite} when the asset is created` : "with no deploy routine to run";
      return (
        `Create a MASX asset ${symbol} from a manifest of ${masx.routines} routine${masx.routines === 1 ? "" : "s"} (SHA-256 starting ${masx.digest.slice(0, 12)}), ` +
        `${running}, and move ${funded} from your account into it to pay for its storage. ` +
        "This server cannot show what the asset's code does: the deploy routine runs at once with your account as the sender, as a logic's does, " +
        "and the manifest decides what the asset's routines do afterwards. Create from a manifest you got from a source you trust. " +
        `${FIXED} The fuel costs at most ${asKmoi(maxFee)} KMOI.`
      );
    }
  }
}

/**
 * The summary and the labelled lines of the preview, for a create that will fund `assetId` with `fund` and cost at most
 * `maxFee` base units of fuel.
 *
 * runWrite's preview heads `details` with "What the phone will show:", so a line goes there only if it is in the interaction
 * the phone signs (the operations, the symbol, the standard, the supply, the decimals, the funding amount and address) or
 * says in its own label that this server wrote or read it. `details` is what runWrite compares between the preview and the
 * confirm, so it holds nothing that moves with the fuel estimate; the fee is in the summary, which is not compared. The
 * predicted id depends on the account's next sequence, so if another interaction from the account lands in between, the
 * person is shown a fresh preview, which is right: the funding would then pay another address.
 */
export function describeCreate(
  plan: CreateAssetPlan,
  assetId: string,
  fund: bigint,
  maxFee: bigint,
): { description: string; details: Record<string, string> } {
  const supplyLines: Record<string, string> =
    plan.standard === "MAS1"
      ? { "Max supply in base units": "1", Decimals: "none" }
      : plan.standard === "MASX"
        ? { "Max supply in base units": String(plan.supply), Decimals: "none" }
        : {
            "Max supply": plan.supplyAsGiven as string,
            "Max supply in base units": String(plan.supply),
            Decimals: String(plan.decimals),
          };
  const masx = plan.masx;
  const details: Record<string, string> = {
    Operation: "Create asset",
    Symbol: plan.symbol,
    Standard: plan.standard,
    [MEANING_KEY]: STANDARD_WORDS[plan.standard],
    ...supplyLines,
    "Dimension (0 Economic, 1 Possession)": String(plan.dimension),
    [ID_KEY]: assetId,
    [FUND_KEY]: fund.toString(),
    ...(masx
      ? { "Deploy routine (the callsite)": masx.deployLine, Arguments: masx.argsLine, [MANIFEST_KEY]: masx.manifestLine }
      : {}),
  };
  return { description: summaryOf(plan, fund, maxFee), details };
}
