/**
 * The tool lists, pinned.
 *
 * test/unit/__snapshots__ holds the full tools/list answer of each server mode,
 * in registration order: name, title, description, annotations, input schema,
 * output schema, and whatever else the SDK puts on an entry. A tool that is
 * added, removed, moved, reworded or given another schema changes a file, and
 * the test fails until a person has read the diff and approved it:
 *
 *   npx vitest run test/unit/tool-lists.test.ts -u
 *
 * -u accepts whatever the code produces now, so read the git diff before
 * committing it.
 *
 * What is written is what a client receives. The lists are asked for with a raw
 * JSON-RPC tools/list, because the SDK's Client reshapes the answer (it drops
 * annotation keys it does not know), and the schema dialect rewrite that every
 * real transport applies (src/json-schema-dialect.ts) is switched on.
 *
 * The three modes:
 *   hosted   buildHostedApp (src/server.ts) with the Launchpad and dapp tools on.
 *            Asked over loopback HTTP, because the server is rebuilt per request
 *            inside the handler and is not reachable any other way.
 *   gateway  buildReadOnlyServer (src/http.ts). Its list is the nine tools the hosted server also lists, then the 34 moi_rpc_
 *            node methods (src/capabilities/reads/rpc-methods.ts), which only the gateway registers.
 *   stdio    buildServer from test/helpers/harness.ts, which mirrors src/index.ts
 *            except for ping: index.ts starts the server when imported, so a test
 *            cannot build it. Its nine write tools are the hosted ones
 *            (registerLocalWriteTools), so they are listed exactly as the hosted
 *            server lists them; a test below says so.
 *
 * The hosted block also checks the gate. A write that is registered but not in
 * GATED can be called without signing in, and one without a REQUIRED_SCOPE entry
 * can be called with a token that may only read.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RPC_METHODS } from "../../src/capabilities/reads/rpc-methods.js";
import { buildReadOnlyServer } from "../../src/http.js";
import { withModernSchemaDialect } from "../../src/json-schema-dialect.js";
import { LaunchpadClient } from "../../src/applications/launchpad/client.js";
import { buildHostedApp, GATED, type HostedDeps } from "../../src/server.js";
import { applyEnv, buildServer, restoreEnv, tempHome } from "../helpers/harness.js";
import { deps as writeDeps, fakeHub, fakeStore } from "../helpers/hosted.js";
import { fakeSessions } from "../helpers/launchpad.js";

/** One entry of a tools/list answer, as it goes over the wire. */
interface RawTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  [key: string]: unknown;
}

type ListAnswer = { result?: { tools?: RawTool[] }; error?: { message?: string } };

/** The text a snapshot file holds: two-space JSON and a final newline. */
const pinned = (tools: RawTool[]): string => `${JSON.stringify(tools, null, 2)}\n`;

const WRITE_TOOLS = [
  "moi_transfer", "moi_create_account", "moi_create_asset", "moi_mint", "moi_call_logic", "moi_asset_invoke",
  "moi_register_agent", "moi_set_agent_status", "moi_transfer_agent",
] as const;

/** Ask a server for its tools over an in-memory pipe, through the dialect rewrite a real transport applies. */
async function listTools(server: McpServer): Promise<RawTool[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(withModernSchemaDialect(serverSide));
  const answer = new Promise<ListAnswer>((resolve) => {
    clientSide.onmessage = (message) => resolve(message as unknown as ListAnswer);
  });
  await clientSide.start();
  await clientSide.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const { result, error } = await answer;
  await server.close();
  if (!result?.tools) throw new Error(`tools/list failed: ${error?.message ?? "no result"}`);
  return result.tools;
}

let home: string;
beforeAll(() => {
  // Nothing here reads config, but if something ever does, it must be this and never a developer's .env.
  home = tempHome();
  applyEnv("http://127.0.0.1:1", home);
});
afterAll(() => {
  restoreEnv();
  rmSync(home, { recursive: true, force: true });
});

describe("the read gateway's tool list", () => {
  it("is pinned", async () => {
    const tools = await listTools(buildReadOnlyServer());
    await expect(pinned(tools)).toMatchFileSnapshot("./__snapshots__/tools-gateway.json");
  });
});

describe("the stdio server's tool list", () => {
  it("is pinned, as the test harness builds the server", async () => {
    const tools = await listTools(buildServer());
    await expect(pinned(tools)).toMatchFileSnapshot("./__snapshots__/tools-stdio.json");
  });
});

// ---------------------------------------------------------------------------
// Hosted
// ---------------------------------------------------------------------------

/** A token that may only read, so the scope gate has something to refuse. */
const READ_TOKEN = "read-only-token";

/** Every module switched on. Registration reads nothing from these beyond the Launchpad's base URL. */
function hostedDeps(): HostedDeps {
  const writes = writeDeps(fakeStore(new Map()), fakeHub());
  return {
    authenticate: (req) =>
      req.headers.authorization === `Bearer ${READ_TOKEN}`
        ? { userId: "reader", clientId: "client", scopes: ["moi:read"], expiresAt: Math.floor(Date.now() / 1000) + 3600 }
        : undefined,
    challengeHeader: (opts) =>
      `Bearer error="${opts?.error ?? "invalid_token"}", resource_metadata="https://example.test/.well-known/oauth-protected-resource"` +
      (opts?.scope ? `, scope="${opts.scope}"` : ""),
    store: writes.store,
    hub: writes.hub,
    journal: writes.journal,
    resolveUriMounted: true,
    createPairingLink: (userId) => ({ url: `https://example.test/pair/${userId}`, expiresAt: Date.now() + 300_000 }),
    startPairing: async () => ({ uri: "wc:test@2", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
    launchpad: {
      client: new LaunchpadClient("https://launchpad.example.test"),
      sessions: fakeSessions(),
      writes,
      createDownloadLink: (_userId, agentId) => ({
        url: `https://example.test/download/${agentId}`,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }),
    },
    dapp: { sessions: fakeSessions(), writes },
  };
}

/** POST one JSON-RPC message. The transport answers as a one-event SSE stream, a gate refusal as plain JSON. */
async function post(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, json };
}

describe("the hosted server's tool list", () => {
  let listener: Server;
  let baseUrl: string;
  let tools: RawTool[];

  beforeAll(async () => {
    listener = createServer(buildHostedApp(hostedDeps()));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const answer = await post(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    if (answer.status !== 200 || !answer.json?.result?.tools) {
      throw new Error(`hosted tools/list answered ${answer.status}: ${JSON.stringify(answer.json)}`);
    }
    tools = answer.json.result.tools;
  });

  afterAll(() => new Promise<void>((resolve) => listener.close(() => resolve())));

  it("is pinned", async () => {
    await expect(pinned(tools)).toMatchFileSnapshot("./__snapshots__/tools-hosted.json");
  });

  it("lists none of the node-method tools, which only the read gateway registers", async () => {
    const names = (list: RawTool[]): string[] => list.map((tool) => tool.name);
    const gateway = names(await listTools(buildReadOnlyServer()));
    const stdio = names(await listTools(buildServer()));
    const nodeTools = RPC_METHODS.flatMap((row) => (row.status === "tool" ? [row.tool] : []));
    expect(nodeTools).toHaveLength(34);
    // The gateway lists every row with status tool, in the table's order, and nothing else of that name.
    expect(gateway.filter((name) => name.startsWith("moi_rpc_"))).toEqual(nodeTools);
    expect(names(tools).filter((name) => name.startsWith("moi_rpc_")), "hosted").toEqual([]);
    expect(stdio.filter((name) => name.startsWith("moi_rpc_")), "stdio").toEqual([]);
    // What the hosted server lists first is what the gateway lists first: ping and the eight combined reads.
    expect(names(tools).slice(0, 9)).toEqual(gateway.slice(0, 9));
  });

  it("lists the nine write tools exactly as the stdio server does", async () => {
    const stdio = await listTools(buildServer());
    for (const name of WRITE_TOOLS) {
      const onStdio = stdio.find((tool) => tool.name === name);
      expect(onStdio, `${name} is not on the stdio server`).toBeDefined();
      expect(onStdio, `${name} differs between the stdio and hosted servers`).toEqual(
        tools.find((tool) => tool.name === name),
      );
    }
  });

  it("is gated: every tool that is not read-only needs a token with the write scope", async () => {
    const writers = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect(writers.length).toBeGreaterThan(0);

    const gated: readonly string[] = GATED;
    for (const name of writers) {
      expect(gated, `${name} is not read-only, so it must be in GATED (src/server.ts)`).toContain(name);

      // What the gate does with it. The 403 can only come from a REQUIRED_SCOPE entry: a gated tool without
      // one is waved through, so a read-only token would reach the tool instead of being refused.
      const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } };
      const anonymous = await post(baseUrl, call);
      expect(anonymous.status, `${name} called with no token`).toBe(401);
      const reader = await post(baseUrl, call, { authorization: `Bearer ${READ_TOKEN}` });
      expect(reader.status, `${name} called with a read-only token`).toBe(403);
      expect(reader.headers.get("www-authenticate"), `${name} challenge`).toContain('scope="moi:write"');
    }
  });

  it("registers every name GATED lists, so none of it is stale", () => {
    const registered = new Set(tools.map((tool) => tool.name));
    for (const name of GATED) {
      expect(registered.has(name), `${name} is in GATED but the hosted server does not register it`).toBe(true);
    }
  });
});

describe("the write tools are built in one place each and registered only by src/tools/register.ts", () => {
  it("each is built by defineTool in the capability or application that owns it, and no file registers it by name", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = (readdirSync(`${root}src`, { recursive: true }) as string[])
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/${name.split("\\").join("/")}`);
    const calling = (call: string, tool: string): string[] =>
      files.filter((file) => new RegExp(`${call}\\(\\s*"${tool}"`).test(readFileSync(`${root}${file}`, "utf8")));
    const builtIn: Record<string, string> = {
      moi_transfer: "src/capabilities/assets/shortcuts.ts",
      moi_mint: "src/capabilities/assets/shortcuts.ts",
      moi_create_account: "src/capabilities/accounts/create-participant.ts",
      moi_create_asset: "src/capabilities/assets/create.ts",
      moi_call_logic: "src/capabilities/logics/invoke.ts",
      moi_asset_invoke: "src/capabilities/assets/execute.ts",
      moi_register_agent: "src/applications/registry/tools.ts",
      moi_set_agent_status: "src/applications/registry/tools.ts",
      moi_transfer_agent: "src/applications/registry/tools.ts",
    };
    for (const [name, file] of Object.entries(builtIn)) {
      expect(calling("defineTool", name), name).toEqual([file]);
      expect(calling("registerTool", name), `${name} is registered by name somewhere; register.ts names no tool`).toEqual([]);
    }
    // The read half of the asset tools is registered with the other reads, and is on the gateway.
    expect(calling("registerTool", "moi_asset_routines")).toEqual(["src/capabilities/reads/tools.ts"]);
  });
});
