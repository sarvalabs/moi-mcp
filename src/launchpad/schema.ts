/** Tool inputs and outputs for the moi_launchpad_* family. */

import { z } from "zod";

import { HexId } from "../schema.js";

export const LaunchpadStatusInput = z.object({});

export const LaunchpadAgent = z.object({
  /** The Launchpad's own record id; what the other launchpad tools take. */
  id: z.string(),
  name: z.string(),
  /** The agent's on-chain wallet, minted by the Launchpad. */
  address: z.string().optional(),
  template: z.string().optional(),
  /** pending_grant until registered on chain, then active; paused, deleted. */
  status: z.string(),
  visibility: z.string().optional(),
  registryTx: z.string().optional(),
  /** False when the Launchpad can no longer decrypt the agent's key, so no setup script can be made. */
  keyReadable: z.boolean().optional(),
});
export type LaunchpadAgent = z.infer<typeof LaunchpadAgent>;

export const LaunchpadStatusOutput = z.object({
  launchpad: z.string().url(),
  signedIn: z.boolean(),
  wallet: z.string().optional(),
  /** ISO time the Launchpad session ends. */
  expiresAt: z.string().optional(),
  telegramLinked: z.boolean().optional(),
  agents: z.array(LaunchpadAgent).optional(),
  /** Why signedIn is false, when there was a session that no longer works. */
  note: z.string().optional(),
});
export type LaunchpadStatusOutputType = z.infer<typeof LaunchpadStatusOutput>;

export const LaunchpadSignInInput = z.object({});
export const LaunchpadSignInOutput = z.object({
  launchpad: z.string().url(),
  signedIn: z.literal(true),
  wallet: z.string(),
  expiresAt: z.string(),
});

export const LaunchpadTemplatesInput = z.object({});
export const LaunchpadTemplate = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string().optional(),
  scopes: z.array(z.string()),
  /** What `config` needs when creating an agent from this template. */
  configFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      placeholder: z.string().optional(),
      help: z.string().optional(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
      allowCustom: z.boolean().optional(),
      optional: z.boolean().optional(),
    }),
  ),
  examplePrompts: z.array(z.string()),
  /** False when the template needs a server-side API key the Launchpad does not have right now. */
  available: z.boolean(),
});
export const LaunchpadTemplatesOutput = z.object({ templates: z.array(LaunchpadTemplate) });

export const LaunchpadCreateAgentInput = z.object({
  templateId: z.string().min(1).describe("A template id from moi_launchpad_templates."),
  name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .describe("2 to 40 characters. Names are unique across the Launchpad; a taken name is refused."),
  config: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("One value per configField of the template, keyed by the field's key."),
  visibility: z.enum(["private", "public"]).optional(),
  category: z.string().min(1).max(40).optional(),
  price: z.number().int().min(0).max(1_000_000).optional(),
});
export const LaunchpadCreateAgentOutput = z.object({
  agent: LaunchpadAgent,
  /** What to do next, for the model to relay. */
  next: z.string(),
});

export const LaunchpadRegisterAgentInput = z.object({
  agentId: z.string().min(1).describe("The Launchpad record id of the agent (from create or status), not the on-chain agent_<n> id."),
});

export const LaunchpadRegisterAgentOutput = z.object({
  status: z.enum(["sent"]),
  hash: HexId,
  explorerUrl: z.string().url(),
  summary: z.string().optional(),
  /** The registry's own id for the agent, once the receipt was read. */
  registryAgentId: z.string().optional(),
  /** The Launchpad record's status after confirmation. */
  launchpadStatus: z.string(),
  note: z.string().optional(),
});

export const LaunchpadTelegramLinkInput = z.object({});
export const LaunchpadTelegramLinkOutput = z.object({
  link: z.string().url(),
  /** The code inside the link stops working after this. */
  expiresAt: z.string(),
  /** Whether a Telegram account was already linked before this call. */
  alreadyLinked: z.boolean(),
});

export const LaunchpadSetupScriptInput = z.object({
  agentId: z.string().min(1).describe("The Launchpad record id of an active agent."),
});
export const LaunchpadSetupScriptOutput = z.object({
  downloadUrl: z.string().url(),
  /** ISO time after which the link stops working. It also stops after one download. */
  expiresAt: z.string(),
  agent: LaunchpadAgent,
});

export const LaunchpadSignOutInput = z.object({});
