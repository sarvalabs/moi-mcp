/**
 * The one place a tool that can change something is put on a server, for the stdio server and the hosted server.
 *
 * Every such tool is built with defineTool (src/tools/define.ts) by the capability or application that owns it
 * (src/capabilities, src/applications), and the install function below holds the only registerTool call. The read-only
 * tools register themselves, which is what lets the read gateway (src/tools/register-gateway.ts) list them without
 * importing any wallet, write or application code. test/unit/layout.test.ts fails if any other file registers a tool
 * that is not read-only.
 *
 * registerTools is the whole list for each mode, in the order its tools/list shows them. The group functions are exported
 * for the tests that exercise one group on its own, with the signatures they had before this file existed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dappTools, type DappDeps } from "../applications/dapp/tools.js";
import { faucetTool, type FaucetDeps } from "../applications/faucet/tools.js";
import { launchpadTools, type LaunchpadDeps } from "../applications/launchpad/tools.js";
import { registryWriteTools, type RegistryWriteOptions } from "../applications/registry/tools.js";
import type { AuthInfo } from "../auth/types.js";
import { accountKeyToolsOn } from "../config.js";
import { configureAccountTool } from "../capabilities/accounts/configure.js";
import { createAccountTool } from "../capabilities/accounts/create-participant.js";
import { createAssetTool } from "../capabilities/assets/create.js";
import { assetInvokeTool } from "../capabilities/assets/execute.js";
import { mintTool, transferTool } from "../capabilities/assets/shortcuts.js";
import { deployLogicTool } from "../capabilities/logics/deploy.js";
import { callLogicTool } from "../capabilities/logics/invoke.js";
import { registerReadTools } from "../capabilities/reads/tools.js";
import { registerResources } from "../resources/index.js";
import type { ToolDef } from "./define.js";
import type { HostedWriteDeps, WriteDeps } from "./hosted-writes.js";
import { LOCAL_AUTH, localWriteDeps } from "./local-writes.js";
import { registerStdioPing } from "./ping.js";
import { registerSharedReadTools } from "./register-gateway.js";
import { walletTools } from "./wallet.js";
import { hostedWalletTools, type HostedWalletDeps } from "./wallet-hosted.js";

/** The one call that puts a tool built with defineTool on a server. */
function install(server: McpServer, defs: readonly ToolDef[]): void {
  for (const def of defs) server.registerTool(def.name, def.config as never, def.handler as never);
}

/** The stdio server's pairing tools. */
export function registerWalletTools(server: McpServer): void {
  install(server, walletTools());
}

export interface HostedWriteOptions {
  /** How long moi_deploy_logic watches for the receipt of a deploy it has broadcast, to report the new logic's id. 0 does not look. */
  deployWaitMs?: number;
  /** How long moi_create_asset watches for the receipt of a create it has broadcast, to report the new asset's id. 0 does not look. */
  createWaitMs?: number;
}

/**
 * Register hosted write tools on the given server.
 *
 * Registered even when the caller is anonymous, so the tools appear in tools/list and a model knows they exist. Hiding
 * them looked safer but was worse: an unlisted tool is never called, so the 401 that prompts sign-in never fires, and the
 * user is told this server is read-only. Calls are still gated: see requireAuth in src/tools/hosted-writes.ts.
 *
 * The one exception is moi_configure_account, which is registered only when the operator sets MOI_ACCOUNT_KEY_TOOLS=on
 * (accountKeyToolsOn in src/config.ts). A key added at full weight signs for the account alone, for good, and the phone shows
 * it as a hex string nobody can check by eye, so the chat does not offer the change by default. With the setting off the tool
 * is not listed and a call to it is unknown. This is the only place that decides it, for the hosted and the stdio server.
 */
export function registerHostedWrites(
  server: McpServer,
  deps: WriteDeps,
  auth: AuthInfo | null,
  options: HostedWriteOptions = {},
): void {
  install(server, [
    transferTool(deps, auth),
    createAccountTool(deps, auth),
    ...(accountKeyToolsOn() ? [configureAccountTool(deps, auth)] : []),
    createAssetTool(deps, auth, { receiptWaitMs: options.createWaitMs }),
    mintTool(deps, auth),
    callLogicTool(deps, auth),
    deployLogicTool(deps, auth, { receiptWaitMs: options.deployWaitMs }),
    assetInvokeTool(deps, auth),
  ]);
}

/** The agent registry's write tools, on the hosted and the stdio server. */
export function registerRegistryWrites(
  server: McpServer,
  deps: WriteDeps,
  auth: AuthInfo | null,
  options: RegistryWriteOptions = {},
): void {
  install(server, registryWriteTools(deps, auth, options));
}

/**
 * The write tools on the stdio server: ten, and eleven when MOI_ACCOUNT_KEY_TOOLS is on. They are the hosted tools, run with
 * the local user and the adapters of src/tools/local-writes.ts.
 *
 * registryWaitMs, deployWaitMs and createWaitMs are 0 because a write that waits for the phone already uses most of the MCP
 * client's 60 second budget, and polling afterwards for up to 30 more could lose the hash of a transaction that landed. The
 * registry result still carries the agent's id if one look finds it and says where to look otherwise; a deploy and an asset
 * create do not look at all, since a receipt right after a broadcast is rarely there, and say how to read the new id.
 *
 * The journal is not reconciled at boot: several MCP clients start one stdio process each against the same
 * MOI_MCP_HOME, and a second process would mark the first one's live write orphaned.
 */
export function registerLocalWriteTools(server: McpServer, deps: WriteDeps = localWriteDeps()): void {
  registerHostedWrites(server, deps, LOCAL_AUTH, { deployWaitMs: 0, createWaitMs: 0 });
  registerRegistryWrites(server, deps, LOCAL_AUTH, { registryWaitMs: 0 });
}

/** The MOI Agent Launchpad tools, on the hosted server. */
export function registerLaunchpadTools(server: McpServer, deps: LaunchpadDeps, auth: AuthInfo | null): void {
  install(server, launchpadTools(deps, auth));
}

/** The generic dapp tools, on the hosted server. */
export function registerDappTools(server: McpServer, deps: DappDeps, auth: AuthInfo | null): void {
  install(server, dappTools(deps, auth));
}

/** The devnet faucet tool, on the hosted server when it is configured (faucetDepsFor in src/applications/faucet/tools.ts). */
export function registerFaucetTools(server: McpServer, deps: FaucetDeps, auth: AuthInfo | null): void {
  install(server, [faucetTool(deps, auth)]);
}

/** What the hosted server hands over: the pairing store and hub, the write path, and the optional applications. */
export type HostedToolDeps = HostedWalletDeps &
  HostedWriteDeps & { launchpad?: LaunchpadDeps; dapp?: DappDeps; faucet?: FaucetDeps };

export type ToolContext =
  | {
      mode: "stdio";
      /** Injectable for tests; the stdio defaults (src/tools/local-writes.ts) otherwise. */
      writes?: WriteDeps;
    }
  | { mode: "hosted"; deps: HostedToolDeps; auth: AuthInfo | null };

/** Every tool a server of this mode lists, in the order its tools/list shows them. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  if (ctx.mode === "stdio") {
    registerStdioPing(server);
    registerReadTools(server);
    registerWalletTools(server);
    registerLocalWriteTools(server, ctx.writes);
    registerResources(server);
    return;
  }
  const { deps, auth } = ctx;
  registerSharedReadTools(server);
  install(server, hostedWalletTools(deps, auth));
  registerHostedWrites(server, deps, auth);
  registerRegistryWrites(server, deps, auth);
  if (deps.launchpad) registerLaunchpadTools(server, deps.launchpad, auth);
  // The Launchpad has no sign-in tool of its own: its messages and descriptions send a person to moi_dapp_sign_in. A server
  // that lists the Launchpad tools therefore lists the dapp tools too, over the same sessions, even if its caller passed none.
  const dapp = deps.dapp ?? (deps.launchpad && { sessions: deps.launchpad.sessions, writes: deps.launchpad.writes });
  if (dapp) registerDappTools(server, dapp, auth);
  if (deps.faucet) registerFaucetTools(server, deps.faucet, auth);
}
