/**
 * moi_faucet: test KMOI from the Voyage devnet faucet, for the paired wallet, on the hosted server only.
 *
 * This is NOT a chain write by this server: nothing is signed, nothing goes to the phone, and the funds come from the
 * faucet, not from this server. So it does not use runWrite, the confirm token or the journal, and it needs only the
 * pairing store. It is one call: a third exception to rule 2 of design.md section 5, next to the two Launchpad operations.
 * What that rests on, and what it does not:
 *   - The KMOI has no value, and the faucet allows one claim per account per cooldown period.
 *   - The tool has NO argument, so a model cannot choose the address. It claims for the address the wallet reported when it
 *     paired. That address is self-reported (src/wc/client.ts accepts any 0x hex string), so this bounds a model, not a person
 *     who pairs a scripted wallet. What bounds a person is the faucet's own cooldown and the key's quota on the Voyage side.
 *   - The per-person limit here (FAUCET_CLAIMS_PER_WINDOW an hour, per sign-in identity, in memory) stops a model that loops.
 *     Identities are free to make, so it is not a cap on the shared key.
 *   - Nothing asks the person before a claim. A model that is told to call this can use up that person's claim for the
 *     cooldown period, so the description says to call it only when the person has asked for test KMOI.
 *
 * It exists on a server only when faucetDepsFor says so: MOI_FAUCET_URL and MOI_FAUCET_KEY both set, a client that accepts
 * them, and the network the Voyage devnet. The handler refuses again on any other network. The key is part of the faucet's
 * address, so nothing in this file or src/applications/faucet/client.ts may put the address, the key or a caught error's text
 * in a message, a log line or a result (test/unit/faucet-secret.test.ts).
 */

import { z } from "zod";

import { SlidingWindow } from "../../auth/rate-limit.js";
import type { AuthInfo } from "../../auth/types.js";
import { boundedResult } from "../../bounds.js";
import { getConfig, log } from "../../config.js";
import { toMcpError } from "../../errors.js";
import { MoiError } from "../../moi-error.js";
import { asKmoi } from "../../moi/ix-builder.js";
import { NETWORKS } from "../../moi/provider.js";
import { withTimeout } from "../../moi/reads.js";
import { ErrorCode, type Network } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { loadSession, type WriteDeps } from "../../tools/hosted-writes.js";
import { kmoiBalance } from "../../tools/write-core.js";
import { FAUCET_NETWORK, FaucetClient, FaucetError } from "./client.js";

/** What one person may ask of the faucet through this server. A failed attempt counts too. */
export const FAUCET_CLAIMS_PER_WINDOW = 3;
export const FAUCET_WINDOW_MS = 60 * 60_000;
/** How long the one balance read after a claim is waited for. The node's request cannot be cancelled, so the wait is bounded here. */
const BALANCE_TIMEOUT_MS = 10_000;

export interface FaucetDeps {
  client: FaucetClient;
  /** The pairing store and nothing else: the faucet finds the paired wallet's address, and never signs, pairs or journals. */
  wallets: Pick<WriteDeps, "store">;
  /** The per-person window. One per process by default; injectable for tests. */
  limiter?: SlidingWindow;
  /** Tests only. */
  balanceTimeoutMs?: number;
}

// One window per process: the hosted server registers its tools afresh on every request, so a window made inside
// faucetTool would be empty each time. previewsOf in src/tools/hosted-writes.ts does the same for the confirm registry.
const defaultLimiter = new SlidingWindow({ windowMs: FAUCET_WINDOW_MS, max: FAUCET_CLAIMS_PER_WINDOW });
const limiterOf = (deps: FaucetDeps): SlidingWindow => deps.limiter ?? defaultLimiter;

const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function requireAuth(auth: AuthInfo | null): AuthInfo {
  if (!auth) throw new MoiError(ErrorCode.WALLET_NOT_CONNECTED, "Sign in to this connector before claiming test KMOI.");
  return auth;
}

type FaucetValue = { claimed: true; address: string; faucetSays?: string; balanceKmoi?: string; note: string };

async function run(fn: () => Promise<{ value: FaucetValue; text: string }>) {
  try {
    const { value, text } = await fn();
    return boundedResult(value, text);
  } catch (err) {
    throw toMcpError(err);
  }
}

const ARRIVAL = "The faucet's funds can take a moment to arrive.";
const COOLDOWN_NOTE =
  "Do not call moi_faucet again for now: the faucet allows each account one claim in a fixed cooldown period.";
// Not a guess about when an account comes into being: the protocol requires every participant to be registered on chain
// (a ParticipantCreate, which carries the account's keys), and the faucet's documentation says nothing about an address that
// is not registered. So say that, and send the person to the flag that shows it.
const UNREAD =
  "This wallet's KMOI balance could not be read just now. One reason can be that the wallet has never been registered on chain " +
  "(moi_get_account shows isRegistered false for it), and the faucet's documentation does not say whether it can fund an address " +
  "that is not registered.";

export function faucetTool(deps: FaucetDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_faucet",
    {
      title: "Claim devnet test KMOI",
      description:
        "Ask the Voyage devnet faucet for free test KMOI for the person's paired wallet. Call it only when the person has asked " +
        "for test KMOI: nothing asks them to confirm. Devnet only, and only on a server that has been given a faucet key; the KMOI " +
        "has no real value. It takes no arguments and cannot name another address: it claims for the wallet that is paired, and " +
        "nothing else. Needs a paired wallet (moi_connect_wallet). The faucet allows each account one claim in a fixed cooldown " +
        "period, so do not call it again until that has passed, and this server limits each person to " +
        `${FAUCET_CLAIMS_PER_WINDOW} claims an hour on top. Nothing is signed and nothing is sent on chain by this server: the ` +
        "faucet sends the funds, which can take a moment to arrive. Returns what the faucet said and the wallet's KMOI balance, " +
        "read once right after the claim, which may not include the new funds yet; check again with moi_get_account a minute " +
        "later (its isRegistered flag also shows whether the wallet exists on chain).",
      inputSchema: {},
      outputSchema: {
        claimed: z.literal(true),
        address: z.string(),
        faucetSays: z.string().optional(),
        balanceKmoi: z.string().optional(),
        note: z.string(),
      },
      annotations: ACT,
    },
    async () =>
      run(async () => {
        const who = requireAuth(auth);
        const cfg = getConfig();
        if (cfg.MOI_NETWORK !== FAUCET_NETWORK) {
          throw new FaucetError("wrong_network", "The faucet hands out devnet test KMOI only, and this server is not on the devnet. Nothing was claimed.");
        }
        // The paired wallet's own address, and no other. A person who is not paired is refused here, before the limiter.
        const wallet = await loadSession(deps.wallets, who, NETWORKS[cfg.MOI_NETWORK].caip2);

        const verdict = limiterOf(deps).allow(who.userId);
        if (!verdict.ok) {
          log("info", `faucet: user ${who.userId} -> rate_limited`);
          const minutes = Math.max(1, Math.ceil(verdict.retryAfterS / 60));
          throw new FaucetError(
            "rate_limited",
            `You have already asked the faucet ${FAUCET_CLAIMS_PER_WINDOW} times in the last hour, the most this server allows ` +
              `(the faucet's own cooldown applies on top). Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          );
        }

        let said: string | undefined;
        try {
          ({ said } = await deps.client.claim(wallet.address));
        } catch (err) {
          log("info", `faucet: user ${who.userId} -> ${err instanceof FaucetError ? err.outcome : "failed"}`);
          throw err;
        }
        log("info", `faucet: user ${who.userId} -> claimed`);

        // Once, after the claim, and never allowed to undo it. The node's own words are not shown (they can carry its address).
        let balanceKmoi: string | undefined;
        try {
          balanceKmoi = asKmoi(await withTimeout(kmoiBalance(wallet.address), deps.balanceTimeoutMs ?? BALANCE_TIMEOUT_MS, "balance"));
        } catch {
          balanceKmoi = undefined;
        }

        const note =
          balanceKmoi === undefined
            ? `${ARRIVAL} ${UNREAD} Check again with moi_get_account in a minute. ${COOLDOWN_NOTE}`
            : `${ARRIVAL} The balance above may not include them yet. Check again with moi_get_account in a minute. ${COOLDOWN_NOTE}`;
        return {
          value: {
            claimed: true as const,
            address: wallet.address,
            ...(said ? { faucetSays: said } : {}),
            ...(balanceKmoi !== undefined ? { balanceKmoi } : {}),
            note,
          },
          text: [
            `Asked the devnet faucet for test KMOI for ${wallet.address}, the paired wallet.`,
            said ? `The faucet says: ${said}` : "The faucet accepted the request.",
            ...(balanceKmoi !== undefined ? [`KMOI balance of that wallet, read just now: ${balanceKmoi} KMOI.`] : []),
            note,
          ].join("\n"),
        };
      }),
  );
}

/**
 * What main() in src/server.ts hands the hosted app: the faucet's deps, or undefined when the tool must not exist. Both
 * settings must be set, the network must be the Voyage devnet, and the client must accept the values (it owns every rule
 * about them: https, a public host, no query, fragment or credentials, a usable key). The decision is made here, once, so the
 * tool is absent from tools/list and not merely refusing; the handler checks the network again. The log lines are fixed
 * text: they never hold the address or the key.
 */
export function faucetDepsFor(
  hosted: { MOI_FAUCET_URL?: string | undefined; MOI_FAUCET_KEY?: string | undefined },
  network: Network,
  wallets: Pick<WriteDeps, "store">,
): FaucetDeps | undefined {
  const url = hosted.MOI_FAUCET_URL;
  const key = hosted.MOI_FAUCET_KEY;
  if (!url && !key) return undefined;
  if (!url || !key) {
    log("error", "faucet: MOI_FAUCET_URL and MOI_FAUCET_KEY must both be set; the faucet tool is off.");
    return undefined;
  }
  if (network !== FAUCET_NETWORK) {
    log("error", `faucet: the faucet tool is for the ${FAUCET_NETWORK} devnet only and MOI_NETWORK is ${network}; the faucet tool is off.`);
    return undefined;
  }
  try {
    const client = new FaucetClient({ baseUrl: url, key });
    log("info", "faucet: the devnet faucet tool is on.");
    return { client, wallets };
  } catch {
    // The constructor's message is fixed text, but nothing here is built from it either.
    log(
      "error",
      "faucet: MOI_FAUCET_URL or MOI_FAUCET_KEY was refused (the address must be a public https URL with no query, fragment or credentials, " +
        "and the key must be 1 to 256 characters and not only dots); the faucet tool is off.",
    );
    return undefined;
  }
}
