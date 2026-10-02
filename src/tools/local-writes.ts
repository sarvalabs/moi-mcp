/**
 * What the stdio server supplies to the write path.
 *
 * Every write, on every transport, goes through runWrite in hosted-writes.ts: preview, confirm token, journal. That
 * path was written for a server with many users, so it asks its caller for four things the stdio server does not have
 * in that form. Each gets a small local answer here, and registerLocalWriteTools (src/tools/register.ts) registers the ten
 * write tools with them.
 *   - Who: there is one person, so one constant user.
 *   - The pairing: the session.json that WalletConnectClient already keeps. Its format is not touched, so a pairing
 *     made with `moi-mcp pair` or an older version still works.
 *   - Signing: the same WalletConnectClient.
 *   - The journal: a file in MOI_MCP_HOME, as the hosted server keeps one in its data directory.
 *
 * Nothing here runs at registration. src/index.ts promises to start on a bad config so that `ping` can report it, and
 * the tests install their fake wallet after the server is built, so config, the wallet client and the journal are all
 * reached when a write is made, never before.
 *
 * Only src/tools/register.ts imports this file. It reaches the wallet client, so the read gateway (src/http.ts) must
 * never import it; test/unit/gateway-imports.test.ts holds that line. For the same reason nothing here imports
 * src/server.ts: bundled into the stdio entry point, its isMain guard would start the hosted server inside it.
 */

import type { AuthInfo } from "../auth/types.js";
import { getConfig } from "../config.js";
import { WriteJournal } from "../journal.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import { clearSession, requireSession, type Session } from "../wc/session.js";
import type { StoredWalletSession } from "../wc/store.js";
import type { WriteDeps } from "./hosted-writes.js";
import { walletClient } from "./wallet.js";

/** The one person a stdio server acts for. The preview tokens and journal entries are filed under it. */
export const LOCAL_USER_ID = "local";

export const LOCAL_AUTH: AuthInfo = {
  userId: LOCAL_USER_ID,
  clientId: "stdio",
  scopes: ["moi:read", "moi:write"],
  // Unix seconds. There is no token to expire: whoever can talk to this process is the person it acts for.
  expiresAt: Number.MAX_SAFE_INTEGER,
};

/** WalletConnectClient writes createdAt in unix seconds. It is display-only here: expiresAt is always set. */
function isoFromSeconds(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function toStored(session: Session): StoredWalletSession {
  return {
    version: 1,
    userId: LOCAL_USER_ID,
    topic: session.topic,
    caip2: session.chainId,
    address: session.account,
    sessionData: {},
    createdAt: isoFromSeconds(session.createdAt),
    // A stdio pairing lasts as long as WalletConnect keeps it, and is never forgotten after one use.
    mode: "persistent",
    // WalletConnect's own expiry, unix seconds. Without it lifetime.ts would age the record from createdAt plus seven days.
    expiresAt: Math.floor(session.expiry),
  };
}

function localStore(): WriteDeps["store"] {
  return {
    async get(userId) {
      if (userId !== LOCAL_USER_ID) return undefined;
      // requireSession is what the stdio writes have always run, so an unpaired, expired or wrong-network wallet is
      // refused in the words stdio users already know, and in the same order, before anything touches the node. It
      // throws where a store would return undefined; runWrite turns the MoiError into the same rejected result.
      return toStored(requireSession(await walletClient().currentSession(), getConfig().MOI_NETWORK));
    },
    async delete(userId) {
      if (userId === LOCAL_USER_ID) clearSession(getConfig().home);
    },
  };
}

function localHub(): WriteDeps["hub"] {
  return {
    async signInteractionFor(topic, ix, opts) {
      const wc = walletClient();
      // The topic is what the write path is told to sign on. Check it is still the pairing on disk, so a pairing
      // that was replaced or ended between the preview and the confirm is refused instead of signed on.
      const session = wc.session();
      if (!session || session.topic !== topic) {
        throw new MoiError(
          ErrorCode.WALLET_NOT_CONNECTED,
          "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
        );
      }
      return wc.signInteraction(session, ix, opts);
    },
    async disconnect(topic) {
      // Only a "once" pairing is disconnected after use and stdio has none, so this is not reached by a write. It
      // does what its name says for the topic it is given and for no other.
      const wc = walletClient();
      if (wc.session()?.topic === topic) await wc.disconnect();
    },
  };
}

function localJournal(): WriteDeps["journal"] {
  // A WriteJournal is a path and nothing else, so one is made per call from the current config. A cached one could
  // outlive a change of MOI_MCP_HOME (tests do that) and write somewhere nobody is looking.
  return {
    append: (entry) => new WriteJournal(getConfig().home).append(entry),
    update: (id, state, patch) => new WriteJournal(getConfig().home).update(id, state, patch),
  };
}

export function localWriteDeps(): WriteDeps {
  return { store: localStore(), hub: localHub(), journal: localJournal() };
}
