/**
 * Live reads against voyage devnet.
 *
 * Skipped unless MOI_E2E=1, so CI never flakes on someone else's uptime:
 *   MOI_E2E=1 npx vitest run test/e2e
 */

import { describe, expect, it } from "vitest";

import { getProvider, getReadOnlySigner, interactionUrl, NETWORKS } from "../../src/moi/provider.js";
import { getAccount } from "../../src/moi/reads.js";
import { agentCount, DEFAULT_REGISTRY_LOGIC_ID, getRegistryDriver, resolveAgent } from "../../src/capabilities/reads/registry.js";

const live = process.env["MOI_E2E"] === "1";
const d = live ? describe : describe.skip;

d("voyage devnet", () => {
  const options = { network: "voyage" as const };

  it("the RPC endpoint answers", async () => {
    const provider = getProvider(options);
    const status = await provider.getSyncStatus();
    expect(status).toBeDefined();
  }, 30_000);

  it("rejects a malformed participant id as INVALID_ARGS, not a crash", async () => {
    await expect(getAccount(getProvider(options), "0xdeadbeef")).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  }, 30_000);

  it("the agent registry logic exists and exposes its routines", async () => {
    const driver = await getRegistryDriver(getReadOnlySigner(options), DEFAULT_REGISTRY_LOGIC_ID);
    const routines = Object.keys(driver.routines ?? {});
    expect(routines).toContain("GetAgentProfile");
    expect(routines).toContain("GetAllAgentIds");
    expect(routines).toContain("GetAgentCount");
  }, 45_000);

  it("an unwritten registry answers 'not found' rather than erroring", async () => {
    const result = await resolveAgent(getReadOnlySigner(options), "definitely-not-registered-xyz");
    expect(result.found).toBe(false);
    expect(result.capabilities).toEqual([]);
  }, 60_000);

  it("agentCount degrades to 0 rather than throwing", async () => {
    expect(await agentCount(getReadOnlySigner(options))).toBeGreaterThanOrEqual(0);
  }, 45_000);
});

describe("explorer links", () => {
  it("uses the bare query string the Voyage explorer expects", () => {
    // /interaction/?0xabc — no path segment, no ?hash= key.
    expect(interactionUrl("voyage", "0xabc")).toBe("https://voyage.moi.technology/interaction/?0xabc");
  });

  it("voyage ships a verified CAIP-2 id; mainnet does not", () => {
    expect(NETWORKS.voyage.caip2).toBe("moi:14");
    expect(NETWORKS.voyage.caip2Verified).toBe(true);
    expect(NETWORKS.mainnet.caip2Verified).toBe(false);
    expect(NETWORKS.mainnet.rpcUrl).toBeNull();
  });
});
