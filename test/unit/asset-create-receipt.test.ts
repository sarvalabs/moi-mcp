/**
 * Reading an asset create's receipt, and what moi_create_asset tells the model once the interaction is broadcast. The reader
 * is the deploy's strict one (readReceipt) pointed at ASSET_CREATE and asset_id: a new asset's id is reported only from a
 * receipt that is exactly a clean create whose id is the address the funding paid, and every other shape is a failure, an
 * unsure outcome or no receipt, never a guess. Pure: no node (the receipt reader is handed a fake provider).
 */

import { describe, expect, it } from "vitest";

import {
  createOutcomeOf,
  createResult,
  readCreateOutcome,
  type CreateOutcome,
} from "../../src/capabilities/assets/create-receipt.js";
import { encodeException } from "../helpers/asset-fixtures.js";
import { createReceipt, predictedAssetId } from "../helpers/asset-create-fixtures.js";
import { importGraph } from "../helpers/import-graph.js";
import { SENT_HASH } from "../helpers/mock-node.js";

const ID = predictedAssetId("MAS1");
const ID2 = `0x10${"cd".repeat(31)}`;

describe("createOutcomeOf: a clean create", () => {
  it("finds the id on the operation of type ASSET_CREATE, whatever form the type and the statuses come in", () => {
    for (const tx_type of ["0x4", 4, "4", 4n]) {
      for (const status of [0, "0x0", "0", 0n]) {
        const receipt = { status, ix_operations: [{ tx_type, status, data: { asset_id: ID, error: "0x" } }, { tx_type: "0x5", status: 0, data: {} }] };
        expect(createOutcomeOf(receipt), `${String(tx_type)} ${String(status)}`).toEqual({ kind: "created", assetId: ID });
      }
    }
    expect(createOutcomeOf(createReceipt({ assetId: ID }))).toEqual({ kind: "created", assetId: ID });
  });

  it("accepts the id only when it is the address that was funded, in either letter case, and never reports the predicted id by itself", () => {
    expect(createOutcomeOf(createReceipt({ assetId: ID }), ID.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "created", assetId: ID });
    const other = createOutcomeOf(createReceipt({ assetId: ID }), ID2);
    expect(other).toMatchObject({ kind: "unsure" });
    expect((other as { why: string }).why).toBe(`The asset id in its receipt (${ID}) is not the address the KMOI was sent to (${ID2}).`);
    // A receipt with no id says so, whatever was predicted.
    expect(createOutcomeOf(createReceipt(), ID)).toEqual({ kind: "unsure", why: "Its receipt carries no usable asset id." });
  });
});

describe("createOutcomeOf: a failed interaction", () => {
  it("is failed whenever the status is a well-formed number other than 0, with the chain's reason when the create operation gave one", () => {
    expect(createOutcomeOf(createReceipt({ status: 1 }))).toEqual({ kind: "failed", status: 1 });
    expect(createOutcomeOf({ status: "0x2", ix_operations: [] })).toEqual({ kind: "failed", status: 2 });
    expect(createOutcomeOf(createReceipt({ status: 1, opStatus: 0, assetId: ID }))).toEqual({ kind: "failed", status: 1 });
    const error = encodeException({ class: "runtime", error: "supply must be positive" });
    expect(createOutcomeOf(createReceipt({ status: 1, error }))).toEqual({ kind: "failed", status: 1, detail: '"runtime: supply must be positive"' });
  });
});

describe("createOutcomeOf: a receipt that cannot be trusted says unsure, never created", () => {
  const unsure = (v: unknown) => {
    const o = createOutcomeOf(v);
    expect(o.kind, JSON.stringify(v)).toBe("unsure");
    return o as Extract<CreateOutcome, { kind: "unsure" }>;
  };
  const create = { tx_type: "0x4", status: 0, data: { asset_id: ID, error: "0x" } };

  it("with no create operation (a deploy's, or the mock node's default receipt), with two, or with no operations list", () => {
    const why = "Its receipt does not list exactly one create operation.";
    expect(unsure({ status: 0, ix_operations: [{ tx_type: "0x5", status: 0, data: {} }] }).why).toBe(why);
    expect(unsure({ status: 0, ix_operations: [{ tx_type: "0xb", status: 0, data: { logic_id: ID, error: "0x" } }] }).why).toBe(why);
    expect(unsure({ status: 0, ix_operations: [create, create] }).why).toBe(why);
    expect(unsure({ status: 0 }).why).toBe("Its receipt does not list its operations.");
  });

  it("with an operation error under a status of 0, with a bad id, and with an operation that failed under a status of 0", () => {
    expect(unsure(createReceipt({ assetId: ID, error: encodeException({ class: "runtime", error: "boom" }) }))).toMatchObject({
      why: "Its create operation reports an error.",
      detail: '"runtime: boom"',
    });
    for (const assetId of ["0x12", "12", `${ID}00`, "<script>"]) expect(unsure(createReceipt({ assetId })).why, assetId).toBe("Its receipt carries no usable asset id.");
    expect(unsure(createReceipt({ assetId: ID, fundStatus: 1 })).why).toBe("Its receipt says the interaction succeeded, but one of its operations did not.");
    expect(unsure(createReceipt({ assetId: ID, opStatus: 1 })).why).toBe("Its receipt says the interaction succeeded, but one of its operations did not.");
  });

  it("and none of them reports an id", () => {
    for (const r of [createReceipt(), { status: 0, ix_operations: [] }, { status: "?", ix_operations: [create] }]) {
      expect(JSON.stringify(createOutcomeOf(r))).not.toContain(ID);
    }
  });
});

describe("createOutcomeOf: not a receipt", () => {
  it("is pending for anything that is not an object with a status or an operation list", () => {
    for (const v of [undefined, null, "0x", 0, [], {}, { ix_hash: SENT_HASH }, { from: "0x1" }]) {
      expect(createOutcomeOf(v), JSON.stringify(v)).toEqual({ kind: "pending" });
    }
  });
});

describe("readCreateOutcome", () => {
  const provider = (answer: () => unknown) => ({ getInteractionReceipt: async () => answer() });

  it("does not look at all for a wait of 0: the stdio server returns the hash at once", async () => {
    let looks = 0;
    expect(await readCreateOutcome(provider(() => (looks++, createReceipt({ assetId: ID }))), SENT_HASH, 0)).toEqual({ kind: "pending" });
    expect(looks).toBe(0);
  });

  it("looks at once and again every poll until the receipt appears, and reads a node that errors as no receipt yet", async () => {
    let looks = 0;
    const p = provider(() => {
      if (++looks < 3) throw new Error("not found");
      return createReceipt({ assetId: ID });
    });
    const slept: number[] = [];
    expect(await readCreateOutcome(p, SENT_HASH, 60_000, ID, { pollMs: 5, sleep: async (ms) => void slept.push(ms) })).toEqual({ kind: "created", assetId: ID });
    expect(looks).toBe(3);
    expect(slept).toEqual([5, 5]);
  });

  it("gives up as pending when the wait is over, and never takes longer than the wait even when a look hangs", async () => {
    const never = { getInteractionReceipt: () => new Promise<never>(() => {}) };
    const started = Date.now();
    expect(await readCreateOutcome(never, SENT_HASH, 60, undefined, { pollMs: 5, lookTimeoutMs: 10_000 })).toEqual({ kind: "pending" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("createResult: what the model is told", () => {
  const sent = { status: "sent", summary: "the preview's sentence", hash: SENT_HASH, explorerUrl: "https://example.test/ix" };
  const info = { symbol: "NFTA", standard: "MAS1", fund: 10_000_000_000n };
  const RETRY = "Do not call moi_create_asset again for this asset until the receipt has been read: a second call would create a second asset and move another 10 KMOI.";
  const LOOK = "moi_get_interaction with the hash shows the whole receipt.";

  it("a created asset: created yes, with its id, and a summary that says it was created", () => {
    const r = createResult(sent, { kind: "created", assetId: ID }, info);
    expect(r).toEqual({
      ...sent,
      summary: `Created asset NFTA (MAS1). Its id is ${ID}. 10 KMOI moved into it to pay for its storage.`,
      created: "yes",
      assetId: ID,
    });
  });

  it("a failed receipt: created no, the reason quoted, all or nothing said as expected and not as checked, and the retry rule", () => {
    const r = createResult(sent, { kind: "failed", status: 1, detail: '"runtime: boom"' }, info) as Record<string, string>;
    expect(r["created"]).toBe("no");
    expect(r["status"]).toBe("sent");
    expect(r["assetId"]).toBeUndefined();
    expect(r["summary"]).toBe("The interaction was broadcast and included, but its receipt says it failed, so the asset should not exist.");
    expect(r["note"]).toBe(
      'The receipt says the interaction failed (status 1): "runtime: boom". An interaction is applied all or nothing, so no asset should have been created and the KMOI ' +
        `should not have moved, but this server has not checked. The fuel was still charged. ${LOOK} ${RETRY}`,
    );
  });

  it("an unsure receipt: created unknown, the reason, and that the KMOI may have moved", () => {
    const r = createResult(sent, { kind: "unsure", why: "Its receipt carries no usable asset id." }, info) as Record<string, string>;
    expect(r["created"]).toBe("unknown");
    expect(r["assetId"]).toBeUndefined();
    expect(r["summary"]).toBe("The interaction was broadcast, and it is not known whether an asset was created.");
    expect(r["note"]).toBe(`The interaction was included, but this server cannot say an asset exists. Its receipt carries no usable asset id. The 10 KMOI may have moved. ${LOOK} ${RETRY}`);
  });

  it("no receipt: created unknown, and how to read the id from the interaction", () => {
    const r = createResult(sent, { kind: "pending" }, info) as Record<string, string>;
    expect(r["created"]).toBe("unknown");
    expect(r["note"]).toMatch(/No receipt was read before this returned.*moi_get_interaction with this hash.*ASSET_CREATE, tx_type 0x4.*data\.asset_id/);
    expect(r["note"]).toMatch(/Do not call moi_create_asset again/);
  });

  it("the id appears only when the asset was created, and the retry rule is in every note but that one", () => {
    const outcomes: CreateOutcome[] = [{ kind: "failed", status: 1 }, { kind: "unsure", why: "x" }, { kind: "pending" }];
    for (const o of outcomes) {
      const r = createResult(sent, o, info) as Record<string, string>;
      expect(r["assetId"]).toBeUndefined();
      expect(r["note"]).toContain(RETRY);
    }
    expect((createResult(sent, { kind: "created", assetId: ID }, info) as Record<string, string>)["note"]).toBeUndefined();
  });

  it("names the fund that was previewed, not a fixed figure", () => {
    expect(createResult(sent, { kind: "pending" }, { ...info, fund: 7_000_000_000n }).note).toContain("move another 7 KMOI.");
  });
});

describe("this file stays pure", () => {
  it("create-receipt.ts reaches nothing under src/tools, src/wc or the journal", () => {
    const graph = importGraph("src/capabilities/assets/create-receipt.ts");
    expect(graph.files).toContain("src/capabilities/logics/deploy-receipt.ts");
    const reached = graph.files.filter((f) => f.startsWith("src/tools/") || f.startsWith("src/wc/") || f === "src/journal.ts");
    expect(reached.map((name) => graph.chain(name).join(" -> "))).toEqual([]);
  });
});
