/**
 * The one path every write takes: runWrite. The write tools themselves are built by the capability each belongs to
 * (src/capabilities) and put on a server by src/tools/register.ts.
 *
 * The hosted server runs it with a signed-in user, the pairing store, the WalletConnect hub and a journal in its data
 * directory. The stdio server runs the same code with a constant local user and small adapters over its own session
 * file, WalletConnect client and journal file (src/tools/local-writes.ts). Nothing below knows which of the two it is
 * under: it asks for a WriteDeps and an AuthInfo. A write routes to the paired wallet's WalletConnect session, then the
 * signed interaction is broadcast from here.
 *
 * Identity is always auth.userId. The session is looked up via
 * deps.store.get(auth.userId), and signed on that session's topic. No tool
 * input schema may carry a topic, session id, account override, or userId.
 *
 * Every write is two calls. The first, without `confirm`, builds and
 * simulates the interaction and returns a preview: the sentence, the values
 * the wallet will render, and a confirm token. The second, with the token,
 * sends the approval to the phone. The wallet has no field for a description
 * (docs/upstream-issues.md), so the preview is how the user reads in the
 * chat, in the same numbers, exactly what the phone is about to ask them to
 * sign.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getConfig, log } from "../config.js";
import { messageOf } from "../errors.js";
import { interactionUrl, NETWORKS } from "../moi/provider.js";
import type { AuthInfo } from "../auth/types.js";
import { isExpired } from "../wc/lifetime.js";
import { ErrorCode, type WriteResult } from "../schema.js";
import { MoiError } from "../moi-error.js";
import type { StoredWalletSession, WalletSessionStore } from "../wc/store.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import type { WriteJournal } from "../journal.js";
import { fingerprint, PreviewRegistry } from "./preview.js";
import { asWriteResult, broadcastSigned, ok, type PreparedWrite } from "./write-core.js";

/**
 * What the write path uses, and no more. The hosted server satisfies it with its real store, hub and journal
 * (HostedWriteDeps below); the stdio server with small adapters over its own session file, WalletConnect client and
 * journal file (src/tools/local-writes.ts). Naming the narrow shape is what lets the second exist without a cast.
 */
export interface WriteDeps {
  /** get and delete are all the write path needs: it never pairs, lists, or looks a session up by topic. */
  store: Pick<WalletSessionStore, "get" | "delete">;
  /** signInteractionFor signs. disconnect runs only for a "once" pairing, which the stdio server never has. */
  hub: Pick<WalletConnectHubLike, "signInteractionFor" | "disconnect">;
  journal: Pick<WriteJournal, "append" | "update">;
  /** Confirm tokens. One registry per process by default; injectable for tests. */
  previews?: PreviewRegistry;
}

/**
 * Dependencies for the hosted write tools: the full store, hub and journal. The Launchpad and dapp tools need more
 * than the write path does (the hub signs their sign-in messages), so they take this.
 */
export interface HostedWriteDeps extends WriteDeps {
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  journal: WriteJournal;
}

const defaultPreviews = new PreviewRegistry();

/**
 * The registry for these deps: one per process unless a test injects one. The hosted server rebuilds McpServer and
 * re-registers every tool on each request, so a registry created inside a register* function would be empty on the
 * confirm call. moi_dapp_call and moi_launchpad_create_agent use it too.
 */
export const previewsOf = (d: WriteDeps): PreviewRegistry => d.previews ?? defaultPreviews;

export type WriteKind =
  | "transfer"
  | "create_account"
  | "configure_account"
  | "create_asset"
  | "mint"
  | "call_logic"
  | "deploy_logic"
  | "asset_invoke"
  | "register_agent"
  | "set_agent_status"
  | "transfer_agent";

/**
 * Record a signed-but-not-broadcast (or never-signed) attempt as failed once
 * we know it will not complete in this request. `wasSigned` picks the state:
 * once the wallet has produced a signature, a broadcast failure strands an
 * approved interaction ("orphaned" — exactly the mid-restart gap
 * reconcileOnBoot exists to close), whereas a failure before that point (the
 * user rejected on their phone, the wallet timed out, ...) never left the
 * user on the hook for anything, so it is just "failed". Journal writes are
 * best-effort: a journal I/O error must never mask the real tool error.
 */
async function markUnwound(
  journal: Pick<WriteJournal, "update">,
  id: string,
  wasSigned: boolean,
  err: unknown,
): Promise<void> {
  try {
    await journal.update(id, wasSigned ? "orphaned" : "failed", { detail: messageOf(err) });
  } catch {
    /* best-effort audit trail; never let this hide the original error */
  }
}

/**
 * Network-only pre-flight check against our own store record.
 * Expiry/liveness is NOT checked here — it is enforced by
 * WalletConnectHub.signInteractionFor via the native SignClient
 * session store, because StoredWalletSession does not carry
 * a first-class expiry/peer field.
 */
function assertNetworkMatches(stored: StoredWalletSession, expectedNetwork?: string): void {
  if (expectedNetwork && stored.caip2 !== expectedNetwork) {
    throw new MoiError("NETWORK_MISMATCH", `Wallet is on ${stored.caip2}, expected ${expectedNetwork}`);
  }
}

/**
 * Load and validate the user's wallet session from the store. Takes only the store, so a tool that reads the pairing and
 * never signs does not need to be handed the hub.
 */
export async function loadSession(
  deps: Pick<WriteDeps, "store">,
  auth: AuthInfo,
  expectedNetwork?: string,
): Promise<StoredWalletSession> {
  const stored = await deps.store.get(auth.userId);
  if (!stored) {
    throw new MoiError(ErrorCode.WALLET_NOT_CONNECTED, "No wallet paired for this account.");
  }
  if (isExpired(stored)) {
    await deps.store.delete(auth.userId);
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "The wallet pairing has expired. Call moi_connect_wallet to pair again.",
    );
  }
  assertNetworkMatches(stored, expectedNetwork);
  return stored; // hub.signInteractionFor(stored.topic, ...) validates liveness
}

/**
 * A "just this once" pairing has done its one job. Forget it now, before the
 * result is even returned, so nothing can reuse it. The relay teardown is best
 * effort: the server-side deletion is the guarantee, the phone's list is
 * cosmetic.
 */
async function afterSignedUse(deps: WriteDeps, session: StoredWalletSession): Promise<void> {
  if (session.mode !== "once") return;
  try {
    await deps.store.delete(session.userId);
  } catch (err) {
    // The broadcast already happened; a cleanup failure must never turn that
    // success into an error the caller sees. The cost of swallowing it: the
    // once-pairing stays usable until its 15-minute expiry, on this user's
    // own phone. Logged so an operator sees it.
    log("error", `failed to forget once-pairing for ${session.userId}: ${messageOf(err)}`);
  }
  try {
    await deps.hub.disconnect(session.topic);
  } catch {
    // see above
  }
}

/**
 * Calls are gated twice: handleMcp answers 401 for these tool names before a
 * handler runs, and this is the belt to that braces.
 */
function requireAuth(auth: AuthInfo | null): AuthInfo {
  if (!auth) {
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "Sign in to this connector before proposing a transaction.",
    );
  }
  return auth;
}

export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  // These move funds or change chain state, and cannot be undone. The hint is
  // what a client uses to decide whether to ask before calling.
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const ConfirmArg = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "Token from this tool's preview. Omit it to get the preview; pass it, with the same arguments, to send the approval to the phone.",
  );

export const APPROVAL_PROTOCOL =
  " Two calls, always. First call without confirm: nothing reaches the phone; you get a one-sentence summary, " +
  "the exact values the wallet will display, and a confirm token. Show the user the summary and those values and " +
  "get an explicit yes to them, even if they already asked for the action. Second call with the same arguments plus " +
  "confirm: this sends the approval to the phone and waits for the tap, which can take a few minutes. Tell the user " +
  "to check that the amount and address on the phone match the preview before tapping. Returns the interaction hash " +
  "once broadcast, or a reason it was refused.";

const NO_MATCH_NOTE =
  "That confirm token did not match this call: it was missing, expired, already used, or the arguments changed. " +
  "Nothing was sent to the phone. This is a fresh preview; show it and get the user's yes again.";

const CHANGED_NOTE =
  "The numbers changed since the preview, for example because a balance moved. Nothing was sent to the phone. " +
  "This is a fresh preview; show it and get the user's yes again.";

function previewOf(
  prepared: PreparedWrite,
  token: string,
  expiresAt: number,
  note: string | undefined,
): WriteResult {
  return {
    status: "preview",
    confirm: token,
    summary: prepared.description,
    details: prepared.details,
    fuel: `up to ${prepared.ix.fuel_limit} at price ${prepared.ix.fuel_price}`,
    network: getConfig().MOI_NETWORK,
    expiresAt: new Date(expiresAt).toISOString(),
    ...(note ? { note } : {}),
  };
}

/**
 * The one write path. Loads the caller's session, builds and simulates the
 * interaction, and then either previews it or, given a confirm token that
 * matches this user, this tool, these arguments and these numbers, sends it
 * to the phone, broadcasts, and journals every step.
 *
 * The preview does the full build and simulation on purpose: a balance
 * shortfall or a reverting call is reported before the user is asked for a
 * yes, not after.
 */
export async function runWrite(
  deps: WriteDeps,
  auth: AuthInfo | null,
  kind: WriteKind,
  args: unknown,
  confirm: string | undefined,
  prepare: (session: StoredWalletSession) => Promise<PreparedWrite>,
) {
  const previews = previewsOf(deps);
  const id = randomUUID();
  let proposed = false;
  let signed = false;
  try {
    const cfg = getConfig();
    const who = requireAuth(auth);
    const session = await loadSession(deps, who, NETWORKS[cfg.MOI_NETWORK].caip2);
    const prepared = await prepare(session);

    const key = { userId: who.userId, kind, fingerprint: fingerprint(args) };
    let note: string | undefined;
    if (confirm) {
      const match = previews.redeem(confirm, key);
      if (!match) note = NO_MATCH_NOTE;
      else if (fingerprint(match.details) !== fingerprint(prepared.details)) note = CHANGED_NOTE;
    }
    if (!confirm || note) {
      const issued = previews.issue({ ...key, details: prepared.details });
      return ok(previewOf(prepared, issued.token, issued.expiresAt, note));
    }

    await deps.journal.append({ id, userId: who.userId, kind, state: "proposed" });
    proposed = true;

    const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
      description: prepared.description,
    });
    // The phone HAS signed, whatever happens next. Setting the flag after
    // the journal write meant a failed write demoted a live signature to
    // "failed"; it must land as "orphaned" so someone looks at it.
    signed = true;
    await deps.journal.update(id, "signed");

    const hash = await broadcastSigned(ix_args, signatures);
    // From here the interaction is on the chain. Nothing below may turn that
    // into an error the caller sees: cleanup and journaling are best-effort,
    // and reconcileJournalOnBoot finalizes an entry a crash leaves behind.
    try {
      await afterSignedUse(deps, session);
      await deps.journal.update(id, "broadcast", { ixHash: hash });
      // Nothing later confirms this from the server side, so broadcast is the
      // terminal success; leaving it non-terminal made every restart report a
      // landed transaction as stranded.
      await deps.journal.update(id, "confirmed", { ixHash: hash });
    } catch (err) {
      log("error", `post-broadcast bookkeeping failed for write ${id}: ${messageOf(err)}`);
    }

    return ok({
      status: "sent",
      summary: prepared.description,
      hash,
      explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
    });
  } catch (err) {
    if (proposed) await markUnwound(deps.journal, id, signed, err);
    return ok(asWriteResult(err));
  }
}
