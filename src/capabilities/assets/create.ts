/**
 * Create an asset: build the interaction, measure fuel, simulate. Moved from src/tools/write-core.ts.
 */

import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import {
  asKmoi, assertSendable, buildCreateAsset, chooseStorageFund, DEFAULT_STORAGE_FUND, MIN_STORAGE_FUND, parseAmount,
} from "../../moi/ix-builder.js";
import { CreateAssetInput } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  assertWillSucceed, kmoiBalance, senderFor, withMeasuredFuel, WriteOutputShape, type PreparedWrite,
} from "../../tools/write-core.js";

/**
 * Prepare asset creation: build, measure fuel, simulate.
 */
export async function prepareCreateAsset(
  account: string,
  params: z.infer<typeof CreateAssetInput> & { balance: bigint },
): Promise<PreparedWrite> {
  const supply = parseAmount(params.supply, params.decimals);
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
  await assertWillSucceed(
    ix,
    `A new asset is funded with KMOI to pay its own storage. \`storageFund\` is ` +
      `in BASE UNITS, not whole KMOI: with KMOI at 9 decimals, ${DEFAULT_STORAGE_FUND} ` +
      `base units is ${asKmoi(DEFAULT_STORAGE_FUND)} KMOI. Below about ` +
      `${asKmoi(MIN_STORAGE_FUND)} KMOI the chain refuses the create, and a fund that ` +
      `is too SMALL fails exactly like this. Check the account's balance before ` +
      `assuming it is too low.`,
  );

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
