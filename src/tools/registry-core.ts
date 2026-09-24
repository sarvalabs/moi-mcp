/**
 * The agent registry's write routines, prepared the way every other write
 * is: built, simulated, and described for the person before the phone is
 * asked. Shared by the hosted and stdio servers and by the Launchpad flow.
 * No MCP imports.
 */

import type { z } from "zod";

import { registryLogicId } from "../moi/registry.js";
import type { RegisterAgentInput, SetAgentStatusInput, TransferAgentInput } from "../schema.js";
import { prepareLogicInvoke, type PreparedWrite } from "./write-core.js";

/** RegisterAgent(url, card_uri, agent_wallet) -> agent_id. The sender becomes the owner. */
export async function prepareRegisterAgent(
  account: string,
  params: z.infer<typeof RegisterAgentInput>,
  options: { label?: string } = {},
): Promise<PreparedWrite> {
  const logicId = registryLogicId();
  const prepared = await prepareLogicInvoke(account, {
    logicId,
    routine: "RegisterAgent",
    args: [params.url, params.cardUri, params.agentWallet],
  });
  const what = options.label ? `agent "${options.label}"` : "an agent";
  return {
    ...prepared,
    description: `Register ${what} (${params.agentWallet}) in the MOI agent registry, owned by ${account}`,
    details: {
      Operation: "Register agent",
      ...(options.label ? { Agent: options.label } : {}),
      "Agent wallet": params.agentWallet,
      Owner: account,
      URL: params.url,
      Card: params.cardUri,
      Registry: logicId,
    },
  };
}

/** SetAgentStatus(agent_id, status) -> success. Owner only. */
export async function prepareSetAgentStatus(
  account: string,
  params: z.infer<typeof SetAgentStatusInput>,
): Promise<PreparedWrite> {
  const logicId = registryLogicId();
  const prepared = await prepareLogicInvoke(account, {
    logicId,
    routine: "SetAgentStatus",
    args: [params.agentId, params.status],
  });
  return {
    ...prepared,
    description: `Set agent ${params.agentId} to ${params.status} in the MOI agent registry`,
    details: {
      Operation: "Set agent status",
      Agent: params.agentId,
      Status: params.status,
      Owner: account,
      Registry: logicId,
    },
  };
}

/** TransferAgent(agent_id, new_owner) -> success. Owner only; the sender stops owning it. */
export async function prepareTransferAgent(
  account: string,
  params: z.infer<typeof TransferAgentInput>,
): Promise<PreparedWrite> {
  const logicId = registryLogicId();
  const prepared = await prepareLogicInvoke(account, {
    logicId,
    routine: "TransferAgent",
    args: [params.agentId, params.newOwner],
  });
  return {
    ...prepared,
    description: `Transfer agent ${params.agentId} from ${account} to ${params.newOwner} in the MOI agent registry`,
    details: {
      Operation: "Transfer agent",
      Agent: params.agentId,
      "Current owner": account,
      "New owner": params.newOwner,
      Registry: logicId,
    },
  };
}
