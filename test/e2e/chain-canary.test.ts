/**
 * The chain canary: does the live voyage devnet still accept what this server
 * builds?
 *
 * The September 2026 chain upgrade broke asset creation here for about a
 * week before anyone noticed. It changed three things under an unchanged
 * codebase: KMOI's asset id, a validation rule on participants, and the
 * meaning of an asset's `dimension`. Each check below would have failed the
 * first night. Unit tests cannot catch this class of break: they run against
 * a mock node that only ever changes when we change it.
 *
 * Every check SIMULATES. Nothing is signed or broadcast, no fuel is spent,
 * and the account used is read, never controlled. A rejected simulation is a
 * throw from the node or SDK; an interaction that validates but would revert
 * returns a receipt, and that is a pass here, because the canary asks whether
 * the chain still accepts our interaction's shape.
 *
 *   MOI_E2E=1 npx vitest run test/e2e/chain-canary.test.ts
 */

import { AssetStandard, KMOI_ASSET_ID } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  buildCreateAsset,
  buildTransfer,
  chooseStorageFund,
  MEASURED_STORAGE_FLOOR,
  MIN_STORAGE_FUND,
} from "../../src/moi/ix-builder.js";
import { getProvider } from "../../src/moi/provider.js";
import { getAsset } from "../../src/moi/reads.js";

const live = process.env["MOI_E2E"] === "1";
const d = live ? describe : describe.skip;

/**
 * An existing, funded devnet account whose address is public: KMOI's
 * creator. Used only as the sender of simulations, so its state is read and
 * never changed. Override with MOI_CANARY_ACCOUNT if it ever stops existing.
 */
const ACCOUNT =
  process.env["MOI_CANARY_ACCOUNT"] ?? "0x000000005dfd3e93ae09bea907f0d6db965ddfe84d09dfdf868e4e6800000000";

const TIMEOUT = 60_000;

/**
 * What moi.StoragePricing answered on 2 October 2026, as the raw strings the node sent. They are compared as strings
 * and never parsed, so a change of format fails the same way a change of value does. MEASURED_STORAGE_FLOOR in
 * src/moi/ix-builder.ts is read as the floor under this pricing, so the two change together, in one commit, after a
 * re-measure.
 */
const PRICING_WHEN_FLOOR_MEASURED = {
  storage_price_per_byte: "0xf4240",
  storage_multiplier: "0x1",
  anu_per_byte: "0xf4240",
};

/** Ends every failure message of the three storage checks below. */
const REMEASURE = "Re-measure the floor: the comment above MEASURED_STORAGE_FLOOR in src/moi/ix-builder.ts says how.";

d("chain canary (voyage devnet)", () => {
  const provider = getProvider({ network: "voyage" });

  async function sender() {
    const p = provider as unknown as { getPendingInteractionCount: (id: string, key: number) => Promise<number> };
    return { id: ACCOUNT, sequence: Number(await p.getPendingInteractionCount(ACCOUNT, 0)), keyId: 0 };
  }

  /**
   * Receipt status from simulating: 0 means the interaction would succeed.
   * Checking the status, not merely that the node accepted the shape, is what
   * catches a default that has drifted. An underfunded create is accepted and
   * comes back status 1, which an earlier version of this canary read as a
   * pass while asset creation was broken in production.
   */
  async function simulateStatus(ix: unknown): Promise<number> {
    const call = (provider as unknown as { call: (ix: unknown) => Promise<{ receipt?: { status?: number } }> }).call;
    const r = await call.call(provider, ix);
    return Number(r?.receipt?.status ?? -1);
  }

  /** KMOI the canary account holds, in base units. */
  async function balance(): Promise<bigint> {
    const p = provider as unknown as { getTDU: (id: string) => Promise<Array<{ asset_id: string; amount: string }>> };
    const held = (await p.getTDU(ACCOUNT)).find(
      (b) => String(b.asset_id).toLowerCase() === String(KMOI_ASSET_ID).toLowerCase(),
    );
    return BigInt(held?.amount ?? 0);
  }

  it("the RPC endpoint answers", async () => {
    expect(await provider.getSyncStatus()).toBeDefined();
  }, TIMEOUT);

  it("KMOI exists at the id this SDK carries", async () => {
    // The upgrade moved KMOI's id; an SDK with the old constant reads an
    // asset that no longer exists and reports every balance as 0.
    const asset = await getAsset(provider, KMOI_ASSET_ID as string);
    expect(asset.symbol).toBe("KMOI");
  }, TIMEOUT);

  it("every asset standard the chain reports is one this SDK can name", async () => {
    // An unnamed standard shows as UNKNOWN(<code>): the chain grew a standard
    // this SDK version predates, which is what KMOI becoming MASN looked like.
    const asset = await getAsset(provider, KMOI_ASSET_ID as string);
    expect(asset.standard).not.toMatch(/^UNKNOWN/);
    expect(Object.values(AssetStandard)).toContain(asset.standard);
  }, TIMEOUT);

  it("the chain reports decimals, and amounts scale by them", async () => {
    // Amounts used to scale by `dimension`. The upgrade split that field in
    // two, and reading the wrong one scaled every KMOI amount by 1e9.
    const asset = await getAsset(provider, KMOI_ASSET_ID as string);
    expect(typeof asset.decimals).toBe("number");
    expect([0, 1]).toContain(asset.dimension);
  }, TIMEOUT);

  it("the storage fund this server picks still creates an asset", async () => {
    // The automatic fund, exactly as moi_create_asset would choose it. When
    // the chain repriced storage, the old default became a ten-thousandth of
    // the floor and every create failed; this is that class of break.
    const ix = buildCreateAsset(await sender(), {
      symbol: "CANARY",
      supply: 1000n,
      decimals: 0,
      dimension: 0,
      standard: "MAS0",
      isStateful: false,
      isFungible: true,
      storageFund: chooseStorageFund(await balance()),
    });
    expect(await simulateStatus(ix)).toBe(0);
  }, TIMEOUT);

  it("the floor is still enough to create an asset", async () => {
    const ix = buildCreateAsset(await sender(), {
      symbol: "CANARYFLOOR",
      supply: 1000n,
      decimals: 0,
      dimension: 0,
      standard: "MAS0",
      isStateful: false,
      isFungible: true,
      storageFund: MIN_STORAGE_FUND,
    });
    expect(await simulateStatus(ix)).toBe(0);
  }, TIMEOUT);

  /**
   * A create funded with `storageFund`, shaped like the canary's other creates: MAS0, not stateful, decimals 0. The symbol
   * is the longest the chain takes (12 characters), which has the highest floor.
   */
  async function createFunded(storageFund: bigint) {
    return buildCreateAsset(await sender(), {
      symbol: "CANARYMARGIN",
      supply: 1000n,
      decimals: 0,
      dimension: 0,
      standard: "MAS0",
      isStateful: false,
      isFungible: true,
      storageFund,
    });
  }

  it("a fund 5 percent above the measured floor is still accepted", async () => {
    const fund = (MEASURED_STORAGE_FLOOR * 105n) / 100n;
    expect(
      await simulateStatus(await createFunded(fund)),
      `A dry run funded with ${fund} base units, 5 percent above MEASURED_STORAGE_FLOOR, was refused: the chain's floor has risen. ${REMEASURE}`,
    ).toBe(0);
  }, TIMEOUT);

  it("a fund 10 percent below the measured floor is still refused", async () => {
    // greater than 0, not "not 0": a missing receipt reads as -1 and must not pass.
    const fund = (MEASURED_STORAGE_FLOOR * 90n) / 100n;
    expect(
      await simulateStatus(await createFunded(fund)),
      `A dry run funded with ${fund} base units, 10 percent below MEASURED_STORAGE_FLOOR, was accepted or came back with no receipt: the chain's floor has fallen. ${REMEASURE}`,
    ).toBeGreaterThan(0);
  }, TIMEOUT);

  it("storage is still priced as it was when the floor was measured", async () => {
    // The pricing alone does not give the floor: it has no byte count for an asset account. So this cannot say the
    // floor moved, only that the numbers it was measured under have changed.
    const pricing = await provider.getStoragePricing();
    expect(
      {
        storage_price_per_byte: pricing.storage_price_per_byte,
        storage_multiplier: pricing.storage_multiplier,
        anu_per_byte: pricing.anu_per_byte,
      },
      `moi.StoragePricing no longer answers what it did on 2 October 2026. ${REMEASURE}`,
    ).toEqual(PRICING_WHEN_FLOOR_MEASURED);
  }, TIMEOUT);

  it("the transfer this server builds would succeed", async () => {
    // To itself, so the only account the interaction touches is one known to
    // exist; a transfer to an unknown account fails for an unrelated reason.
    const ix = buildTransfer(await sender(), { to: ACCOUNT, assetId: KMOI_ASSET_ID as string, amount: 1n });
    expect(await simulateStatus(ix)).toBe(0);
  }, TIMEOUT);
});
