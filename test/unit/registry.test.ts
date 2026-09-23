/**
 * The registry logic as js-moi-sdk 0.9 actually returns it: every routine
 * result wrapped in { output, error }, identifiers as raw 32-byte arrays, ids
 * shaped "agent_<n>". The driver is primed directly; no node is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentCount,
  isCallerRejected,
  listAgents,
  primeRegistryDriverForTests,
  resetRegistryCache,
  resolveAgent,
  unwrapRoutineResult,
} from "../../src/moi/registry.js";

const LOGIC = "0x200000002f3e9469d94de695be18fc5839fb9535f543b381f903f7f800000000";
const OWNER_HEX = "0x00000000bfa45bc089945cf2befd0bd488e863562628cb47b14f3d1800000000";
const WALLET_HEX = "0x000000002497e599b212a83896919005863b05511d46d0a32ad0af8600000000";
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
const signer = {} as never;

type Routine = (...args: unknown[]) => Promise<{ call: () => Promise<{ result: () => Promise<unknown> }> }>;
const routine = (impl: (...args: unknown[]) => unknown): Routine =>
  vi.fn(async (...args: unknown[]) => ({ call: async () => ({ result: async () => impl(...args) }) }));

function profile(id: string) {
  return {
    agent_id: id,
    owner: bytes(OWNER_HEX),
    agent_wallet: bytes(WALLET_HEX),
    status: "ACTIVE",
    url: `https://launchpad.moi.technology/agent/${id}`,
    card_uri: `https://launchpad.moi.technology/api/moi/card/${WALLET_HEX}`,
    score: 0n,
    created_at: 1790096034000000000n,
    updated_at: 0n,
  };
}

const KNOWN = new Set(["agent_145", "agent_146", "agent_153"]);

function primeDriver() {
  const routines = {
    GetAgentCount: routine(() => ({ output: { count: 153n }, error: null })),
    GetAllAgentIds: routine((offset, limit) => {
      const all = Array.from({ length: 153 }, (_, i) => `agent_${i + 1}`);
      const page = all.slice(Number(offset), Number(offset) + Number(limit));
      return { output: { ids: page, total: 153n }, error: null };
    }),
    GetAgentsByOwner: routine((owner) => ({
      output: owner === OWNER_HEX ? { ids: [...KNOWN], total: 3n } : { ids: [], total: 0n },
      error: null,
    })),
    GetAgentProfile: routine((id) => ({
      output: KNOWN.has(String(id)) ? { profile: profile(String(id)), found: true } : { profile: {}, found: false },
      error: null,
    })),
  };
  primeRegistryDriverForTests(LOGIC, { routines });
  return routines;
}

afterEach(() => resetRegistryCache());

describe("unwrapRoutineResult", () => {
  it("takes the SDK's envelope apart and passes bare outputs through", () => {
    expect(unwrapRoutineResult({ output: { count: 1n }, error: null }, "x")).toEqual({ count: 1n });
    expect(unwrapRoutineResult({ count: 1n }, "x")).toEqual({ count: 1n });
  });

  it("turns a logic-side error into a thrown error rather than an empty answer", () => {
    expect(() => unwrapRoutineResult({ output: null, error: "no such agent" }, "registry.GetAgentProfile")).toThrow(
      /registry\.GetAgentProfile failed: no such agent/,
    );
  });
});

describe("agentCount", () => {
  it("reads the count out of the envelope", async () => {
    primeDriver();
    expect(await agentCount(signer, LOGIC)).toBe(153);
  });
});

describe("resolveAgent", () => {
  it("looks an agent_<n> id up directly and decodes byte identifiers to hex", async () => {
    const routines = primeDriver();
    // Cards are fetched over HTTP; none here.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const out = await resolveAgent(signer, "agent_153", { logicId: LOGIC });
    expect(out.found).toBe(true);
    expect(out.agentId).toBe("agent_153");
    expect(out.address).toBe(WALLET_HEX);
    expect(out.endpoint).toBe("https://launchpad.moi.technology/agent/agent_153");
    expect(out.metadata?.["owner"]).toBe(OWNER_HEX);
    expect(out.metadata?.["created_at"]).toBe("1790096034000000000");
    // Direct hit: no scan of the id list.
    expect(routines.GetAllAgentIds).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("listAgents", () => {
  it("pages through every agent with the registry's total and a next offset", async () => {
    primeDriver();
    const page = await listAgents(signer, { offset: 150, limit: 2, logicId: LOGIC });
    expect(page.total).toBe(153);
    expect(page.agents.map((a) => a.agentId)).toEqual(["agent_151", "agent_152"]);
    expect(page.nextOffset).toBe(152);
    // Listed but unreadable profiles are kept, marked, not dropped.
    expect(page.agents[0]).toEqual({ agentId: "agent_151", found: false });

    const last = await listAgents(signer, { offset: 152, limit: 2, logicId: LOGIC });
    expect(last.agents).toHaveLength(1);
    expect(last.nextOffset).toBeUndefined();
  });

  it("lists an owner's agents with decoded profiles", async () => {
    primeDriver();
    const page = await listAgents(signer, { owner: OWNER_HEX, logicId: LOGIC });
    expect(page.total).toBe(3);
    expect(page.agents).toHaveLength(3);
    const a = page.agents.find((x) => x.agentId === "agent_153")!;
    expect(a).toMatchObject({
      found: true,
      owner: OWNER_HEX,
      address: WALLET_HEX,
      status: "ACTIVE",
      url: "https://launchpad.moi.technology/agent/agent_153",
      score: "0",
      createdAt: "1790096034000000000",
    });
    expect(page.nextOffset).toBeUndefined();
  });

  it("clamps the page size", async () => {
    const routines = primeDriver();
    await listAgents(signer, { limit: 500, logicId: LOGIC });
    expect(routines.GetAllAgentIds).toHaveBeenCalledWith(0, 50);
  });
});

describe("a rejected read caller", () => {
  it("is named, not reported as an empty registry", async () => {
    primeRegistryDriverForTests(LOGIC, {
      routines: {
        GetAgentCount: routine(() => {
          throw new Error(
            "failed to fetch transition objects: state object fetch failed: failed to fetch acc meta info: account not found",
          );
        }),
      },
    });
    await expect(agentCount(signer, LOGIC)).rejects.toThrow(/MOI_READ_CALLER/);
    expect(isCallerRejected(new Error("failed to fetch acc meta info: account not found"))).toBe(true);
    expect(isCallerRejected(new Error("state object fetch failed"))).toBe(false);
  });
});
