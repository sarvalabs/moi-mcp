/**
 * The health-check tools. Read-only, so each registers itself; a tool that can change something goes through
 * src/tools/register.ts. There are two, because the two kinds of server have different things to report: the stdio
 * server says whether its configuration loaded, the HTTP servers (the read gateway, and the hosted server, which uses the
 * same one) say which transport and network they serve.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig } from "../config.js";
import { messageOf } from "../errors.js";
import { pkg } from "../pkg.js";

const PingOutput = {
  server: z.string(),
  version: z.string(),
  node: z.string(),
  configOk: z.boolean(),
  network: z.string().optional(),
  home: z.string().optional(),
  configError: z.string().optional(),
};

export function registerStdioPing(server: McpServer): void {
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

export function registerHttpPing(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping MOI MCP (read-only)",
      description:
        "Health check for the read-only MOI MCP endpoint. Returns the server version and the " +
        "network it is pointed at. This endpoint has no wallet and cannot write.",
      inputSchema: {},
      outputSchema: {
        server: z.string(),
        version: z.string(),
        transport: z.string(),
        network: z.string(),
        readOnly: z.boolean(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const cfg = getConfig();
      const structuredContent = {
        server: pkg.name,
        version: pkg.version,
        transport: "streamable-http",
        network: cfg.MOI_NETWORK,
        readOnly: true,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );
}
