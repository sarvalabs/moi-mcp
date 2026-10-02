/**
 * Reading a deploy's receipt, and what moi_deploy_logic tells the model once the interaction is broadcast. The reader fails
 * closed: a new logic's id is reported only from a receipt that is exactly a clean deploy, and every other shape is a
 * failure, an unsure outcome or no receipt, never a guess. Pure: no node (the receipt reader is handed a fake provider).
 */

import { describe, expect, it } from "vitest";

import { deployResult, outcomeOf, readDeployOutcome, type DeployOutcome } from "../../src/capabilities/logics/deploy-receipt.js";
import { encodeException } from "../helpers/asset-fixtures.js";
import { deployReceipt } from "../helpers/logic-fixtures.js";
import { LOGIC, SENT_HASH } from "../helpers/mock-node.js";

const ID = LOGIC;
const ID2 = `0x20${"cd".repeat(31)}`;

describe("outcomeOf: a clean deploy", () => {
  it("finds the id on the operation of type LOGIC_DEPLOY, whatever form the type and the statuses come in", () => {
    for (const tx_type of ["0xb", 11, "11", 11n]) {
      for (const status of [0, "0x0", "0", 0n]) {
        const receipt = { status, ix_operations: [{ tx_type: "0x5", status: 0, data: {} }, { tx_type, status, data: { logic_id: ID, error: "0x" } }] };
        expect(outcomeOf(receipt), `${String(tx_type)} ${String(status)}`).toEqual({ kind: "created", logicId: ID });
      }
    }
    expect(outcomeOf(deployReceipt({ logicId: ID }))).toEqual({ kind: "created", logicId: ID });
  });

  it("accepts the id only when it is the address that was funded, in either case", () => {
    expect(outcomeOf(deployReceipt({ logicId: ID }), ID.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "created", logicId: ID });
    const other = outcomeOf(deployReceipt({ logicId: ID }), ID2);
    expect(other).toMatchObject({ kind: "unsure" });
    expect((other as { why: string }).why).toBe(`The logic id in its receipt (${ID}) is not the address the KMOI was sent to (${ID2}).`);
  });
});

describe("outcomeOf: not a receipt", () => {
  it("is pending for anything that is not an object with a status or an operation list", () => {
    for (const v of [undefined, null, "0x", 0, [], {}, { ix_hash: SENT_HASH }, { from: "0x1" }]) {
      expect(outcomeOf(v), JSON.stringify(v)).toEqual({ kind: "pending" });
    }
  });
});

describe("outcomeOf: a failed interaction", () => {
  it("is failed whenever the receipt's status is a well-formed number other than 0, whatever the operations say", () => {
    expect(outcomeOf(deployReceipt({ status: 1 }))).toEqual({ kind: "failed", status: 1 });
    expect(outcomeOf({ status: "0x2", ix_operations: [] })).toEqual({ kind: "failed", status: 2 });
    expect(outcomeOf({ status: 1 })).toEqual({ kind: "failed", status: 1 });
    // The interaction failed and the deploy operation, which comes first, says nothing of it: still not created.
    expect(outcomeOf(deployReceipt({ status: 1, opStatus: 0, logicId: ID }))).toEqual({ kind: "failed", status: 1 });
  });

  it("carries the reason the chain gave, quoted, when the deploy operation has one", () => {
    const error = encodeException({ class: "runtime", error: "supply must be positive" });
    expect(outcomeOf(deployReceipt({ status: 1, error }))).toEqual({ kind: "failed", status: 1, detail: '"runtime: supply must be positive"' });
  });
});

describe("outcomeOf: a receipt that cannot be trusted says unsure, never created", () => {
  const unsure = (v: unknown) => {
    const o = outcomeOf(v);
    expect(o.kind, JSON.stringify(v)).toBe("unsure");
    return (o as Extract<DeployOutcome, { kind: "unsure" }>).why;
  };
  const ops = [{ tx_type: "0xb", status: 0, data: { logic_id: ID, error: "0x" } }, { tx_type: "0x5", status: 0, data: {} }];

  it("when its status is missing or not a whole number, which the repo's toBigInt would read as 0", () => {
    for (const status of [undefined, "failed", "ok", -1, 1.5, Number.NaN, null, {}, "0xzz", "1.5", true]) {
      expect(unsure({ status, ix_operations: ops }), String(status)).toBe("Its receipt has no readable status.");
    }
  });

  it("when it says the interaction succeeded but an operation failed, the funding transfer included", () => {
    const why = "Its receipt says the interaction succeeded, but one of its operations did not.";
    expect(unsure(deployReceipt({ logicId: ID, fundStatus: 1 }))).toBe(why);
    expect(unsure(deployReceipt({ logicId: ID, opStatus: 3 }))).toBe(why);
  });

  it("when its operations are not listed, or one of them cannot be read", () => {
    expect(unsure({ status: 0 })).toBe("Its receipt does not list its operations.");
    expect(unsure({ status: 0, ix_operations: "none" })).toBe("Its receipt does not list its operations.");
    for (const bad of [null, 5, "x", { status: 0 }, { tx_type: "0xb" }, { tx_type: "0xb", status: "ok" }, { tx_type: "deploy", status: 0 }]) {
      expect(unsure({ status: 0, ix_operations: [...ops, bad] }), JSON.stringify(bad)).toBe("Its receipt lists an operation this server cannot read.");
    }
  });

  it("when it does not list exactly one deploy operation", () => {
    const why = "Its receipt does not list exactly one deploy operation.";
    expect(unsure({ status: 0, ix_operations: [] })).toBe(why);
    expect(unsure({ status: 0, ix_operations: [{ tx_type: "0x5", status: 0, data: {} }] })).toBe(why); // the mock node's default receipt
    expect(unsure({ status: 0, ix_operations: [ops[0], ops[0]] })).toBe(why);
  });

  it("when both statuses are 0 and the deploy operation still carries an error", () => {
    const o = outcomeOf(deployReceipt({ logicId: ID, error: encodeException({ class: "runtime", error: "boom" }) }));
    expect(o).toEqual({ kind: "unsure", why: "Its deploy operation reports an error.", detail: '"runtime: boom"' });
  });

  it("when the id is not 0x and 64 hex characters", () => {
    for (const logicId of ["0x12", "12", `${ID}00`, "0xzz".padEnd(66, "z"), "<script>"]) {
      expect(unsure(deployReceipt({ logicId })), logicId).toBe("Its receipt carries no usable logic id.");
    }
    expect(unsure(deployReceipt())).toBe("Its receipt carries no usable logic id.");
  });
});

describe("readDeployOutcome", () => {
  const provider = (answer: () => unknown) => ({ getInteractionReceipt: async () => answer() });

  it("does not look at all for a wait of 0: the stdio server returns the hash at once", async () => {
    let looks = 0;
    const p = provider(() => (looks++, deployReceipt({ logicId: ID })));
    expect(await readDeployOutcome(p, SENT_HASH, 0)).toEqual({ kind: "pending" });
    expect(looks).toBe(0);
  });

  it("looks at once, and again every poll until the receipt appears", async () => {
    let looks = 0;
    const p = provider(() => {
      if (++looks < 3) throw new Error("not found");
      return deployReceipt({ logicId: ID });
    });
    const slept: number[] = [];
    const found = await readDeployOutcome(p, SENT_HASH, 60_000, ID, { pollMs: 5, sleep: async (ms) => void slept.push(ms) });
    expect(found).toEqual({ kind: "created", logicId: ID });
    expect(looks).toBe(3);
    expect(slept).toEqual([5, 5]);
  });

  it("returns a failed or unsure receipt as soon as it is there, without waiting for a better one", async () => {
    let looks = 0;
    expect(await readDeployOutcome(provider(() => (looks++, deployReceipt({ status: 1 }))), SENT_HASH, 60_000, undefined, { pollMs: 5 })).toEqual({ kind: "failed", status: 1 });
    expect(await readDeployOutcome(provider(() => (looks++, { status: "?", ix_operations: [] })), SENT_HASH, 60_000, undefined, { pollMs: 5 })).toMatchObject({ kind: "unsure" });
    expect(looks).toBe(2);
  });

  it("gives up as pending when the wait is over, and never takes longer than the wait even when a look hangs", async () => {
    let looks = 0;
    const never = { getInteractionReceipt: () => (looks++, new Promise<never>(() => {})) };
    const started = Date.now();
    // The look's own limit is 10 seconds here; the 60 ms that are left of the wait cut it short.
    expect(await readDeployOutcome(never, SENT_HASH, 60, undefined, { pollMs: 5, lookTimeoutMs: 10_000 })).toEqual({ kind: "pending" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(looks).toBeGreaterThanOrEqual(1);
    const failing = { getInteractionReceipt: async () => { throw new Error("down"); } };
    expect(await readDeployOutcome(failing, SENT_HASH, 20, undefined, { pollMs: 5 })).toEqual({ kind: "pending" });
  });
});

describe("deployResult: what the model is told", () => {
  const sent = { status: "sent", summary: "the preview's sentence", hash: SENT_HASH, explorerUrl: "https://example.test/ix" };

  it("a created logic: deployed yes, with its id, and a summary that says it was deployed", () => {
    const r = deployResult(sent, { kind: "created", logicId: ID });
    expect(r).toEqual({ ...sent, summary: `Deployed a new logic. Its id is ${ID}. 10 KMOI moved into it.`, deployed: "yes", logicId: ID });
  });

  it("a failed receipt: deployed no, the reason quoted, all or nothing said as expected and not as checked, and no retry", () => {
    const r = deployResult(sent, { kind: "failed", status: 1, detail: '"runtime: boom"' }) as Record<string, string>;
    expect(r["deployed"]).toBe("no");
    expect(r["status"]).toBe("sent");
    expect(r["hash"]).toBe(SENT_HASH);
    expect(r["logicId"]).toBeUndefined();
    expect(r["summary"]).not.toMatch(/^Deployed/);
    expect(r["note"]).toMatch(/receipt says the interaction failed \(status 1\): "runtime: boom"\. An interaction is applied all or nothing, so no logic should have been created and the KMOI should not have moved, but this server has not checked\./);
    expect(r["note"]).toMatch(/moi_get_interaction with the hash shows the whole receipt\. Do not call moi_deploy_logic again for this manifest until the receipt has been read: a second call would create a second logic and move another 10 KMOI\.$/);
  });

  it("an unsure receipt: deployed unknown, the reason, and that the KMOI may have moved", () => {
    const r = deployResult(sent, { kind: "unsure", why: "Its receipt carries no usable logic id." }) as Record<string, string>;
    expect(r["deployed"]).toBe("unknown");
    expect(r["logicId"]).toBeUndefined();
    expect(r["summary"]).toBe("The interaction was broadcast, and it is not known whether a logic was created.");
    expect(r["note"]).toMatch(/cannot say a logic exists\. Its receipt carries no usable logic id\. The 10 KMOI may have moved\./);
    expect(r["note"]).toMatch(/Do not call moi_deploy_logic again/);
  });

  it("no receipt: deployed unknown, and how to read the id from the interaction", () => {
    const r = deployResult(sent, { kind: "pending" }) as Record<string, string>;
    expect(r["deployed"]).toBe("unknown");
    expect(r["note"]).toMatch(/No receipt was read before this returned.*moi_get_interaction with this hash.*LOGIC_DEPLOY, tx_type 0xb.*data\.logic_id/);
    expect(r["note"]).toMatch(/Do not call moi_deploy_logic again/);
  });
});
