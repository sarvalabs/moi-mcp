/**
 * What a refused write says after the node's own reason. A dry run that the node refuses with no reason of its own says so
 * (src/moi/ix-builder.ts), and a refused moi_call_logic invoke adds the hint about `payer Logic` (src/capabilities/logics/invoke.ts).
 * Set up as tools-writes.test.ts is: the real handlers, with the node and the phone faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareLogicCall, prepareLogicInvoke } from "../../src/capabilities/logics/invoke.js";
import { ACCOUNT, KMOI, LOGIC, OTHER, startMockNode, type MockNode } from "../helpers/mock-node.js";
import { fakeWallet, installWallet, seedSession, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

describe("a refusal with no reason from the node", () => {
  it("receipt status 1 with every operation at status 0 and no error → says the node gave no reason, not op status", async () => {
    seedSession(h.home);
    node.on("moi.Call", () => ({
      status: 1,
      fuel_used: "0x12b",
      ix_operations: [{ tx_type: "0x5", status: 0, data: { outputs: "0x", error: "0x" } }],
    }));

    const result = await h.call("moi_transfer", { to: OTHER, assetId: KMOI, amount: "10" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /\(receipt status 1\): the node gave no reason, and no operation in its receipt carries an error/,
    );
    expect(result.text).not.toMatch(/op status/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });
});

describe("moi_call_logic refusal hint", () => {
  it("kind:'invoke' that the node says would fail is refused before the phone, with the payer Logic hint", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;

    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "invoke" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/payer Logic/);
    expect(result.text).toMatch(/storage grant/);
    expect(result.text).toMatch(/participants/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).toContain("moi.Call");
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("does not say that no call to the routine can succeed: a caller with a storage grant might", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;

    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "invoke" });

    expect(result.text).not.toMatch(/can succeed/);
    // What it does say: the fix for a logic deployed without `payer Logic` is in the source, conditional on that being the cause.
    expect(result.text).toMatch(/If the logic was deployed without `payer Logic` on its writes, the fix is in the Cocolang source/);
    expect(result.text).toMatch(/add `payer Logic` to each mutate clause, compile it again and deploy a new logic/);
  });

  it("kind:'invoke' that succeeds in simulation carries no hint", async () => {
    seedSession(h.home);
    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "invoke" });
    expect(result.structuredContent).toMatchObject({ status: "preview" });
    expect(result.text).not.toMatch(/payer Logic/);
  });

  it("the registry path does not carry the payer hint", async () => {
    // Both end in the same simulation. The registry logic declares its payer, so for its writes the hint would name the wrong cause.
    node.state.callStatus = 1;
    const call = { logicId: LOGIC, routine: "Ping", args: [] };
    const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a refusal");
    };

    const viaRegistry = await refusalOf(() => prepareLogicInvoke(ACCOUNT, call));
    expect(viaRegistry).toMatch(/would fail/);
    expect(viaRegistry).not.toMatch(/payer Logic/);

    const viaCall = await refusalOf(() => prepareLogicCall(ACCOUNT, call));
    expect(viaCall).toMatch(/would fail/);
    expect(viaCall).toMatch(/payer Logic/);
  });
});
