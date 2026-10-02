/**
 * The transfer and mint shortcuts for the asset standards they are built for, and the guard that refuses the rest before
 * anything is simulated or sent to the phone. Moved from src/tools/write-core.ts.
 */

import { KMOI_ASSET_ID } from "js-moi-sdk";
import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { getConfig } from "../../config.js";
import { MoiError } from "../../moi-error.js";
import { assertSendable, buildMint, buildTransfer, parseAmount } from "../../moi/ix-builder.js";
import { getProvider, getReadOnlySigner } from "../../moi/provider.js";
import { getAccount, getAsset, toBigInt } from "../../moi/reads.js";
import { ErrorCode, MintInput, TransferInput } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  assertWillSucceed, providerOptions, senderFor, withMeasuredFuel, WriteOutputShape, type PreparedWrite,
} from "../../tools/write-core.js";

/**
 * The asset standards each write is built for. Transfer is MAS0 and MASN: KMOI is MASN and takes the MAS0 calldata
 * (MASNAssetLogic.transfer in js-moi-asset). Mint is MAS0 and MAS2, whose Mint takes {beneficiary, amount} in both
 * (MINT_SCHEMA in mas0-schema and mas2-schema), so the MAS0AssetLogic that buildMint uses writes the same bytes for
 * either. MAS1 and MAS2 transfers name a token id, MAS1 mint takes no amount, and MASX defines its own routines, so
 * nothing here builds those. Widen a list when the builder behind it is right for that standard, and not before.
 */
const TRANSFERABLE_STANDARDS: readonly string[] = ["MAS0", "MASN"];
const MINTABLE_STANDARDS: readonly string[] = ["MAS0", "MAS2"];

/**
 * Refuse an asset this write is not built for, before anything is simulated, previewed or sent to the phone. It lives
 * here so the stdio and hosted servers both get it. An allow-list, so a standard the SDK cannot name (UNKNOWN(n), or
 * "" when the id does not decode) is refused like any other. KMOI is the exception: its standard has been renamed once
 * already (MAS0 to MASN), and a rename must never stop KMOI transfers, so transfer lets its id through whatever name the
 * SDK decodes. For mint the same id check keeps the "native asset" message when it is renamed again.
 */
export function assertStandardSupported(
  tool: "moi_transfer" | "moi_mint",
  asset: { assetId: string; symbol: string; standard: string },
): void {
  const { assetId, standard } = asset;
  const isKmoi = assetId.toLowerCase() === String(KMOI_ASSET_ID).toLowerCase();
  const label = `${asset.symbol || "(no symbol)"} ${assetId}`;
  const named = standard || "unreadable";
  const unsupported = "This tool does not recognise that standard.";
  let message: string;
  let supported: readonly string[];

  if (tool === "moi_transfer") {
    if (isKmoi || TRANSFERABLE_STANDARDS.includes(standard)) return;
    supported = TRANSFERABLE_STANDARDS;
    const why =
      standard === "MAS1" || standard === "MAS2"
        ? `A ${standard} transfer names a token id, which this tool has no argument for.`
        : standard === "MASX"
          ? "A MASX asset defines its own Transfer, and this tool does not know its shape."
          : unsupported;
    message =
      `moi_transfer does not support ${label}: its standard is ${named}, and only MAS0 assets and KMOI can be ` +
      `transferred for now. ${why} Nothing was sent to your wallet.`;
  } else if (isKmoi || standard === "MASN") {
    supported = MINTABLE_STANDARDS;
    message =
      `moi_mint cannot mint ${label}: it is a native asset (standard ${named}), and the chain reserves minting it ` +
      `for the protocol. Nothing was sent to your wallet.`;
  } else {
    if (MINTABLE_STANDARDS.includes(standard)) return;
    supported = MINTABLE_STANDARDS;
    const why =
      standard === "MAS1"
        ? "A MAS1 Mint takes only a recipient and no amount, so the call this tool builds does not fit it."
        : standard === "MASX"
          ? "A MASX asset defines its own Mint, and this tool does not know its shape."
          : unsupported;
    message =
      `moi_mint does not support ${label}: its standard is ${named}, and only MAS0 and MAS2 assets can be minted ` +
      `for now. ${why} Nothing was sent to your wallet.`;
  }
  throw new MoiError(ErrorCode.INVALID_ARGS, message, { assetId, standard, supported: [...supported] });
}

export async function prepareTransfer(
  account: string,
  params: z.infer<typeof TransferInput>,
): Promise<PreparedWrite> {
  const cfg = getConfig();
  const provider = getProvider(providerOptions());
  const asset = await getAsset(provider, params.assetId);
  assertStandardSupported("moi_transfer", asset);
  const raw = parseAmount(params.amount, asset.decimals);

  const accountState = await getAccount(provider, account);
  const held = accountState.balances.find((b) => b.assetId.toLowerCase() === params.assetId.toLowerCase());
  const heldRaw = toBigInt(held?.amount ?? 0);
  if (heldRaw < raw) {
    throw new MoiError(
      ErrorCode.INSUFFICIENT_BALANCE,
      `Account ${account} holds ${held?.amount ?? "0"} of ${asset.symbol || params.assetId} ` +
        `in base units but the transfer needs ${raw.toString()}.`,
      { assetId: params.assetId, needed: raw.toString(), held: held?.amount ?? "0" },
    );
  }

  const ix = await withMeasuredFuel(
    buildTransfer(await senderFor(account), { to: params.to, assetId: params.assetId, amount: raw }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix);

  return {
    ix,
    description: `Transfer ${params.amount} ${asset.symbol || params.assetId} to ${params.to}${params.memo ? ` — ${params.memo}` : ""}`,
    details: {
      Operation: "Transfer",
      Asset: `${asset.symbol || "(no symbol)"} ${params.assetId}`,
      Amount: params.amount,
      "Amount in base units": raw.toString(),
      To: params.to,
      ...(params.memo ? { Memo: params.memo } : {}),
    },
  };
}

/**
 * Prepare minting: build, measure fuel, simulate.
 */
export async function prepareMint(
  account: string,
  params: z.infer<typeof MintInput>,
): Promise<PreparedWrite> {
  const asset = await getAsset(getProvider(providerOptions()), params.assetId);
  assertStandardSupported("moi_mint", asset);
  const recipient = params.to ?? account;
  const raw = parseAmount(params.amount, asset.decimals);

  const ix = await withMeasuredFuel(
    await buildMint(
      getReadOnlySigner(providerOptions()),
      await senderFor(account),
      { assetId: params.assetId, to: recipient, amount: raw },
    ),
  );
  assertSendable(ix);
  await assertWillSucceed(
    ix,
    `Minting requires you to be the asset's manager, and the new total cannot exceed its ` +
      `maximum supply.`,
  );

  return {
    ix,
    description: `Mint ${params.amount} ${asset.symbol || params.assetId} to ${recipient}`,
    details: {
      Operation: "Mint",
      Asset: `${asset.symbol || "(no symbol)"} ${params.assetId}`,
      Amount: params.amount,
      "Amount in base units": raw.toString(),
      To: recipient,
    },
  };
}

export function transferTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_transfer",
    {
      title: "Transfer a MOI asset",
      description:
        "Propose a transfer of a MOI asset from the user's paired wallet; nothing moves until they tap Send on their phone. The balance is checked first. " +
        "Works for MAS0 assets and KMOI; any other asset standard is refused with an explanation, before any preview." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...TransferInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "transfer", args, confirm, (s) => prepareTransfer(s.address, args)),
  );
}

export function mintTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_mint",
    {
      title: "Mint tokens of a MOI asset",
      description:
        "Propose minting more of an asset the user's paired wallet manages; nothing happens until they tap Send on their phone. " +
        "Works for MAS0 and MAS2 assets; the native asset (KMOI) cannot be minted and other standards are refused with an explanation, before any preview." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...MintInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "mint", args, confirm, (s) => prepareMint(s.address, args)),
  );
}
