/**
 * Write tools. Every one of these builds an interaction locally and hands it to
 * MOI Wallet for approval. None of them can sign.
 *
 * Each write runs the same guard sequence before touching the relay:
 *   1. a valid session exists            -> WALLET_NOT_CONNECTED
 *   2. that session is on our network    -> NETWORK_MISMATCH
 *   3. (transfer) the balance covers it  -> INSUFFICIENT_BALANCE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getConfig, log } from "../config.js";
import { interactionUrl } from "../moi/provider.js";
import {
  CallLogicInput,
  CreateAccountInput,
  CreateAssetInput,
  MintInput,
  RegisterAgentInput,
  SetAgentStatusInput,
  TransferAgentInput,
  TransferInput,
} from "../schema.js";
import { prepareRegisterAgent, prepareSetAgentStatus, prepareTransferAgent } from "./registry-core.js";
import type { UnsignedInteraction } from "../moi/ix-builder.js";
import { requireSession, type Session } from "../wc/session.js";
import { walletClient } from "./wallet.js";
import {
  WriteOutputShape,
  asWriteResult,
  broadcastSigned,
  kmoiBalance,
  ok,
  prepareCreateAccount,
  prepareCreateAsset,
  prepareLogicInvoke,
  prepareMint,
  prepareTransfer,
  viewLogicCall,
} from "./write-core.js";

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Sign on the phone, broadcast from here. stdio-only path.
 *
 * The split of sign from broadcast is what makes writes work at all right now —
 * the wallet's combined sendInteractions is broken (see wc/client.ts). It also
 * keeps the zero-key property: the signature is produced on the phone and this
 * process only relays it to the node.
 */
async function signAndBroadcast(
  session: Session,
  ix: UnsignedInteraction,
  description: string,
): Promise<string> {
  const signed = await walletClient().signInteraction(session, ix, { description });
  return broadcastSigned(signed.ix_args, signed.signatures);
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "moi_transfer",
    {
      title: "Transfer a MOI asset",
      description:
        "Propose a transfer of a MOI native asset. Builds the interaction here and sends it to " +
        "MOI Wallet on your phone — nothing moves until you tap Send there. The balance is " +
        "checked first. Returns the interaction hash once broadcast.",
      inputSchema: TransferInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const prepared = await prepareTransfer(session.account, params);

        const hash = await signAndBroadcast(
          session,
          prepared.ix,
          prepared.description,
        );

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_create_account",
    {
      title: "Create a MOI account",
      description:
        "Register a brand-new MOI account on chain and fund it with KMOI from your paired wallet. " +
        "A transfer to an address that has never existed is refused by the node, so this is how a " +
        "fresh account gets its first KMOI. Takes the new account's address and compressed public key; " +
        "the tool refuses a key that does not produce that address. Sent to MOI Wallet for approval.",
      inputSchema: CreateAccountInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);
        const prepared = await prepareCreateAccount(session.account, params);
        const hash = await signAndBroadcast(session, prepared.ix, prepared.description);
        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI native asset (a token). `supply` sets the MAXIMUM supply — " +
        "it does not mint anything, so circulating supply starts at 0 and you will hold none " +
        "until you call moi_mint. `dimension` is the number of decimal places; `standard` is " +
        "MAS0, MAS1, MAS2 or MASX. Storage funding is handled automatically. Sent to MOI Wallet " +
        "for approval on your phone.",
      inputSchema: CreateAssetInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ symbol, supply, decimals, dimension, standard, isStateful, isFungible, storageFund }) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const balance = await kmoiBalance(session.account);
        const prepared = await prepareCreateAsset(session.account, {
          symbol,
          supply,
          decimals,
          dimension,
          standard,
          isStateful,
          isFungible,
          storageFund,
          balance,
        });

        const hash = await signAndBroadcast(session, prepared.ix, prepared.description);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_mint",
    {
      title: "Mint tokens of a MOI asset",
      description:
        "Mint tokens of an asset you manage, to yourself or another account. Creating an asset " +
        "sets a maximum supply but mints nothing — until you mint, circulating supply is 0, you " +
        "hold none, and the asset does not appear in a wallet. Sent to MOI Wallet for approval.",
      inputSchema: MintInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ assetId, amount, to }) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const prepared = await prepareMint(session.account, { assetId, amount, to });

        const hash = await signAndBroadcast(session, prepared.ix, prepared.description);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a deployed MOI logic. kind:'view' reads the result immediately and " +
        "needs no wallet. kind:'invoke' changes state and is sent to MOI Wallet for approval. " +
        "Call moi_get_logic first to learn the routine names and argument order.",
      inputSchema: CallLogicInput.shape,
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async ({ logicId, routine, args, kind }) => {
      try {
        const cfg = getConfig();
        // A view runs against the node directly — no wallet, no approval, and
        // no wallet-client construction either: currentSession() would spin up
        // a real SignClient (relay connection, wc.db) for a read.
        if (kind === "view") {
          const value = await viewLogicCall({ logicId, routine, args, kind: "view" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        }

        const wc = walletClient();
        const valid = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const prepared = await prepareLogicInvoke(valid.account, { logicId, routine, args });

        const hash = await signAndBroadcast(valid, prepared.ix, prepared.description);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );
  // The agent registry's own write routines, on the same path as any invoke.
  const registryTools: Array<{
    name: string;
    title: string;
    description: string;
    input: typeof RegisterAgentInput | typeof SetAgentStatusInput | typeof TransferAgentInput;
    prepare: (account: string, params: never) => ReturnType<typeof prepareRegisterAgent>;
  }> = [
    {
      name: "moi_register_agent",
      title: "Register an agent in the MOI agent registry",
      description:
        "Register an AI agent in the on-chain MOI agent registry, owned by your paired wallet. Takes the agent's own " +
        "MOI account, the URL it is served at, and the URL of its card. Sent to MOI Wallet for approval.",
      input: RegisterAgentInput,
      prepare: prepareRegisterAgent as never,
    },
    {
      name: "moi_set_agent_status",
      title: "Set an agent's status in the MOI agent registry",
      description: "Mark an agent you own ACTIVE or DEPRECATED in the on-chain MOI agent registry. Sent to MOI Wallet for approval.",
      input: SetAgentStatusInput,
      prepare: prepareSetAgentStatus as never,
    },
    {
      name: "moi_transfer_agent",
      title: "Transfer an agent to a new owner",
      description: "Hand an agent you own in the on-chain MOI agent registry to another account. Sent to MOI Wallet for approval.",
      input: TransferAgentInput,
      prepare: prepareTransferAgent as never,
    },
  ];
  for (const tool of registryTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input.shape,
        outputSchema: WriteOutputShape,
        annotations: WRITE_ANNOTATIONS,
      },
      async (params: Record<string, unknown>) => {
        try {
          const cfg = getConfig();
          const wc = walletClient();
          const valid = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);
          const prepared = await tool.prepare(valid.account, params as never);
          const hash = await signAndBroadcast(valid, prepared.ix, prepared.description);
          return ok({
            status: "sent",
            hash,
            explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
          });
        } catch (err) {
          return ok(asWriteResult(err));
        }
      },
    );
  }

}
