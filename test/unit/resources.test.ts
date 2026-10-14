/**
 * MCP resources, read through the SDK client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_REGISTRY_LOGIC_ID } from "../../src/capabilities/reads/registry.js";
import { startMockNode, type MockNode } from "../helpers/mock-node.js";
import { applyEnv, startHarness, type Harness } from "../helpers/harness.js";

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
      "moi_get_history",
      "moi_get_asset",
      "moi_asset_routines",
      "moi_get_interaction",
      "moi_get_logic",
      "moi_resolve_agent",
      "moi_list_agents",
      "moi_connect_wallet",
      "moi_transfer",
      "moi_create_asset",
      "moi_mint",
      "moi_call_logic",
      "moi_asset_invoke",
      "moi_deploy_logic",
    ]) {
      expect(item.text).toContain(tool);
    }
    // The tool is not registered unless the operator turns it on (MOI_ACCOUNT_KEY_TOOLS), so the quickstart does not name it.
    expect(item.text).not.toContain("moi_configure_account");
  });

  it("moi://docs/quickstart names moi_configure_account, with its paragraph, only while the setting is on", async () => {
    const read = async (): Promise<string> => {
      const { contents } = await h.client.readResource({ uri: "moi://docs/quickstart" });
      return (contents[0] as { text?: string }).text ?? "";
    };
    const off = await read();
    try {
      applyEnv(node.url, h.home, { MOI_ACCOUNT_KEY_TOOLS: "on" });
      const on = await read();
      expect(on).toContain("`moi_asset_invoke`, `moi_deploy_logic` and `moi_configure_account` build an");
      const paragraph = on.split(/\n\s*\n/).find((p) => p.startsWith("`moi_configure_account` adds keys"));
      expect(paragraph, "expected a paragraph on moi_configure_account in the quickstart").toBeDefined();
      // It sits in section 3, before the heading of section 4, and nothing else about the text moves.
      expect(on.indexOf("`moi_configure_account` adds keys")).toBeLessThan(on.indexOf("## 4."));
      expect(on.indexOf("`moi_configure_account` adds keys")).toBeGreaterThan(on.indexOf("`moi_deploy_logic` deploys"));
      expect(on.replace(paragraph! + "\n\n", "").replace(", `moi_deploy_logic` and `moi_configure_account`", " and `moi_deploy_logic`")).toBe(off);
    } finally {
      applyEnv(node.url, h.home); // the defaults again
    }
    expect(await read()).toBe(off);
  });

  it("moi://docs/quickstart signs in to the Launchpad with the generic dapp tool, and gives its address", async () => {
    const { contents } = await h.client.readResource({ uri: "moi://docs/quickstart" });
    const text = (contents[0] as { text?: string }).text ?? "";
    expect(text).toContain("moi_dapp_sign_in");
    expect(text).toContain("https://launchpad.moi.technology");
    expect(text).not.toMatch(/moi_launchpad_sign_(in|out)/);
  });

  it("an unknown resource is an error, not an empty answer", async () => {
    await expect(h.client.readResource({ uri: "moi://nope" })).rejects.toThrow();
  });
});
