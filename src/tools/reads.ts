/**
 * The five read tools. These never touch a wallet — they answer straight from
 * the node, so they work before pairing and on any network.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getConfig } from "../config.js";
import { toMcpError } from "../errors.js";
import { getProvider, getReadOnlySigner, interactionUrl } from "../moi/provider.js";
import { getAccount, getAsset, getInteraction, getLogic } from "../moi/reads.js";
import { listAgents, resolveAgent } from "../moi/registry.js";
import {
  GetAccountInput,
  GetAccountOutput,
  GetAssetInput,
  GetAssetOutput,
  GetInteractionInput,
  GetInteractionOutput,
  GetLogicInput,
  GetLogicOutput,
  ListAgentsInput,
  ListAgentsOutput,
  ResolveAgentInput,
  ResolveAgentOutput,
} from "../schema.js";

/** Wrap a handler so library errors surface as proper MCP errors. */
async function run<T>(fn: () => Promise<T>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
}> {
  try {
    const value = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    };
  } catch (err) {
    throw toMcpError(err);
  }
}

function providerOptions() {
  const cfg = getConfig();
  return { network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "moi_get_account",
    {
      title: "Get MOI account",
      description:
        "Read a MOI participant account: its nonce, whether it is registered on chain, and its " +
        "balance in every asset it holds. Takes a participant id (0x-prefixed). Use this to check " +
        "a balance before proposing a transfer.",
      inputSchema: GetAccountInput.shape,
      outputSchema: GetAccountOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ address }) =>
      run(async () => getAccount(getProvider(providerOptions()), address)),
  );

  server.registerTool(
    "moi_get_asset",
    {
      title: "Get MOI asset",
      description:
        "Read a MOI native asset by its asset id: symbol, standard (MAS0/MAS1/MAS2), circulating " +
        "supply, decimal dimension, and owner. Use this to learn an asset's dimension before " +
        "interpreting raw balances.",
      inputSchema: GetAssetInput.shape,
      outputSchema: GetAssetOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ assetId }) => run(async () => getAsset(getProvider(providerOptions()), assetId)),
  );

  server.registerTool(
    "moi_get_interaction",
    {
      title: "Get MOI interaction",
      description:
        "Look up a MOI interaction (MOI's term for a transaction) by hash. Returns its status " +
        "(pending/success/failed), sender, operations and fuel used. Use this after moi_transfer " +
        "to confirm the interaction landed.",
      inputSchema: GetInteractionInput.shape,
      outputSchema: GetInteractionOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ hash }) =>
      run(async () => {
        const cfg = getConfig();
        const result = await getInteraction(getProvider(providerOptions()), hash);
        // Not part of the schema output, but handy for the agent to cite.
        void interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL);
        return result;
      }),
  );

  server.registerTool(
    "moi_get_logic",
    {
      title: "Get MOI logic",
      description:
        "Read a deployed MOI logic (MOI's term for a smart contract) by logic id. Returns its " +
        "callable routines with their input and output types. Call this before moi_call_logic so " +
        "you know the routine name and argument order.",
      inputSchema: GetLogicInput.shape,
      outputSchema: GetLogicOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ logicId }) => run(async () => getLogic(getProvider(providerOptions()), logicId)),
  );

  server.registerTool(
    "moi_resolve_agent",
    {
      title: "Resolve MOI agent",
      description:
        "Look up an AI agent in the MOI agent registry by handle, name, or address. Returns the " +
        "agent's on-chain id, wallet address, capabilities and service endpoint. Use before paying " +
        "or calling an agent. Returns found:false when the agent is not registered — that is a " +
        "normal answer, not an error.",
      inputSchema: ResolveAgentInput.shape,
      outputSchema: ResolveAgentOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ query }) =>
      run(async () => resolveAgent(getReadOnlySigner(providerOptions()), query)),
  );

  server.registerTool(
    "moi_list_agents",
    {
      title: "List MOI agents",
      description:
        "Page through the MOI agent registry: every registered agent, or only those a given account " +
        "registered. Each entry has the agent id, owner, wallet address, status and service URL. " +
        "Use moi_resolve_agent for one agent's full profile and card.",
      inputSchema: ListAgentsInput.shape,
      outputSchema: ListAgentsOutput.shape,
      annotations: READ_ONLY,
    },
    async ({ owner, offset, limit }) =>
      run(async () =>
        listAgents(getReadOnlySigner(providerOptions()), {
          ...(owner ? { owner } : {}),
          offset,
          limit,
        }),
      ),
  );
}
