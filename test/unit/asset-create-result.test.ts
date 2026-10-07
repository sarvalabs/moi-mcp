/**
 * What moi_create_asset reports once the interaction is broadcast, on the hosted server, which watches for the receipt for a
 * short while (createWaitMs): the new asset's id from a clean receipt, and "unknown" or "no" for every receipt that is not.
 * The strict reader and the five result texts are pinned in asset-create-receipt.test.ts; here they run through the real
 * handler, for each standard, with the node and the phone faked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeException } from "../helpers/asset-fixtures.js";
import { createReceipt, predictedAssetId, TAX_CREATE } from "../helpers/asset-create-fixtures.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, session, structured, TOPIC, USER } from "../helpers/hosted.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { RpcFailure, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;

beforeEach(async () => {
  node = await startMockNode();
  // The harness sets the environment the handlers read; the hosted registration below is the one under test.
  h = await startHarness(node.url);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

const CALLS: Record<string, Record<string, unknown>> = {
  MAS0: { symbol: "TST", supply: "1000", decimals: 2 },
  MAS1: { symbol: "NFTA", standard: "MAS1" },
  MAS2: { symbol: "GOLD", standard: "MAS2", supply: "1000", decimals: 2 },
  MASX: TAX_CREATE,
};
const receiptLooks = () => node.methods().filter((m) => m === "moi.InteractionReceipt").length;

/** A create through the hosted registration with a wait of `waitMs`: the preview, then the confirm. */
async function hostedCreate(args: Record<string, unknown>, waitMs: number) {
  const store = fakeStore(new Map([[USER, session()], ["user-b", session({ userId: "user-b", topic: "topic-b" })]]));
  const hub = fakeHub();
  const journal = fakeJournal();
  const client = await connect(deps(store, hub, journal), undefined, { createWaitMs: waitMs });
  await client.listTools(); // so the client validates the result against the advertised output schema, as a real one does
  const first = await client.callTool({ name: "moi_create_asset", arguments: args });
  const confirm = (structured(first) as { confirm: string }).confirm;
  const started = Date.now();
  const sent = await client.callTool({ name: "moi_create_asset", arguments: { ...args, confirm } });
  return { client, hub, journal, store, first, sent, result: structured(sent) as Record<string, unknown>, tookMs: Date.now() - started };
}

describe("on the hosted server, which watches for the receipt", () => {
  for (const standard of ["MAS0", "MAS1", "MAS2", "MASX"] as const) {
    it(`a clean receipt gives created yes and the new asset's id, for ${standard}`, async () => {
      const id = predictedAssetId(standard);
      node.on("moi.InteractionReceipt", () => createReceipt({ assetId: id }));
      const { client, hub, journal, store, first, result } = await hostedCreate(CALLS[standard]!, 2_000);
      try {
        expect(structured(first)).toMatchObject({ status: "preview" });
        // The user's own pairing: one request to their topic, one journal entry of its kind, no pairing forgotten.
        expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
        expect(hub.signInteractionFor.mock.calls[0]![0]).toBe(TOPIC);
        expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ kind: "create_asset", userId: USER }));
        expect(store.delete).not.toHaveBeenCalled();
        const symbol = String(CALLS[standard]!["symbol"]);
        expect(result).toEqual({
          status: "sent",
          summary: `Created asset ${symbol} (${standard}). Its id is ${id}. 10 KMOI moved into it to pay for its storage.`,
          hash: SENT_HASH,
          explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
          created: "yes",
          assetId: id,
        });
      } finally {
        await client.close();
      }
    });
  }

  it("reports the fund that was previewed, not a fixed figure: an explicit 8 KMOI is 8 KMOI in the summary", async () => {
    node.on("moi.InteractionReceipt", () => createReceipt({ assetId: predictedAssetId("MAS1") }));
    const { client, result } = await hostedCreate({ ...CALLS["MAS1"]!, storageFund: "8000000000" }, 2_000);
    try {
      expect(String(result["summary"])).toMatch(/8 KMOI moved into it/);
    } finally {
      await client.close();
    }
  });

  it("a receipt that says it failed: created no, with the reason the chain gave, the status still sent, and no asset id", async () => {
    node.on("moi.InteractionReceipt", () => createReceipt({ status: 1, error: encodeException({ class: "runtime", error: "supply must be positive" }) }));
    const { client, result } = await hostedCreate(CALLS["MAS2"]!, 2_000);
    try {
      expect(result).toMatchObject({ status: "sent", hash: SENT_HASH, created: "no" });
      expect(result["assetId"]).toBeUndefined();
      expect(String(result["summary"])).not.toMatch(/^Created/);
      expect(String(result["note"])).toMatch(/receipt says the interaction failed \(status 1\): "runtime: supply must be positive"\./);
      expect(String(result["note"])).toMatch(/Do not call moi_create_asset again/);
    } finally {
      await client.close();
    }
  });

  it("a receipt without a create operation, or with another id than the address that was funded, is unknown, and the predicted id is never reported", async () => {
    // The mock's default receipt has one operation, an ASSET_INVOKE.
    const plain = await hostedCreate(CALLS["MAS1"]!, 2_000);
    try {
      expect(plain.result).toMatchObject({ created: "unknown" });
      expect(plain.result["assetId"]).toBeUndefined();
      expect(JSON.stringify(plain.result)).not.toContain(predictedAssetId("MAS1"));
      expect(String(plain.result["note"])).toMatch(/does not list exactly one create operation/);
    } finally {
      await plain.client.close();
    }
    node.on("moi.InteractionReceipt", () => createReceipt({ assetId: `0x10${"ab".repeat(31)}` }));
    const other = await hostedCreate(CALLS["MAS1"]!, 2_000);
    try {
      expect(other.result).toMatchObject({ created: "unknown" });
      expect(other.result["assetId"]).toBeUndefined();
      // The note names the address the KMOI was sent to, as the deploy's does, but nothing calls it the asset's id.
      expect(String(other.result["summary"])).not.toContain(predictedAssetId("MAS1"));
      expect(String(other.result["note"])).toMatch(/is not the address the KMOI was sent to \(0x1003/);
      expect(JSON.stringify(other.result)).not.toMatch(/Its id is/);
    } finally {
      await other.client.close();
    }
  });

  it("a receipt for the id of another standard is not taken for this one", async () => {
    node.on("moi.InteractionReceipt", () => createReceipt({ assetId: predictedAssetId("MAS0") }));
    const { client, result } = await hostedCreate(CALLS["MAS2"]!, 2_000);
    try {
      expect(result).toMatchObject({ created: "unknown" });
      expect(result["assetId"]).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("a receipt that never comes: created unknown after the wait, and no longer, with the hash", async () => {
    node.on("moi.InteractionReceipt", () => {
      throw new RpcFailure("receipt not found");
    });
    const { client, result, tookMs } = await hostedCreate(CALLS["MAS1"]!, 150);
    try {
      expect(result).toMatchObject({ status: "sent", hash: SENT_HASH, created: "unknown" });
      expect(String(result["note"])).toMatch(/No receipt was read before this returned/);
      expect(receiptLooks()).toBeGreaterThanOrEqual(1);
      expect(tookMs).toBeLessThan(3_000);
    } finally {
      await client.close();
    }
  });

  it("a wait of 0 does not look at all", async () => {
    const { client, result } = await hostedCreate(CALLS["MAS0"]!, 0);
    try {
      expect(result).toMatchObject({ status: "sent", created: "unknown" });
      expect(receiptLooks()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("a failed broadcast is not read for a receipt", async () => {
    node.on("moi.SendInteractions", () => {
      throw new Error("ixpool full");
    });
    const { client, result } = await hostedCreate(CALLS["MAS1"]!, 2_000);
    try {
      expect(result["created"]).toBeUndefined();
      expect(receiptLooks()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("advertises created and assetId, which the advertised output schema (additionalProperties false) would otherwise reject", async () => {
    const store = fakeStore(new Map([[USER, session()]]));
    const client = await connect(deps(store, fakeHub(), fakeJournal()), undefined, { createWaitMs: 0 });
    try {
      const { tools } = await client.listTools();
      const create = tools.find((t) => t.name === "moi_create_asset")!;
      const schema = create.outputSchema as { properties: Record<string, { enum?: string[] }> };
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["status", "hash", "explorerUrl", "created", "assetId"]));
      expect(schema.properties["created"]!.enum).toEqual(["yes", "no", "unknown"]);
    } finally {
      await client.close();
    }
  });
});
