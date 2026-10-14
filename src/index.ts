#!/usr/bin/env node
/**
 * stdio entry point for @moi-protocol/mcp-server.
 *
 * The tools are registered by src/tools/register.ts.
 *
 * INVARIANT: stdout is the MCP transport. All diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";

import { accountKeyToolsOn, getConfig, log, projectIdIssue } from "./config.js";
import { messageOf } from "./errors.js";
import { STDIO_INSTRUCTIONS } from "./instructions.js";
import { withModernSchemaDialect } from "./json-schema-dialect.js";
import { registerTools } from "./tools/register.js";

// Resolves to the package root from both src/ (tsx) and dist/ (built).
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

async function main(): Promise<void> {
  // Guard against misuse: if someone runs mcp-server with a CLI subcommand,
  // print a hint and exit before starting the MCP server.
  const arg = process.argv[2];
  if (arg && !arg.startsWith("-")) {
    process.stderr.write(
      `This is the MCP stdio server. For wallet commands run: npx -y -p @moi-protocol/mcp-server moi-mcp ${arg}\n`,
    );
    process.exit(1);
  }

  // Surface configuration problems on stderr at startup, but never refuse to
  // start: a server that dies before `initialize` shows up in Claude Desktop as
  // an unexplained failure. `ping` reports the same error to the agent.
  try {
    const cfg = getConfig();
    // A usable-but-odd project id loads fine and then fails at the relay.
    // Say so at error level so it is visible under the default LOG_LEVEL.
    const idIssue = projectIdIssue(cfg.WC_PROJECT_ID);
    if (idIssue) log("error", idIssue);
    log("info", `config ok — network=${cfg.MOI_NETWORK} home=${cfg.home}`);
  } catch (err) {
    log("error", `starting with invalid config — ${messageOf(err)}`);
  }

  if (accountKeyToolsOn()) {
    log("info", "account key tools are on (MOI_ACCOUNT_KEY_TOOLS=on): moi_configure_account is registered");
  }

  // What the client hands its model about this server: the write rules and the units, in src/instructions.ts.
  const server = new McpServer({ name: pkg.name, version: pkg.version }, { instructions: STDIO_INSTRUCTIONS });
  registerTools(server, { mode: "stdio" });

  await server.connect(withModernSchemaDialect(new StdioServerTransport()));
  log("info", `${pkg.name}@${pkg.version} ready on stdio`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[moi-mcp] fatal: ${messageOf(err)}\n`);
  process.exit(1);
});
