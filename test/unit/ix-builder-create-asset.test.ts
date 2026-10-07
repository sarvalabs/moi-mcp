/**
 * buildCreateAsset for MAS0, MAS1, MAS2 and MASX, and predictAssetId, against the SDK's own builders (MAS0AssetLogic.create,
 * MAS1AssetLogic.create, MAS2AssetLogic.create and AssetFactory.create in js-moi-asset). In its own file because
 * ix-builder.test.ts is at the 500 line limit.
 *
 * Each standard is compared with the SDK three ways, because the bytes the phone signs are not the bytes the server holds:
 *   1. the interaction the server holds (a bigint supply) against the SDK built with a bigint;
 *   2. toPoloHex(toWireJson(ix)), the form the phone is asked to sign, against the SDK built with a number, because
 *      toWireJson turns every bigint that fits into a number and POLO writes the two differently in full width;
 *   3. compareSigned, the check that stands between the phone's answer and the broadcast, accepts the SDK's bytes as the
 *      answer for the interaction the server previewed, in the wire form and in the full-width form.
 *
 * The SDK side is given the funding amount as a NUMBER (10000000000, not 10000000000n). The server passes a number wherever
 * the amount fits one (buildTransfer does too), and the SDK writes a bigint amount differently in full width. For MASX the
 * funding option must be `new RoutineOption({ storageFund })`: AssetFactory.create reads the option only when its last
 * argument is a RoutineOption, so a plain { storageFund } object is silently ignored and the funding stays at the default.
 * The MASX tests give a non-default fund and check that it changed the funding, so a test that fell back to the default
 * cannot pass.
 */

import {
  AssetFactory,
  AssetStandard,
  createParticipantId,
  DEFAULT_STORAGE_FUND,
  deriveAssetId,
  KMOI_ASSET_ID,
  ManifestCoder,
  MAS0AssetLogic,
  MAS1AssetLogic,
  MAS2AssetLogic,
  OpType,
  ParticipantTagV0,
  RoutineOption,
} from "js-moi-sdk";
import { Depolorizer } from "js-polo";
import { describe, expect, it } from "vitest";

import {
  BUILDABLE_STANDARDS,
  buildCreateAsset,
  predictAssetId,
  toPoloHex,
  toWireJson,
  type MasxCreate,
  type SenderInfo,
  type UnsignedInteraction,
} from "../../src/moi/ix-builder.js";
import { compareSigned } from "../../src/moi/signed-check.js";
import { CREATABLE_STANDARDS } from "../../src/schema.js";
import { TAXTOKEN } from "../helpers/asset-create-fixtures.js";
import { PLAIN_ASSET, NO_INPUT_DEPLOY_ASSET } from "../helpers/asset-create-fixtures.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };
const SDK_SENDER = { id: SENDER.id, sequence: 3, key_id: 0 };
const FUEL = { fuelLimit: 449, fuelPrice: 50 };
const SDK_OPTS = { sender: SDK_SENDER as never, fuel_limit: 449, fuel_price: 50 };
const DEFAULT_FUND = Number(DEFAULT_STORAGE_FUND);
const LOW_FUND = 7_000_000_000;

const base = { dimension: 0, isStateful: false, isFungible: true } as const;
const manifestHex = (m: unknown) => ManifestCoder.encodeManifest(m as never);
const payloadOf = (ix: UnsignedInteraction) => ix.ix_operations[0]!.payload;

/** A copy, because toPoloHex rewrites `participants` in place. */
const polo = (ix: unknown) => toPoloHex(structuredClone(ix) as UnsignedInteraction);

/** The funding transfer's calldata, decoded: who is funded and with how much. */
function funded(calldata: unknown): { beneficiary: string; amount: bigint } {
  const decoded = new Depolorizer(Buffer.from(String(calldata).replace(/^0x/, ""), "hex")).depolorize({
    kind: "struct",
    fields: { beneficiary: { kind: "bytes" }, amount: { kind: "integer" } },
  }) as { beneficiary: Uint8Array; amount: bigint };
  return { beneficiary: `0x${Buffer.from(decoded.beneficiary).toString("hex")}`, amount: BigInt(decoded.amount) };
}

/** What the SDK builds for the same create, with the sender fixed and no signer. `supply` is what the SDK is handed. */
interface SdkCase {
  name: string;
  /** The server's interaction. */
  ours: (fund?: number) => UnsignedInteraction;
  /** The SDK's, given the supply as a bigint or as a number, and the storage fund. */
  sdk: (supply: bigint | number, fund?: number) => Promise<unknown>;
}

const coder = new ManifestCoder(TAXTOKEN as never);
const TAX_ARGS: [string, number, number] = [SENDER.id, 300, 1_000_000];
const TAX_CALLDATA = coder.encodeArguments("Init", ...TAX_ARGS);

function masxOurs(masx: MasxCreate, fund?: number): UnsignedInteraction {
  return buildCreateAsset(SENDER, { symbol: "TAX", supply: 1_000_000n, ...base, standard: "MASX", masx, ...(fund ? { storageFund: BigInt(fund) } : {}) }, FUEL);
}

const CASES: SdkCase[] = [
  {
    name: "MAS0 with decimals",
    ours: (fund) => buildCreateAsset(SENDER, { symbol: "TST", supply: 100_000n, decimals: 2, ...base, standard: "MAS0", ...(fund ? { storageFund: BigInt(fund) } : {}) }, FUEL),
    sdk: (supply, fund) => MAS0AssetLogic.create({} as never, "TST", supply as never, SENDER.id as never, false, 2, fund ? { storageFund: fund } : undefined).ixData(SDK_OPTS),
  },
  {
    name: "MAS1",
    ours: (fund) => buildCreateAsset(SENDER, { symbol: "NFTA", ...base, standard: "MAS1", ...(fund ? { storageFund: BigInt(fund) } : {}) }, FUEL),
    // MAS1 has no supply: the SDK's create takes none.
    sdk: (_supply, fund) => MAS1AssetLogic.create({} as never, "NFTA", SENDER.id as never, false, fund ? { storageFund: fund } : undefined).ixData(SDK_OPTS),
  },
  {
    name: "MAS2 with decimals",
    ours: (fund) => buildCreateAsset(SENDER, { symbol: "GOLD", supply: 100_000n, decimals: 2, ...base, standard: "MAS2", ...(fund ? { storageFund: BigInt(fund) } : {}) }, FUEL),
    sdk: (supply, fund) => MAS2AssetLogic.create({} as never, "GOLD", supply as never, SENDER.id as never, false, 2, fund ? { storageFund: fund } : undefined).ixData(SDK_OPTS),
  },
  {
    name: "MASX with a deploy routine and inputs",
    ours: (fund) => masxOurs({ manifest: manifestHex(TAXTOKEN), callsite: "Init", calldata: `0x${TAX_CALLDATA.replace(/^0x/, "")}` }, fund),
    sdk: (supply, fund) =>
      AssetFactory.create({} as never, "TAX", supply as never, SENDER.id as never, false, TAXTOKEN as never, "Init", ...TAX_ARGS, new RoutineOption({ storageFund: fund ?? DEFAULT_FUND } as never) as never).ixData(SDK_OPTS),
  },
  {
    name: "MASX with no deploy routine",
    ours: (fund) => masxOurs({ manifest: manifestHex(PLAIN_ASSET) }, fund),
    sdk: (supply, fund) => AssetFactory.create({} as never, "TAX", supply as never, SENDER.id as never, false, PLAIN_ASSET as never, undefined as never, new RoutineOption({ storageFund: fund ?? DEFAULT_FUND } as never) as never).ixData(SDK_OPTS),
  },
  {
    name: "MASX with a deploy routine that takes no inputs",
    ours: (fund) => masxOurs({ manifest: manifestHex(NO_INPUT_DEPLOY_ASSET), callsite: "Init" }, fund),
    sdk: (supply, fund) => AssetFactory.create({} as never, "TAX", supply as never, SENDER.id as never, false, NO_INPUT_DEPLOY_ASSET as never, "Init", new RoutineOption({ storageFund: fund ?? DEFAULT_FUND } as never) as never).ixData(SDK_OPTS),
  },
];

describe("buildCreateAsset against the SDK, standard by standard", () => {
  for (const row of CASES) {
    describe(row.name, () => {
      it("writes the SDK's bytes in the full-width form, with a bigint supply", async () => {
        expect(polo(row.ours())).toBe(polo(await row.sdk(row.name.startsWith("MASX") ? 1_000_000n : 100_000n)));
      });

      it("writes the SDK's bytes in the wire form the phone is asked to sign, with a number supply", async () => {
        const supply = row.name.startsWith("MASX") ? 1_000_000 : 100_000;
        expect(toPoloHex(toWireJson(row.ours()) as never)).toBe(polo(await row.sdk(supply)));
      });

      it("is accepted by the signed-interaction check as the answer for the interaction it previewed, in both forms", async () => {
        const big = row.name.startsWith("MASX") ? 1_000_000 : 100_000;
        const wire = compareSigned(polo(await row.sdk(big)), row.ours());
        expect(wire.matched).toContain("wire");
        const full = compareSigned(polo(await row.sdk(BigInt(big))), row.ours());
        expect(full.matched).toContain("full-width");
      });

      it("writes the SDK's funding for a non-default fund, and that funding differs from the default's", async () => {
        const supply = row.name.startsWith("MASX") ? 1_000_000 : 100_000;
        const low = await row.sdk(supply, LOW_FUND);
        expect(toPoloHex(toWireJson(row.ours(LOW_FUND)) as never)).toBe(polo(low));
        expect(polo(low)).not.toBe(polo(await row.sdk(supply)));
        const ourFund = row.ours(LOW_FUND).ix_operations[1]!.payload;
        expect(funded(ourFund["calldata"]).amount).toBe(BigInt(LOW_FUND));
      });
    });
  }

  it("a plain { storageFund } object given to AssetFactory.create is not the option: the SDK keeps the default (the trap the MASX tests avoid)", async () => {
    const plain = await AssetFactory.create({} as never, "TAX", 1_000_000 as never, SENDER.id as never, false, TAXTOKEN as never, "Init", ...TAX_ARGS, { storageFund: LOW_FUND } as never).ixData(SDK_OPTS).catch(() => undefined);
    const real = await AssetFactory.create({} as never, "TAX", 1_000_000 as never, SENDER.id as never, false, TAXTOKEN as never, "Init", ...TAX_ARGS, new RoutineOption({ storageFund: LOW_FUND } as never) as never).ixData(SDK_OPTS);
    const amount = (ix: { ix_operations: Array<{ payload: unknown }> } | undefined) =>
      ix && funded((ix.ix_operations[1]!.payload as Record<string, unknown>)["calldata"]).amount;
    expect(amount(real)).toBe(BigInt(LOW_FUND));
    expect(amount(plain as never)).not.toBe(BigInt(LOW_FUND));
  });
});

describe("what each standard sends", () => {
  it("MAS0 is as it was: decimals, no logic payload", () => {
    const p = payloadOf(buildCreateAsset(SENDER, { symbol: "TST", supply: 100_000n, decimals: 2, ...base, standard: "MAS0" }, FUEL));
    expect(p).toEqual({ symbol: "TST", max_supply: 100_000n, decimals: 2, dimension: 0, standard: AssetStandard.MAS0, enable_events: false, manager: SENDER.id });
    expect(p).not.toHaveProperty("logic_payload");
  });

  it("MAS1 sends max_supply 1 as a number, no decimals key, dimension 0 and the Init logic payload", () => {
    const p = payloadOf(buildCreateAsset(SENDER, { symbol: "NFTA", ...base, standard: "MAS1" }, FUEL));
    expect(p).toEqual({
      symbol: "NFTA",
      max_supply: 1,
      dimension: 0,
      standard: AssetStandard.MAS1,
      enable_events: false,
      manager: SENDER.id,
      logic_payload: { manifest: "0x", callsite: "Init" },
    });
    expect(typeof p["max_supply"]).toBe("number");
    expect(p).not.toHaveProperty("decimals");
    expect(p).not.toHaveProperty("supply");
  });

  it("MAS1's max_supply is the number 1: the bigint 1n encodes to different bytes in full width and to the same bytes in the wire form", () => {
    const ours = buildCreateAsset(SENDER, { symbol: "NFTA", ...base, standard: "MAS1" }, FUEL);
    const asBigint = structuredClone(ours);
    (asBigint.ix_operations[0]!.payload as Record<string, unknown>)["max_supply"] = 1n;
    expect(polo(asBigint)).not.toBe(polo(ours));
    expect(toPoloHex(toWireJson(asBigint) as never)).toBe(toPoloHex(toWireJson(ours) as never));
  });

  it("MAS2 sends the scaled supply as a bigint, the decimals and the Init logic payload", () => {
    const p = payloadOf(buildCreateAsset(SENDER, { symbol: "GOLD", supply: 100_000n, decimals: 2, ...base, standard: "MAS2" }, FUEL));
    expect(p).toEqual({
      symbol: "GOLD",
      max_supply: 100_000n,
      decimals: 2,
      dimension: 0,
      standard: AssetStandard.MAS2,
      enable_events: false,
      manager: SENDER.id,
      logic_payload: { manifest: "0x", callsite: "Init" },
    });
  });

  it("MASX sends no decimals key; with a deploy routine the manifest, callsite and calldata, with none the manifest alone", () => {
    const withInit = payloadOf(masxOurs({ manifest: manifestHex(TAXTOKEN), callsite: "Init", calldata: `0x${TAX_CALLDATA.replace(/^0x/, "")}` }));
    expect(withInit).not.toHaveProperty("decimals");
    expect(withInit["standard"]).toBe(AssetStandard.MASX);
    expect(withInit["logic_payload"]).toEqual({ manifest: manifestHex(TAXTOKEN), callsite: "Init", calldata: `0x${TAX_CALLDATA.replace(/^0x/, "")}` });
    const bare = payloadOf(masxOurs({ manifest: manifestHex(PLAIN_ASSET) }));
    expect(bare["logic_payload"]).toEqual({ manifest: manifestHex(PLAIN_ASSET) });
    expect(Object.keys(bare["logic_payload"] as object)).toEqual(["manifest"]);
    const noInputs = payloadOf(masxOurs({ manifest: manifestHex(NO_INPUT_DEPLOY_ASSET), callsite: "Init" }));
    expect(noInputs["logic_payload"]).toEqual({ manifest: manifestHex(NO_INPUT_DEPLOY_ASSET), callsite: "Init" });
  });

  it("dimension and isStateful reach dimension and enable_events for every standard; the defaults are the SDK's bytes", () => {
    for (const standard of ["MAS0", "MAS1", "MAS2"] as const) {
      const make = (dimension: number, isStateful: boolean) =>
        payloadOf(buildCreateAsset(SENDER, { symbol: "X", ...(standard === "MAS1" ? {} : { supply: 5n }), dimension, isStateful, isFungible: true, standard }, FUEL));
      expect(make(1, true)).toMatchObject({ dimension: 1, enable_events: true });
      expect(make(0, false)).toMatchObject({ dimension: 0, enable_events: false });
    }
    const masx = payloadOf(buildCreateAsset(SENDER, { symbol: "X", supply: 5n, dimension: 1, isStateful: true, isFungible: true, standard: "MASX", masx: { manifest: manifestHex(PLAIN_ASSET) } }, FUEL));
    expect(masx).toMatchObject({ dimension: 1, enable_events: true });
  });
});

describe("the funding transfer", () => {
  it("is the second operation and pays the id derived for each standard, which differ in bytes 2 and 3 only", () => {
    const ids = (["MAS0", "MAS1", "MAS2", "MASX"] as const).map((standard) => {
      const ix = buildCreateAsset(SENDER, {
        symbol: "X",
        ...(standard === "MAS1" ? {} : { supply: 5n }),
        ...base,
        standard,
        ...(standard === "MASX" ? { masx: { manifest: manifestHex(PLAIN_ASSET) } } : {}),
      });
      expect(ix.ix_operations.map((o) => o.type)).toEqual([OpType.ASSET_CREATE, OpType.ASSET_INVOKE]);
      const fund = ix.ix_operations[1]!;
      expect(fund.payload["asset_id"]).toBe(KMOI_ASSET_ID);
      expect(fund.payload["callsite"]).toBe("Transfer");
      expect(String(fund.payload["calldata"])).not.toMatch(/^0x/);
      const { beneficiary, amount } = funded(fund.payload["calldata"]);
      expect(beneficiary).toBe(predictAssetId(SENDER, standard));
      expect(beneficiary).toBe(deriveAssetId({ id: SENDER.id as never, sequence: 3, key_id: 0 }, AssetStandard[standard]).toHex());
      expect(amount).toBe(BigInt(DEFAULT_STORAGE_FUND));
      return beneficiary;
    });
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id.slice(0, 6) + id.slice(10)).toBe(ids[0]!.slice(0, 6) + ids[0]!.slice(10));
  });

  it("predictAssetId follows the sequence and the key, and refuses MASN, a number as text and an unknown name", () => {
    expect(predictAssetId({ ...SENDER, sequence: 4 }, "MAS1")).not.toBe(predictAssetId(SENDER, "MAS1"));
    expect(predictAssetId({ ...SENDER, keyId: 1 }, "MAS1")).not.toBe(predictAssetId(SENDER, "MAS1"));
    expect(predictAssetId({ id: SENDER.id, sequence: 3 }, "MAS1")).toBe(predictAssetId(SENDER, "MAS1"));
    for (const standard of ["MASN", "0", "MAS9", "", "constructor"]) {
      expect(() => predictAssetId(SENDER, standard), standard).toThrow(/Unknown asset standard.*MAS0, MAS1, MAS2, MASX/);
    }
  });
});

describe("what the builder refuses, which the SDK never sends", () => {
  const make = (params: Record<string, unknown>) =>
    buildCreateAsset(SENDER, { symbol: "X", ...base, standard: "MAS0", supply: 5n, ...params } as never, FUEL);

  it("MAS1 with a supply or with decimals, even 0", () => {
    expect(() => make({ standard: "MAS1", supply: 1n })).toThrow(/MAS1 create takes no supply and no decimals/);
    expect(() => make({ standard: "MAS1", supply: undefined, decimals: 0 })).toThrow(/MAS1 create takes no supply and no decimals/);
  });

  it("a manifest block on a built-in standard, and a MASX create without one", () => {
    for (const standard of ["MAS0", "MAS1", "MAS2"]) {
      expect(() => make({ standard, masx: { manifest: "0x00" }, supply: standard === "MAS1" ? undefined : 5n })).toThrow(/takes no manifest/);
    }
    expect(() => make({ standard: "MASX" })).toThrow(/needs its manifest/);
  });

  it("decimals on a MASX create, and no supply where one is needed", () => {
    expect(() => make({ standard: "MASX", decimals: 0, masx: { manifest: "0x00" } })).toThrow(/MASX create sends no decimals/);
    for (const standard of ["MAS0", "MAS2"]) expect(() => make({ standard, supply: undefined })).toThrow(/needs a supply/);
    expect(() => make({ standard: "MASX", supply: undefined, masx: { manifest: "0x00" } })).toThrow(/needs a supply/);
  });

  it("an unknown standard, in the words the old builder used", () => {
    expect(() => make({ standard: "MAS9" })).toThrow(/Unknown asset standard "MAS9". Expected one of MAS0, MAS1, MAS2, MASX/);
  });
});

describe("every create shape", () => {
  it("POLO-encodes and survives toWireJson, with ASSET_CREATE first and the funding second", () => {
    const shapes = [
      buildCreateAsset(SENDER, { symbol: "A", supply: 5n, decimals: 0, ...base, standard: "MAS0" }),
      buildCreateAsset(SENDER, { symbol: "B", ...base, standard: "MAS1" }),
      buildCreateAsset(SENDER, { symbol: "C", supply: 5n, decimals: 3, ...base, standard: "MAS2" }),
      masxOurs({ manifest: manifestHex(TAXTOKEN), callsite: "Init", calldata: `0x${TAX_CALLDATA.replace(/^0x/, "")}` }),
    ];
    for (const ix of shapes) {
      expect(ix.ix_operations.map((o) => o.type)).toEqual([OpType.ASSET_CREATE, OpType.ASSET_INVOKE]);
      expect(() => polo(ix)).not.toThrow();
      expect(() => JSON.stringify(toWireJson(ix))).not.toThrow();
    }
  });

  it("the schema's list of creatable standards and the builder's are the same set", () => {
    expect([...CREATABLE_STANDARDS].sort()).toEqual([...BUILDABLE_STANDARDS].sort());
  });
});
