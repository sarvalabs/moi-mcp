/**
 * Shared write-tool helpers extracted for use by both stdio (writes.ts) and
 * hosted (hosted-writes.ts) paths. Contains:
 *   - balance/sender lookups
 *   - per-operation build logic (prepare* functions)
 *   - simulation and fuel-measurement infrastructure
 *   - broadcast and error handling
 *
 * Does NOT handle signing or session routing — callers pass already-validated
 * sessions (stdio) or fetch from a store by userId (hosted).
 */

import { z } from "zod";

import { getConfig, log } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import {
  assertSendable,
  buildCreateAsset,
  buildLogicInvoke,
  buildMint,
  buildTransfer,
  encodeLogicCall,
  asKmoi,
  chooseStorageFund,
  DEFAULT_STORAGE_FUND,
  MIN_STORAGE_FUND,
  estimateFuelFor,
  parseAmount,
  simulate,
  type SenderInfo,
  type UnsignedInteraction,
} from "../moi/ix-builder.js";
import { getProvider, getReadOnlySigner, interactionUrl } from "../moi/provider.js";
import { getAccount, getAsset, toBigInt } from "../moi/reads.js";
import {
  CallLogicInput,
  CallLogicViewOutput,
  CreateAssetInput,
  ErrorCode,
  MintInput,
  TransferInput,
  WriteResult,
} from "../schema.js";

type Write = z.infer<typeof WriteResult>;

/**
 * Replace the built-in fuel ceiling with a measured one.
 *
 * A fuel_limit far above the real cost is the number a human sees on the
 * approval screen, so an unmeasured default reads as though the interaction
 * is enormous.
 */
async function withMeasuredFuel(ix: UnsignedInteraction): Promise<UnsignedInteraction> {
  const provider = getProvider(providerOptions()) as unknown as {
    estimateFuel: (i: unknown) => Promise<number | bigint>;
  };
  const { fuelLimit, estimated, reason } = await estimateFuelFor(provider, ix);
  if (!estimated) log("info", `fuel estimation unavailable (${reason}); using fallback ${fuelLimit}`);
  return { ...ix, fuel_limit: fuelLimit };
}

/**
 * Refuse to push an interaction that the node says will revert.
 *
 * Without this the user is asked to approve something on their phone that then
 * burns fuel and fails — the worst outcome, because it looks like their
 * approval caused the failure.
 */
async function assertWillSucceed(ix: UnsignedInteraction, hint?: string): Promise<void> {
  const provider = getProvider(providerOptions()) as unknown as { call: (i: unknown) => Promise<unknown> };
  const result = await simulate(provider, ix);
  if (result.ok) return;

  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `The node says this interaction would fail (receipt status ${result.status ?? "?"})` +
      `${result.detail ? `: ${result.detail}` : ""}. ` +
      `Not sending it to your wallet — approving it would burn fuel and change nothing.` +
      (hint ? ` ${hint}` : ""),
    { simulatedStatus: result.status ?? null },
  );
}

/** KMOI the account holds, in base units. */
export async function kmoiBalance(account: string): Promise<bigint> {
  const { KMOI_ASSET_ID } = await import("js-moi-sdk");
  const state = await getAccount(getProvider(providerOptions()), account);
  const held = state.balances.find(
    (b) => b.assetId.toLowerCase() === String(KMOI_ASSET_ID).toLowerCase(),
  );
  return toBigInt(held?.amount ?? 0);
}

function providerOptions() {
  const cfg = getConfig();
  return { network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL };
}

/**
 * Resolve the sequence number the chain expects next.
 *
 * This must match what js-moi-sdk's Signer.getNonce() would produce —
 * getPendingInteractionCount(id, keyId), which counts queued interactions too.
 * Reading AccountState.nonce instead yields undefined (the node does not
 * return that field), which silently becomes 0 and the wallet rejects the
 * interaction with "invalid nonce".
 */
export async function senderFor(account: string, keyId = 0): Promise<SenderInfo> {
  const provider = getProvider(providerOptions()) as unknown as {
    getPendingInteractionCount: (id: string, keyId: number) => Promise<number | bigint>;
  };
  const sequence = Number(await provider.getPendingInteractionCount(account, keyId));
  return { id: account, sequence, keyId };
}

/**
 * Convert a thrown error into the schema's WriteResult envelope where the
 * schema models it (rejection reasons), and rethrow everything else so the
 * client sees a real MCP error.
 */
export function asWriteResult(err: unknown): Write {
  if (isMoiError(err)) {
    switch (err.code) {
      case ErrorCode.USER_REJECTED:
        return { status: "rejected", reason: "user_rejected", message: err.message };
      case ErrorCode.REQUEST_TIMEOUT:
        return { status: "rejected", reason: "timeout", message: err.message };
      case ErrorCode.NETWORK_MISMATCH:
        return { status: "rejected", reason: "network_mismatch", message: err.message };
      case ErrorCode.WALLET_NOT_CONNECTED:
        return { status: "rejected", reason: "wallet_disconnected", message: err.message };
      default:
        // Insufficient balance, bad arguments, a node error: things the model
        // can explain or fix. As a bare thrown error they lost their code and
        // structured shape; as a result they keep both.
        return { status: "error", code: err.code, message: err.message };
    }
  }
  throw toMcpError(err);
}

/**
 * Advertised output shape for the write tools.
 *
 * schema.WriteResult is a discriminated union, and MCP SDK 1.30's zod-compat
 * layer cannot convert a Zod 3 union into JSON Schema (it probes Zod 4's
 * internals and throws on `_zod`). We therefore advertise the permissive
 * superset of the three variants, and still validate the real value against
 * WriteResult below — so the strict contract holds even though the published
 * schema is looser.
 */
export const WriteOutputShape = {
  status: z.enum(["sent", "rejected", "error", "preview"]),
  hash: z.string().optional(),
  explorerUrl: z.string().optional(),
  summary: z.string().optional(),
  reason: z.enum(["user_rejected", "timeout", "network_mismatch", "wallet_disconnected"]).optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  confirm: z.string().optional(),
  details: z.record(z.string(), z.string()).optional(),
  fuel: z.string().optional(),
  network: z.string().optional(),
  expiresAt: z.string().optional(),
  note: z.string().optional(),
};

/** The preview as a block the model can paste into the chat. */
function previewText(p: Extract<Write, { status: "preview" }>): string {
  const lines = [
    ...(p.note ? [p.note, ""] : []),
    "PREVIEW. Nothing has been sent to the phone.",
    p.summary,
    "",
    "What the phone will show:",
    ...Object.entries(p.details).map(([k, v]) => `  ${k}: ${v}`),
    `  Fuel: ${p.fuel}`,
    `  Network: ${p.network}`,
    "",
    "Show the user the summary and these values and get an explicit yes. Then call again with " +
      `the same arguments and confirm="${p.confirm}" (valid until ${p.expiresAt}). ` +
      "Tell them to check that the amount and address on the phone match before tapping.",
  ];
  return lines.join("\n");
}

export function ok(value: Write) {
  // Enforce the union even though the advertised schema is the superset.
  const checked = WriteResult.parse(value);
  if (checked.status === "error") {
    // A failure the model can act on: flagged as an error so it knows the
    // call did not succeed, with the code and message kept structured, and
    // the text left plain rather than JSON-escaped so it reads naturally.
    return {
      content: [{ type: "text" as const, text: `[${checked.code}] ${checked.message}` }],
      structuredContent: checked as Record<string, unknown>,
      isError: true,
    };
  }
  if (checked.status === "preview") {
    return {
      content: [{ type: "text" as const, text: previewText(checked) }],
      structuredContent: checked as Record<string, unknown>,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(checked, null, 2) }],
    structuredContent: checked as Record<string, unknown>,
  };
}

/**
 * The broadcast half: send already-signed interaction to the node.
 *
 * Splitting sign from broadcast is what makes writes work at all right now —
 * the wallet's combined sendInteractions is broken (see wc/client.ts). It also
 * keeps the zero-key property: the signature is produced on the phone and this
 * process only relays it to the node.
 */
export async function broadcastSigned(ix_args: string, signatures: string): Promise<string> {
  const provider = getProvider(providerOptions()) as unknown as {
    sendInteraction: (req: { ix_args: string; signatures: string }) => Promise<{ hash: string }>;
  };
  try {
    const response = await provider.sendInteraction({ ix_args, signatures });
    const hash = response?.hash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]+$/.test(hash)) {
      throw new MoiError(ErrorCode.RPC_ERROR, `Node accepted the interaction but returned no hash.`);
    }
    return hash;
  } catch (err) {
    if (err instanceof MoiError) throw err;
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `You approved the interaction but broadcasting it failed: ${err instanceof Error ? err.message.slice(0, 180) : String(err)}`,
    );
  }
}

/**
 * Pre-built interaction ready for signing.
 */
export interface PreparedWrite {
  ix: UnsignedInteraction;
  description: string;
  /**
   * What the wallet will render, labelled for a person. The wallet has no
   * field for `description`, so these are how the chat lets the user check
   * the phone: the same numbers, in base units where the phone shows base
   * units.
   */
  details: Record<string, string>;
}

/**
 * Prepare a transfer: build, measure fuel, simulate.
 */
export async function prepareTransfer(
  account: string,
  params: z.infer<typeof TransferInput>,
): Promise<PreparedWrite> {
  const cfg = getConfig();
  const provider = getProvider(providerOptions());
  const asset = await getAsset(provider, params.assetId);
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

/**
 * Prepare minting: build, measure fuel, simulate.
 */
export async function prepareMint(
  account: string,
  params: z.infer<typeof MintInput>,
): Promise<PreparedWrite> {
  const asset = await getAsset(getProvider(providerOptions()), params.assetId);
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

/**
 * Prepare logic invocation: build, measure fuel, simulate.
 */
export async function prepareLogicInvoke(
  account: string,
  params: Omit<z.infer<typeof CallLogicInput>, "kind">,
): Promise<PreparedWrite> {
  const payload = await encodeLogicCall(
    getReadOnlySigner(providerOptions()),
    params.logicId,
    params.routine,
    params.args ?? [],
  );
  const ix = await withMeasuredFuel(
    buildLogicInvoke(await senderFor(account), {
      logicId: params.logicId,
      callsite: params.routine,
      ...(payload.calldata ? { calldata: payload.calldata } : {}),
    }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix);

  return {
    ix,
    description: `Call ${params.routine} on logic ${params.logicId}`,
    details: {
      Operation: "Invoke logic routine",
      Logic: params.logicId,
      Routine: params.routine,
      Arguments: JSON.stringify(params.args ?? [], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    },
  };
}

/**
 * View-only logic call: run against the node directly, no wallet needed.
 */
export async function viewLogicCall(
  params: z.infer<typeof CallLogicInput>,
): Promise<z.infer<typeof CallLogicViewOutput>> {
  const signer = getReadOnlySigner(providerOptions());
  const { getLogicDriver } = await import("js-moi-sdk");
  const driver = (await getLogicDriver(params.logicId, signer as never)) as unknown as {
    routines: Record<string, (...a: unknown[]) => Promise<{ call: () => Promise<{ result: () => unknown }> }>>;
  };
  const fn = driver.routines[params.routine];
  if (typeof fn !== "function") {
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Logic ${params.logicId} has no routine "${params.routine}". Available: ${Object.keys(driver.routines ?? {}).join(", ")}.`,
    );
  }
  const response = await (await fn(...(params.args ?? []))).call();
  const outputs = (await response.result()) as Record<string, unknown>;
  return {
    routine: params.routine,
    outputs: JSON.parse(
      JSON.stringify(outputs, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ) as Record<string, unknown>,
  };
}
