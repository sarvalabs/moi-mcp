/**
 * The node-method tools (src/capabilities/reads/rpc-tools.ts), end to end through the read gateway's real McpServer and the
 * mock node. rpc-coverage.test.ts checks the table against the provider; this file checks what a call does: which node
 * method goes out and with what, what comes back, and what a failure looks like.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CustomError, ErrorCode as SdkErrorCode, topicHash } from "js-moi-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RPC_METHODS } from "../../src/capabilities/reads/rpc-methods.js";
import { nodeFailure, registerRpcTools, shapeAnswer, withTimeout } from "../../src/capabilities/reads/rpc-tools.js";
import { MAX_BODY_BYTES } from "../../src/bounds.js";
import { buildReadOnlyServer } from "../../src/http.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { ACCOUNT, IX_HASH, KMOI, LOGIC, MAS0_ASSET, POOLED_IX, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";

const rows = RPC_METHODS.flatMap((row) => (row.status === "tool" ? [row] : []));

const INTERACTION = {
  sender: { id: ACCOUNT, sequence: 5, key_id: 0 },
  fuel_price: "50",
  fuel_limit: 1000,
  ix_operations: [{ type: 5, payload: { asset_id: MAS0_ASSET, callsite: "Transfer" } }],
  funds: [{ asset_id: KMOI, amount: "100" }],
};

/** One valid call for every row with status tool, keyed by wire name. A new row has to bring its own. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  "moi.AccountState": { id: ACCOUNT },
  "moi.AccountMetaInfo": { id: ACCOUNT },
  "moi.AccountKeys": { id: ACCOUNT },
  "moi.Balance": { id: ACCOUNT, asset_id: KMOI },
  "moi.TDU": { id: ACCOUNT },
  "moi.InteractionCount": { id: ACCOUNT },
  "moi.PendingInteractionCount": { id: ACCOUNT },
  "moi.SubAccountCount": { id: ACCOUNT },
  "moi.Deeds": { id: ACCOUNT },
  "moi.ContextInfo": { id: ACCOUNT },
  "moi.Syncing": {},
  "moi.AssetInfoByAssetID": { asset_id: KMOI },
  "moi.StorageMetric": { target_account: MAS0_ASSET, user_account: ACCOUNT },
  "moi.StoragePricing": {},
  "moi.LogicManifest": { logic_id: LOGIC },
  "moi.LogicStorage": { logic_id: LOGIC, storage_key: "0x01" },
  "moi.LogicIDs": { id: ACCOUNT },
  "moi.Call": { interaction: INTERACTION },
  "moi.FuelEstimate": { interaction: INTERACTION },
  "moi.InteractionByHash": { hash: IX_HASH },
  "moi.InteractionByTesseract": { id: ACCOUNT, tesseract_number: 1, ix_index: 1 },
  "moi.InteractionReceipt": { hash: IX_HASH },
  "moi.Tesseract": { id: ACCOUNT, tesseract_number: 3 },
  "moi.AccessPolicy": { id: ACCOUNT, resource_type: "storage", resource_id: LOGIC },
  "moi.AccessPolicies": { id: ACCOUNT, resource_type: "storage" },
  "moi.GetLogs": { id: ACCOUNT, start_height: 1, end_height: 5 },
  "ixpool.Content": {},
  "ixpool.ContentFrom": { id: ACCOUNT },
  "ixpool.Status": {},
  "ixpool.Inspect": {},
  "ixpool.WaitTime": { id: ACCOUNT },
  "net.Peers": {},
  "net.Version": {},
  "net.Info": {},
};

let node: MockNode;
let h: Harness;

beforeAll(async () => {
  node = await startMockNode();
  h = await startHarness(node.url, { build: () => buildReadOnlyServer() });
});

afterAll(async () => {
  await h.close();
  await node.close();
});

beforeEach(() => {
  node.reset();
});

/** The parameters the last node call carried, as the SDK sent them. */
const sent = (): Record<string, unknown> => node.calls.at(-1)?.params ?? {};
const answer = (result: { structuredContent?: Record<string, unknown> }): unknown => result.structuredContent?.["result"];

describe("the node-method tools on the read gateway", () => {
  it("come after the eight tools the gateway had, one per row, read-only, each with the shared output shape", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.slice(0, 8).map((tool) => tool.name)).toEqual([
      "ping",
      "moi_get_account",
      "moi_get_asset",
      "moi_asset_routines",
      "moi_get_interaction",
      "moi_get_logic",
      "moi_resolve_agent",
      "moi_list_agents",
    ]);
    expect(tools.slice(8).map((tool) => tool.name)).toEqual(rows.map((row) => row.tool));
    for (const tool of tools.slice(8)) {
      const row = rows.find((r) => r.tool === tool.name);
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true });
      expect(tool.title, tool.name).toBe(`Node method ${row?.wire}`);
      expect(tool.description, tool.name).toBe(row?.description);
      expect(Object.keys((tool.outputSchema as { properties: Record<string, unknown> }).properties), tool.name).toEqual([
        "method",
        "result",
        "truncated",
        "note",
      ]);
      // The same output schema is in all 34 tools, so every byte of it is paid 34 times in the tool list.
      expect(JSON.stringify(tool.outputSchema).length, tool.name).toBeLessThan(500);
    }
  });

  it("advertise schemas that are valid JSON Schema 2020-12 with no $ref left in them", async () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv as never);
    const { tools } = await h.client.listTools();
    for (const tool of tools.filter((t) => t.name.startsWith("moi_rpc_"))) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
        expect(() => ajv.compile(schema as object), tool.name).not.toThrow();
      }
    }
  });

  it("each sends its own node method, once, and answers { method, result, truncated }", async () => {
    for (const row of rows) {
      const sample = SAMPLES[row.wire];
      expect(sample, `${row.wire} needs a sample call in SAMPLES`).toBeDefined();
      node.reset();
      const result = await h.call(row.tool, sample);
      expect(result.isError, `${row.tool}: ${result.text}`).toBeFalsy();
      // One call to the node, under the wire name the row gives, and never a send.
      expect(node.methods(), row.tool).toEqual([row.wire]);
      expect(result.structuredContent, row.tool).toMatchObject({ method: row.wire, truncated: false });
      expect(result.structuredContent, row.tool).toHaveProperty("result");
    }
  });
});

describe("account methods", () => {
  it("read the latest tesseract unless told which, by number or by hash", async () => {
    const latest = await h.call("moi_rpc_account_state", { id: ACCOUNT });
    expect(latest.structuredContent).toEqual({
      method: "moi.AccountState",
      result: { balance: {}, context_hash: "0x00" },
      truncated: false,
    });
    expect(sent()).toEqual({ id: ACCOUNT, options: { tesseract_number: -1 } });

    await h.call("moi_rpc_account_state", { id: ACCOUNT, tesseract_number: 7 });
    expect(sent()["options"]).toEqual({ tesseract_number: 7 });
    await h.call("moi_rpc_account_state", { id: ACCOUNT, tesseract_hash: IX_HASH });
    expect(sent()["options"]).toEqual({ tesseract_hash: IX_HASH });
  });

  it("refuse a tesseract number and a hash together before the node is asked", async () => {
    const result = await h.call("moi_rpc_account_state", { id: ACCOUNT, tesseract_number: 7, tesseract_hash: IX_HASH });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] Give tesseract_number or tesseract_hash, not both\./);
    expect(node.calls).toHaveLength(0);
  });

  it("send key 0 unless a key is named, and the pending count takes no tesseract", async () => {
    const count = await h.call("moi_rpc_interaction_count", { id: ACCOUNT });
    expect(answer(count)).toBe(5);
    expect(sent()).toEqual({ id: ACCOUNT, key_id: 0, options: { tesseract_number: -1 } });
    await h.call("moi_rpc_interaction_count", { id: ACCOUNT, key_id: 2 });
    expect(sent()["key_id"]).toBe(2);

    node.reset();
    await h.call("moi_rpc_pending_interaction_count", { id: ACCOUNT });
    expect(sent()).toEqual({ id: ACCOUNT, key_id: 0 });
  });

  it("hand back big numbers as decimal strings and small ones as numbers", async () => {
    const small = await h.call("moi_rpc_tdu", { id: ACCOUNT });
    expect(answer(small)).toEqual([{ asset_id: KMOI, token_id: 0, amount: 110_000_000_000_000 }]);

    node.on("moi.TDU", () => [{ asset_id: KMOI, token_id: "0x1", amount: `0x${(2n ** 70n).toString(16)}` }]);
    const big = await h.call("moi_rpc_tdu", { id: ACCOUNT });
    expect(answer(big)).toEqual([{ asset_id: KMOI, token_id: 1, amount: "1180591620717411303424" }]);
    expect(big.text).toContain('"amount": "1180591620717411303424"');
  });

  it("send the asset id as asset_id, and the account for the sync status only when given", async () => {
    await h.call("moi_rpc_balance", { id: ACCOUNT, asset_id: KMOI });
    expect(sent()).toEqual({ id: ACCOUNT, asset_id: KMOI, options: { tesseract_number: -1 } });

    node.reset();
    const node_sync = await h.call("moi_rpc_syncing", {});
    expect(sent()).toEqual({});
    expect(answer(node_sync)).toMatchObject({ node_sync_status: null });
    await h.call("moi_rpc_syncing", { id: ACCOUNT });
    expect(sent()).toEqual({ id: ACCOUNT });
  });
});

describe("asset and logic methods", () => {
  it("answer the asset's info, the pricing and a storage allowance as the node does", async () => {
    const info = await h.call("moi_rpc_asset_info_by_asset_id", { asset_id: KMOI });
    expect(sent()).toEqual({ asset_id: KMOI, options: { tesseract_number: -1 } });
    expect(answer(info)).toMatchObject({ symbol: "KMOI" });

    const pricing = await h.call("moi_rpc_storage_pricing", {});
    expect(answer(pricing)).toEqual({ storage_price_per_byte: "0xf4240", storage_multiplier: "0x1", anu_per_byte: "0xf4240" });

    await h.call("moi_rpc_storage_metric", { target_account: MAS0_ASSET, user_account: ACCOUNT });
    expect(sent()).toMatchObject({ target_account: MAS0_ASSET, user_account: ACCOUNT });
  });

  it("read a manifest as JSON by default and as POLO on request", async () => {
    const json = await h.call("moi_rpc_logic_manifest", { logic_id: LOGIC });
    expect(sent()["encoding"]).toBe("JSON");
    expect(answer(json)).toMatchObject({ kind: "logic", name: "PingLogic" });

    const polo = await h.call("moi_rpc_logic_manifest", { logic_id: LOGIC, encoding: "POLO" });
    expect(sent()["encoding"]).toBe("POLO");
    expect(typeof answer(polo)).toBe("string");
  });

  it("send the account for a storage read only when given", async () => {
    await h.call("moi_rpc_logic_storage", { logic_id: LOGIC, storage_key: "0x01" });
    expect(sent()).toEqual({ logic_id: LOGIC, storage_key: "0x01", options: { tesseract_number: -1 } });
    await h.call("moi_rpc_logic_storage", { logic_id: LOGIC, storage_key: "0x01", id: ACCOUNT, tesseract_hash: IX_HASH });
    expect(sent()).toEqual({ id: ACCOUNT, logic_id: LOGIC, storage_key: "0x01", options: { tesseract_hash: IX_HASH } });
  });
});

describe("interaction methods", () => {
  it("look an interaction and its receipt up by hash", async () => {
    const byHash = await h.call("moi_rpc_interaction_by_hash", { hash: IX_HASH });
    expect(sent()).toEqual({ hash: IX_HASH });
    expect(answer(byHash)).toMatchObject({ hash: IX_HASH });
    const receipt = await h.call("moi_rpc_interaction_receipt", { hash: IX_HASH });
    expect(answer(receipt)).toMatchObject({ ix_hash: IX_HASH, status: 0, fuel_used: "0x12b" });
  });

  it("find an interaction of a tesseract by account and height, or by hash alone, at the index asked for, and refuse a height alone", async () => {
    await h.call("moi_rpc_interaction_by_tesseract", { id: ACCOUNT, tesseract_number: 3, ix_index: 1 });
    expect(sent()).toEqual({ address: ACCOUNT, options: { tesseract_number: 3 }, ix_index: "0x1" });
    await h.call("moi_rpc_interaction_by_tesseract", { id: ACCOUNT, tesseract_number: 3, ix_index: 0 });
    expect(sent()["ix_index"]).toBe("0x0");
    await h.call("moi_rpc_interaction_by_tesseract", { tesseract_hash: IX_HASH, ix_index: 2 });
    expect(sent()).toEqual({ options: { tesseract_hash: IX_HASH }, ix_index: "0x2" });

    node.reset();
    const refused = await h.call("moi_rpc_interaction_by_tesseract", { tesseract_number: 3, ix_index: 1 });
    expect(refused.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] Without id, a tesseract is found by its hash/);
    expect(node.calls).toHaveLength(0);
  });

  it("simulate a full interaction and answer only the receipt, and estimate its fuel", async () => {
    const simulated = await h.call("moi_rpc_call", { interaction: INTERACTION });
    expect(answer(simulated)).toMatchObject({ status: 0, fuel_used: "0x12b" });
    const ixArgs = sent()["ix_args"] as { sender: unknown; fuel_price: string; ix_operations: unknown[]; funds: Array<{ amount: string }> };
    expect(ixArgs.sender).toEqual(INTERACTION.sender);
    // fuel_price "50" and the fund's "100" were decimal strings; the SDK got them as numbers and sent them as hex.
    expect(ixArgs.fuel_price).toBe("0x32");
    expect(ixArgs.funds[0]?.amount).toBe("0x64");
    expect(ixArgs.ix_operations).toHaveLength(1);

    node.reset();
    const estimate = await h.call("moi_rpc_fuel_estimate", { interaction: INTERACTION });
    expect(answer(estimate)).toBe(299);
    expect(node.methods()).toEqual(["moi.FuelEstimate"]);
  });

  it("refuse an interaction the SDK cannot encode, as INVALID_ARGS, before the node is asked", async () => {
    const noCallsite = { ...INTERACTION, ix_operations: [{ type: 5, payload: { asset_id: MAS0_ASSET } }] };
    const refused = await h.call("moi_rpc_call", { interaction: noCallsite });
    expect(refused.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] The interaction cannot be encoded: callsite must be a non-empty string/);
    const badPrice = await h.call("moi_rpc_fuel_estimate", { interaction: { ...INTERACTION, fuel_price: "fifty" } });
    expect(badPrice.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] fuel_price must be a whole number/);
    // A payload `funds` object makes the SDK throw "map.keys is not a function"; the caller gets a sentence about the payload.
    const payloadFunds = {
      ...INTERACTION,
      ix_operations: [{ type: 5, payload: { asset_id: MAS0_ASSET, callsite: "Transfer", funds: { [KMOI]: 5 } } }],
    };
    const refusedFunds = await h.call("moi_rpc_fuel_estimate", { interaction: payloadFunds });
    expect(refusedFunds.text).toMatch(
      /^MCP error -32602: \[INVALID_ARGS\] The interaction cannot be encoded: an operation payload has a field of a shape the SDK cannot encode, such as a funds object \(/,
    );
    expect(node.calls).toHaveLength(0);
  });
});

describe("tesseract, access and log methods", () => {
  it("read a tesseract by account and height or by hash, with or without its interactions", async () => {
    const plain = await h.call("moi_rpc_tesseract", { id: ACCOUNT });
    expect(sent()).toEqual({ id: ACCOUNT, with_interactions: false, with_commit_info: false, options: { tesseract_number: -1 } });
    expect(answer(plain)).toMatchObject({ ixns: [{ hash: IX_HASH }] });

    await h.call("moi_rpc_tesseract", { id: ACCOUNT, with_interactions: true, with_commit_info: true, tesseract_number: 4 });
    expect(sent()).toEqual({ id: ACCOUNT, with_interactions: true, with_commit_info: true, options: { tesseract_number: 4 } });
    await h.call("moi_rpc_tesseract", { tesseract_hash: IX_HASH });
    expect(sent()).toEqual({ with_interactions: false, with_commit_info: false, options: { tesseract_hash: IX_HASH } });

    node.reset();
    const neither = await h.call("moi_rpc_tesseract", {});
    expect(neither.text).toMatch(/\[INVALID_ARGS\] Without id, a tesseract is found by its hash/);
    expect(node.calls).toHaveLength(0);
  });

  it("send an access policy's resource type as the node's lowercase label", async () => {
    const one = await h.call("moi_rpc_access_policy", { id: ACCOUNT, resource_type: "storage", resource_id: LOGIC });
    expect(sent()).toMatchObject({ id: ACCOUNT, resource_type: "storage", resource_id: LOGIC });
    expect(answer(one)).toMatchObject({ resource_type: "storage", resource_id: LOGIC });
    await h.call("moi_rpc_access_policies", { id: ACCOUNT, resource_type: "logic" });
    expect(sent()["resource_type"]).toBe("logic");
    const refused = await h.call("moi_rpc_access_policies", { id: ACCOUNT, resource_type: "bucket" });
    expect(refused.isError).toBe(true);
  });

  it("read logs over a height range, and send every topic name hashed, which is what the node matches", async () => {
    const logs = await h.call("moi_rpc_get_logs", { id: ACCOUNT, start_height: 1, end_height: 5 });
    expect(sent()).toEqual({ id: ACCOUNT, topics: [], start_height: 1, end_height: 5 });
    expect(answer(logs)).toMatchObject([{ ix_hash: IX_HASH }]);

    // The tool takes a list of lists only, because js-moi-providers 0.9.0-rc2 leaves a flat list unhashed on the wire (its
    // hashTopics returns a copy it took before hashing). The input schema test below refuses a flat list.
    await h.call("moi_rpc_get_logs", { id: ACCOUNT, start_height: 1, end_height: 5, topics: [["a"], ["b", "c"]] });
    expect(sent()["topics"]).toEqual([[topicHash("a")], [topicHash("b"), topicHash("c")]]);
  });
});

describe("pool and network methods", () => {
  it("answer the pool keyed by account and nonce as plain objects, not as the empty objects a Map becomes in JSON", async () => {
    const content = await h.call("moi_rpc_ixpool_content", {});
    expect(answer(content)).toEqual({
      pending: { [ACCOUNT]: { "5": POOLED_IX, "6": POOLED_IX } },
      queued: { [ACCOUNT]: { "9": POOLED_IX } },
    });
    const from = await h.call("moi_rpc_ixpool_content_from", { id: ACCOUNT });
    expect(sent()).toEqual({ id: ACCOUNT });
    expect(answer(from)).toEqual({ pending: { "5": POOLED_IX }, queued: {} });
    const inspect = await h.call("moi_rpc_ixpool_inspect", {});
    expect(answer(inspect)).toEqual({
      pending: { [ACCOUNT]: { "5": "transfer" } },
      queued: {},
      wait_time: { [ACCOUNT]: { expired: false, time: 60 } },
    });
  });

  it("answer the pool's counts, an account's wait and the node's own details", async () => {
    expect(answer(await h.call("moi_rpc_ixpool_status", {}))).toEqual({ pending: 2, queued: 1 });
    expect(answer(await h.call("moi_rpc_ixpool_wait_time", { id: ACCOUNT }))).toEqual({ expired: true, time: "0x0" });
    expect(answer(await h.call("moi_rpc_net_peers", {}))).toEqual(["peer-a", "peer-b"]);
    expect(answer(await h.call("moi_rpc_net_version", {}))).toBe("0.13.0");
    expect(answer(await h.call("moi_rpc_net_info", {}))).toEqual({ krama_id: "krama-1" });
  });
});

describe("failures", () => {
  it("a node error is RPC_ERROR and names the method, not the arguments", async () => {
    node.on("moi.StorageMetric", () => {
      throw new RpcFailure("storage metric is unavailable");
    });
    const result = await h.call("moi_rpc_storage_metric", { target_account: LOGIC, user_account: ACCOUNT });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^MCP error -32603: \[RPC_ERROR\] moi\.StorageMetric: storage metric is unavailable/);
    expect(result.text).not.toContain(ACCOUNT);
  });

  it("a node that calls an identifier invalid is INVALID_ARGS", async () => {
    const result = await h.call("moi_rpc_account_state", { id: "0xdeadbeef" });
    expect(result.text).toMatch(/^MCP error -32602: \[INVALID_ARGS\] moi\.AccountState: .*invalid identifier/i);
    expect(node.methods()).toEqual(["moi.AccountState"]);
  });

  it("input that fails the schema never reaches the node", async () => {
    for (const [tool, args] of [
      ["moi_rpc_account_state", { id: "not-hex" }],
      ["moi_rpc_account_state", {}],
      ["moi_rpc_account_state", { id: ACCOUNT, tesseract_number: -2 }],
      ["moi_rpc_interaction_count", { id: ACCOUNT, key_id: -1 }],
      ["moi_rpc_get_logs", { id: ACCOUNT, start_height: 1 }],
      // A flat topic list would reach the node unhashed, so it is refused; and ix_index has no default.
      ["moi_rpc_get_logs", { id: ACCOUNT, start_height: 1, end_height: 5, topics: ["a", "b"] }],
      ["moi_rpc_interaction_by_tesseract", { id: ACCOUNT, tesseract_number: 1 }],
    ] as const) {
      const result = await h.call(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(node.calls).toHaveLength(0);
  });
});

describe("a large or deep answer", () => {
  it("is cut at 64 KB of JSON and says so, through the tool", async () => {
    node.on("net.Peers", () => Array.from({ length: 20_000 }, (_, i) => `peer-${i}`));
    const result = await h.call("moi_rpc_net_peers", {});
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { result: string; truncated: boolean; note?: string };
    expect(out.truncated).toBe(true);
    expect(out.result).toHaveLength(MAX_BODY_BYTES);
    expect(out.result.startsWith('["peer-0","peer-1"')).toBe(true);
    expect(out.note).toMatch(/cut at 65536 characters/);
  });

  it("is cut at 19 levels of nesting and says so, through the tool", async () => {
    node.on("net.Info", () => JSON.parse('{"a":'.repeat(30) + "1" + "}".repeat(30)));
    const result = await h.call("moi_rpc_net_info", {});
    const out = result.structuredContent as { truncated: boolean; note?: string };
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/deeper than 19 levels/);
    expect(result.text).toContain("[omitted: nested more than 19 levels deep]");
    expect(result.text.length).toBeLessThan(5000);
  });
});

describe("shapeAnswer", () => {
  it("gives a small answer whole, as pretty JSON, with no note", () => {
    const out = shapeAnswer("net.Version", "0.13.0");
    expect(out.structuredContent).toEqual({ method: "net.Version", result: "0.13.0", truncated: false });
    expect(out.content[0]?.text).toBe(JSON.stringify(out.structuredContent, null, 2));
  });

  it("turns bigints into decimal strings and a missing answer into null", () => {
    expect(shapeAnswer("x", 2n ** 70n).structuredContent.result).toBe("1180591620717411303424");
    expect(shapeAnswer("x", { a: [1n] }).structuredContent.result).toEqual({ a: ["1"] });
    expect(shapeAnswer("x", undefined).structuredContent.result).toBeNull();
  });

  it("turns a Map into a plain object, nested Maps too, with a bigint key as its digits", () => {
    const value = { pending: new Map([["0xab", new Map([[5n, "x"], [2n ** 70n, "y"]])]]), queued: new Map() };
    expect(shapeAnswer("x", value).structuredContent.result).toEqual({
      pending: { "0xab": { "5": "x", "1180591620717411303424": "y" } },
      queued: {},
    });
  });

  it("keeps 19 levels and cuts the 20th, because the answer sits one level down in the result", () => {
    const nested = (levels: number) => JSON.parse('{"a":'.repeat(levels) + "1" + "}".repeat(levels)) as unknown;
    expect(shapeAnswer("x", nested(19)).structuredContent.truncated).toBe(false);
    const cut = shapeAnswer("x", nested(20));
    expect(cut.structuredContent.truncated).toBe(true);
    expect(cut.structuredContent.note).toMatch(/deeper than 19 levels/);
  });

  it("survives an answer nested thousands of levels deep", () => {
    const deep = JSON.parse('{"a":'.repeat(7000) + "1" + "}".repeat(7000)) as unknown;
    const out = shapeAnswer("x", deep);
    expect(out.structuredContent.truncated).toBe(true);
    expect(out.content[0]?.text.length).toBeLessThan(5000);
  });
});

describe("nodeFailure", () => {
  it("calls an identifier or an argument the node finds invalid INVALID_ARGS, and anything else RPC_ERROR", () => {
    expect(nodeFailure("moi.X", new Error("invalid identifier: 0x12")).code).toBe("INVALID_ARGS");
    expect(nodeFailure("moi.X", new Error("Invalid query range")).code).toBe("INVALID_ARGS");
    const other = nodeFailure("moi.X", new Error("Error: fetch failed"));
    expect(other.code).toBe("RPC_ERROR");
    expect(other.message).toBe("moi.X: Error: fetch failed");
    expect(nodeFailure("moi.X", "a string").code).toBe("RPC_ERROR");
  });

  it("passes one of our own errors through as it is", () => {
    const own = new MoiError(ErrorCode.INVALID_ARGS, "Give tesseract_number or tesseract_hash, not both.");
    expect(nodeFailure("moi.X", own)).toBe(own);
  });

  it("tells the caller only that the node could not be reached, never where it is", () => {
    // What the SDK throws when the request never gets there: its own message holds the node's URL, address and port.
    const unreachable = new CustomError(
      "Error: request to http://10.1.2.3:8545/ failed, reason: connect ECONNREFUSED 10.1.2.3:8545",
      SdkErrorCode.NETWORK_ERROR,
    );
    const failure = nodeFailure("net.Peers", unreachable);
    expect(failure.code).toBe("RPC_ERROR");
    expect(failure.message).toBe("net.Peers: the node could not be reached.");
  });

  it("cuts a long message from the node, such as an HTML error page, at 300 characters", () => {
    const failure = nodeFailure("net.Peers", new Error(`<html>${"x".repeat(5000)}</html>`));
    expect(failure.code).toBe("RPC_ERROR");
    expect(failure.message.length).toBe("net.Peers: ".length + 300);
  });
});

describe("a node that is slow to answer", () => {
  it("is given up on after the timeout as REQUEST_TIMEOUT, and a failure that comes later is not left unhandled", async () => {
    let failLater: (reason: Error) => void = () => undefined;
    const never = new Promise<string>((_, reject) => {
      failLater = reject;
    });
    await expect(withTimeout(never, 20, "net.Peers")).rejects.toMatchObject({ code: ErrorCode.REQUEST_TIMEOUT });
    // The SDK cannot cancel its request, so it can fail after the tool has given up. Nobody is waiting, and vitest fails the run on
    // an unhandled rejection, so this proves a late failure leaves none behind.
    failLater(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(withTimeout(Promise.resolve(7), 1000, "net.Peers")).resolves.toBe(7);
  });

  it("answers REQUEST_TIMEOUT through the tool, naming the method and nothing about the node", async () => {
    node.on("net.Version", () => new Promise((resolve) => setTimeout(() => resolve("0.13.0"), 400)));
    // The gateway's own server waits 20 seconds; this one is the same loop with a 100 ms wait.
    const server = new McpServer({ name: "slow-node", version: "0.0.0" });
    registerRpcTools(server, 100);
    const client = new Client({ name: "slow-node-client", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    const result = (await client.callTool({ name: "moi_rpc_net_version", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("MCP error -32001: [REQUEST_TIMEOUT] net.Version: the node did not answer within 0.1 seconds.");
    expect(node.methods()).toEqual(["net.Version"]);
    await client.close();
    await server.close();
  });
});
