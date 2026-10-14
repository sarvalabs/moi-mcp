/**
 * What simulate (src/moi/ix-builder.ts) says when the node refuses a dry run and gives no reason. Every operation of such a
 * receipt can be at status 0, and "op status 0" read as success on a refusal, so the detail now says that the node gave no
 * reason. ix-builder.test.ts keeps the older simulate tests, with the two changed on purpose.
 */
import { AssetStandard, createParticipantId, deriveAssetId, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { buildTransfer, simulate, type SenderInfo } from "../../src/moi/ix-builder.js";
import { encodeException } from "../helpers/asset-fixtures.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const recipient = createParticipantId({ fingerprint: new Uint8Array(24).fill(9), variant: 0, tag: ParticipantTagV0 });
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

describe("simulate, when the node refuses and gives no reason", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
  const answering = (response: unknown) => ({ call: async () => response });
  const NO_REASON = "the node gave no reason, and no operation in its receipt carries an error";

  it("does not describe an operation at status 0 with no error as op status 0", async () => {
    const result = await simulate(
      answering({ receipt: { status: 1, ix_operations: [{ status: 0, data: { error: "0x" } }, { status: 0 }] } }),
      ix,
    );
    expect(result).toEqual({ ok: false, status: 1, fuelUsed: undefined, detail: NO_REASON });
    expect(result.detail).not.toMatch(/op status/);
    // An operation that did not fail is not named, so the funding transfer that went through is not blamed.
    expect(result.detail).not.toMatch(/operation \d/);
  });

  it("says the node gave no reason when the receipt has no operations at all", async () => {
    for (const receipt of [{ status: 1 }, { status: 1, ix_operations: [] }]) {
      await expect(simulate(answering({ receipt }), ix)).resolves.toMatchObject({ ok: false, status: 1, detail: NO_REASON });
    }
  });

  it("says it too when the operations cannot be read, so the person is never given an empty reason", async () => {
    for (const ix_operations of ["nope", { 0: 1 }, [null, 5, "x"]]) {
      const result = await simulate(answering({ receipt: { status: 1, ix_operations } }), ix);
      expect(result).toMatchObject({ ok: false, status: 1, detail: NO_REASON });
    }
  });

  it("keeps the node's reason where there is one and says nothing of an operation that did not fail", async () => {
    const error = encodeException({ class: "runtime", error: "supply must be positive" });
    const result = await simulate(
      answering({
        receipt: { status: 1, ix_operations: [{ status: 1, data: { error } }, { status: 0, data: { error: "0x" } }] },
      }),
      ix,
    );
    // The node's text only: one part, with no sentence about the second operation and none about a missing reason.
    expect(result.detail).toContain("supply must be positive");
    expect(result.detail).not.toMatch(/;|no reason|operation/);
  });

  it("names an operation that failed at a status with no reason, by its place in the receipt", async () => {
    const result = await simulate(answering({ receipt: { status: 1, ix_operations: [null, { status: 2 }] } }), ix);
    expect(result.detail).toBe("operation 2 failed with status 2 and the node gave no reason");
  });
});
