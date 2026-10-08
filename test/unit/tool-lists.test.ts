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
 *   hosted   buildHostedApp (src/server.ts) with the Launchpad, dapp and faucet tools on.
 *            Asked over loopback HTTP, because the server is rebuilt per request
 *            inside the handler and is not reachable any other way.
 *   gateway  buildReadOnlyServer (src/http.ts). Its list is the nine tools the hosted server also lists, then the 34 moi_rpc_
 *            node methods (src/capabilities/reads/rpc-methods.ts), which only the gateway registers.
 *   stdio    buildServer from test/helpers/harness.ts, which mirrors src/index.ts
 *            except for ping: index.ts starts the server when imported, so a test
 *            cannot build it. Its ten write tools are the hosted ones
 *            (registerLocalWriteTools), so they are listed exactly as the hosted
 *            server lists them; a test below says so.
 *
 * The pinned files are the lists with MOI_ACCOUNT_KEY_TOOLS off, the default, which is what the test harness sets. With it on
 * each server lists an eleventh write tool, moi_configure_account, straight after moi_create_account; the last describe checks
 * that, and pins the tool's entry in tools-account-keys.json.
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
import { FaucetClient } from "../../src/applications/faucet/client.js";
import { LaunchpadClient } from "../../src/applications/launchpad/client.js";
import { buildHostedApp, GATED, OPTIONAL_GATED, type HostedDeps } from "../../src/server.js";
import { FAUCET_KEY } from "../helpers/faucet.js";
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

/** The write tools a server lists whatever its settings are. moi_configure_account is not one: it needs MOI_ACCOUNT_KEY_TOOLS=on. */
const WRITE_TOOLS = [
  "moi_transfer", "moi_create_account", "moi_create_asset", "moi_mint", "moi_call_logic", "moi_deploy_logic", "moi_asset_invoke",
  "moi_register_agent", "moi_set_agent_status", "moi_transfer_agent",
] as const;

/** The tool that exists only when the operator turns it on. */
const ACCOUNT_KEY_TOOL = "moi_configure_account";

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
/** A token with both scopes, which no gate refuses. */
const WRITE_TOKEN = "write-token";

/** Every module switched on. Registration reads nothing from these beyond the Launchpad's base URL. */
function hostedDeps(): HostedDeps {
  const writes = writeDeps(fakeStore(new Map()), fakeHub());
  return {
    authenticate: (req) => {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      if (req.headers.authorization === `Bearer ${READ_TOKEN}`) {
        return { userId: "reader", clientId: "client", scopes: ["moi:read"], expiresAt };
      }
      if (req.headers.authorization === `Bearer ${WRITE_TOKEN}`) {
        return { userId: "writer", clientId: "client", scopes: ["moi:read", "moi:write"], expiresAt };
      }
      return undefined;
    },
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
    // Constructing the client opens no socket, and registering the tool reads nothing from it.
    faucet: {
      client: new FaucetClient({ baseUrl: "https://faucet.example.test/devnet/v2/faucet", key: FAUCET_KEY }),
      wallets: writes,
    },
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

  it("lists the ten write tools exactly as the stdio server does", async () => {
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

  it("registers every name GATED lists, so none of it is stale, except the optional ones (checked with the setting on, below)", () => {
    const registered = new Set(tools.map((tool) => tool.name));
    for (const name of GATED) {
      if (OPTIONAL_GATED.includes(name)) continue;
      expect(registered.has(name), `${name} is in GATED but the hosted server does not register it`).toBe(true);
    }
  });

  it("lists no moi_configure_account, on either server, with MOI_ACCOUNT_KEY_TOOLS off", async () => {
    expect(tools.map((tool) => tool.name)).not.toContain(ACCOUNT_KEY_TOOL);
    expect((await listTools(buildServer())).map((tool) => tool.name)).not.toContain(ACCOUNT_KEY_TOOL);
  });

  it("answers a call to moi_configure_account as an unknown tool, with no sign-in prompt, whoever calls", async () => {
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: ACCOUNT_KEY_TOOL, arguments: {} } };
    for (const [who, headers] of [
      ["no token", {}],
      ["a read-only token", { authorization: `Bearer ${READ_TOKEN}` }],
      ["a token with the write scope", { authorization: `Bearer ${WRITE_TOKEN}` }],
    ] as const) {
      const answer = await post(baseUrl, call, headers);
      expect(answer.status, who).toBe(200);
      expect(answer.headers.get("www-authenticate"), who).toBeNull();
      expect(answer.json.result.isError, who).toBe(true);
      expect(answer.json.result.content[0].text, who).toMatch(/not found/);
    }
  });

  it("lists moi_faucet last, and on neither the stdio server nor the read gateway", async () => {
    // The faucet is the third optional module, registered after the dapp tools, and only the hosted server has it.
    expect(tools.map((tool) => tool.name).at(-1)).toBe("moi_faucet");
    for (const [label, server] of [["stdio", buildServer()], ["gateway", buildReadOnlyServer()]] as const) {
      expect((await listTools(server)).map((tool) => tool.name), label).not.toContain("moi_faucet");
    }
  });
});

describe("the hosted server's tool list when an optional module is left out", () => {
  /** tools/list names of a hosted app built over `deps`, asked over loopback like the pinned list. */
  async function namesOf(deps: HostedDeps): Promise<string[]> {
    const listener = createServer(buildHostedApp(deps));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      const answer = await post(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      return answer.json.result.tools.map((tool: RawTool) => tool.name);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }

  it("is the list with a faucet less moi_faucet: the tool is absent when it is not configured", async () => {
    // Compared with a live server rather than the snapshot file, which a -u run rewrites only at the end of the run.
    const without = await namesOf({ ...hostedDeps(), faucet: undefined });
    const withFaucet = await namesOf(hostedDeps());
    expect(without).not.toContain("moi_faucet");
    expect(without).toHaveLength(33);
    expect(withFaucet).toEqual([...without, "moi_faucet"]);
  });

  // The Launchpad has no sign-in tool of its own: its messages and descriptions send a person to moi_dapp_sign_in, and the
  // tool that ends the session is moi_dapp_sign_out. A server that lists the Launchpad tools must list those two, whether or
  // not whoever built it passed dapp deps (src/tools/register.ts).
  it("lists moi_dapp_sign_in and moi_dapp_sign_out whenever it lists the Launchpad tools, even given no dapp deps", async () => {
    const names = await namesOf({ ...hostedDeps(), dapp: undefined });
    expect(names).toContain("moi_launchpad_create_agent");
    expect(names).toEqual(expect.arrayContaining(["moi_dapp_sign_in", "moi_dapp_sign_out"]));
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
      moi_configure_account: "src/capabilities/accounts/configure.ts",
      moi_create_asset: "src/capabilities/assets/create.ts",
      moi_call_logic: "src/capabilities/logics/invoke.ts",
      moi_deploy_logic: "src/capabilities/logics/deploy.ts",
      moi_asset_invoke: "src/capabilities/assets/execute.ts",
      moi_register_agent: "src/applications/registry/tools.ts",
      moi_set_agent_status: "src/applications/registry/tools.ts",
      moi_transfer_agent: "src/applications/registry/tools.ts",
      moi_faucet: "src/applications/faucet/tools.ts",
    };
    for (const [name, file] of Object.entries(builtIn)) {
      expect(calling("defineTool", name), name).toEqual([file]);
      expect(calling("registerTool", name), `${name} is registered by name somewhere; register.ts names no tool`).toEqual([]);
    }
    // The read half of the asset tools is registered with the other reads, and is on the gateway.
    expect(calling("registerTool", "moi_asset_routines")).toEqual(["src/capabilities/reads/tools.ts"]);
  });
});

// ---------------------------------------------------------------------------
// With the account key tool switched on
// ---------------------------------------------------------------------------

describe("with MOI_ACCOUNT_KEY_TOOLS=on", () => {
  /** The full tools/list answer of a hosted app built over `deps`, asked over loopback like the pinned list. */
  async function hostedList(deps: HostedDeps): Promise<RawTool[]> {
    const listener = createServer(buildHostedApp(deps));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      const answer = await post(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      return answer.json.result.tools as RawTool[];
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }

  /** `list` with moi_configure_account inserted straight after moi_create_account, where the register order puts it. */
  function withAccountKeyTool(list: RawTool[], entry: RawTool): RawTool[] {
    const at = list.findIndex((tool) => tool.name === "moi_create_account");
    expect(at, "moi_create_account is in the list").toBeGreaterThanOrEqual(0);
    return [...list.slice(0, at + 1), entry, ...list.slice(at + 1)];
  }

  let hostedOff: RawTool[];
  let stdioOff: RawTool[];
  let hostedOn: RawTool[];
  let stdioOn: RawTool[];
  let listener: Server;
  let baseUrl: string;

  beforeAll(async () => {
    hostedOff = await hostedList(hostedDeps());
    stdioOff = await listTools(buildServer());
    applyEnv("http://127.0.0.1:1", home, { MOI_ACCOUNT_KEY_TOOLS: "on" });
    hostedOn = await hostedList(hostedDeps());
    stdioOn = await listTools(buildServer());
    listener = createServer(buildHostedApp(hostedDeps()));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    applyEnv("http://127.0.0.1:1", home); // the defaults again, so nothing after this sees the setting
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });

  it("lists moi_configure_account straight after moi_create_account, on both servers, and nothing else moves", () => {
    const hostedEntry = hostedOn.find((tool) => tool.name === ACCOUNT_KEY_TOOL);
    const stdioEntry = stdioOn.find((tool) => tool.name === ACCOUNT_KEY_TOOL);
    expect(hostedEntry).toBeDefined();
    expect(hostedOn).toEqual(withAccountKeyTool(hostedOff, hostedEntry!));
    expect(stdioOn).toEqual(withAccountKeyTool(stdioOff, stdioEntry!));
    expect(hostedOn).toHaveLength(hostedOff.length + 1);
    expect(stdioOn).toHaveLength(stdioOff.length + 1);
  });

  it("is the same entry on both servers, and is pinned", async () => {
    const hostedEntry = hostedOn.find((tool) => tool.name === ACCOUNT_KEY_TOOL)!;
    const stdioEntry = stdioOn.find((tool) => tool.name === ACCOUNT_KEY_TOOL)!;
    expect(stdioEntry).toEqual(hostedEntry);
    await expect(pinned([hostedEntry])).toMatchFileSnapshot("./__snapshots__/tools-account-keys.json");
  });

  it("is gated again: no token is 401, and a token that may only read is 403 for the write scope", async () => {
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: ACCOUNT_KEY_TOOL, arguments: {} } };
    const anonymous = await post(baseUrl, call);
    expect(anonymous.status).toBe(401);
    const reader = await post(baseUrl, call, { authorization: `Bearer ${READ_TOKEN}` });
    expect(reader.status).toBe(403);
    expect(reader.headers.get("www-authenticate")).toContain('scope="moi:write"');
  });

  it("is named in GATED and in OPTIONAL_GATED, and only it is optional", () => {
    expect(GATED).toContain(ACCOUNT_KEY_TOOL);
    expect(OPTIONAL_GATED).toEqual([ACCOUNT_KEY_TOOL]);
  });
});
