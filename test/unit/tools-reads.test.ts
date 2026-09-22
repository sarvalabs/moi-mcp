/**
 * Read tools, end to end through the real McpServer handlers, against a fake
 * node. Verifies the wire-level facts reads.ts depends on: nonce comes from
 * moi.InteractionCount, balances from moi.TDU, registration from
 * moi.AccountMetaInfo.state_exists.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT, IX_HASH, KMOI, LOGIC, startMockNode, type MockNode } from "../helpers/mock-node.js";
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

beforeEach(() => {
  node.reset();
  node.state.registered = true;
  node.state.receiptStatus = 0;
});

describe("moi_get_account", () => {
  it("maps nonce from InteractionCount, balances from TDU, isRegistered from state_exists", async () => {
    const result = await h.call("moi_get_account", { address: ACCOUNT });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      address: ACCOUNT,
      nonce: 5,
      balances: [{ assetId: KMOI, amount: "110000000000000" }],
      isRegistered: true,
    });

    // Nonce must come from the per-key interaction counter — AccountState
    // carries no nonce field on chain, whatever the SDK's type says.
    const count = node.calls.find((c) => c.method === "moi.InteractionCount");
    expect(count?.params).toMatchObject({ id: ACCOUNT, key_id: 0 });
    expect(node.methods()).toEqual(
      expect.arrayContaining(["moi.AccountState", "moi.InteractionCount", "moi.AccountMetaInfo", "moi.TDU"]),
    );
  });

  it("reports an unregistered participant", async () => {
    node.state.registered = false;
    const result = await h.call("moi_get_account", { address: ACCOUNT });
    expect(result.structuredContent?.["isRegistered"]).toBe(false);
  });

  it("rejects a malformed id as an INVALID_ARGS tool error, not a crash", async () => {
    const result = await h.call("moi_get_account", { address: "0xdeadbeef" });
    expect(result.isError).toBe(true);
    // The leading [CODE] token is the contract, not decoration: SDK 1.30's
    // tools/call wrapper collapses a thrown McpError to {isError, text} and
    // drops `data`, so this token is the only machine-readable code an agent
    // ever sees (src/errors.ts mcpError).
    expect(result.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] /);
    expect(result.text).toMatch(/not a valid MOI participant id: 0xdeadbeef/i);
    // The bad id must be stopped at the first read; nothing else is attempted.
    expect(node.methods()).toEqual(["moi.AccountState"]);
  });

  it("tags an upstream node failure with the RPC_ERROR token", async () => {
    node.on("moi.AccountState", () => {
      throw new Error("node is having a bad day");
    });
    const result = await h.call("moi_get_account", { address: ACCOUNT });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^MCP error -32603: \[RPC_ERROR\] /);
    // No manual restore needed: node.reset() in beforeEach drops overrides.
  });

  it("refuses input that fails the zod schema before touching the node", async () => {
    const result = await h.call("moi_get_account", { address: "not-hex" });
    expect(result.isError).toBe(true);
    expect(node.calls).toHaveLength(0);
  });
});

describe("moi_get_asset", () => {
  it("returns symbol, standard decoded from the id, dimension and supply", async () => {
    const result = await h.call("moi_get_asset", { assetId: KMOI });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      assetId: KMOI,
      symbol: "KMOI",
      standard: "MASN", // KMOI is a native asset since the September 2026 upgrade
      supply: "90000000100000",
      decimals: 0,
      dimension: 0,
      owner: ACCOUNT,
      isLogical: false,
    });
    expect(node.calls[0]).toMatchObject({
      method: "moi.AssetInfoByAssetID",
      params: { asset_id: KMOI, options: { tesseract_number: -1 } },
    });
  });

  it("scales supply by decimals without floating point", async () => {
    node.on("moi.AssetInfoByAssetID", () => ({
      symbol: "BIG",
      decimals: 18,
      creator: ACCOUNT,
      circulating_supply: `0x${(2n ** 70n).toString(16)}`,
    }));
    const result = await h.call("moi_get_asset", { assetId: KMOI });
    expect(result.structuredContent).toMatchObject({
      decimals: 18,
      supply: "1180.591620717411303424",
    });
  });
});

describe("moi_get_interaction", () => {
  it("reports success with fuel used and names the op type", async () => {
    const result = await h.call("moi_get_interaction", { hash: IX_HASH });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      hash: IX_HASH,
      status: "success",
      sender: ACCOUNT,
      fuelUsed: 299,
      operations: [{ type: "ASSET_INVOKE", payload: { asset_id: KMOI } }],
    });
  });

  it("reports failed when the receipt status is non-zero", async () => {
    node.state.receiptStatus = 1;
    const result = await h.call("moi_get_interaction", { hash: IX_HASH });
    expect(result.structuredContent?.["status"]).toBe("failed");
  });

  it("reports pending when there is no receipt yet", async () => {
    node.on("moi.InteractionReceipt", () => {
      throw new Error("receipt not found");
    });
    const result = await h.call("moi_get_interaction", { hash: IX_HASH });
    expect(result.structuredContent?.["status"]).toBe("pending");
    expect(result.structuredContent?.["fuelUsed"]).toBeUndefined();
  });
});

describe("moi_get_logic", () => {
  it("decodes the JSON manifest the node returns and carries the logic name", async () => {
    const result = await h.call("moi_get_logic", { logicId: LOGIC });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ logicId: LOGIC, name: "PingLogic" });
    expect(node.calls[0]).toMatchObject({
      method: "moi.LogicManifest",
      params: { logic_id: LOGIC, encoding: "JSON" },
    });
  });

  // REGRESSION (fixed in 10f2ce1): getLogic() used to keep elements whose kind
  // was "routine", but the manifest format names them "callable"
  // (js-moi-utils ElementType.ROUTINE === "callable"; the SDK's own
  // LogicDriver filters on "callable" too), so every real logic reported zero
  // routines. Reverting that filter must fail here.
  it("lists the manifest's callable routines", async () => {
    const result = await h.call("moi_get_logic", { logicId: LOGIC });
    expect(result.structuredContent?.["routines"]).toEqual([
      { name: "Ping", kind: "invoke", inputs: [], outputs: [] },
    ]);
  });

  it("rejects a malformed logic id", async () => {
    const result = await h.call("moi_get_logic", { logicId: "0x1234" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a valid MOI logic id/i);
  });
});
