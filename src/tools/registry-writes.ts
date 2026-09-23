/**
 * The agent registry's write routines as hosted tools: register an agent
 * you host yourself, change its status, hand it to a new owner. Each runs
 * the same two-call preview and confirm path as every other hosted write.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthInfo } from "../auth/types.js";
import { getConfig } from "../config.js";
import { getReadOnlySigner } from "../moi/provider.js";
import { findAgentByWallet } from "../moi/registry.js";
import { RegisterAgentInput, SetAgentStatusInput, TransferAgentInput } from "../schema.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type HostedWriteDeps } from "./hosted-writes.js";
import { prepareRegisterAgent, prepareSetAgentStatus, prepareTransferAgent } from "./registry-core.js";
import { WriteOutputShape } from "./write-core.js";

export interface RegistryWriteOptions {
  /** The write path. Injectable so tests can stand in for the phone and the node. */
  write?: typeof runWrite;
  /** How long to watch the registry for a newly registered agent's id. */
  registryWaitMs?: number;
}

const DEFAULT_REGISTRY_WAIT_MS = 30_000;

export function registerRegistryWrites(
  server: McpServer,
  deps: HostedWriteDeps,
  auth: AuthInfo | null,
  options: RegistryWriteOptions = {},
): void {
  const write = options.write ?? runWrite;

  server.registerTool(
    "moi_register_agent",
    {
      title: "Register an agent in the MOI agent registry",
      description:
        "Register an AI agent in the on-chain MOI agent registry, owned by the user's paired wallet. Takes the agent's own " +
        "MOI account, the URL it is served at, and the URL of its card. For an agent built on the MOI Agent Launchpad use " +
        "moi_launchpad_register_agent instead; this is for agents you host yourself. Returns the registry's agent_<n> id once " +
        "the registry lists it." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...RegisterAgentInput.shape, confirm: ConfirmArg },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) => {
      let owner = "";
      const result = await write(deps, auth, "register_agent", args, confirm, (session) => {
        owner = session.address;
        return prepareRegisterAgent(session.address, args);
      });
      const sent = result.structuredContent as { status?: string; hash?: string } | undefined;
      if (sent?.status !== "sent" || !sent.hash || !owner) return result;

      const cfg = getConfig();
      const signer = getReadOnlySigner({ network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL });
      const registryAgentId = await findAgentByWallet(
        signer,
        owner,
        args.agentWallet,
        options.registryWaitMs ?? DEFAULT_REGISTRY_WAIT_MS,
      );
      const value = {
        ...(result.structuredContent as Record<string, unknown>),
        ...(registryAgentId
          ? { registryAgentId }
          : {
              note:
                "The registry had not listed the agent yet when this returned. moi_list_agents with the paired wallet as owner will show it once the interaction is included.",
            }),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
    },
  );

  server.registerTool(
    "moi_set_agent_status",
    {
      title: "Set an agent's status in the MOI agent registry",
      description:
        "Mark an agent in the on-chain MOI agent registry ACTIVE or DEPRECATED. Only the agent's owner, the paired wallet, can. " +
        "Deprecating is how an agent is retired; the entry stays in the registry." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...SetAgentStatusInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      write(deps, auth, "set_agent_status", args, confirm, (session) => prepareSetAgentStatus(session.address, args)),
  );

  server.registerTool(
    "moi_transfer_agent",
    {
      title: "Transfer an agent to a new owner",
      description:
        "Hand an agent in the on-chain MOI agent registry to another account. Only the current owner, the paired wallet, can, " +
        "and afterwards it no longer controls the agent. Check the new owner's address with the user before calling." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...TransferAgentInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      write(deps, auth, "transfer_agent", args, confirm, (session) => prepareTransferAgent(session.address, args)),
  );
}
