/**
 * What a tool is before it is on a server.
 *
 * A tool that can change something is built here with defineTool, by the capability or application that owns it, and put
 * on a server by src/tools/register.ts, the only file that calls registerTool for one. defineTool takes what
 * McpServer.registerTool takes and checks it the same way (the handler's arguments are typed from the input schema), but
 * only keeps it, so a file that can build a tool cannot also put it on a server. Read-only tools register themselves.
 */

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** A tool as data. defineTool has checked it; register.ts passes the three parts on as they are. */
export interface ToolDef {
  readonly name: string;
  readonly config: unknown;
  readonly handler: unknown;
}

export function defineTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  handler: ToolCallback<InputArgs>,
): ToolDef {
  return { name, config, handler };
}
