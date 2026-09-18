/**
 * Multi-user write tools for the hosted MOI MCP server.
 *
 * Hosted-specific implementation of the write tools (moi_transfer,
 * moi_create_asset, moi_mint, moi_call_logic) that routes writes to the
 * authenticated user's WalletConnect session via the WalletConnectHub, then
 * broadcasts the signed interaction.
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getConfig, log } from "../config.js";
import { messageOf } from "../errors.js";
import { interactionUrl, NETWORKS } from "../moi/provider.js";
import type { AuthInfo } from "../auth/types.js";
import { isExpired } from "../wc/lifetime.js";
import {
  CallLogicInput,
  CreateAssetInput,
  ErrorCode,
  MintInput,
  TransferInput,
  type WriteResult,
} from "../schema.js";
import { MoiError } from "../moi-error.js";
import type { StoredWalletSession, WalletSessionStore } from "../wc/store.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import type { WriteJournal } from "../journal.js";
import { fingerprint, PreviewRegistry } from "./preview.js";
import {
  WriteOutputShape,
  asWriteResult,
  broadcastSigned,
  kmoiBalance,
  ok,
  prepareCreateAsset,
  prepareLogicInvoke,
  prepareMint,
  prepareTransfer,
  viewLogicCall,
  type PreparedWrite,
} from "./write-core.js";

/**
 * Dependencies for hosted write tools.
 */
export interface HostedWriteDeps {
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  journal: WriteJournal;
  /** Confirm tokens. One registry per process by default; injectable for tests. */
  previews?: PreviewRegistry;
}

const defaultPreviews = new PreviewRegistry();

type WriteKind = "transfer" | "create_asset" | "mint" | "call_logic";

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
  journal: WriteJournal,
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
 * Load and validate the user's wallet session from the store.
 */
async function loadSession(
  deps: HostedWriteDeps,
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
async function afterSignedUse(deps: HostedWriteDeps, session: StoredWalletSession): Promise<void> {
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

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  // These move funds or change chain state, and cannot be undone. The hint is
  // what a client uses to decide whether to ask before calling.
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const ConfirmArg = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "Token from this tool's preview. Omit it to get the preview; pass it, with the same arguments, to send the approval to the phone.",
  );

const APPROVAL_PROTOCOL =
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
async function runWrite(
  deps: HostedWriteDeps,
  auth: AuthInfo | null,
  kind: WriteKind,
  args: unknown,
  confirm: string | undefined,
  prepare: (session: StoredWalletSession) => Promise<PreparedWrite>,
) {
  const previews = deps.previews ?? defaultPreviews;
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

/**
 * Register hosted write tools on the given server.
 *
 * Registered even when the caller is anonymous, so the tools appear in
 * tools/list and a model knows they exist. Hiding them looked safer but was
 * worse: an unlisted tool is never called, so the 401 that prompts sign-in
 * never fires, and the user is told this server is read-only. Calls are
 * still gated — see requireAuth.
 */
export function registerHostedWrites(
  server: McpServer,
  deps: HostedWriteDeps,
  auth: AuthInfo | null,
): void {
  server.registerTool(
    "moi_transfer",
    {
      title: "Transfer a MOI asset",
      description:
        "Propose a transfer of a MOI asset from the user's paired wallet; nothing moves until they tap Send on their phone. The balance is checked first." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...TransferInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "transfer", args, confirm, (s) => prepareTransfer(s.address, args)),
  );

  server.registerTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI asset owned by the user's paired wallet; nothing happens until they tap Send on their phone. Funds the asset's storage automatically, and the preview shows how much." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CreateAssetInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "create_asset", args, confirm, async (s) =>
        prepareCreateAsset(s.address, { ...args, balance: await kmoiBalance(s.address) }),
      ),
  );

  server.registerTool(
    "moi_mint",
    {
      title: "Mint tokens of a MOI asset",
      description:
        "Propose minting more of an asset the user's paired wallet manages; nothing happens until they tap Send on their phone." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...MintInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "mint", args, confirm, (s) => prepareMint(s.address, args)),
  );

  server.registerTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a MOI logic. kind=view reads and needs no wallet, no preview, no confirm. kind=invoke changes state and nothing happens until the user taps Send on their phone." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CallLogicInput.shape, confirm: ConfirmArg },
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async ({ confirm, kind, ...call }) => {
      // A view runs against the node directly — no wallet, no approval, no
      // signed interaction, and so nothing for the journal to track.
      if (kind === "view") {
        try {
          const value = await viewLogicCall({ ...call, kind: "view" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        } catch (err) {
          return ok(asWriteResult(err));
        }
      }
      return runWrite(deps, auth, "call_logic", call, confirm, (s) => prepareLogicInvoke(s.address, call));
    },
  );
}
