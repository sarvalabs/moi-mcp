/**
 * buildLogicDeploy, the builder behind moi_deploy_logic, and predictLogicId, which names the address it funds.
 * In its own file because ix-builder.test.ts is at the 500 line limit.
 *
 * The SDK's LogicFactory is the reference: it bundles a KMOI funding transfer with the LOGIC_DEPLOY operation, and the
 * builder must write what it writes. LogicFactory is run here with an empty object for a signer, which is enough for
 * ixData when the sender is given (the SDK's own tests do the same).
 */

import {
  createParticipantId,
  DEFAULT_STORAGE_FUND,
  deriveLogicId,
  KMOI_ASSET_ID,
  LockType,
  LogicFactory,
  ManifestCoder,
  OpType,
  ParticipantTagV0,
  toInteractionArgs,
} from "js-moi-sdk";
import { Depolorizer } from "js-polo";
import { describe, expect, it } from "vitest";

import { buildLogicDeploy, predictLogicId, toPoloHex, type SenderInfo } from "../../src/moi/ix-builder.js";
import { COUNTER, FLIPPER, LOCK_LEDGER } from "../helpers/logic-fixtures.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };
const OTHER = "0x0000000007070707070707070707070707070707070707070707070700000000";

const manifestHex = (m: unknown) => ManifestCoder.encodeManifest(m as never);

/** The funding transfer's calldata, decoded: who is funded and with how much. */
function funded(calldata: unknown): { beneficiary: string; amount: bigint } {
  const decoded = new Depolorizer(Buffer.from(String(calldata), "hex")).depolorize({
    kind: "struct",
    fields: { beneficiary: { kind: "bytes" }, amount: { kind: "integer" } },
  }) as { beneficiary: Uint8Array; amount: bigint };
  return { beneficiary: `0x${Buffer.from(decoded.beneficiary).toString("hex")}`, amount: BigInt(decoded.amount) };
}

describe("predictLogicId", () => {
  it("is the SDK's derivation for this sender, sequence and key, and changes with the sequence and the key", () => {
    expect(predictLogicId(SENDER)).toBe(deriveLogicId({ id: SENDER.id as `0x${string}`, sequence: 3, key_id: 0 }).toHex());
    expect(predictLogicId({ ...SENDER, sequence: 4 })).not.toBe(predictLogicId(SENDER));
    expect(predictLogicId({ ...SENDER, keyId: 1 })).not.toBe(predictLogicId(SENDER));
    expect(predictLogicId({ id: SENDER.id, sequence: 3 })).toBe(predictLogicId(SENDER)); // no key means key 0
  });
});

describe("buildLogicDeploy", () => {
  const MANIFEST = manifestHex(COUNTER);
  const logicId = predictLogicId(SENDER);

  it("emits the LOGIC_DEPLOY operation first, with the manifest, the callsite and the calldata as given", () => {
    const ix = buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed", calldata: "0x0d2f06" });
    expect(ix.ix_operations).toHaveLength(2);
    expect(ix.ix_operations[0]).toEqual({
      type: OpType.LOGIC_DEPLOY,
      payload: { manifest: MANIFEST, callsite: "Seed", calldata: "0x0d2f06" },
    });
    expect(ix.sender).toEqual({ id: SENDER.id, sequence: 3, key_id: 0 });
  });

  it("leaves calldata out for a routine that takes no inputs", () => {
    expect(buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Init" }).ix_operations[0]!.payload).toEqual({ manifest: MANIFEST, callsite: "Init" });
    expect(buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Init", calldata: "" }).ix_operations[0]!.payload).toEqual({
      manifest: MANIFEST,
      callsite: "Init",
    });
  });

  it("bundles a KMOI transfer of the default fund to the id the deploy will produce, and takes no other amount", () => {
    const ix = buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed" });
    const fund = ix.ix_operations[1]!;
    expect(fund.type).toBe(OpType.ASSET_INVOKE);
    expect(fund.payload["asset_id"]).toBe(KMOI_ASSET_ID);
    expect(fund.payload["callsite"]).toBe("Transfer");
    expect(funded(fund.payload["calldata"])).toEqual({ beneficiary: logicId, amount: BigInt(DEFAULT_STORAGE_FUND) });
    expect(String(fund.payload["calldata"])).not.toMatch(/^0x/);
    // An amount smuggled in with the parameters is not read: nothing in the builder's input names one.
    const smuggled = buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed", storageFund: 99n } as never);
    expect(funded(smuggled.ix_operations[1]!.payload["calldata"]).amount).toBe(BigInt(DEFAULT_STORAGE_FUND));
  });

  it("derives another id for another sequence or key", () => {
    const at = (s: SenderInfo) => funded(buildLogicDeploy(s, { manifest: MANIFEST, callsite: "Seed" }).ix_operations[1]!.payload["calldata"]).beneficiary;
    expect(at(SENDER)).toBe(logicId);
    expect(at({ ...SENDER, sequence: 4 })).not.toBe(logicId);
    expect(at({ ...SENDER, keyId: 1 })).not.toBe(logicId);
  });

  it("declares the caller's participants with their locks, the first spelling of an id and its strongest lock, and never the new logic", () => {
    const ix = buildLogicDeploy(SENDER, {
      manifest: MANIFEST,
      callsite: "Seed",
      participants: [
        { id: OTHER, lock: "none" },
        { id: OTHER.toUpperCase().replace("0X", "0x"), lock: "mutate" },
        { id: OTHER, lock: "read" },
        { id: "0xABCdef", lock: "none" },
      ],
    });
    expect(ix.participants).toEqual([
      { id: OTHER, lock_type: LockType.MUTATE_LOCK },
      { id: "0xABCdef", lock_type: LockType.NO_LOCK },
    ]);
    expect(JSON.stringify(ix.participants).toLowerCase()).not.toContain(logicId.slice(2));
  });

  it("carries no participants key when none are given", () => {
    expect(buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed" })).not.toHaveProperty("participants");
    expect(buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed", participants: [] })).not.toHaveProperty("participants");
  });

  it("POLO-encodes, deterministically, and the SDK adds KMOI as the one participant, locked to mutate", () => {
    const ix = buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed" });
    expect(toPoloHex(ix)).toBe(toPoloHex(buildLogicDeploy(SENDER, { manifest: MANIFEST, callsite: "Seed" })));
    expect((toInteractionArgs(ix as never).participants ?? []).map((p) => [p.id, p.lock_type])).toEqual([[KMOI_ASSET_ID, LockType.MUTATE_LOCK]]);
  });
});

describe("buildLogicDeploy against the SDK's LogicFactory", () => {
  const SDK_SENDER = { id: SENDER.id, sequence: 3, key_id: 0 };

  /** What the SDK builds for the same deploy: its ixData, with the sender fixed and no signer. */
  async function sdkIx(manifest: unknown, routine: string, ...args: unknown[]) {
    const factory = new LogicFactory(manifest as never, {} as never);
    return factory.deploy(routine, ...args).ixData({ sender: SDK_SENDER as never, fuel_limit: 449, fuel_price: 50 });
  }

  const CASES: Array<{ name: string; manifest: unknown; routine: string; args: unknown[]; calldata?: (coder: ManifestCoder) => string | undefined }> = [
    {
      name: "LOCK_LEDGER Seed(name, symbol, supply)",
      manifest: LOCK_LEDGER,
      routine: "Seed",
      // A safe integer goes to the SDK as a number: POLO writes a number compactly and a bigint full-width, and the tool passes the number.
      args: ["MOI Ledger", "MOI", 1000],
      calldata: (coder) => coder.encodeArguments("Seed", "MOI Ledger", "MOI", 1000),
    },
    { name: "FLIPPER Init(), which takes nothing", manifest: FLIPPER, routine: "Init", args: [] },
    { name: "FLIPPER Seed(initial)", manifest: FLIPPER, routine: "Seed", args: [true], calldata: (coder) => coder.encodeArguments("Seed", true) },
  ];

  for (const row of CASES) {
    it(`writes the same interaction as the SDK for ${row.name}`, async () => {
      const sdk = await sdkIx(row.manifest, row.routine, ...row.args);
      const calldata = row.calldata?.(new ManifestCoder(row.manifest as never));
      const ours = buildLogicDeploy(
        SENDER,
        { manifest: manifestHex(row.manifest), callsite: row.routine, ...(calldata ? { calldata } : {}) },
        { fuelLimit: 449, fuelPrice: 50 },
      );

      // The deploy operation is the SDK's, key for key.
      expect(ours.ix_operations[0]).toEqual(sdk.ix_operations[0]);
      // The funding operation is too, except that the repo writes calldata without 0x, as for an asset create.
      const [sdkFund, ourFund] = [sdk.ix_operations[1]!.payload as Record<string, unknown>, ours.ix_operations[1]!.payload];
      expect(ourFund).toEqual({ ...sdkFund, calldata: String(sdkFund["calldata"]).replace(/^0x/, "") });
      // What the node is sent is identical: the processed operations and the participants it derives.
      expect(toInteractionArgs(ours as never)).toEqual(toInteractionArgs(sdk as never));
    });
  }
});
