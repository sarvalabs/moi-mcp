/**
 * MCP resources, read through the SDK client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_REGISTRY_LOGIC_ID } from "../../src/moi/registry.js";
import { startMockNode, type MockNode } from "../helpers/mock-node.js";
import { startHarness, type Harness } from "../helpers/harness.js";

let node: MockNode;
let h: Harness;

beforeAll(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
});

afterAll(async () => {
  await h.close();
  await node.close();
});

describe("resources", () => {
  it("lists both resources", async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["moi://docs/quickstart", "moi://networks"]);
  });

  it("moi://networks is JSON with the three networks and the registry logic id", async () => {
    const { contents } = await h.client.readResource({ uri: "moi://networks" });
    expect(contents).toHaveLength(1);
    const item = contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(item.uri).toBe("moi://networks");
    expect(item.mimeType).toBe("application/json");

    const parsed = JSON.parse(item.text ?? "") as {
      networks: Array<{ network: string; rpcUrl: string | null; caip2: string; caip2Verified: boolean }>;
      agentRegistry: { logicId: string; isDefault: boolean; overrideWith: string };
      notes: string[];
    };
    expect(parsed.networks.map((n) => n.network).sort()).toEqual(["custom", "mainnet", "voyage"]);
    const voyage = parsed.networks.find((n) => n.network === "voyage")!;
    expect(voyage).toMatchObject({
      rpcUrl: "https://dev.voyage-rpc.moi.technology/devnet/",
      caip2: "moi:14",
      caip2Verified: true,
    });
    expect(parsed.networks.find((n) => n.network === "mainnet")).toMatchObject({
      rpcUrl: null,
      caip2Verified: false,
    });
    expect(parsed.agentRegistry).toEqual({
      logicId: DEFAULT_REGISTRY_LOGIC_ID,
      isDefault: true,
      overrideWith: "MOI_AGENT_REGISTRY_LOGIC_ID",
    });
    expect(parsed.notes.length).toBeGreaterThan(0);
  });

  it("moi://docs/quickstart is markdown naming every tool", async () => {
    const { contents } = await h.client.readResource({ uri: "moi://docs/quickstart" });
    const item = contents[0] as { mimeType?: string; text?: string };
    expect(item.mimeType).toBe("text/markdown");
    expect(item.text).toMatch(/^# MOI MCP/);
    for (const tool of [
      "moi_get_account",
      "moi_get_asset",
      "moi_get_interaction",
      "moi_get_logic",
      "moi_resolve_agent",
      "moi_list_agents",
      "moi_connect_wallet",
      "moi_transfer",
      "moi_create_asset",
      "moi_call_logic",
    ]) {
      expect(item.text).toContain(tool);
    }
  });

  it("an unknown resource is an error, not an empty answer", async () => {
    await expect(h.client.readResource({ uri: "moi://nope" })).rejects.toThrow();
  });
});
