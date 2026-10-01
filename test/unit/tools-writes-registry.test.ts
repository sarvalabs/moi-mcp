/**
 * The agent registry's write tools on the stdio server: the same two calls as every other write, through the real
 * local adapters, the fake phone and the mock node. The interaction itself is stood in for (prepareLogicInvoke needs a
 * node that serves the registry's manifest, which the mock does not); everything around it is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { primeRegistryDriverForTests, resetRegistryCache } from "../../src/moi/registry.js";
import { ACCOUNT, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";
import {
  fakeWallet,
  installWallet,
  journalLines,
  seedSession,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";

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
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url, { env: { MOI_AGENT_REGISTRY_LOGIC_ID: REGISTRY } });
  wallet = fakeWallet();
  installWallet(h.home, wallet);
  seedSession(h.home);
});

afterEach(async () => {
  resetRegistryCache();
  await h.close();
  await node.close();
});

/** Prime the registry reads. Returns the GetAgentsByOwner spy, so a test can count how often the registry was asked. */
function primeRegistry(listed: boolean) {
  const routine = (impl: () => unknown) =>
    vi.fn(async () => ({ call: async () => ({ result: async () => impl() }) }));
  const byOwner = routine(() => ({
    output: listed ? { ids: ["agent_7"], total: 1n } : { ids: [], total: 0n },
    error: null,
  }));
  primeRegistryDriverForTests(REGISTRY, {
    routines: {
      GetAgentsByOwner: byOwner,
      GetAgentProfile: routine(() => ({
        output: {
          profile: {
            agent_id: "agent_7",
            owner: bytes(ACCOUNT),
            agent_wallet: bytes(AGENT_WALLET),
            status: "ACTIVE",
            url: "",
            card_uri: "",
          },
          found: true,
        },
        error: null,
      })),
    },
  });
  return byOwner;
}

const REGISTER = {
  url: "https://agents.example/pricefeed",
  cardUri: "https://agents.example/pricefeed/card.json",
  agentWallet: AGENT_WALLET,
};

describe("moi_register_agent on the stdio server", () => {
  it("previews, then registers, journals it, and reports the registry's id after one look", async () => {
    const byOwner = primeRegistry(true);

    const preview = await h.call("moi_register_agent", REGISTER);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: `Register an agent (${AGENT_WALLET}) in the MOI agent registry, owned by ${ACCOUNT}`,
      details: { Operation: "Register agent", Owner: ACCOUNT },
    });
    expect(wallet.request).not.toHaveBeenCalled();

    const done = await h.call("moi_register_agent", { ...REGISTER, confirm: String(preview.structuredContent?.["confirm"]) });
    expect(done.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH, registryAgentId: "agent_7" });
    expect(wallet.request).toHaveBeenCalledTimes(1);
    expect(byOwner).toHaveBeenCalledTimes(1); // one look, no polling: stdio's registryWaitMs is 0

    const lines = journalLines(h.home);
    expect(lines.map((l) => l["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    for (const line of lines) expect(line).toMatchObject({ userId: "local", kind: "register_agent" });
  });

  it("says where to look when the registry has not listed the agent yet, and does not poll", async () => {
    const byOwner = primeRegistry(false);
    const done = await h.send("moi_register_agent", REGISTER);
    expect(done.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(done.structuredContent?.["registryAgentId"]).toBeUndefined();
    expect(String(done.structuredContent?.["note"])).toMatch(/moi_list_agents/);
    expect(byOwner).toHaveBeenCalledTimes(1);
  });
});

describe("moi_set_agent_status and moi_transfer_agent on the stdio server", () => {
  it("set_agent_status is two calls and is journaled", async () => {
    const args = { agentId: "agent_7", status: "deprecated" };
    const preview = await h.call("moi_set_agent_status", args);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: "Set agent agent_7 to DEPRECATED in the MOI agent registry",
    });
    expect(wallet.request).not.toHaveBeenCalled();

    const done = await h.send("moi_set_agent_status", args);
    expect(done.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(journalLines(h.home).at(-1)).toMatchObject({ state: "confirmed", kind: "set_agent_status", userId: "local" });
  });

  it("transfer_agent is two calls and is journaled", async () => {
    const args = { agentId: "agent_7", newOwner: OTHER };
    const preview = await h.call("moi_transfer_agent", args);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: `Transfer agent agent_7 from ${ACCOUNT} to ${OTHER} in the MOI agent registry`,
    });
    expect(wallet.request).not.toHaveBeenCalled();

    const done = await h.send("moi_transfer_agent", args);
    expect(done.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(journalLines(h.home).at(-1)).toMatchObject({ state: "confirmed", kind: "transfer_agent", userId: "local" });
  });
});
