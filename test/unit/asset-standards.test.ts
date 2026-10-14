import { AssetStandard, MAS1, MAS2 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { coerceArgs } from "../../src/capabilities/assets/codec.js";
import { readManifest } from "../../src/capabilities/assets/routines.js";
import {
  amountDetails,
  describeExpiry,
  kindOf,
  type RoutineContext,
  type StandardFile,
} from "../../src/capabilities/assets/standards/common.js";
import { mas0File } from "../../src/capabilities/assets/standards/mas0.js";
import { mas1File } from "../../src/capabilities/assets/standards/mas1.js";
import { mas2File } from "../../src/capabilities/assets/standards/mas2.js";
import { masnFile } from "../../src/capabilities/assets/standards/masn.js";
import { NO_FILE_NEEDED, STANDARD_FILES, specFor, standardFileFor } from "../../src/capabilities/assets/standards/index.js";
import { ErrorCode } from "../../src/schema.js";
import {
  MAS0_MANIFEST,
  MAS1_MANIFEST,
  MAS2_MANIFEST,
  MASN_MANIFEST,
  PIXEL,
  fieldsOf,
  type ManifestLike,
} from "../helpers/asset-fixtures.js";
import { KMOI, MAS1_ASSET, MAS2_ASSET, OTHER } from "../helpers/mock-node.js";

const ref = (assetId: string, standard: string) => ({ assetId, symbol: "SYM", standard, decimals: 0 });

/** A routine's context for a file: the inputs are validated against the manifest's own field list, as the tool does. */
function context(
  manifest: ManifestLike,
  file: StandardFile,
  routine: string,
  raw: Record<string, unknown>,
  o: { symbol?: string; decimals?: number; assetId?: string } = {},
): RoutineContext {
  const decimals = o.decimals ?? 0;
  return {
    assetId: o.assetId ?? PIXEL,
    symbol: o.symbol ?? "PIXEL",
    decimals,
    standard: file.standard,
    routine,
    args: coerceArgs(routine, fieldsOf(manifest, routine).accepts, raw, { decimals }),
  };
}

const spec = (file: StandardFile, routine: string) => {
  const s = file.routines[routine];
  if (!s) throw new Error(`${file.standard} has no spec for ${routine}`);
  return s;
};

describe("one file per built-in standard", () => {
  it("has a file for every standard the SDK names, except the ones that need none", () => {
    // AssetStandard is a numeric enum, so Object.keys holds the numbers as well as the names.
    const names = Object.keys(AssetStandard).filter((k) => Number.isNaN(Number(k)));
    expect(names).toEqual(expect.arrayContaining(["MAS0", "MAS1", "MAS2", "MASN", "MASX"]));
    for (const name of names.filter((n) => !NO_FILE_NEEDED.includes(n))) {
      const file = (STANDARD_FILES as Record<string, StandardFile | undefined>)[name];
      expect(
        file,
        `the SDK lists standard ${name} and src/capabilities/assets/standards has no file for it`,
      ).toBeDefined();
      expect(file?.standard).toBe(name);
    }
  });

  it("exempts exactly MASX, and has no file for a name the SDK does not list", () => {
    expect(NO_FILE_NEEDED).toEqual(["MASX"]);
    const names = Object.keys(AssetStandard).filter((k) => Number.isNaN(Number(k)));
    for (const key of Object.keys(STANDARD_FILES)) expect(names).toContain(key);
  });

  it("finds a file only for an own, built-in name", () => {
    for (const name of ["constructor", "__proto__", "toString", "UNKNOWN(9)", "", "MASX"]) {
      expect(standardFileFor(name)).toBeUndefined();
    }
    expect(standardFileFor("MAS0")).toBe(mas0File);
  });

  it("describes exactly the write routines of the real manifests, with the inputs the real ones have", () => {
    const writes = (manifest: ManifestLike) =>
      [...readManifest(manifest, ref(PIXEL, "MAS0")).callables.values()].filter((c) => c.access === "write");
    for (const [manifest, file, count] of [
      [MAS0_MANIFEST, mas0File, 11],
      [MASN_MANIFEST, masnFile, 6],
    ] as const) {
      const real = writes(manifest);
      expect(real).toHaveLength(count);
      expect(Object.keys(file.routines).sort()).toEqual(real.map((c) => c.name).sort());
      for (const callable of real) {
        expect(specFor(file, callable), `${file.standard} ${callable.name}`).toBeDefined();
        const wanted = spec(file, callable.name).inputs;
        expect(Object.fromEntries(callable.accepts.map((a) => [a.label, kindOf(a.type)]))).toEqual(wanted);
      }
    }
  });

  it("gives MAS1 and MAS2 the thirteen routines of the SDK's own endpoint lists", () => {
    for (const [file, endpoints] of [
      [mas1File, new Set<string>(Object.values(MAS1.Endpoint))],
      [mas2File, new Set<string>(Object.values(MAS2.Endpoint))],
    ] as const) {
      const names = Object.keys(file.routines);
      expect(names).toHaveLength(13);
      for (const name of names) expect(endpoints.has(name), `${file.standard} ${name}`).toBe(true);
    }
  });

  it("describes every write routine of the synthetic MAS1 and MAS2 manifests", () => {
    for (const [manifest, file, asset] of [
      [MAS1_MANIFEST, mas1File, MAS1_ASSET],
      [MAS2_MANIFEST, mas2File, MAS2_ASSET],
    ] as const) {
      const writes = [...readManifest(manifest, ref(asset, file.standard)).callables.values()].filter((c) => c.access === "write");
      expect(writes).toHaveLength(13);
      for (const callable of writes) expect(specFor(file, callable), `${file.standard} ${callable.name}`).toBeDefined();
    }
  });
});

describe("refusals that run before the manifest is read", () => {
  it("MASN refuses exactly the five routines the chain reserves, and says why", () => {
    for (const routine of ["Mint", "MintWithMetadata", "Burn"]) {
      expect(masnFile.refusal?.(routine, {})).toMatch(/cannot be minted or burned/);
    }
    for (const routine of ["SetStaticMetadata", "SetDynamicMetadata"]) {
      expect(masnFile.refusal?.(routine, {})).toMatch(/metadata cannot be changed/);
    }
    for (const routine of ["Transfer", "Approve", "constructor", "Nope", ""]) {
      expect(masnFile.refusal?.(routine, {})).toBeUndefined();
    }
    // None of the five is a routine of the real KMOI manifest, which is why the message can say so.
    const names = [...readManifest(MASN_MANIFEST, ref(KMOI, "MASN")).callables.keys()];
    for (const routine of ["Mint", "MintWithMetadata", "Burn", "SetStaticMetadata", "SetDynamicMetadata"]) {
      expect(names).not.toContain(routine);
    }
  });

  it("MAS1 refuses an amount, whatever the routine, and nothing else", () => {
    expect(mas1File.refusal?.("Transfer", { amount: 1 })).toMatch(/MAS1 asset has no amounts/);
    expect(mas1File.refusal?.("Anything", { amount: undefined })).toMatch(/MAS1 asset has no amounts/);
    expect(mas1File.refusal?.("Transfer", { token_id: 1 })).toBeUndefined();
    for (const file of [mas0File, mas2File]) expect(file.refusal?.("Transfer", { amount: 1 })).toBeUndefined();
  });
});

describe("specFor compares by label and kind", () => {
  const transfer = { name: "Transfer", accepts: [{ label: "beneficiary", type: "identifier" }, { label: "amount", type: "u256" }] };

  it("gives the spec to the real inputs, in any order", () => {
    expect(specFor(mas0File, transfer)).toBe(spec(mas0File, "Transfer"));
    expect(specFor(mas0File, { ...transfer, accepts: [...transfer.accepts].reverse() })).toBe(spec(mas0File, "Transfer"));
  });

  it("gives it to a MAS1 token_id typed u256 instead of u64, which is the same kind", () => {
    const callable = (type: string) => ({ name: "Burn", accepts: [{ label: "token_id", type }] });
    expect(specFor(mas1File, callable("u64"))).toBeDefined();
    expect(specFor(mas1File, callable("u256"))).toBeDefined();
  });

  it("withholds it when a label, a kind or the number of inputs differs", () => {
    const renamed = { name: "Burn", accepts: [{ label: "tokenId", type: "u64" }] };
    expect(specFor(mas1File, renamed)).toBeUndefined();
    const asText = { ...transfer, accepts: [{ label: "beneficiary", type: "identifier" }, { label: "amount", type: "string" }] };
    expect(specFor(mas0File, asText)).toBeUndefined();
    const asBytes = { ...transfer, accepts: [{ label: "beneficiary", type: "bytes" }, { label: "amount", type: "u256" }] };
    expect(specFor(mas0File, asBytes)).toBeUndefined();
    const extra = { ...transfer, accepts: [...transfer.accepts, { label: "memo", type: "string" }] };
    expect(specFor(mas0File, extra)).toBeUndefined();
    expect(specFor(mas0File, { ...transfer, accepts: [] })).toBeUndefined();
  });

  it("finds nothing for names that live on Object.prototype, and nothing for no file", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(specFor(mas0File, { name, accepts: [] })).toBeUndefined();
    }
    expect(specFor(undefined, transfer)).toBeUndefined();
  });
});

describe("describeExpiry", () => {
  it("shows the raw value and one labelled reading in seconds", () => {
    expect(describeExpiry(1893456000n)).toBe(
      "1893456000 (as unix seconds that is 2030-01-01T00:00:00.000Z; the unit is not confirmed)",
    );
    expect(describeExpiry(0n)).toBe("0 (as unix seconds that is 1970-01-01T00:00:00.000Z; the unit is not confirmed)");
  });

  it("gives no reading, and does not throw, for a value too large to be a date in seconds", () => {
    expect(describeExpiry(1893456000000000000n)).toBe("1893456000000000000 (the unit is not confirmed)");
    expect(describeExpiry(2n ** 64n - 1n)).toBe("18446744073709551615 (the unit is not confirmed)");
  });
});

describe("what a person reads before approving", () => {
  const OWNER = OTHER;

  it("says Burn 5 PIXEL for a burn of 5 PIXEL", () => {
    const c = context(MAS0_MANIFEST, mas0File, "Burn", { amount: 5 });
    expect(spec(mas0File, "Burn").summary(c)).toBe("Burn 5 PIXEL");
    expect(spec(mas0File, "Burn").details?.(c)).toEqual({ Amount: "5", "Amount in base units": "5" });
  });

  it("says who a transfer goes to", () => {
    const c = context(MAS0_MANIFEST, mas0File, "Transfer", { beneficiary: OWNER, amount: "5" });
    expect(spec(mas0File, "Transfer").summary(c)).toBe(`Transfer 5 PIXEL to ${OWNER}`);
    expect(spec(mas0File, "Transfer").details?.(c)).toEqual({ To: OWNER, Amount: "5", "Amount in base units": "5" });
  });

  it("says Approve with the cap, the raw expiry and one labelled reading of it", () => {
    const c = context(MAS0_MANIFEST, mas0File, "Approve", { beneficiary: OWNER, amount: 10, expires_at: 1893456000 });
    expect(spec(mas0File, "Approve").summary(c)).toBe(
      `Approve ${OWNER} to spend up to 10 PIXEL until 1893456000 (as unix seconds that is 2030-01-01T00:00:00.000Z; the unit is not confirmed)`,
    );
    expect(spec(mas0File, "Approve").details?.(c)).toMatchObject({
      Beneficiary: OWNER,
      "Spending cap": "10",
      "Spending cap in base units": "10",
      "Expires at (as given)": "1893456000",
    });
  });

  it("shows whole tokens and base units together for an asset with decimals", () => {
    const c = context(MAS0_MANIFEST, mas0File, "Transfer", { beneficiary: OWNER, amount: "1500000000" }, { decimals: 9 });
    expect(spec(mas0File, "Transfer").summary(c)).toBe(`Transfer 1.5 PIXEL to ${OWNER}`);
    expect(spec(mas0File, "Transfer").details?.(c)).toMatchObject({ Amount: "1.5", "Amount in base units": "1500000000" });
    expect(amountDetails(c, "amount", "Cap")).toEqual({ Cap: "1.5", "Cap in base units": "1500000000" });
  });

  it("names the token id in a MAS1 transfer and in a MAS2 burn", () => {
    const t = context(MAS1_MANIFEST, mas1File, "Transfer", { token_id: 12, beneficiary: OWNER }, { symbol: "SYM", assetId: MAS1_ASSET });
    expect(spec(mas1File, "Transfer").summary(t)).toBe(`Transfer token #12 of SYM to ${OWNER}`);
    expect(spec(mas1File, "Transfer").details?.(t)).toEqual({ "Token id": "12", To: OWNER });
    const b = context(MAS2_MANIFEST, mas2File, "Burn", { token_id: 12, amount: 3 }, { symbol: "SYM", assetId: MAS2_ASSET });
    expect(spec(mas2File, "Burn").summary(b)).toBe("Burn 3 of token #12 of SYM");
    expect(spec(mas2File, "Burn").details?.(b)).toEqual({ "Token id": "12", Amount: "3", "Amount in base units": "3" });
  });

  it("says a MAS1 mint names no token, and a MAS2 mint takes an amount", () => {
    const m1 = context(MAS1_MANIFEST, mas1File, "Mint", { beneficiary: OWNER }, { symbol: "SYM", assetId: MAS1_ASSET });
    expect(spec(mas1File, "Mint").summary(m1)).toBe(`Mint a token of SYM to ${OWNER}`);
    expect(spec(mas1File, "Mint").details?.(m1)).toEqual({ "Token id": "not part of the call", To: OWNER });
    const m2 = context(MAS2_MANIFEST, mas2File, "Mint", { beneficiary: OWNER, amount: 4 }, { symbol: "SYM", assetId: MAS2_ASSET });
    expect(spec(mas2File, "Mint").summary(m2)).toBe(`Mint 4 of SYM to ${OWNER}`);
  });

  it("keeps a metadata key to one clean line", () => {
    const c = context(MAS0_MANIFEST, mas0File, "SetStaticMetadata", { key: "a\nb\u0007c", value: "0x01" });
    expect(spec(mas0File, "SetStaticMetadata").summary(c)).toBe('Set the static metadata "a b c" of PIXEL');
  });
});

describe("checks on the inputs", () => {
  const zeroAmount = (manifest: ManifestLike, file: StandardFile, routine: string, extra: Record<string, unknown> = {}) => () => {
    const c = context(manifest, file, routine, { ...extra, amount: 0 });
    spec(file, routine).check?.(c);
  };

  it("refuses a zero amount for every routine that moves or makes value", () => {
    const who = { beneficiary: OTHER };
    const both = { benefactor: OTHER, beneficiary: OTHER };
    const cases: Array<[ManifestLike, StandardFile, string, Record<string, unknown>]> = [
      [MAS0_MANIFEST, mas0File, "Transfer", who],
      [MAS0_MANIFEST, mas0File, "TransferFrom", both],
      [MAS0_MANIFEST, mas0File, "Mint", who],
      [MAS0_MANIFEST, mas0File, "MintWithMetadata", { ...who, static_metadata: {} }],
      [MAS0_MANIFEST, mas0File, "Burn", {}],
      [MAS0_MANIFEST, mas0File, "Lockup", who],
      [MAS0_MANIFEST, mas0File, "Release", both],
      [MAS2_MANIFEST, mas2File, "Burn", { token_id: 1 }],
      [MAS2_MANIFEST, mas2File, "Transfer", { token_id: 1, ...who }],
      [MASN_MANIFEST, masnFile, "Transfer", who],
    ];
    for (const [manifest, file, routine, extra] of cases) {
      expect(zeroAmount(manifest, file, routine, extra), `${file.standard} ${routine}`).toThrow(/moves nothing/);
    }
    try {
      zeroAmount(MAS0_MANIFEST, mas0File, "Burn")();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("accepts a zero amount for Approve, where it may cancel an approval", () => {
    expect(zeroAmount(MAS0_MANIFEST, mas0File, "Approve", { beneficiary: OTHER, expires_at: 1 })).not.toThrow();
  });

  it("refuses an empty key for the metadata setters of MAS0 and MAS1", () => {
    const empty = (manifest: ManifestLike, file: StandardFile, routine: string, extra: Record<string, unknown> = {}) => () =>
      spec(file, routine).check?.(context(manifest, file, routine, { ...extra, key: "", value: "0x01" }));
    for (const routine of ["SetStaticMetadata", "SetDynamicMetadata"]) {
      expect(empty(MAS0_MANIFEST, mas0File, routine)).toThrow(/needs a non-empty key/);
      expect(empty(MAS1_MANIFEST, mas1File, routine)).toThrow(/needs a non-empty key/);
    }
    for (const routine of ["SetStaticTokenMetadata", "SetDynamicTokenMetadata"]) {
      expect(empty(MAS1_MANIFEST, mas1File, routine, { token_id: 1 })).toThrow(/needs a non-empty key/);
    }
  });
});
