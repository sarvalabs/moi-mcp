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

import { buildCreateAsset, buildTransfer } from "../../src/moi/ix-builder.js";
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

d("chain canary (voyage devnet)", () => {
  const provider = getProvider({ network: "voyage" });

  async function sender() {
    const p = provider as unknown as { getPendingInteractionCount: (id: string, key: number) => Promise<number> };
    return { id: ACCOUNT, sequence: Number(await p.getPendingInteractionCount(ACCOUNT, 0)), keyId: 0 };
  }

  /** Resolves when the chain accepts the shape, rejects with its reason when not. */
  async function simulate(ix: unknown): Promise<void> {
    await (provider as unknown as { call: (ix: unknown) => Promise<unknown> }).call(ix);
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

  it("accepts the asset-create interaction this server builds", async () => {
    const ix = buildCreateAsset(await sender(), {
      symbol: "CANARY",
      supply: 1000n,
      decimals: 0,
      dimension: 0,
      standard: "MAS0",
      isStateful: false,
      isFungible: true,
      storageFund: 1000n,
    });
    await expect(simulate(ix)).resolves.toBeUndefined();
  }, TIMEOUT);

  it("accepts the transfer interaction this server builds", async () => {
    // To itself, so the only account the interaction touches is one known to
    // exist; a transfer to an unknown account fails for an unrelated reason.
    const ix = buildTransfer(await sender(), { to: ACCOUNT, assetId: KMOI_ASSET_ID as string, amount: 1n });
    await expect(simulate(ix)).resolves.toBeUndefined();
  }, TIMEOUT);
});
