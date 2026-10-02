/**
 * moi_asset_invoke on a routine that only reads: no wallet, no preview, no journal, and an answer that is refused rather
 * than guessed when the node's reply is not whole. moi.Call is faked here; the read path has run against this mock and
 * not against a node (src/capabilities/assets/execute.ts says so).
 */

import { hexToBytes } from "js-moi-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MASX_MANIFEST,
  PIXEL,
  callReceipt,
  encodeException,
  encodeOutputs,
  type PoloField,
} from "../helpers/asset-fixtures.js";
import { fakeHub, fakeJournal, fakeStore, connect, deps, structured } from "../helpers/hosted.js";
import {
  fakeWallet,
  installWallet,
  journalLines,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";
import { ACCOUNT, MASX_ASSET, OTHER, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet); // present, but never paired: a read must not need it
});

afterEach(async () => {
  await h.close();
  await node.close();
});

const integer: PoloField = { kind: "integer" };
const balance = (n: number | bigint) => encodeOutputs({ balance: integer }, { balance: n });
const read = (routine: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, asset = PIXEL) =>
  h.call("moi_asset_invoke", { assetId: asset, routine, args, ...extra });

describe("a routine that only reads", () => {
  it("answers at once with the decoded outputs, touching neither the wallet nor the journal", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: balance(7) }));
    const result = await read("BalanceOf", { address: ACCOUNT });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      assetId: PIXEL,
      routine: "BalanceOf",
      outputs: { balance: "7" },
      decimals: 0,
      truncated: false,
    });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(wallet.factory).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);

    const methods = node.methods();
    expect(methods).toEqual(expect.arrayContaining(["moi.AssetInfoByAssetID", "moi.LogicManifest", "moi.Call"]));
    for (const never of ["moi.PendingInteractionCount", "moi.FuelEstimate", "moi.SendInteractions"]) {
      expect(methods).not.toContain(never);
    }
  });

  it("asks as the configured read caller, with one ASSET_INVOKE and the SDK's read-path fuel", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: balance(1) }));
    await read("BalanceOf", { address: ACCOUNT });
    const call = node.calls.find((c) => c.method === "moi.Call");
    const ix = call?.params["ix_args"] as {
      sender: { id: string; sequence: number | string; key_id: number | string };
      fuel_price: string | number;
      fuel_limit: string | number;
      ix_operations: Array<{ type: number | string }>;
    };
    expect(ix.sender.id).toBe(ACCOUNT); // MOI_READ_CALLER, which the harness sets
    expect(ix.ix_operations).toHaveLength(1);
    expect(Number(ix.ix_operations[0]!.type)).toBe(5); // ASSET_INVOKE
    expect(BigInt(ix.fuel_limit)).toBe(100000n);
    expect(BigInt(ix.fuel_price)).toBe(50n);
  });

  it("reads a routine with no inputs, an identifier output and a balance past 2^63", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: encodeOutputs({ symbol: { kind: "string" } }, { symbol: "PIXEL" }) }));
    expect((await read("Symbol")).structuredContent?.["outputs"]).toEqual({ symbol: "PIXEL" });

    node.on("moi.Call", () => callReceipt({ outputs: encodeOutputs({ creator: { kind: "bytes" } }, { creator: hexToBytes(OTHER) }) }));
    expect((await read("Creator")).structuredContent?.["outputs"]).toEqual({ creator: OTHER });

    node.on("moi.Call", () => callReceipt({ outputs: balance(2n ** 63n) }));
    expect((await read("BalanceOf", { address: ACCOUNT })).structuredContent?.["outputs"]).toEqual({ balance: "9223372036854775808" });
  });

  it("scales nothing: an amount comes back in base units, with the asset's decimals beside it", async () => {
    node.on("moi.AssetInfoByAssetID", () => ({ symbol: "NINE", decimals: "0x9", dimension: "0x0", max_supply: "0x1" }));
    node.on("moi.Call", () => callReceipt({ outputs: balance(1_500_000_000) }));
    const result = await read("BalanceOf", { address: ACCOUNT });
    expect(result.structuredContent).toMatchObject({ outputs: { balance: "1500000000" }, decimals: 9 });
  });

  it("refuses participants on a read, and ignores a confirm token", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: balance(3) }));
    const bad = await read("BalanceOf", { address: ACCOUNT }, { participants: [] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^\[INVALID_ARGS\] /);
    expect(bad.text).toMatch(/only reads, so it takes no participants/);

    const withConfirm = await read("BalanceOf", { address: ACCOUNT }, { confirm: "anything" });
    expect(withConfirm.isError).toBeFalsy();
    expect(withConfirm.structuredContent?.["outputs"]).toEqual({ balance: "3" });
  });

  it("cuts a long text and a long list in the answer, says so, and still returns one JSON document", async () => {
    node.on("moi.LogicManifest", () => `0x${Buffer.from(JSON.stringify(MASX_MANIFEST)).toString("hex")}`);
    node.on("moi.Call", () => callReceipt({ outputs: encodeOutputs({ text: { kind: "string" } }, { text: "x".repeat(5000) }) }));
    const note = await read("Note", {}, {}, MASX_ASSET);
    expect(note.structuredContent).toMatchObject({ truncated: true });
    expect(String((note.structuredContent?.["outputs"] as { text: string }).text)).toHaveLength(1025);
    expect(() => JSON.parse(note.text)).not.toThrow();

    const tags = Array.from({ length: 300 }, (_, i) => `t${i}`);
    node.on(
      "moi.Call",
      () => callReceipt({ outputs: encodeOutputs({ tags: { kind: "array", fields: { values: { kind: "string" } } } }, { tags }) }),
    );
    const list = await read("Tags", {}, {}, MASX_ASSET);
    expect(list.structuredContent).toMatchObject({ truncated: true });
    expect((list.structuredContent?.["outputs"] as { tags: string[] }).tags).toHaveLength(100);
  });
});

describe("a read fails closed", () => {
  const refused = (result: { isError?: boolean; text: string }, pattern: RegExp) => {
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[RPC_ERROR\] /);
    expect(result.text).toMatch(pattern);
  };

  it("when the receipt carries no status", async () => {
    node.on("moi.Call", () => ({ fuel_used: "0x1", ix_operations: [{ data: { outputs: balance(7), error: "0x" } }] }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /no readable status/);
  });

  it("when there is no operation in the receipt", async () => {
    node.on("moi.Call", () => ({ status: 0 }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /no result/);
    node.on("moi.Call", () => ({ status: 0, ix_operations: [] }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /no result/);
  });

  it("when a routine that declares outputs returns none", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: "0x" }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /returned no outputs although its manifest says it returns balance/);
  });

  it("when the outputs do not decode", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: "0xdeadbeef" }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /Could not decode the outputs of BalanceOf/);
  });

  it("when the node reports a failure, quoting its reason as data", async () => {
    node.on("moi.Call", () => callReceipt({ status: 1, error: encodeException({ class: "builtin.AssetError", error: "boom" }) }));
    const result = await read("BalanceOf", { address: ACCOUNT });
    refused(result, /BalanceOf on 0x[0-9a-f]+ failed: "builtin\.AssetError: boom"/);
  });

  it("when the receipt status is not zero and the node gave no reason", async () => {
    node.on("moi.Call", () => callReceipt({ status: 3 }));
    refused(await read("BalanceOf", { address: ACCOUNT }), /failed: "receipt status 3"/);
  });

  it("when the node does not know the placeholder caller, with the hint the registry reads give", async () => {
    node.on("moi.Call", () => {
      throw new RpcFailure("failed to fetch acc meta info: account not found");
    });
    refused(await read("BalanceOf", { address: ACCOUNT }), /rejected MOI_READ_CALLER/);
  });

  it("when the node itself fails", async () => {
    node.on("moi.Call", () => {
      throw new RpcFailure("node on fire");
    });
    refused(await read("BalanceOf", { address: ACCOUNT }), /moi\.Call\(BalanceOf on 0x[0-9a-f]+\): .*node on fire/);
  });
});

describe("on the hosted server", () => {
  it("a read needs no wallet session: the store, the hub and the journal are never touched", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: balance(11) }));
    const store = fakeStore(new Map());
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal));
    try {
      const result = await client.callTool({
        name: "moi_asset_invoke",
        arguments: { assetId: PIXEL, routine: "BalanceOf", args: { address: ACCOUNT } },
      });
      expect(result.isError).toBeFalsy();
      expect(structured(result)).toMatchObject({ outputs: { balance: "11" } });
      expect(store.get).not.toHaveBeenCalled();
      expect(hub.signInteractionFor).not.toHaveBeenCalled();
      expect(journal.append).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
