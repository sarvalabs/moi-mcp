/**
 * The hosted server's pairing tools: connect, status, disconnect, per signed-in user. Moved from src/server.ts.
 */

import QRCode from "qrcode";
import { z } from "zod";

import type { AuthInfo } from "../auth/types.js";
import { toMcpError } from "../errors.js";
import { MoiError } from "../moi-error.js";
import { NETWORKS } from "../moi/provider.js";
import type { PairingSeed } from "../pairing/index.js";
import { ErrorCode } from "../schema.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import { expiresAtOf, isExpired, type PairingMode } from "../wc/lifetime.js";
import type { WalletSessionStore } from "../wc/store.js";
import { defineTool, type ToolDef } from "./define.js";

/** What the hosted pairing tools use of the hosted server's dependencies; src/server.ts's HostedDeps satisfies it. */
export interface HostedWalletDeps {
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  createPairingLink(userId: string, seed?: PairingSeed): { url: string; expiresAt: number };
  startPairing(userId: string, mode?: PairingMode): Promise<{ uri: string; expiresAt: number }>;
}

/** caip2 -> the network key NETWORKS lists it under, when it matches one we know. */
function networkForCaip2(caip2: string): string | undefined {
  return Object.values(NETWORKS).find((n) => n.caip2 === caip2)?.network;
}

const CONNECT_OUTPUT = {
  pairingUrl: z
    .string()
    .describe("Web page showing the same QR code, plus the pairing link with a copy button. Give this to the person as a clickable link."),
  uri: z.string().describe("The raw WalletConnect pairing string. Paste it only if the person asks for it by name."),
  expiresAt: z.number().describe("Unix seconds; the pairing proposal dies at this time."),
  mode: z.enum(["persistent", "once"]).describe("How long the pairing lives once approved."),
  replaces: z
    .object({ address: z.string(), since: z.string() })
    .optional()
    .describe("Present when a live pairing already exists for this user and will be replaced on approval."),
};
const WALLET_STATUS_OUTPUT = {
  connected: z.boolean(),
  address: z.string().optional(),
  caip2: z.string().optional(),
  network: z.string().optional(),
};

/**
 * Register the three per-user wallet tools onto an already-authenticated
 * request's ephemeral server. Never called for an unauthenticated request —
 * buildHostedApp only reaches this after deps.authenticate(req) succeeded.
 */
export function hostedWalletTools(deps: HostedWalletDeps, auth: AuthInfo | null): ToolDef[] {
  // See registerHostedWrites: listed for everyone so they are discoverable,
  // gated on call by handleMcp's 401.
  const requireAuth = (): AuthInfo => {
    if (!auth) {
      throw new MoiError(
        ErrorCode.WALLET_NOT_CONNECTED,
        "Sign in to this connector before connecting a wallet.",
      );
    }
    return auth;
  };
  const tools: ToolDef[] = [];
  tools.push(defineTool(
    "moi_connect_wallet",
    {
      title: "Connect MOI Wallet",
      description:
        "Pair MOI Wallet on your phone with this server over WalletConnect. Returns a QR code image " +
        "and, in the text, a link to a web page showing the same code. Show the image if your client " +
        "renders images from tool results, and ALWAYS give the person the page link as a clickable URL, " +
        "because some clients never display the image. Do not paste the raw wc: string unless asked. " +
        "After they approve on their phone, call moi_wallet_status to confirm. No private key ever " +
        "reaches this server.",
      inputSchema: {
        remember: z
          .boolean()
          .optional()
          .describe(
            "true (default): stay connected for a week, so later transactions only need a tap on the " +
              "phone. false: forget the pairing after the next approved transaction, or after 15 minutes.",
          ),
      },
      outputSchema: CONNECT_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ remember }) => {
      try {
        const userId = requireAuth().userId;
        const mode: PairingMode = remember === false ? "once" : "persistent";
        // Say so when this would replace a wallet that is already paired. A
        // stolen cookie could otherwise swap in an attacker's phone silently,
        // and an honest user reconnecting deserves to know too.
        const existing = await deps.store.get(userId);
        const replaces =
          existing && !isExpired(existing) ? { address: existing.address, since: existing.createdAt } : undefined;
        // The lifetime goes on the pairing record first, so the page shows
        // the same choice and the approval handler reads it from one place
        // (makeStartPairing falls back to modeForUser when mode is omitted).
        deps.createPairingLink(userId, { mode });
        const { uri, expiresAt } = await deps.startPairing(userId);
        // Then the page is seeded with this very proposal, so a person who
        // cannot see the image in chat opens the link and scans the same code.
        const link = deps.createPairingLink(userId, { uri });

        // The URI lands in the chat transcript, and it carries the key for
        // this pairing proposal. That is a deliberate trade: the proposal is
        // dead after about five minutes or its first use, so the exposure is a
        // real-time race on the transcript, and the user chose staying in the
        // chat over a separate page. Funds are never at stake either way; a
        // hijacked pairing can raise prompts on a phone, not sign for it.
        //
        // claude.ai does not show image blocks from tool results to the
        // person, and does not give its model structuredContent, so the page
        // link in the text is the one path that works everywhere.
        const png = await QRCode.toBuffer(uri, { type: "png", width: 320, margin: 1 });
        const lifetime =
          mode === "once"
            ? "This pairing is forgotten after your next approved transaction, or after 15 minutes."
            : 'You stay connected for a week. Say "disconnect my wallet" to end it sooner.';
        const text = [
          "Scan this QR code with MOI Wallet on your phone, then approve the pairing there.",
          `If the QR code is not showing here, open ${link.url} in your browser. It shows the same code, ` +
            "with the pairing link and a copy button.",
          "It expires in about 5 minutes. " + lifetime,
          "Once approved, moi_wallet_status confirms the pairing.",
          ...(replaces
            ? [
                `Note: a wallet is already paired to this account (${replaces.address}). Approving this replaces it. ` +
                  "If you did not ask to change wallets, do not scan; say \"disconnect my wallet\" instead.",
              ]
            : []),
        ].join("\n");
        const structuredContent = { pairingUrl: link.url, uri, expiresAt, mode, ...(replaces ? { replaces } : {}) };
        return {
          content: [
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
            { type: "text" as const, text },
          ],
          structuredContent,
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  ));

  tools.push(defineTool(
    "moi_wallet_status",
    {
      title: "MOI Wallet status",
      description: "Report whether your MOI Wallet is paired to this server, and which account.",
      inputSchema: {},
      outputSchema: WALLET_STATUS_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const userId = requireAuth().userId;
        let record = await deps.store.get(userId);
        if (record && isExpired(record)) {
          // Report the truth rather than a pairing the server will refuse to
          // use, and tidy up so the next connect starts clean.
          await deps.store.delete(userId);
          record = undefined;
        }
        const structuredContent = record
          ? {
              connected: true,
              address: record.address,
              caip2: record.caip2,
              ...(networkForCaip2(record.caip2) ? { network: networkForCaip2(record.caip2) } : {}),
              mode: record.mode ?? "persistent",
              expiresAt: expiresAtOf(record),
            }
          : { connected: false };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  ));

  tools.push(defineTool(
    "moi_disconnect_wallet",
    {
      title: "Disconnect MOI Wallet",
      description: "Forget your paired MOI Wallet session on this server.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const userId = requireAuth().userId;
        const record = await deps.store.get(userId);
        await deps.store.delete(userId);
        // Our record is what matters for security; the relay teardown is so
        // the phone stops listing a connection that can no longer be used.
        if (record) {
          try {
            await deps.hub.disconnect(record.topic);
          } catch {
            // Already gone on the relay, or the relay is unreachable. Either
            // way the server-side pairing is deleted, which is the guarantee.
          }
        }
        return { content: [{ type: "text" as const, text: "Wallet disconnected." }] };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  ));
  return tools;
}
