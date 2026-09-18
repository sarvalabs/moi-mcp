#!/usr/bin/env node
/**
 * Read-only HTTP transport.
 *
 * This is the hostable half of the server: stateless, no wallet, no session,
 * no keys. It exposes the same read tools and resources as the stdio server
 * and none of the write tools.
 *
 * Why the split. A WalletConnect session is a persistent relay socket and a
 * pending approval waits up to five minutes for a phone tap; neither survives
 * a stateless request/response service. So writes stay local (stdio) and reads
 * — which need nothing but an RPC endpoint — can run behind a URL.
 *
 * Run:  moi-mcp-http            (PORT, default 8787)
 * Point an MCP client at:  http://host:PORT/mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";

import { getConfig, log } from "./config.js";
import { brandAsset, brandServerInfo, landingHtml } from "./branding.js";
import { clientAddress, SlidingWindow } from "./auth/rate-limit.js";

// Public and unauthenticated, so a ceiling per address: enough for a busy
// conversation, not enough to use the RPC node as a load generator.
const readWindow = new SlidingWindow({ windowMs: 60_000, max: 240 });
import { messageOf } from "./errors.js";
import { withModernSchemaDialect } from "./json-schema-dialect.js";
import { NETWORKS } from "./moi/provider.js";
import { registerResources } from "./resources/index.js";
import { registerReadTools } from "./tools/reads.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;

/**
 * A server carrying only the read surface.
 *
 * Deliberately does not import tools/wallet or tools/writes: the write path
 * must be unreachable over HTTP by construction, not by configuration.
 */
export function buildReadOnlyServer(opts: { publicUrl?: string } = {}): McpServer {
  const server = new McpServer({
    name: `${pkg.name}-http`,
    title: "MOI",
    version: pkg.version,
    ...brandServerInfo(opts.publicUrl),
  });

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

  registerReadTools(server);
  registerResources(server);
  return server;
}

/** Collect a JSON body, refusing anything oversized. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    let network = "unknown";
    let configOk = true;
    try {
      network = getConfig().MOI_NETWORK;
    } catch {
      configOk = false;
    }
    send(res, configOk ? 200 : 503, { ok: configOk, version: pkg.version, network, readOnly: true });
    return;
  }

  const brand = brandAsset(url.pathname);
  if (brand) {
    res.writeHead(200, { "content-type": brand.type, "cache-control": "public, max-age=86400" });
    res.end(brand.body);
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(landingHtml("MOI MCP (read-only)", MCP_PATH));
    return;
  }

  if (url.pathname !== MCP_PATH) {
    send(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
    return;
  }

  const client = clientAddress(req.socket.remoteAddress ?? undefined, req.headers["x-forwarded-for"]);
  const verdict = readWindow.allow(client);
  if (!verdict.ok) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": String(verdict.retryAfterS) });
    res.end(JSON.stringify({ error: "rate_limited", error_description: "Too many requests. Try again shortly." }));
    return;
  }

  // Stateless: a fresh server and transport per request, so concurrent callers
  // can never observe each other's state. There is none to share.
  const server = buildReadOnlyServer();
  const transport = withModernSchemaDialect(
    new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
  );

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = await readJsonBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log("error", `request failed: ${messageOf(err)}`);
    if (!res.headersSent) send(res, 400, { error: messageOf(err) });
  }
}

const PortSchema = z.coerce.number().int().positive().default(8787);

/**
 * Resolve PORT the same way config.ts treats every other env var: blank or
 * whitespace-only falls back to the default, and anything else must parse as
 * a positive integer or the process fails fast with a clear message instead
 * of silently binding to an ephemeral port (empty string) or crashing inside
 * `listen()` with a raw stack trace (non-numeric).
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env["PORT"] ?? "").trim();
  const parsed = PortSchema.safeParse(raw === "" ? undefined : raw);
  if (!parsed.success) {
    throw new Error(`Invalid PORT ${JSON.stringify(env["PORT"])} — expected a positive integer.`);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const port = resolvePort();

  // The read-only server needs no WalletConnect project id — it registers no
  // wallet tools — but the shared Config schema requires one. Satisfy it with
  // an explicit dummy so reads and /health work with nothing configured.
  process.env["WC_PROJECT_ID"] ??= "0".repeat(32);

  try {
    const cfg = getConfig();
    const info = NETWORKS[cfg.MOI_NETWORK];
    log("info", `read-only MCP on ${info.label} (${info.rpcUrl ?? cfg.MOI_RPC_URL ?? "custom"})`);
  } catch (err) {
    // Reads need no WC_PROJECT_ID, but a bad network config is worth saying.
    log("error", `starting with invalid config — ${messageOf(err)}`);
  }

  createServer((req, res) => void handle(req, res)).listen(port, () => {
    log("info", `${pkg.name}@${pkg.version} listening on :${port}${MCP_PATH}`);
    process.stderr.write(`[moi-mcp] read-only MCP endpoint: http://localhost:${port}${MCP_PATH}\n`);
  });
}

// Only run when executed directly, so tests can import buildReadOnlyServer.
// npm installs bins as SYMLINKS (node_modules/.bin/moi-mcp-http -> dist/http.js),
// so argv[1]'s basename differs from this module's file name and a naive
// endsWith() check makes the bin exit silently. Compare realpaths instead.
const isMain = (() => {
  try {
    return process.argv[1]
      ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
      : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[moi-mcp] fatal: ${messageOf(err)}\n`);
    process.exit(1);
  });
}
