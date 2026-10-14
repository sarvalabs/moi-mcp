/**
 * A logic view (moi_call_logic with kind "view") that fails because the node cannot find an account says which setting
 * may fix it, as the registry reads and the asset reads do (src/moi/read-caller.ts). moi.Call is faked: the wording is
 * what is under test, not a node.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeWallet, installWallet, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { ACCOUNT, LOGIC, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet); // present, but never paired: a view must not need it
});

afterEach(async () => {
  await h.close();
  await node.close();
});

const NODE_TEXT = "failed to fetch acc meta info: account not found";
const view = () => h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "view" });
const rejectCaller = () =>
  node.on("moi.Call", () => {
    throw new RpcFailure(NODE_TEXT);
  });

describe("a logic view where the node cannot find an account", () => {
  it("names MOI_READ_CALLER and its value when one is set", async () => {
    rejectCaller();
    const result = await view();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code: "RPC_ERROR" });
    expect(result.text).toContain(`MOI_READ_CALLER (${ACCOUNT})`); // the account the harness sets
    expect(result.text).toContain("MOI_READ_CALLER must be set");
    expect(result.text).toContain("an account named in the call's arguments");
    expect(result.text).toContain(NODE_TEXT);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("with MOI_READ_CALLER unset says the placeholder caller is in use and shows no value", async () => {
    process.env["MOI_READ_CALLER"] = ""; // the harness restores it
    rejectCaller();
    const result = await view();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code: "RPC_ERROR" });
    expect(result.text).toContain("placeholder caller");
    expect(result.text).toContain("MOI_READ_CALLER must be set");
    expect(result.text).not.toMatch(/0x[0-9a-f]{8}/);
  });

  it("with MOI_READ_CALLER set to something invalid says it is ignored and does not repeat it", async () => {
    process.env["MOI_READ_CALLER"] = "not-an-id";
    rejectCaller();
    const result = await view();

    expect(result.isError).toBe(true);
    expect(result.text).toContain("placeholder caller");
    expect(result.text).toContain("is set but is not a valid participant id, so it is ignored");
    expect(result.text).not.toContain("not-an-id");
  });
});

describe("any other failure of a logic view", () => {
  it("passes through as before, without naming the setting", async () => {
    node.on("moi.Call", () => {
      throw new RpcFailure("node on fire");
    });
    const result = await view();

    expect(result.isError).toBe(true);
    expect(result.text).toContain("node on fire");
    expect(result.text).not.toContain("MOI_READ_CALLER");
  });

  it("does not relabel a bare 'account not found'", async () => {
    node.on("moi.Call", () => {
      throw new RpcFailure("account not found");
    });
    const result = await view();

    expect(result.isError).toBe(true);
    expect(result.text).toContain("account not found");
    expect(result.text).not.toContain("MOI_READ_CALLER");
  });
});
