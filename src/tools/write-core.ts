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
import { asKmoi, estimateFuelFor, simulate, type SenderInfo, type UnsignedInteraction } from "../moi/ix-builder.js";
import { compareSigned, type SignedComparison } from "../moi/signed-check.js";
import { getProvider, interactionUrl } from "../moi/provider.js";
import { getAccount, toBigInt } from "../moi/reads.js";
import { ErrorCode, WriteResult } from "../schema.js";

type Write = z.infer<typeof WriteResult>;

/**
 * Measure the fuel an interaction needs, and say whether it was measured.
 *
 * A fuel_limit far above the real cost is the number a human sees on the approval screen, so an unmeasured default reads
 * as though the interaction is enormous. When the node cannot estimate, the limit is `fallbackLimit` if one is given and
 * the ordinary 200,000 otherwise: a deploy, and a MASX create that runs a deploy routine, pass the larger limit a deploy
 * needs, which the 200,000 sized for transfers and plain creates is not.
 */
export async function measureFuel(
  ix: UnsignedInteraction,
  fallbackLimit?: number,
): Promise<{ ix: UnsignedInteraction; estimated: boolean }> {
  const provider = getProvider(providerOptions()) as unknown as {
    estimateFuel: (i: unknown) => Promise<number | bigint>;
  };
  const { fuelLimit, estimated, reason } = await estimateFuelFor(provider, ix);
  const limit = estimated ? fuelLimit : (fallbackLimit ?? fuelLimit);
  if (!estimated) log("info", `fuel estimation unavailable (${reason}); using fallback ${limit}`);
  return { ix: { ...ix, fuel_limit: limit }, estimated };
}

/** Replace the built-in fuel ceiling with a measured one. See measureFuel. */
export async function withMeasuredFuel(ix: UnsignedInteraction, fallbackLimit?: number): Promise<UnsignedInteraction> {
  return (await measureFuel(ix, fallbackLimit)).ix;
}

/**
 * Refuse a write whose account cannot pay for it: the fund that moves into the new account plus the whole fuel limit,
 * which the chain holds back until the interaction is done. An account with the fund and a little more cannot pay for its
 * own deploy, and the node's own refusal says only that the interaction would fail. `what` begins the sentence: "Deploying
 * a logic" or "Creating a MASX asset".
 */
export function assertAffordable(balance: bigint, fund: bigint, maxFee: bigint, what: string): void {
  if (balance >= fund + maxFee) return;
  throw new MoiError(
    ErrorCode.INSUFFICIENT_BALANCE,
    `${what} moves ${fund} base units of KMOI (${asKmoi(fund)} KMOI) into it, and the chain holds back ` +
      `the whole fuel limit, up to ${maxFee} (${asKmoi(maxFee)} KMOI), until the interaction is done, but this account holds ${balance} ` +
      `(${asKmoi(balance)} KMOI). Fund the account from the faucet. Nothing was sent to your wallet.`,
    { balance: balance.toString(), needed: (fund + maxFee).toString() },
  );
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

  // No status means the node did not say the interaction would fail: it said nothing usable (it was unreachable, or the
  // receipt had no readable status). That is not an argument the model can fix, so it is not INVALID_ARGS, and it must not
  // claim a verdict the node did not give. Nothing has been sent to the phone either way.
  if (result.status === undefined) {
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `The node's dry run gave no usable answer${result.detail ? ` (${result.detail})` : ""}, so this was not sent to your ` +
        `wallet. Nothing was changed. Try again; if it keeps happening the node may be down or answering in a form this ` +
        `server cannot read.`,
      { simulatedStatus: null },
    );
  }

  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `The node says this interaction would fail (receipt status ${result.status})` +
      `${result.detail ? `: ${result.detail}` : ""}. ` +
      `Not sending it to your wallet — approving it would burn fuel and change nothing.` +
      (hint ? ` ${hint}` : ""),
    { simulatedStatus: result.status },
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

/** What the person is told when MOI_SIGNED_CHECK is enforce and the phone's answer is not the interaction that was previewed. */
const SIGNED_MISMATCH =
  "MOI Wallet returned a different interaction than the one that was previewed. Nothing was sent to the network: the " +
  "interaction was not broadcast and the signature was discarded. Tell the user, and have them check what MOI Wallet showed " +
  "before they try again from a fresh preview.";

/** The lengths of the answer and of each encoding it was compared with. Lengths only: the bytes never go in a log. */
function lengthsOf(c: SignedComparison): string {
  const of = (n: number | undefined) => (n === undefined ? "not encodable" : `${n}`);
  return (
    `the answer is ${c.answerLength} hex characters, the wire form is ${of(c.expectedLength.wire)} ` +
    `and the full-width form is ${of(c.expectedLength["full-width"])}`
  );
}

/**
 * Check that what the phone signed is the interaction that was simulated and previewed, before anything is broadcast.
 *
 * A match is logged at info level in both modes, so one real write shows which encoding the wallet produces. A mismatch is
 * logged at error level, the only level that shows by default (there is no warn), and then depends on MOI_SIGNED_CHECK:
 * `warn` lets the broadcast go ahead as it always did, `enforce` throws and nothing is sent. The throw is a MoiError, which
 * runWrite journals as orphaned, because by now the phone has signed.
 */
function checkSigned(ix_args: string, previewed: UnsignedInteraction): void {
  const mode = getConfig().MOI_SIGNED_CHECK;
  const result = compareSigned(ix_args, previewed);
  if (result.matched.length > 0) {
    const forms =
      result.matched.length > 1
        ? "wire and full-width encodings, which are the same bytes for this interaction"
        : `${result.matched[0]} encoding`;
    log("info", `signed check (${mode}): the interaction MOI Wallet signed matches the preview as the ${forms} (${result.answerLength} hex characters)`);
    return;
  }
  if (mode === "warn") {
    log(
      "error",
      `signed check (warn): the interaction MOI Wallet signed is not byte for byte the one that was previewed (${lengthsOf(result)}); ` +
        `broadcasting it anyway because MOI_SIGNED_CHECK is warn`,
    );
    return;
  }
  log(
    "error",
    `signed check (enforce): the interaction MOI Wallet signed is not byte for byte the one that was previewed (${lengthsOf(result)}); ` +
      `refusing to broadcast it`,
  );
  throw new MoiError(ErrorCode.RPC_ERROR, SIGNED_MISMATCH);
}

/**
 * The broadcast half: send already-signed interaction to the node.
 *
 * Splitting sign from broadcast is what makes writes work at all right now —
 * the wallet's combined sendInteractions is broken (see wc/client.ts). It also
 * keeps the zero-key property: the signature is produced on the phone and this
 * process only relays it to the node.
 *
 * `previewed` is the interaction that was simulated, shown to the person and sent to the phone. What the phone signed is
 * compared with it first (checkSigned), here so that the hosted and the stdio server, which share this path, both get the
 * check, and so that no caller can broadcast without saying what it expects. The signatures are not inspected: the node
 * verifies them.
 */
export async function broadcastSigned(ix_args: string, signatures: string, previewed: UnsignedInteraction): Promise<string> {
  checkSigned(ix_args, previewed);
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
