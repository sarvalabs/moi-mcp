/** Pairing and session tools. */

import { z } from "zod";

import { getConfig, log, projectIdIssue } from "../config.js";
import { messageOf, toMcpError } from "../errors.js";
import { NETWORKS } from "../moi/provider.js";
import {
  ConnectWalletInput,
  ConnectWalletOutput,
  DisconnectWalletInput,
  WalletStatusInput,
  WalletStatusOutput,
} from "../schema.js";
import { WalletConnectClient, type SignClientLike, type WcConfig } from "../wc/client.js";
import { checkValidity } from "../wc/session.js";
import { defineTool, type ToolDef } from "./define.js";

let client: WalletConnectClient | undefined;

/** Shared client, built lazily so a bad config cannot stop the server booting. */
export function walletClient(): WalletConnectClient {
  if (!client) {
    const cfg = getConfig();
    const wc: WcConfig = {
      projectId: cfg.WC_PROJECT_ID,
      home: cfg.home,
      network: cfg.MOI_NETWORK,
      requestTimeoutMs: cfg.REQUEST_TIMEOUT_MS,
    };
    client = new WalletConnectClient(wc);
  }
  return client;
}

/** Test seam. */
export function setWalletClient(
  cfg: WcConfig,
  factory?: (c: WcConfig) => Promise<SignClientLike>,
): WalletConnectClient {
  client = new WalletConnectClient(cfg, factory);
  return client;
}

export function resetWalletClient(): void {
  client = undefined;
}

/**
 * Status carries configuration health too. It is the first tool anyone reaches
 * for when something is wrong, and most callers never think to try `ping`.
 */
const StatusOutput = WalletStatusOutput.extend({
  configOk: z.boolean(),
  configError: z.string().optional(),
  caip2Verified: z.boolean().optional(),
});

export function walletTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  tools.push(defineTool(
    "moi_connect_wallet",
    {
      title: "Connect MOI Wallet",
      description:
        "Pair MOI Wallet on your phone with this server over WalletConnect. Returns a QR code to " +
        "scan. Approval happens on the phone, so this returns immediately — call moi_wallet_status " +
        "afterwards to confirm the pairing landed. No private key ever reaches this server.",
      inputSchema: ConnectWalletInput.shape,
      outputSchema: ConnectWalletOutput.shape,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ qr }) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const existing = await wc.currentSession();
        const validity = checkValidity(existing, cfg.MOI_NETWORK);

        if (validity.valid && existing) {
          const structuredContent = {
            status: "already_connected" as const,
            account: existing.account,
            network: existing.network,
            expiresAt: existing.expiry * 1000,
          };
          return {
            content: [
              { type: "text" as const, text: `Already paired with ${existing.account} on ${existing.network}.` },
            ],
            structuredContent,
          };
        }

        const { uri, approval } = await wc.pair();

        // Do not block the tool on the human. Surface the outcome on stderr.
        approval.then(
          (s) => log("info", `wallet paired: ${s.account} on ${s.network}`),
          (err: unknown) => log("error", `pairing not completed: ${messageOf(err)}`),
        );

        const structuredContent = {
          status: "awaiting_scan" as const,
          uri,
          network: cfg.MOI_NETWORK,
        };

        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];

        if (qr) {
          const { toPng } = await import("../wc/qr.js");
          content.push({ type: "image", data: await toPng(uri), mimeType: "image/png" });
        }
        content.push({
          type: "text",
          text:
            `Scan this with MOI Wallet on your phone, then call moi_wallet_status to confirm.\n\n` +
            `Network: ${cfg.MOI_NETWORK} (${NETWORKS[cfg.MOI_NETWORK].caip2})\n${uri}`,
        });

        return { content, structuredContent };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  ));

  tools.push(defineTool(
    "moi_wallet_status",
    {
      title: "MOI Wallet status",
      description:
        "Report whether a MOI Wallet is paired, which account and network, when the session " +
        "expires, and whether this server is configured correctly. Check this first when a MOI " +
        "tool fails.",
      inputSchema: WalletStatusInput.shape,
      outputSchema: StatusOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      let structuredContent: z.infer<typeof StatusOutput>;
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = await wc.currentSession();
        const validity = checkValidity(session, cfg.MOI_NETWORK);

        // A syntactically odd project id still loads, but it will fail at the
        // relay — say so here rather than letting the user find out mid-pair.
        const idIssue = projectIdIssue(cfg.WC_PROJECT_ID);

        structuredContent = {
          connected: validity.valid,
          pendingRequests: wc.pendingRequests,
          configOk: !idIssue,
          caip2Verified: NETWORKS[cfg.MOI_NETWORK].caip2Verified,
          ...(session
            ? {
                account: session.account,
                network: session.network,
                chainId: session.chainId,
                peerName: session.peer.name,
                expiry: session.expiry,
              }
            : {}),
          ...(idIssue
            ? { configError: idIssue }
            : validity.valid
              ? {}
              : validity.message
                ? { configError: validity.message }
                : {}),
        };
      } catch (err) {
        // A broken config is exactly what this tool exists to report.
        structuredContent = {
          connected: false,
          pendingRequests: 0,
          configOk: false,
          configError: messageOf(err),
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  ));

  tools.push(defineTool(
    "moi_disconnect_wallet",
    {
      title: "Disconnect MOI Wallet",
      description: "End the WalletConnect session and delete the local session file.",
      inputSchema: DisconnectWalletInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ reason }) => {
      try {
        const had = await walletClient().disconnect(reason ?? "Disconnected by the agent");
        return {
          content: [
            { type: "text" as const, text: had ? "Wallet disconnected." : "No wallet was paired." },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  ));
  return tools;
}
