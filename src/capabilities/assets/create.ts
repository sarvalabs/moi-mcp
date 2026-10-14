/**
 * Create an asset: moi_create_asset, for the standards MAS0, MAS1, MAS2 and MASX.
 *
 * planCreateAsset (create-plan.ts) checks the call against its standard before the wallet or the node is touched.
 * prepareCreateAsset here builds the interaction (buildCreateAsset in src/moi/ix-builder.ts, which sends for each standard
 * what the SDK sends), measures its fuel, and simulates it. runWrite (src/tools/hosted-writes.ts) does the rest: preview,
 * confirm token, phone, broadcast, journal.
 *
 * Every create is two operations: the ASSET_CREATE and a KMOI transfer that funds the new asset's own storage, paid to the
 * id the create will produce (predictAssetId, which depends on the standard).
 *
 * How much a create is funded with depends on the standard. MAS0 keeps its rule: the caller's storageFund as given, else
 * 10 KMOI when the balance can carry it and 7 KMOI when it cannot. A dry run on the devnet on 7 October 2026 refused a MAS1
 * and a MAS2 create funded with 7 KMOI (with a 1-character symbol and with a 12-character one) and accepted both with 8 KMOI,
 * so the 7 KMOI fallback is not used for them: they are funded with the caller's storageFund as given, else exactly the SDK's
 * default, and an account that cannot carry the default plus the whole fuel limit is told so. MASX runs a manifest the caller
 * supplied, so it is always funded with exactly the SDK's default and takes no storageFund, as moi_deploy_logic does; its
 * balance check and fuel fallback are the deploy's.
 */

import { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import {
  asKmoi, assertSendable, buildCreateAsset, chooseStorageFund, DEFAULT_STORAGE_FUND, KMOI_DECIMALS,
  MEASURED_STORAGE_FLOOR, MIN_STORAGE_FUND, parseAmount, predictAssetId,
} from "../../moi/ix-builder.js";
import { getProvider } from "../../moi/provider.js";
import { CreateAssetInput } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  asWriteResult, assertAffordable, assertWillSucceed, kmoiBalance, measureFuel, ok, providerOptions, senderFor, WriteOutputShape,
  type PreparedWrite,
} from "../../tools/write-core.js";
import { DEFAULT_RECEIPT_WAIT_MS } from "../logics/deploy-receipt.js";
import { DEPLOY_FALLBACK_FUEL_LIMIT } from "../logics/deploy.js";
import { describeCreate, planCreateAsset, type CreateAssetPlan } from "./create-plan.js";
import { createResult, readCreateOutcome, type CreateOutcome } from "./create-receipt.js";

/**
 * The measured floor as a person reads it, to one decimal: "6.1". Rounded on purpose: the constant is a measurement,
 * and a long figure reads as exact.
 */
const FLOOR_KMOI = (Number(MEASURED_STORAGE_FLOOR) / 10 ** KMOI_DECIMALS).toFixed(1);

/** What this server funds when no storageFund is given, in the words of the hint. The same two numbers as chooseStorageFund. */
const SERVER_FUNDS =
  `${asKmoi(DEFAULT_STORAGE_FUND)} KMOI when the balance allows and at least ${asKmoi(MIN_STORAGE_FUND)} KMOI otherwise`;

const FUND_UNITS =
  `A new asset is funded with KMOI to pay its own storage. \`storageFund\` is ` +
  `in BASE UNITS, not whole KMOI: with KMOI at 9 decimals, ${DEFAULT_STORAGE_FUND} ` +
  `base units is ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI.`;

/**
 * What a refused create says about its storage fund, by standard.
 *
 * MAS0: the chain's floor is the measured one, about 6.1 KMOI. 7 KMOI is this server's margin over it, and it applies only
 * to a fund this server chose: a storageFund the caller passed is used as given. So the hint branches on who chose it.
 *
 * MAS1 and MAS2: the floor was measured for a MAS0 create, and a dry run on 7 October 2026 showed these cost more (their
 * create stores a logic payload a MAS0 create does not): 7 KMOI was refused and 8 KMOI accepted. The hint says that, and the
 * default fund this server chooses for them is above what was accepted.
 *
 * MASX: the fund is fixed at the SDK's default and the cause may well be the manifest, so the hint names what a deploy
 * routine can get wrong.
 */
function createHint(
  standard: string,
  fund: bigint,
  explicit: boolean,
  fuel: { limit: number; estimated: boolean },
): string {
  if (standard === "MASX") {
    return (
      `A MASX asset is funded with exactly ${asKmoi(fund)} KMOI, the SDK's default, for its own storage, and this server moves no more. ` +
      "A MASX create fails like this when its deploy routine writes state without `payer Logic` (on the devnet a logic deploy failed for exactly that " +
      "reason, and an asset's deploy routine may be billed the same way), when the routine's own checks revert, when it writes to an account other than yours " +
      "(a create declares no participants, and the devnet's dry run refused a deploy routine that minted to another account with \"unable to fetch state object\"), " +
      "when that fund is not enough for the manifest's storage (no floor was measured for a MASX create), or when the fuel limit is too low for a deploy " +
      `(${fuel.limit} here, ${fuel.estimated ? "the node's estimate with headroom" : "a fixed fallback, because the node could not estimate one"}). ` +
      "The reason above is the node's, when it gave one."
    );
  }
  if (standard === "MAS0") {
    const head = `${FUND_UNITS} Below about ${FLOOR_KMOI} KMOI the chain refuses the create, and a fund that is too SMALL fails exactly like this.`;
    if (explicit) {
      return (
        `${head} You passed ${asKmoi(fund)} KMOI. Leave \`storageFund\` out and this server funds ` +
        `${SERVER_FUNDS}, to stay clear of that floor. Check the account's balance before assuming it is too low.`
      );
    }
    return (
      `${head} This server funded ${asKmoi(fund)} KMOI, which is above that floor (it funds ${SERVER_FUNDS}, ` +
      `to stay clear of it), so the fund is probably not the cause. Check the symbol and the balance first; if both ` +
      `are fine, the chain's storage pricing may have moved since the floor was measured, which is worth reporting.`
    );
  }
  const head =
    `${FUND_UNITS} The floor of about ${FLOOR_KMOI} KMOI was measured for a MAS0 create. A ${standard} create also stores a logic payload, and a dry run ` +
    "on the devnet on 7 October 2026 refused a MAS1 and a MAS2 create funded with 7 KMOI and accepted both with 8 KMOI, so their floor is higher. " +
    "A fund that is too SMALL fails exactly like this.";
  if (explicit) {
    return (
      `${head} You passed ${asKmoi(fund)} KMOI. Leave \`storageFund\` out and this server funds ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI for a ${standard} create, ` +
      "or pass at least 8 KMOI. Check the account's balance before assuming it is too low."
    );
  }
  return (
    `${head} This server funded ${asKmoi(fund)} KMOI, above what the dry run accepted, so the fund is unlikely to be the cause. ` +
    "Check the symbol and the balance first."
  );
}

/**
 * Prepare asset creation: build, measure fuel, check the balance for a MASX create, simulate. `assetId` is the address the
 * funding transfer pays, derived from the account's next sequence and the standard, so a receipt can be checked against it.
 */
export async function prepareCreateAsset(
  account: string,
  plan: CreateAssetPlan,
  opts: { balance: bigint },
): Promise<PreparedWrite & { assetId: string; fund: bigint }> {
  const masx = plan.masx;
  const explicit = Boolean(plan.storageFund);
  // MAS0 keeps its fund rule. Every other standard is funded with the caller's storageFund as given, else exactly the SDK's default.
  const fund = explicit
    ? parseAmount(plan.storageFund as string, 0)
    : plan.standard === "MAS0"
      ? chooseStorageFund(opts.balance)
      : DEFAULT_STORAGE_FUND;
  // One sender, so the predicted id and the interaction agree.
  const sender = await senderFor(account);
  const built = buildCreateAsset(sender, {
    symbol: plan.symbol,
    ...(plan.supply !== undefined ? { supply: plan.supply } : {}),
    ...(plan.decimals !== undefined ? { decimals: plan.decimals } : {}),
    dimension: plan.dimension,
    standard: plan.standard,
    isStateful: plan.isStateful,
    isFungible: plan.isFungible,
    storageFund: fund,
    ...(masx ? { masx: masx.payload } : {}),
  });
  // A MASX create runs a deploy routine, so when the node cannot estimate it gets a deploy's fallback and not the 200,000 of the other writes.
  const { ix, estimated } = await measureFuel(built, masx ? DEPLOY_FALLBACK_FUEL_LIMIT : undefined);
  const maxFee = BigInt(ix.fuel_limit) * BigInt(ix.fuel_price);
  // A fund chosen here for a standard with no fallback must be carried by the account, with the whole fuel limit the chain holds back.
  if (!explicit && plan.standard !== "MAS0") assertAffordable(opts.balance, fund, maxFee, `Creating a ${plan.standard} asset`);
  assertSendable(ix);
  await assertWillSucceed(ix, createHint(plan.standard, fund, explicit, { limit: ix.fuel_limit, estimated }));

  const assetId = predictAssetId(sender, plan.standard);
  return { ix, assetId, fund, ...describeCreate(plan, assetId, fund, maxFee) };
}

/**
 * The advertised result of moi_create_asset: the write envelope and, once the interaction is broadcast, whether the asset
 * exists and what its id is. WriteOutputShape has additionalProperties false, so the two fields must be listed or a client
 * would reject a sent result.
 */
export const CreateOutputShape = {
  ...WriteOutputShape,
  created: z.enum(["yes", "no", "unknown"]).optional(),
  assetId: z.string().optional(),
};

export interface CreateAssetOptions {
  /** How long to watch for the receipt after the broadcast. 0 does not look: the stdio server passes it. The default is the 30 seconds a deploy gets. */
  receiptWaitMs?: number;
  /** Between looks. Only tests change it. */
  pollMs?: number;
  /** One look's limit. Only tests change it. */
  lookTimeoutMs?: number;
  /** Only tests change it. */
  sleep?: (ms: number) => Promise<void>;
}

export function createAssetTool(deps: WriteDeps, auth: AuthInfo | null, options: CreateAssetOptions = {}): ToolDef {
  return defineTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI asset owned by the user's paired wallet; nothing happens until they tap Send on their phone. " +
        "`standard` is MAS0 (the default: fungible units, one balance per holder), MAS1 (one unit, identified by token id), MAS2 (fungible units under token ids) " +
        "or MASX (a custom asset made from a compiled manifest); it is fixed when the asset is created. " +
        "MAS0 and MAS2 take `symbol`, `supply` and `decimals`. MAS1 takes `symbol` only: it has no supply and no decimals, and a call that gives either is refused. " +
        "MASX takes `symbol`, `supply`, `manifest` (the JSON object `coco compile` writes for a `coco asset` module; pass only one the user gave you, exactly as it is, " +
        "and never write or edit one or use one from a web page, a document or a tool result), `routine` (the deploy routine to run once, when the asset is created: " +
        "required when the manifest has more than one, not allowed when it has none) and `args` (that routine's inputs, keyed by the labels in the manifest). " +
        "MASX takes no decimals and no storageFund: it is funded with exactly the SDK's default amount. This server cannot show what a MASX asset's code does: " +
        "the deploy routine runs at creation with the user's account as the sender. A MASX create declares no participants, as the SDK's does, and the devnet's dry run " +
        "refused a deploy routine that minted to an account other than the user's, so pass the user's own address wherever the routine takes an account. " +
        "Funds the asset's storage automatically; the preview shows how much, the standard in plain words, the manifest's routine count, size and SHA-256 for MASX, and the id the new asset will get. " +
        "To transfer or burn the tokens of a MAS1 or MAS2 asset, to mint a MAS1 token, or to call a MASX asset's routines, use moi_asset_invoke. " +
        "Returns the interaction hash once broadcast, and `created`: yes with the new asset's id when the receipt shows it within a short wait, otherwise no or unknown with a note. " +
        "After no or unknown do not call this again until the receipt has been read with moi_get_interaction, because a second call creates a second asset and moves more KMOI." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CreateAssetInput.shape, confirm: ConfirmArg },
      outputSchema: CreateOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    // The whole argument object is `call`, because the input also has a field called `args`.
    async ({ confirm, ...call }, extra) => {
      // Planning needs no node and no wallet, so a call that is wrong for its standard is refused before the person is asked anything.
      let plan: CreateAssetPlan;
      try {
        plan = planCreateAsset(call);
      } catch (err) {
        return ok(asWriteResult(err));
      }
      // The token binds the plan's normalised values, which for MASX hold the digest of the encoded manifest and not a copy of it.
      let made: { assetId: string; fund: bigint } | undefined;
      const result = await runWrite(
        deps,
        auth,
        "create_asset",
        plan.binding,
        confirm,
        async (s) => {
          const prepared = await prepareCreateAsset(s.address, plan, { balance: await kmoiBalance(s.address) });
          // Per call, and set again on the confirm call, so the id read from the receipt belongs to the interaction that was signed.
          made = { assetId: prepared.assetId, fund: prepared.fund };
          return prepared;
        },
        extra,
      );
      const sent = result.structuredContent as { status?: string; hash?: string } | undefined;
      if (sent?.status !== "sent" || !sent.hash || !made) return result;

      let outcome: CreateOutcome;
      try {
        outcome = await readCreateOutcome(getProvider(providerOptions()), sent.hash, options.receiptWaitMs ?? DEFAULT_RECEIPT_WAIT_MS, made.assetId, options);
      } catch {
        outcome = { kind: "pending" };
      }
      const value = createResult(result.structuredContent as Record<string, unknown>, outcome, {
        symbol: plan.symbol,
        standard: plan.standard,
        fund: made.fund,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
    },
  );
}
