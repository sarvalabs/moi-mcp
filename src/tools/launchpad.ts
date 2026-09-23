/**
 * The MOI Agent Launchpad from the chat: sign in with the paired wallet, pick
 * a template, create an agent, register it on chain with one tap on the
 * phone, link Telegram, and fetch the setup script.
 *
 * Identity is auth.userId throughout, the same identity the wallet pairing
 * hangs off. The Launchpad session (its cookie) lives in deps.sessions under
 * that id; the wallet session in deps.writes.store. No tool input carries
 * either.
 *
 * Two things never pass through a tool result: the Launchpad cookie, and the
 * agent's private key. The setup script that embeds the key is fetched only
 * when the person opens a one-time download link (src/launchpad/download.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";

import type { AuthInfo } from "../auth/types.js";
import { getConfig } from "../config.js";
import { messageOf, toMcpError } from "../errors.js";
import type { AgentRecord, LaunchpadClient, RegisterIntent } from "../launchpad/client.js";
import * as S from "../launchpad/schema.js";
import { isLaunchpadSessionExpired, type LaunchpadSessionStore, type StoredLaunchpadSession } from "../launchpad/store.js";
import { MoiError } from "../moi-error.js";
import { getReadOnlySigner, NETWORKS } from "../moi/provider.js";
import { findAgentByWallet } from "../moi/registry.js";
import { ErrorCode } from "../schema.js";
import { ConfirmArg, loadSession, runWrite, type HostedWriteDeps } from "./hosted-writes.js";
import { prepareRegisterAgent } from "./registry-core.js";
import { asWriteResult, ok } from "./write-core.js";

export interface LaunchpadDeps {
  client: LaunchpadClient;
  sessions: LaunchpadSessionStore;
  /** The wallet side: pairing store, hub, journal, previews. */
  writes: HostedWriteDeps;
  /** Where one-time download links point; the connector's own origin. */
  createDownloadLink(userId: string, agentId: string): { url: string; expiresAt: number };
  /** The write path. Injectable so tests can stand in for the phone and the node. */
  write?: typeof runWrite;
  /** How long to watch the registry for the new agent before confirming without its id. */
  registryWaitMs?: number;
}

/** The Telegram link's code is minted with a 15-minute life inside it. */
const TELEGRAM_CODE_MS = 15 * 60 * 1000;
const DEFAULT_REGISTRY_WAIT_MS = 45_000;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function requireAuth(auth: AuthInfo | null): AuthInfo {
  if (!auth) {
    throw new MoiError(ErrorCode.WALLET_NOT_CONNECTED, "Sign in to this connector before using the Launchpad.");
  }
  return auth;
}

async function requireLaunchpadSession(deps: LaunchpadDeps, userId: string): Promise<StoredLaunchpadSession> {
  const rec = await deps.sessions.get(userId);
  if (rec && !isLaunchpadSessionExpired(rec) && rec.baseUrl === deps.client.baseUrl) return rec;
  if (rec) await deps.sessions.delete(userId);
  throw new MoiError(
    ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
    rec
      ? "The Launchpad session has expired. Call moi_launchpad_sign_in to sign in again with the paired wallet."
      : "Not signed in to the Launchpad. Call moi_launchpad_sign_in first; it signs one message with the paired wallet.",
  );
}

/** A Launchpad answer of "who are you" means the stored session is dead; forget it. */
async function forgetIfRejected(deps: LaunchpadDeps, userId: string, err: unknown): Promise<void> {
  if (err instanceof MoiError && err.code === ErrorCode.LAUNCHPAD_NOT_SIGNED_IN) await deps.sessions.delete(userId);
}

function toAgent(rec: AgentRecord): S.LaunchpadAgent {
  return {
    id: rec.id,
    name: rec.name,
    ...(rec.moi_address ? { address: rec.moi_address } : {}),
    ...(rec.template_id ? { template: rec.template_id } : {}),
    status: rec.status,
    ...(rec.visibility ? { visibility: rec.visibility } : {}),
    ...(rec.registry_tx ? { registryTx: rec.registry_tx } : {}),
    ...(rec.keyReadable !== undefined ? { keyReadable: rec.keyReadable } : {}),
  };
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

type StatusValue = S.LaunchpadStatusOutputType;

async function run<T extends Record<string, unknown>>(fn: () => Promise<{ value: T; text?: string }>) {
  try {
    const { value, text } = await fn();
    return { content: [{ type: "text" as const, text: text ?? JSON.stringify(value, null, 2) }], structuredContent: value };
  } catch (err) {
    throw toMcpError(err);
  }
}

/** The registry's id for the agent whose wallet this is, under this owner; see findAgentByWallet. */
async function findRegistryAgentId(owner: string, agentWallet: string, waitMs: number): Promise<string | undefined> {
  const cfg = getConfig();
  const signer = getReadOnlySigner({ network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL });
  return findAgentByWallet(signer, owner, agentWallet, waitMs);
}

export function registerLaunchpadTools(server: McpServer, deps: LaunchpadDeps, auth: AuthInfo | null): void {
  const launchpad = deps.client.baseUrl;

  server.registerTool(
    "moi_launchpad_status",
    {
      title: "MOI Agent Launchpad status",
      description:
        "Whether this connector is signed in to the MOI Agent Launchpad with the paired wallet, whether Telegram is linked, " +
        "and the agents the wallet owns there with their Launchpad record ids and statuses.",
      inputSchema: S.LaunchpadStatusInput.shape,
      outputSchema: S.LaunchpadStatusOutput.shape,
      annotations: READ,
    },
    async () =>
      run<StatusValue>(async () => {
        const userId = requireAuth(auth).userId;
        const rec = await deps.sessions.get(userId);
        if (!rec || isLaunchpadSessionExpired(rec) || rec.baseUrl !== launchpad) {
          if (rec) await deps.sessions.delete(userId);
          return {
            value: {
              launchpad,
              signedIn: false,
              ...(rec ? { note: "The Launchpad session expired. Call moi_launchpad_sign_in to sign in again." } : {}),
            },
          };
        }
        try {
          const [me, agents] = await Promise.all([deps.client.me(rec.cookie), deps.client.listAgents(rec.cookie)]);
          return {
            value: {
              launchpad,
              signedIn: true,
              wallet: rec.walletAddress,
              expiresAt: iso(rec.expiresAt),
              telegramLinked: me.profile.telegramLinked,
              agents: agents.map(toAgent),
            },
          };
        } catch (err) {
          await forgetIfRejected(deps, userId, err);
          if (err instanceof MoiError && err.code === ErrorCode.LAUNCHPAD_NOT_SIGNED_IN) {
            return {
              value: { launchpad, signedIn: false, note: "The Launchpad no longer accepts the stored session. Call moi_launchpad_sign_in again." },
            };
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "moi_launchpad_sign_in",
    {
      title: "Sign in to the MOI Agent Launchpad",
      description:
        "Sign in to the MOI Agent Launchpad as the paired wallet. The Launchpad hands out a short sign-in message, " +
        "MOI Wallet on the phone shows it and the person approves it there, and the resulting session is kept on this " +
        "server for a week. Needs a paired wallet (moi_connect_wallet). Nothing is sent on chain and no fee is paid.",
      inputSchema: S.LaunchpadSignInInput.shape,
      outputSchema: S.LaunchpadSignInOutput.shape,
      annotations: ACT,
    },
    async () =>
      run(async () => {
        const who = requireAuth(auth);
        const cfg = getConfig();
        const wallet = await loadSession(deps.writes, who, NETWORKS[cfg.MOI_NETWORK].caip2);
        const { message } = await deps.client.nonce(wallet.address);
        const { signature } = await deps.writes.hub.signMessageFor(wallet.topic, wallet.address, message);
        const session = await deps.client.verify({ address: wallet.address, message, signature });
        await deps.sessions.set({
          version: 1,
          userId: who.userId,
          baseUrl: launchpad,
          cookie: session.cookie,
          walletAddress: wallet.address,
          createdAt: new Date().toISOString(),
          expiresAt: session.expiresAt,
        });
        return {
          value: { launchpad, signedIn: true as const, wallet: wallet.address, expiresAt: iso(session.expiresAt) },
          text: `Signed in to ${launchpad} as ${wallet.address}. The session lasts until ${iso(session.expiresAt)}.`,
        };
      }),
  );

  server.registerTool(
    "moi_launchpad_templates",
    {
      title: "List MOI Agent Launchpad templates",
      description:
        "The agent templates the MOI Agent Launchpad offers, with the config fields each needs. Needs no sign-in. " +
        "Pick one, then call moi_launchpad_create_agent with its id and a config that fills those fields.",
      inputSchema: S.LaunchpadTemplatesInput.shape,
      outputSchema: S.LaunchpadTemplatesOutput.shape,
      annotations: READ,
    },
    async () =>
      run(async () => {
        const templates = await deps.client.templates();
        return {
          value: {
            templates: templates.map((t) => ({
              id: t.id,
              name: t.name,
              ...(t.tagline ? { tagline: t.tagline } : {}),
              scopes: t.scopes,
              configFields: t.configFields.map((f) => ({
                key: f.key,
                label: f.label,
                type: f.type,
                ...(f.placeholder ? { placeholder: f.placeholder } : {}),
                ...(f.help ? { help: f.help } : {}),
                ...(f.options ? { options: f.options } : {}),
                ...(f.allowCustom !== undefined ? { allowCustom: f.allowCustom } : {}),
                ...(f.optional !== undefined ? { optional: f.optional } : {}),
              })),
              examplePrompts: t.examplePrompts,
              available: !(t.requiresApiKey === true && t.apiKeyPresent === false),
            })),
          },
        };
      }),
  );

  server.registerTool(
    "moi_launchpad_create_agent",
    {
      title: "Create an agent on the MOI Agent Launchpad",
      description:
        "Create an agent from a template on the MOI Agent Launchpad, owned by the paired wallet. The Launchpad mints the " +
        "agent its own on-chain wallet. The agent does not run until it is registered on chain with " +
        "moi_launchpad_register_agent. Needs moi_launchpad_sign_in first. Confirm the template, name and config with the " +
        "person before calling; a taken name is refused.",
      inputSchema: S.LaunchpadCreateAgentInput.shape,
      outputSchema: S.LaunchpadCreateAgentOutput.shape,
      annotations: ACT,
    },
    async ({ templateId, name, config, visibility, category, price }) =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const rec = await requireLaunchpadSession(deps, userId);
        try {
          const created = await deps.client.createAgent(rec.cookie, {
            templateId,
            name,
            avatarSeed: randomBytes(8).toString("hex"),
            config,
            ...(visibility ? { visibility } : {}),
            ...(category ? { category } : {}),
            ...(price !== undefined ? { price } : {}),
          });
          const agent = toAgent(created);
          return {
            value: {
              agent,
              next:
                `Created "${agent.name}" (Launchpad id ${agent.id}, status ${agent.status}). It runs only once registered on chain: ` +
                `call moi_launchpad_register_agent with agentId ${agent.id}; the person approves one RegisterAgent interaction on the phone.`,
            },
          };
        } catch (err) {
          await forgetIfRejected(deps, userId, err);
          throw err;
        }
      }),
  );

  server.registerTool(
    "moi_launchpad_register_agent",
    {
      title: "Register a Launchpad agent on chain",
      description:
        "Register an agent created on the MOI Agent Launchpad in the on-chain MOI agent registry, as the paired wallet. " +
        "This is the step that makes the agent live. Two calls, always. First call without confirm: nothing reaches the phone; " +
        "you get a summary of the RegisterAgent interaction and a confirm token. Show it and get an explicit yes. Second call " +
        "with the same agentId plus confirm: the phone asks for the tap, the interaction is broadcast, and the Launchpad is " +
        "told the agent is registered. Fuel is paid by the paired wallet. Needs moi_launchpad_sign_in first.",
      inputSchema: {
        ...S.LaunchpadRegisterAgentInput.shape,
        confirm: ConfirmArg,
      },
      annotations: { ...ACT, destructiveHint: true },
    },
    async ({ agentId, confirm }) => {
      const write = deps.write ?? runWrite;
      let launch: StoredLaunchpadSession;
      let agent: AgentRecord;
      let intent: RegisterIntent;
      let owner: string;
      try {
        const who = requireAuth(auth);
        launch = await requireLaunchpadSession(deps, who.userId);
        owner = (await loadSession(deps.writes, who)).address;
        try {
          agent = await deps.client.getAgent(launch.cookie, agentId);
        } catch (err) {
          await forgetIfRejected(deps, who.userId, err);
          throw err;
        }
        if (agent.status !== "pending_grant") {
          throw new MoiError(
            ErrorCode.INVALID_ARGS,
            `Agent "${agent.name}" is ${agent.status}; only an agent still awaiting registration (pending_grant) can be registered.`,
          );
        }
        if (!agent.moi_address) {
          throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `The Launchpad has no on-chain wallet for agent "${agent.name}".`);
        }
        // The Launchpad's own pre-flight: ownership, status, and whether the
        // owner's account has stuck interactions ahead of this one.
        intent = await deps.client.registerIntent(launch.cookie, agentId);
      } catch (err) {
        return ok(asWriteResult(err));
      }
      const agentWallet = agent.moi_address;

      // Already in the registry under this owner (a broadcast whose confirm
      // never reached the Launchpad): just tell the Launchpad, no new tap.
      const already = await findRegistryAgentId(owner, agentWallet, 0);
      if (already) {
        try {
          await deps.client.registerConfirm(launch.cookie, agentId, { txHash: `recovered:${already}`, agentId: already });
        } catch (err) {
          return ok(asWriteResult(err));
        }
        const value = {
          status: "sent" as const,
          hash: "0x0",
          explorerUrl: `${launchpad}/agent/${agent.id}`,
          registryAgentId: already,
          launchpadStatus: "active",
          note: `"${agent.name}" was already in the registry as ${already}; the Launchpad has now been told. Nothing was sent to the phone.`,
        };
        return { content: [{ type: "text" as const, text: value.note }], structuredContent: value };
      }

      // The Launchpad's own conventions for where the agent lives and where
      // its card is. Building the interaction here, rather than signing the
      // one the Launchpad returns, keeps the preview, the simulation and the
      // sequence number on the same path every other write uses.
      const url = `${launchpad}/agent/${agent.id}`;
      const cardUri = `${launchpad}/api/moi/card/${encodeURIComponent(agentWallet)}`;
      const args = { agentId, url, cardUri, agentWallet };
      const result = await write(deps.writes, auth, "register_agent", args, confirm, async (session) => {
        const prepared = await prepareRegisterAgent(session.address, { url, cardUri, agentWallet }, { label: agent.name });
        if (!intent.blocked) return prepared;
        return {
          ...prepared,
          details: {
            ...prepared.details,
            Note:
              `Your account has ${intent.blocked.blockedCount} stuck interaction(s) ahead of this one in the node's pool; ` +
              `this registration waits behind them${intent.blocked.underfunded ? " and your balance is too low to clear them" : ""}.`,
          },
        };
      });

      const sent = result.structuredContent as
        | { status?: string; hash?: string; explorerUrl?: string; summary?: string }
        | undefined;
      if (sent?.status !== "sent" || !sent.hash || !sent.explorerUrl) return result;

      // On chain. Now the Launchpad, with the registry's id for the agent if
      // it has shown up yet.
      const registryAgentId = await findRegistryAgentId(owner, agentWallet, deps.registryWaitMs ?? DEFAULT_REGISTRY_WAIT_MS);
      let launchpadStatus = "pending_grant";
      let note: string | undefined;
      try {
        await deps.client.registerConfirm(launch.cookie, agentId, {
          txHash: sent.hash,
          ...(registryAgentId ? { agentId: registryAgentId } : {}),
        });
        launchpadStatus = "active";
      } catch (err) {
        note =
          `The registration is on chain (${sent.hash}) but the Launchpad did not record it: ${messageOf(err)}. ` +
          `Call moi_launchpad_register_agent again with the same agentId; it will find the agent in the registry and tell the Launchpad without a new tap.`;
      }
      if (!registryAgentId && !note) {
        note = "The Launchpad recorded the registration by hash; the registry had not listed the agent yet when this returned.";
      }
      const value = {
        status: "sent" as const,
        hash: sent.hash,
        explorerUrl: sent.explorerUrl,
        ...(sent.summary ? { summary: sent.summary } : {}),
        ...(registryAgentId ? { registryAgentId } : {}),
        launchpadStatus,
        ...(note ? { note } : {}),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
    },
  );

  server.registerTool(
    "moi_launchpad_telegram_link",
    {
      title: "Link Telegram to the Launchpad",
      description:
        "Get the link that connects the person's Telegram to their MOI Agent Launchpad account, so their agents can message " +
        "them. Give the person the link as a clickable URL; opening it starts a chat with the MOI bot and they press Start. " +
        "The link works for 15 minutes. Needs moi_launchpad_sign_in first.",
      inputSchema: S.LaunchpadTelegramLinkInput.shape,
      outputSchema: S.LaunchpadTelegramLinkOutput.shape,
      annotations: ACT,
    },
    async () =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const rec = await requireLaunchpadSession(deps, userId);
        try {
          let alreadyLinked = false;
          try {
            alreadyLinked = (await deps.client.me(rec.cookie)).profile.telegramLinked;
          } catch {
            /* the link still works without knowing */
          }
          const link = await deps.client.telegramLink(rec.cookie);
          const expiresAt = new Date(Date.now() + TELEGRAM_CODE_MS).toISOString();
          return {
            value: { link, expiresAt, alreadyLinked },
            text:
              `Open this on the phone that has Telegram: ${link}\n` +
              "It opens a chat with the MOI bot; press Start there. The code inside the link works for 15 minutes." +
              (alreadyLinked ? "\nA Telegram account is already linked; this replaces it." : ""),
          };
        } catch (err) {
          await forgetIfRejected(deps, userId, err);
          throw err;
        }
      }),
  );

  server.registerTool(
    "moi_launchpad_setup_script",
    {
      title: "Download link for an agent's setup script",
      description:
        "A one-time download link for the setup script of an active Launchpad agent. The script contains the agent's private " +
        "key, so it is never returned here: the link fetches it from the Launchpad with the person's session when opened, " +
        "serves it once, and dies after ten minutes. Give the person the link as a clickable URL and tell them to run the " +
        "script on the machine that will host the agent. Needs moi_launchpad_sign_in first.",
      inputSchema: S.LaunchpadSetupScriptInput.shape,
      outputSchema: S.LaunchpadSetupScriptOutput.shape,
      annotations: ACT,
    },
    async ({ agentId }) =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const rec = await requireLaunchpadSession(deps, userId);
        let agent: AgentRecord;
        try {
          agent = await deps.client.getAgent(rec.cookie, agentId);
        } catch (err) {
          await forgetIfRejected(deps, userId, err);
          throw err;
        }
        if (agent.status === "deleted") {
          throw new MoiError(ErrorCode.INVALID_ARGS, `Agent "${agent.name}" has been deleted; it has no setup script.`);
        }
        if (agent.keyReadable === false) {
          throw new MoiError(
            ErrorCode.LAUNCHPAD_ERROR,
            `The Launchpad can no longer read the key of agent "${agent.name}", so no setup script can be produced. Create a new agent.`,
          );
        }
        const link = deps.createDownloadLink(userId, agentId);
        const value = { downloadUrl: link.url, expiresAt: iso(link.expiresAt), agent: toAgent(agent) };
        return {
          value,
          text:
            `Download link for "${agent.name}" (works once, for ten minutes): ${link.url}\n` +
            "It fetches the setup script from the Launchpad with your session and hands it straight to the browser. " +
            "The script holds the agent's private key, so it is never shown in this chat. Run it with bash on the " +
            "machine that will host the agent.",
        };
      }),
  );

  server.registerTool(
    "moi_launchpad_sign_out",
    {
      title: "Sign out of the Launchpad",
      description: "Forget the MOI Agent Launchpad session kept on this server. The wallet pairing is untouched.",
      inputSchema: S.LaunchpadSignOutInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      run(async () => {
        const userId = requireAuth(auth).userId;
        const rec = await deps.sessions.get(userId);
        await deps.sessions.delete(userId);
        if (rec) {
          try {
            await deps.client.logout(rec.cookie);
          } catch {
            // Our record is gone, which is the guarantee; the Launchpad's
            // cookie expires on its own.
          }
        }
        return { value: { signedIn: false }, text: rec ? "Signed out of the Launchpad." : "There was no Launchpad session." };
      }),
  );
}
