/**
 * measureFuel, withMeasuredFuel and assertAffordable: the fuel measurement and the balance check that moi_deploy_logic and a
 * MASX create share. The existing logic-deploy tests pin that the deploy's own texts did not move; these pin the helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTransfer, DEFAULT_FUEL_LIMIT } from "../../src/moi/ix-builder.js";
import { isMoiError } from "../../src/moi-error.js";
import { assertAffordable, measureFuel, withMeasuredFuel } from "../../src/tools/write-core.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { ACCOUNT, KMOI, RpcFailure, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;

beforeEach(async () => {
  node = await startMockNode();
  applyEnv(node.url, tempHome());
});

afterEach(async () => {
  restoreEnv();
  await node.close();
});

const ix = () => buildTransfer({ id: ACCOUNT, sequence: 5 }, { to: ACCOUNT, assetId: KMOI, amount: 1n });
const cannotEstimate = () =>
  node.on("moi.FuelEstimate", () => {
    throw new RpcFailure("execution reverted");
  });

describe("measureFuel", () => {
  it("gives the node's estimate with headroom, and says it was measured", async () => {
    const measured = await measureFuel(ix());
    expect(measured.estimated).toBe(true);
    expect(measured.ix.fuel_limit).toBe(449); // the mock estimates 299 and the margin is 1.5
    expect(measured.ix.ix_operations).toEqual(ix().ix_operations);
  });

  it("falls back to the ordinary limit when the node cannot estimate and no fallback is given", async () => {
    cannotEstimate();
    expect(await measureFuel(ix())).toMatchObject({ estimated: false, ix: { fuel_limit: DEFAULT_FUEL_LIMIT } });
  });

  it("falls back to the limit it is given when the node cannot estimate, and ignores it when the node can", async () => {
    cannotEstimate();
    expect(await measureFuel(ix(), 2_000_000)).toMatchObject({ estimated: false, ix: { fuel_limit: 2_000_000 } });
    node.reset();
    expect(await measureFuel(ix(), 2_000_000)).toMatchObject({ estimated: true, ix: { fuel_limit: 449 } });
  });

  it("withMeasuredFuel is the same interaction, with the same fallback parameter", async () => {
    expect((await withMeasuredFuel(ix())).fuel_limit).toBe(449);
    cannotEstimate();
    expect((await withMeasuredFuel(ix())).fuel_limit).toBe(DEFAULT_FUEL_LIMIT);
    expect((await withMeasuredFuel(ix(), 2_000_000)).fuel_limit).toBe(2_000_000);
  });
});

describe("assertAffordable", () => {
  it("passes at exactly the fund plus the fee, and refuses one base unit short, with the numbers and the words it is given", () => {
    expect(() => assertAffordable(10_000_022_450n, 10_000_000_000n, 22_450n, "Creating a MASX asset")).not.toThrow();
    let error: unknown;
    try {
      assertAffordable(10_000_022_449n, 10_000_000_000n, 22_450n, "Creating a MASX asset");
    } catch (err) {
      error = err;
    }
    expect(isMoiError(error)).toBe(true);
    const e = error as { code: string; message: string; data?: unknown };
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.message).toBe(
      "Creating a MASX asset moves 10000000000 base units of KMOI (10 KMOI) into it, and the chain holds back the whole fuel limit, up to 22450 (0.00002245 KMOI), " +
        "until the interaction is done, but this account holds 10000022449 (10.000022449 KMOI). Fund the account from the faucet. Nothing was sent to your wallet.",
    );
    expect(e.data).toEqual({ balance: "10000022449", needed: "10000022450" });
  });

  it("begins its sentence with whatever it is told: a deploy and a create each say their own", () => {
    for (const what of ["Deploying a logic", "Creating a MAS1 asset"]) {
      expect(() => assertAffordable(0n, 1n, 1n, what)).toThrow(new RegExp(`^${what} moves 1 base units of KMOI`));
    }
  });
});
