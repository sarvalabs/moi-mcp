/**
 * The hosted server's pairing tools: connect, status, disconnect, per signed-in user. Moved from src/server.ts.
 */

import QRCode from "qrcode";
import { z } from "zod";

import type { AuthInfo } from "../auth/types.js";
import { toMcpError } from "../errors.js";
import { MoiError } from "../moi-error.js";
import { NETWORKS } from "../moi/provider.js";
import { ErrorCode } from "../schema.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import {
  expiresAtOf,
  isExpired,
  lifetimeOfMode,
  LIFETIMES,
  modeOfLifetime,
  type PairingMode,
} from "../wc/lifetime.js";
import { toBlockText } from "../wc/qr.js";
import type { WalletSessionStore } from "../wc/store.js";
import { defineTool, type ToolDef } from "./define.js";

/** What the hosted pairing tools use of the hosted server's dependencies; src/server.ts's HostedDeps satisfies it. */
export interface HostedWalletDeps {
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  startPairing(userId: string, mode: PairingMode): Promise<{ uri: string; expiresAt: number }>;
}

/** caip2 -> the network key NETWORKS lists it under, when it matches one we know. */
function networkForCaip2(caip2: string): string | undefined {
  return Object.values(NETWORKS).find((n) => n.caip2 === caip2)?.network;
}

const CONNECT_OUTPUT = {
  uri: z
    .string()
    .describe("The raw WalletConnect pairing string. Paste it only if the person asks for it by name."),
  expiresAt: z.number().describe("Unix seconds; the pairing proposal dies at this time."),
  lifetime: z.enum(LIFETIMES).describe("The lifetime that applies once the person approves: once, day or week."),
  replaces: z
    .object({ address: z.string(), since: z.string() })
    .optional()
    .describe("Present when a live pairing already exists for this user and will be replaced on approval."),
};

/**
 * What the result text tells the person about the lifetime they chose. Every clock starts when they approve on the
 * phone, which is when the record is written, not when the tool is called.
 */
const LIFETIME_SENTENCE = {
  once:
    "This pairing ends after your next approved transaction, or 15 minutes after you approve it if none comes. " +
    'Say "disconnect my wallet" to end it sooner.',
  day: 'You stay connected for 24 hours after you approve it. Say "disconnect my wallet" to end it sooner.',
  week: 'You stay connected for 7 days after you approve it. Say "disconnect my wallet" to end it sooner.',
} as const satisfies Record<(typeof LIFETIMES)[number], string>;

const WALLET_STATUS_OUTPUT = {
  connected: z.boolean(),
  address: z.string().optional(),
  caip2: z.string().optional(),
  network: z.string().optional(),
  lifetime: z.enum(LIFETIMES).optional().describe("Present when connected: once, day or week, as chosen when pairing."),
  expiresAt: z.number().optional().describe("Present when connected: Unix seconds when this pairing ends."),
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
        "Pair MOI Wallet on the person's phone with this server over WalletConnect. Before calling this, ask the " +
        "person how long the connection should stay open and offer three choices: once, which ends after the next " +
        "approved transaction or after 15 minutes; day, which is 24 hours; and week, which is 7 days. Do not assume " +
        "an answer, and do not call this tool until the person has given one. The result starts with a QR " +
        "code drawn in block characters inside a fenced code block, and also carries the same code as an image. " +
        "Print that code block exactly as given, unchanged, in a code block, before any other text. Do not retype " +
        "it, trim it, reflow it or put anything inside it, and keep every space at the start and end of each line, " +
        "because the phone has to scan it from the screen and a changed character can stop it scanning. The code " +
        "works for about 5 minutes. After the person approves on their phone, call moi_wallet_status to " +
        "confirm. No private key ever reaches this server.",
      inputSchema: {
        lifetime: z
          .enum(LIFETIMES)
          .describe(
            "How long the connection stays open once the person approves on their phone. Once ends after the " +
              "next approved transaction, or after 15 minutes if none comes. Day lasts 24 hours. Week lasts 7 " +
              "days. This input is required: ask the person which one they want before calling, and never choose " +
              "for them.",
          ),
      },
      outputSchema: CONNECT_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ lifetime }) => {
      try {
        const userId = requireAuth().userId;
        const mode = modeOfLifetime(lifetime);
        // Say so when this would replace a wallet that is already paired. A
        // stolen cookie could otherwise swap in an attacker's phone silently,
        // and an honest user reconnecting deserves to know too.
        const existing = await deps.store.get(userId);
        const replaces =
          existing && !isExpired(existing) ? { address: existing.address, since: existing.createdAt } : undefined;
        const { uri, expiresAt } = await deps.startPairing(userId, mode);

        // The URI lands in the chat transcript, and it carries the key for
        // this pairing proposal. That is a deliberate trade: the proposal is
        // dead after about five minutes or its first use, so the exposure is a
        // real-time race on the transcript, and the user chose staying in the
        // chat over a separate page. Funds are never at stake either way; a
        // hijacked pairing can raise prompts on a phone, not sign for it.
        //
        // claude.ai shows an image block from a tool result only as a small
        // thumbnail, and gives its model the content text and not
        // structuredContent. So the person sees the code in the chat as text,
        // which the model prints in a code block. The image is kept for the
        // clients that do show it. The text code spells the same pairing
        // string as the image, so the exposure described above is the same for
        // both. The text itself carries no raw wc: string: spelled out it is a
        // secret in a transcript and noise next to the code.
        const png = await QRCode.toBuffer(uri, { type: "png", width: 320, margin: 1 });
        const block = await toBlockText(uri);
        const lifetimeSentence = LIFETIME_SENTENCE[lifetime];
        // The fence comes first and holds only the code, which is made of spaces, block characters and newlines, so it
        // cannot close its own fence.
        const text = [
          "```",
          block,
          "```",
          "Show the code block above to the person exactly as it is, unchanged, in a code block, before anything else " +
            "you say. Keep every space at the start and end of each line.",
          "Then tell them to scan it with MOI Wallet on their phone and approve the pairing there. " +
            "It expires in about 5 minutes. " +
            lifetimeSentence,
          "Once they approve, call moi_wallet_status to confirm the pairing.",
          ...(replaces
            ? [
                `Note: a wallet is already paired to this account (${replaces.address}). Approving this replaces it. ` +
                  "If you did not ask to change wallets, do not scan; say \"disconnect my wallet\" instead.",
              ]
            : []),
        ].join("\n");
        const structuredContent = { uri, expiresAt, lifetime, ...(replaces ? { replaces } : {}) };
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
              lifetime: lifetimeOfMode(record.mode),
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
