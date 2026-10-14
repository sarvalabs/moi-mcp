/**
 * The read gateway's tools: the shared read tools, then the node's own methods.
 *
 * This file and what it imports are all the read-only HTTP server (src/http.ts) can reach, so no wallet, write or
 * application code is in that server by construction. test/unit/gateway-imports.test.ts walks the import graph from
 * src/http.ts and fails if it reaches any of that code.
 *
 * Two lists, so the node methods are on the gateway and nowhere else. registerSharedReadTools is the ping, the combined
 * reads and the resources: src/tools/register.ts calls it for the hosted server's read half, so the two lists cannot drift.
 * registerGatewayTools is that and then the 34 moi_rpc_ tools (src/capabilities/reads/rpc-tools.ts), and only src/http.ts
 * calls it. The hosted signing server and the stdio server list the combined reads and not the node methods, which keeps
 * their lists short.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "../capabilities/reads/tools.js";
import { registerRpcTools } from "../capabilities/reads/rpc-tools.js";
import { registerResources } from "../resources/index.js";
import { registerHttpPing } from "./ping.js";

/** The ping, the combined reads and the resources: what the gateway and the hosted server both list. */
export function registerSharedReadTools(server: McpServer): void {
  registerHttpPing(server);
  registerReadTools(server);
  registerResources(server);
}

/** Everything the read gateway lists: the shared tools, then one tool for each node method. */
export function registerGatewayTools(server: McpServer): void {
  registerSharedReadTools(server);
  registerRpcTools(server);
}
