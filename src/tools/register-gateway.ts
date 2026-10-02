/**
 * The read gateway's tools: its ping, the read tools and the resources, and nothing else.
 *
 * This file and what it imports are all the read-only HTTP server (src/http.ts) can reach, so no wallet, write or
 * application code is in that server by construction. src/tools/register.ts calls registerGatewayTools for the hosted
 * server's read half, so the two lists cannot drift. test/unit/gateway-imports.test.ts walks the import graph from
 * src/http.ts and fails if it reaches any of that code.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "../capabilities/reads/tools.js";
import { registerResources } from "../resources/index.js";
import { registerHttpPing } from "./ping.js";

export function registerGatewayTools(server: McpServer): void {
  registerHttpPing(server);
  registerReadTools(server);
  registerResources(server);
}
