#!/usr/bin/env node
/**
 * stdio entry point for @moi-protocol/mcp-server.
 *
 * Phase 0 registers only `ping`. Read tools (Phase 1) and wallet/write tools
 * (Phase 2) are registered from schema.TOOLS as they land.
 *
 * INVARIANT: stdout is the MCP transport. All diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";

import { getConfig, log, projectIdIssue } from "./config.js";
import { messageOf } from "./errors.js";
import { withModernSchemaDialect } from "./json-schema-dialect.js";
import { registerResources } from "./resources/index.js";
import { registerLocalWriteTools } from "./tools/local-writes.js";
import { registerReadTools } from "./tools/reads.js";
import { registerWalletTools } from "./tools/wallet.js";

// Resolves to the package root from both src/ (tsx) and dist/ (built).
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

const PingOutput = {
  server: z.string(),
  version: z.string(),
  node: z.string(),
  configOk: z.boolean(),
  network: z.string().optional(),
  home: z.string().optional(),
  configError: z.string().optional(),
};

function registerPing(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping MOI MCP server",
      description:
        "Health check for the MOI MCP server. Returns the server version and whether its " +
        "configuration loaded cleanly. Call this first when other moi_* tools are failing.",
      inputSchema: {},
      outputSchema: PingOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      let structuredContent: Record<string, unknown>;
      try {
        const cfg = getConfig();
        structuredContent = {
          server: pkg.name,
          version: pkg.version,
          node: process.version,
          configOk: true,
          network: cfg.MOI_NETWORK,
          home: cfg.home,
        };
      } catch (err) {
        structuredContent = {
          server: pkg.name,
          version: pkg.version,
          node: process.version,
          configOk: false,
          configError: messageOf(err),
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );
}

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

  const server = new McpServer({ name: pkg.name, version: pkg.version });
  registerPing(server);
  registerReadTools(server);
  registerWalletTools(server);
  registerLocalWriteTools(server);
  registerResources(server);

  await server.connect(withModernSchemaDialect(new StdioServerTransport()));
  log("info", `${pkg.name}@${pkg.version} ready on stdio`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[moi-mcp] fatal: ${messageOf(err)}\n`);
  process.exit(1);
});
