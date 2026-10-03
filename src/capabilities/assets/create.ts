/**
 * Create an asset: build the interaction, measure fuel, simulate. Moved from src/tools/write-core.ts.
 */

import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import {
  asKmoi, assertSendable, buildCreateAsset, chooseStorageFund, DEFAULT_STORAGE_FUND, KMOI_DECIMALS,
  MEASURED_STORAGE_FLOOR, MIN_STORAGE_FUND, parseAmount,
} from "../../moi/ix-builder.js";
import { CreateAssetInput } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  assertWillSucceed, kmoiBalance, senderFor, withMeasuredFuel, WriteOutputShape, type PreparedWrite,
} from "../../tools/write-core.js";

/**
 * The measured floor as a person reads it, to one decimal: "6.1". Rounded on purpose: the constant is a measurement,
 * and a long figure reads as exact.
 */
const FLOOR_KMOI = (Number(MEASURED_STORAGE_FLOOR) / 10 ** KMOI_DECIMALS).toFixed(1);

/** What this server funds when no storageFund is given, in the words of the hint. The same two numbers as chooseStorageFund. */
const SERVER_FUNDS =
  `${asKmoi(DEFAULT_STORAGE_FUND)} KMOI when the balance allows and at least ${asKmoi(MIN_STORAGE_FUND)} KMOI otherwise`;

/**
 * What a refused create says about its storage fund.
 *
 * The chain's floor is the measured one, about 6.1 KMOI. 7 KMOI is this server's margin over it, and it applies only to
 * a fund this server chose: a storageFund the caller passed is used as given. So the hint branches on who chose it.
 */
function storageFundHint(storageFund: bigint, explicit: boolean): string {
  const head =
    `A new asset is funded with KMOI to pay its own storage. \`storageFund\` is ` +
    `in BASE UNITS, not whole KMOI: with KMOI at 9 decimals, ${DEFAULT_STORAGE_FUND} ` +
    `base units is ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI. Below about ${FLOOR_KMOI} KMOI ` +
    `the chain refuses the create, and a fund that is too SMALL fails exactly like this.`;
  if (explicit) {
    return (
      `${head} You passed ${asKmoi(storageFund)} KMOI. Leave \`storageFund\` out and this server funds ` +
      `${SERVER_FUNDS}, to stay clear of that floor. Check the account's balance before assuming it is too low.`
    );
  }
  return (
    `${head} This server funded ${asKmoi(storageFund)} KMOI, which is above that floor (it funds ${SERVER_FUNDS}, ` +
    `to stay clear of it), so the fund is probably not the cause. Check the symbol and the balance first; if both ` +
    `are fine, the chain's storage pricing may have moved since the floor was measured, which is worth reporting.`
  );
}

/**
 * Prepare asset creation: build, measure fuel, simulate.
 */
export async function prepareCreateAsset(
  account: string,
  params: z.infer<typeof CreateAssetInput> & { balance: bigint },
): Promise<PreparedWrite> {
  const supply = parseAmount(params.supply, params.decimals);
  const explicitFund = Boolean(params.storageFund);
  const storageFund = params.storageFund
    ? parseAmount(params.storageFund, 0)
    : chooseStorageFund(params.balance);
  const ix = await withMeasuredFuel(
    buildCreateAsset(await senderFor(account), {
      symbol: params.symbol,
      supply,
      decimals: params.decimals,
      dimension: params.dimension,
      standard: params.standard,
      isStateful: params.isStateful,
      isFungible: params.isFungible,
      storageFund,
    }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix, storageFundHint(storageFund, explicitFund));

  return {
    ix,
    description: `Create asset ${params.symbol} with supply ${params.supply}`,
    details: {
      Operation: "Create asset",
      Symbol: params.symbol,
      "Max supply": params.supply,
      "Max supply in base units": supply.toString(),
      Decimals: String(params.decimals),
      "Dimension (0 Economic, 1 Possession)": String(params.dimension),
      Standard: params.standard,
      "Storage fund, KMOI base units (deposited into the asset's own account, not spent)":
        storageFund.toString(),
    },
  };
}

export function createAssetTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI asset owned by the user's paired wallet; nothing happens until they tap Send on their phone. Funds the asset's storage automatically, and the preview shows how much. " +
        "Only the MAS0 standard can be created for now: leave `standard` out, because MAS1, MAS2 and MASX are not supported yet." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CreateAssetInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }, extra) =>
      runWrite(
        deps,
        auth,
        "create_asset",
        args,
        confirm,
        async (s) => prepareCreateAsset(s.address, { ...args, balance: await kmoiBalance(s.address) }),
        extra,
      ),
  );
}
