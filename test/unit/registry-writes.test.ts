/**
 * The registry's write routines as hosted tools, with the write path stood
 * in for (the phone and the node) and the registry driver primed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AuthInfo } from "../../src/auth/types.js";
import { primeRegistryDriverForTests, resetRegistryCache } from "../../src/moi/registry.js";
import type { runWrite } from "../../src/tools/hosted-writes.js";
import { registerRegistryWrites } from "../../src/tools/registry-writes.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { authFor, deps as writeDeps, fakeHub, fakeJournal, fakeStore, session, structured, USER } from "../helpers/hosted.js";
import { ACCOUNT } from "../helpers/mock-node.js";

// The interaction itself is not built here: prepareLogicInvoke needs a node.
// What is under test is everything around it, so it is stood in for and the
// registry-core descriptions and details run for real on top of it.
vi.mock("../../src/tools/write-core.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/tools/write-core.js")>();
  return {
    ...mod,
    prepareLogicInvoke: vi.fn(async (account: string, params: { logicId: string; routine: string; args?: unknown[] }) => ({
      ix: { sender: { id: account, sequence: 0, key_id: 0 }, fuel_price: 50, fuel_limit: 1000, ix_operations: [] },
      description: `Call ${params.routine} on logic ${params.logicId}`,
      details: { Routine: params.routine, Arguments: JSON.stringify(params.args ?? []) },
    })),
  };
});

const REGISTRY = "0x200000002f3e9469d94de695be18fc5839fb9535f543b381f903f7f800000000";
const AGENT_WALLET = "0x000000002497e599b212a83896919005863b05511d46d0a32ad0af8600000000";
const HASH = "0x" + "cd".repeat(32);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

beforeAll(() => applyEnv("http://127.0.0.1:1", tempHome(), { MOI_AGENT_REGISTRY_LOGIC_ID: REGISTRY }));
afterAll(() => restoreEnv());
afterEach(() => resetRegistryCache());

function primeRegistry(listed: () => boolean) {
  const routine = (impl: (...a: unknown[]) => unknown) =>
    vi.fn(async (...a: unknown[]) => ({ call: async () => ({ result: async () => impl(...a) }) }));
  primeRegistryDriverForTests(REGISTRY, {
    routines: {
      GetAgentsByOwner: routine(() => ({ output: listed() ? { ids: ["agent_7"], total: 1n } : { ids: [], total: 0n }, error: null })),
      GetAgentProfile: routine(() => ({
        output: { profile: { agent_id: "agent_7", owner: bytes(ACCOUNT), agent_wallet: bytes(AGENT_WALLET), status: "ACTIVE", url: "", card_uri: "" }, found: true },
        error: null,
      })),
    },
  });
}

/** Records what it was asked to write; previews without confirm, "sends" with it. */
function fakeWrite() {
  let sent = false;
  const calls: Array<{ kind: string; args: unknown; confirm: unknown; description: string; details: Record<string, string> }> = [];
  const write = vi.fn(async (_deps, _auth, kind, args, confirm, prepare) => {
    // Run the real prepare closure against a fake session so the description
    // and details are what a person would see; the ix itself is not built.
    const prepared = await prepare({ address: ACCOUNT, topic: "t" });
    calls.push({ kind, args, confirm, description: prepared.description, details: prepared.details });
    if (!confirm) {
      const value = { status: "preview", confirm: "tok", summary: prepared.description, details: prepared.details, fuel: "x", network: "custom", expiresAt: new Date().toISOString() };
      return { content: [{ type: "text" as const, text: "preview" }], structuredContent: value };
    }
    sent = true;
    const value = { status: "sent", hash: HASH, explorerUrl: `https://voyage.moi.technology/interactions/${HASH}`, summary: prepared.description };
    return { content: [{ type: "text" as const, text: "sent" }], structuredContent: value };
  }) as unknown as typeof runWrite;
  return { write, calls, sent: () => sent };
}

async function connect(write: typeof runWrite, who: AuthInfo | null = authFor(USER)): Promise<Client> {
  const d = writeDeps(fakeStore(new Map([[USER, session()]])), fakeHub(), fakeJournal());
  const server = new McpServer({ name: "t", version: "0" });
  registerRegistryWrites(server, d, who, { write, registryWaitMs: 0 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

describe("moi_register_agent", () => {
  it("previews, then registers and reports the registry's id", async () => {
    const { write, calls, sent } = fakeWrite();
    primeRegistry(sent);
    const client = await connect(write);
    const args = { url: "https://agents.example/pricefeed", cardUri: "https://agents.example/pricefeed/card.json", agentWallet: AGENT_WALLET };

    const preview = structured<{ status: string; confirm: string; details: Record<string, string> }>(
      await client.callTool({ name: "moi_register_agent", arguments: args }),
    );
    expect(preview.status).toBe("preview");
    expect(calls[0]).toMatchObject({ kind: "register_agent", args, confirm: undefined });
    expect(calls[0]!.description).toMatch(/Register an agent .* owned by /);
    expect(calls[0]!.details).toMatchObject({ Operation: "Register agent", "Agent wallet": AGENT_WALLET, Owner: ACCOUNT, Registry: REGISTRY });

    const done = structured<{ status: string; hash: string; registryAgentId?: string }>(
      await client.callTool({ name: "moi_register_agent", arguments: { ...args, confirm: preview.confirm } }),
    );
    expect(done).toMatchObject({ status: "sent", hash: HASH, registryAgentId: "agent_7" });
  });

  it("says so when the registry has not listed the agent yet", async () => {
    const { write } = fakeWrite();
    primeRegistry(() => false);
    const client = await connect(write);
    const done = structured<{ status: string; registryAgentId?: string; note?: string }>(
      await client.callTool({
        name: "moi_register_agent",
        arguments: { url: "https://a.example", cardUri: "https://a.example/card.json", agentWallet: AGENT_WALLET, confirm: "tok" },
      }),
    );
    expect(done.status).toBe("sent");
    expect(done.registryAgentId).toBeUndefined();
    expect(done.note).toMatch(/moi_list_agents/);
  });

  it("rejects a malformed input before anything is prepared", async () => {
    const { write } = fakeWrite();
    const client = await connect(write);
    const res = await client.callTool({ name: "moi_register_agent", arguments: { url: "not a url", cardUri: "https://a.example/c", agentWallet: AGENT_WALLET } });
    expect(res.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("moi_set_agent_status and moi_transfer_agent", () => {
  it("prepare the registry routines with the user's account as owner", async () => {
    const { write, calls } = fakeWrite();
    const client = await connect(write);

    await client.callTool({ name: "moi_set_agent_status", arguments: { agentId: "agent_7", status: "deprecated" } });
    expect(calls[0]).toMatchObject({ kind: "set_agent_status", args: { agentId: "agent_7", status: "DEPRECATED" } });
    expect(calls[0]!.details).toMatchObject({ Operation: "Set agent status", Agent: "agent_7", Status: "DEPRECATED", Owner: ACCOUNT });

    const other = "0x0000000007070707070707070707070707070707070707070707070700000000";
    await client.callTool({ name: "moi_transfer_agent", arguments: { agentId: "agent_7", newOwner: other } });
    expect(calls[1]).toMatchObject({ kind: "transfer_agent", args: { agentId: "agent_7", newOwner: other } });
    expect(calls[1]!.details).toMatchObject({ Operation: "Transfer agent", "Current owner": ACCOUNT, "New owner": other });
  });

  it("refuse an id that is not the registry's agent_<n> form", async () => {
    const { write } = fakeWrite();
    const client = await connect(write);
    const res = await client.callTool({ name: "moi_set_agent_status", arguments: { agentId: "0xabc", status: "ACTIVE" } });
    expect(res.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});
