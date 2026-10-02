/**
 * Helpers every write shares: balance and sender lookups, simulation and fuel measurement, the result envelope, and the
 * broadcast. The per-operation build logic (the prepare* functions) lives with each capability under src/capabilities.
 * Every write goes through runWrite (src/tools/hosted-writes.ts), on the hosted server and on the stdio one.
 *
 * Does NOT handle signing or session routing: runWrite loads the session and asks the hub to sign, and the prepare*
 * functions are handed the account they build for.
 */

import { z } from "zod";

import { getConfig, log } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import { estimateFuelFor, simulate, type SenderInfo, type UnsignedInteraction } from "../moi/ix-builder.js";
import { getProvider, interactionUrl } from "../moi/provider.js";
import { getAccount, toBigInt } from "../moi/reads.js";
import { ErrorCode, WriteResult } from "../schema.js";

type Write = z.infer<typeof WriteResult>;

/**
 * Replace the built-in fuel ceiling with a measured one.
 *
 * A fuel_limit far above the real cost is the number a human sees on the
 * approval screen, so an unmeasured default reads as though the interaction
 * is enormous.
 */
export async function withMeasuredFuel(ix: UnsignedInteraction): Promise<UnsignedInteraction> {
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
export async function assertWillSucceed(ix: UnsignedInteraction, hint?: string): Promise<void> {
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

export function providerOptions() {
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
