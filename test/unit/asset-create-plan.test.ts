/**
 * planCreateAsset and describeCreate, the planning half of moi_create_asset: which inputs each standard takes, the refusals
 * for the rest, what the confirm token binds, and the words the person reads. Pure: no node, no wallet. The refusals are
 * pinned word for word, because they are what the model tells the person.
 */

import { ManifestCoder } from "js-moi-sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { describeCreate, planCreateAsset, STANDARD_WORDS, type CreateAssetPlan } from "../../src/capabilities/assets/create-plan.js";
import { fingerprint } from "../../src/tools/preview.js";
import { isMoiError } from "../../src/moi-error.js";
import { CreateAssetInput } from "../../src/schema.js";
import {
  BOGUS_KIND,
  LOCK_LEDGER,
  LOGIC_KIND,
  NO_INPUT_DEPLOY_ASSET,
  NO_KIND,
  PLAIN_ASSET,
  TAX_ARGS,
  TAXTOKEN,
  TWO_DEPLOYS_ASSET,
} from "../helpers/asset-create-fixtures.js";
import { importGraph } from "../helpers/import-graph.js";
import { ACCOUNT } from "../helpers/mock-node.js";

const NOTHING = "Nothing was sent to your wallet.";

/** Parse as the tool's schema does (defaults filled in), then plan. */
const plan = (raw: Record<string, unknown>): CreateAssetPlan => planCreateAsset(CreateAssetInput.parse(raw));

function refusal(raw: Record<string, unknown>): { code: string; message: string } {
  try {
    plan(raw);
  } catch (err) {
    if (isMoiError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(raw).slice(0, 120)}`);
}

const TAX = { symbol: "TAX", standard: "MASX", supply: "1000000", manifest: TAXTOKEN, args: TAX_ARGS };
const encodedTax = ManifestCoder.encodeManifest(TAXTOKEN as never);
const digestOf = (hex: string) => createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");

describe("MAS0 and MAS2", () => {
  it("default to MAS0 and scale the supply by the decimals, as before", () => {
    const p = plan({ symbol: "TST", supply: "1000", decimals: 2 });
    expect(p).toMatchObject({ standard: "MAS0", symbol: "TST", supply: 100_000n, supplyAsGiven: "1000", decimals: 2, dimension: 0, isStateful: false, masx: undefined });
    expect(plan({ symbol: "TST", supply: "1000" })).toMatchObject({ supply: 1000n, decimals: 0 });
  });

  it("MAS2 plans the scaled supply and the decimals, default 0", () => {
    expect(plan({ symbol: "GOLD", standard: "MAS2", supply: "1.5", decimals: 2 })).toMatchObject({ standard: "MAS2", supply: 150n, decimals: 2 });
    expect(plan({ symbol: "GOLD", standard: "MAS2", supply: "7" })).toMatchObject({ supply: 7n, decimals: 0 });
  });

  it("refuse a missing supply (R3), each in the standard's own name", () => {
    for (const standard of ["MAS0", "MAS2"]) {
      const r = refusal({ symbol: "X", standard });
      expect(r.code).toBe("INVALID_ARGS");
      expect(r.message).toBe(`A ${standard} asset needs a \`supply\`: the most that can ever be minted, in whole tokens, scaled by decimals. ${NOTHING}`);
    }
  });

  it("refuse a supply of zero in any spelling (R14), instead of letting it reach the dry run", () => {
    for (const standard of ["MAS0", "MAS2", "MASX"]) {
      // A MASX supply is in whole units, so "0.00" is a fraction there and parseAmount refuses it in its own words.
      for (const supply of standard === "MASX" ? ["0", 0] : ["0", "0.00", 0]) {
        const r = refusal({ symbol: "X", standard, supply, decimals: standard === "MASX" ? undefined : 2, manifest: standard === "MASX" ? PLAIN_ASSET : undefined });
        expect(r.message, `${standard} ${String(supply)}`).toBe(
          `A supply of 0 cannot be created: the chain needs a maximum supply above zero, and the SDK refuses to encode a create without one. Give a \`supply\` above zero. ${NOTHING}`,
        );
      }
    }
  });

  it("refuse an amount with more decimal places than the decimals, in parseAmount's words", () => {
    expect(refusal({ symbol: "X", supply: "1.234", decimals: 2 }).message).toMatch(/Amount 1\.234 has 3 decimal places but the asset's dimension is 2\./);
    expect(refusal({ symbol: "X", standard: "MAS2", supply: "1.5" }).message).toMatch(/Amount 1\.5 has 1 decimal places but the asset's dimension is 0\./);
  });
});

describe("MAS1", () => {
  it("with only a symbol plans no supply and no decimals", () => {
    const p = plan({ symbol: "NFTA", standard: "MAS1" });
    expect(p).toMatchObject({ standard: "MAS1", symbol: "NFTA", supply: undefined, supplyAsGiven: undefined, decimals: undefined, masx: undefined });
  });

  it("refuses a supply, even 1, with the reason (R1), and decimals, even 0, with the reason (R2)", () => {
    for (const supply of ["1", 1, "1000"]) {
      expect(refusal({ symbol: "X", standard: "MAS1", supply }).message).toBe(
        "A MAS1 asset takes no supply. MAS1 is single-unit: every MAS1 asset is created with a fixed maximum supply of 1, and each unit is whole and is moved by " +
          `its token id, so there is nothing for a supply to set. Leave \`supply\` out. ${NOTHING}`,
      );
    }
    for (const decimals of [0, 2]) {
      expect(refusal({ symbol: "X", standard: "MAS1", decimals }).message).toBe(
        "A MAS1 asset takes no decimals. A MAS1 unit is never divided: every MAS1 operation moves a whole token id, and the standard has no routine that reads " +
          `decimals back, so a value here would be written and never used. Leave \`decimals\` out. ${NOTHING}`,
      );
    }
  });
});

describe("the inputs only MASX takes", () => {
  it("a built-in standard refuses manifest, routine and a non-empty args, naming exactly what was given (R5), and accepts args {}", () => {
    expect(refusal({ symbol: "X", standard: "MAS1", manifest: TAXTOKEN }).message).toBe(
      "`manifest` only applies to the MASX standard, which creates an asset from a compiled manifest. A MAS1 asset has its routines built in, so it is refused " +
        `instead of being ignored. Leave them out, or pass standard MASX. ${NOTHING}`,
    );
    expect(refusal({ symbol: "X", supply: "5", routine: "Init" }).message).toMatch(/^`routine` only applies to the MASX standard.*A MAS0 asset has its routines built in/);
    expect(refusal({ symbol: "X", standard: "MAS2", supply: "5", manifest: TAXTOKEN, routine: "Init" }).message).toMatch(/^`manifest` and `routine` only apply to the MASX standard.*A MAS2 asset.*they are refused/);
    expect(refusal({ symbol: "X", supply: "5", manifest: TAXTOKEN, routine: "Init", args: { a: 1 } }).message).toMatch(/^`manifest`, `routine` and `args` only apply/);
    expect(() => plan({ symbol: "X", supply: "5", args: {} })).not.toThrow();
    expect(() => plan({ symbol: "X", standard: "MAS1", args: {} })).not.toThrow();
  });

  it("the first mistake is the one reported: R1 before R5, R5 before R3", () => {
    expect(refusal({ symbol: "X", standard: "MAS1", supply: "1", manifest: TAXTOKEN }).message).toMatch(/^A MAS1 asset takes no supply/);
    expect(refusal({ symbol: "X", manifest: TAXTOKEN }).message).toMatch(/^`manifest` only applies/);
    expect(refusal({ symbol: "X", standard: "MASX", decimals: 2, storageFund: "7000000000" }).message).toMatch(/^A MASX create sends no decimals/);
    expect(refusal({ symbol: "X", standard: "MASX", storageFund: "7000000000" }).message).toMatch(/takes no `storageFund`/);
  });
});

describe("MASX", () => {
  it("needs a manifest (R6), refuses decimals (R4) and storageFund (R15), and says why", () => {
    expect(refusal({ symbol: "X", standard: "MASX", supply: "5" }).message).toBe(
      "A MASX asset is created from a compiled asset manifest. Pass `manifest`: the JSON object `coco compile` writes for a `coco asset` module, exactly as the " +
        `user gave it to you. ${NOTHING}`,
    );
    expect(refusal({ ...TAX, decimals: 0 }).message).toBe(
      `A MASX create sends no decimals: the SDK's asset factory has no such field, so \`decimals\` is refused instead of being dropped without a word. Leave it out. ${NOTHING}`,
    );
    expect(refusal({ ...TAX, storageFund: "10000000000" }).message).toBe(
      "A MASX create funds the new asset with exactly 10 KMOI, the SDK's default, as moi_deploy_logic funds a logic, and takes no `storageFund`: this server does " +
        `not let a caller choose how much KMOI goes into an account that runs a manifest the caller supplied. Leave \`storageFund\` out. ${NOTHING}`,
    );
  });

  it("a missing supply is refused in its own words (whole units, no decimals), a zero supply with R14", () => {
    expect(refusal({ symbol: "X", standard: "MASX", manifest: TAXTOKEN }).message).toBe(
      `A MASX asset needs a \`supply\`: the most that can ever be minted, in whole units (a MASX create sends no decimals). ${NOTHING}`,
    );
  });

  it("with the compiled TaxToken runs Init without being told, encodes its three inputs as the SDK does, and plans the manifest", () => {
    const p = plan(TAX);
    const masx = p.masx!;
    expect(p).toMatchObject({ standard: "MASX", supply: 1_000_000n, decimals: undefined, supplyAsGiven: undefined });
    expect(masx.payload.manifest).toBe(encodedTax);
    expect(masx.payload.callsite).toBe("Init");
    expect(masx.payload.calldata).toBe(`0x${new ManifestCoder(TAXTOKEN as never).encodeArguments("Init", ACCOUNT, 300, 1_000_000).replace(/^0x/, "")}`);
    expect(masx.routines).toBe(2);
    expect(masx.bytes).toBe((encodedTax.length - 2) / 2);
    expect(masx.digest).toBe(digestOf(encodedTax));
    expect(masx.deployLine).toBe("Init (the only deploy routine in the manifest)");
    expect(masx.argsLine).toBe(JSON.stringify({ treasury_addr: ACCOUNT, bps: "300", initial_supply: "1000000" }));
    expect(masx.manifestLine).toMatch(/^2 routines \(1 deploy, 1 invoke\): Init, Transfer; 541 bytes encoded; SHA-256 of those bytes aae74411[0-9a-f]{56}; the symbol above is the asset's only name, because a compiled manifest carries none$/);
  });

  it("pins the fixture: a change to the compiled TaxToken shows here", () => {
    expect(digestOf(encodedTax)).toBe("aae74411b3bb7867e19913c84d50e5d47bec53426cd843c355570e5d4bce4024");
    expect(TAXTOKEN.kind).toBe("asset");
  });

  it("a wrong routine name is refused with the near miss offered and not applied; an invoke routine is not a deploy routine (R11)", () => {
    const near = refusal({ ...TAX, routine: "init" });
    expect(near.code).toBe("LOGIC_ROUTINE_NOT_FOUND");
    expect(near.message).toBe(`The manifest has no deploy routine "init" (did you mean "Init"?). Its deploy routines are: Init. ${NOTHING}`);
    const invoke = refusal({ ...TAX, routine: "Transfer" });
    expect(invoke.code).toBe("LOGIC_ROUTINE_NOT_FOUND");
    expect(invoke.message).toMatch(/no deploy routine "Transfer".*Its deploy routines are: Init\./);
  });

  it("two deploy routines need `routine` (R10, 'when the asset is created'), and the one named runs", () => {
    const r = refusal({ ...TAX, manifest: TWO_DEPLOYS_ASSET });
    expect(r.code).toBe("INVALID_ARGS");
    expect(r.message).toBe(`The manifest has 2 deploy routines: Init, Reinit. Pass routine to say which one runs when the asset is created. ${NOTHING}`);
    const chosen = plan({ ...TAX, manifest: TWO_DEPLOYS_ASSET, routine: "Reinit", args: { bps: 5 } });
    expect(chosen.masx).toMatchObject({ callsite: "Reinit", deployLine: "Reinit" });
    expect(chosen.masx!.payload.calldata).toBe(`0x${new ManifestCoder(TWO_DEPLOYS_ASSET as never).encodeArguments("Reinit", 5).replace(/^0x/, "")}`);
  });

  it("a manifest with no deploy routine plans the manifest alone; routine or a non-empty args is refused (R9)", () => {
    const p = plan({ symbol: "PLAIN", standard: "MASX", supply: "5", manifest: PLAIN_ASSET });
    expect(p.masx!.payload).toEqual({ manifest: ManifestCoder.encodeManifest(PLAIN_ASSET as never) });
    expect(p.masx).toMatchObject({ callsite: undefined, argsLine: "none" });
    expect(p.masx!.deployLine).toBe("none: the manifest has no deploy routine, so nothing runs when the asset is created and no callsite is sent");
    const r9 = `The manifest has no deploy routine, so nothing runs when the asset is created and no callsite is sent. Leave \`routine\` and \`args\` out. ${NOTHING}`;
    expect(refusal({ symbol: "P", standard: "MASX", supply: "5", manifest: PLAIN_ASSET, routine: "Init" }).message).toBe(r9);
    expect(refusal({ symbol: "P", standard: "MASX", supply: "5", manifest: PLAIN_ASSET, args: { a: 1 } }).message).toBe(r9);
    expect(() => plan({ symbol: "P", standard: "MASX", supply: "5", manifest: PLAIN_ASSET, args: {} })).not.toThrow();
  });

  it("a deploy routine with no inputs plans a callsite and no calldata, and an extra input is refused by the codec", () => {
    const p = plan({ symbol: "N", standard: "MASX", supply: "5", manifest: NO_INPUT_DEPLOY_ASSET });
    expect(p.masx!.payload).toEqual({ manifest: ManifestCoder.encodeManifest(NO_INPUT_DEPLOY_ASSET as never), callsite: "Init" });
    expect(p.masx!.argsLine).toBe("none");
    expect(refusal({ symbol: "N", standard: "MASX", supply: "5", manifest: NO_INPUT_DEPLOY_ASSET, args: { extra: 1 } }).message).toMatch(/has no input "extra"/);
  });

  it("a missing input, an unknown input, a negative amount, a fraction and a value past 64 bits are refused in the codec's words", () => {
    const withArgs = (args: Record<string, unknown>) => refusal({ ...TAX, args }).message;
    expect(withArgs({ treasury_addr: ACCOUNT, bps: 300 })).toMatch(/Missing input.*initial_supply/);
    expect(withArgs({ ...TAX_ARGS, nope: 1 })).toMatch(/has no input "nope"/);
    expect(withArgs({ ...TAX_ARGS, bps: -1 })).toMatch(/bps/);
    expect(withArgs({ ...TAX_ARGS, bps: 1.5 })).toMatch(/whole number/);
    expect(withArgs({ ...TAX_ARGS, initial_supply: "18446744073709551616" })).toMatch(/initial_supply/);
    expect(withArgs({ ...TAX_ARGS, treasury_addr: "nobody" })).toMatch(/treasury_addr/);
  });

  it("a logic manifest (R7), a manifest with no kind and one of kind bogus (R8) are refused", () => {
    expect(refusal({ ...TAX, manifest: LOGIC_KIND }).message).toBe(
      `This manifest is for a logic (its kind is "logic"), not an asset. A MASX asset is created from the manifest of a \`coco asset\` module (kind "asset"). To deploy a logic use moi_deploy_logic. ${NOTHING}`,
    );
    expect(refusal({ ...TAX, manifest: LOCK_LEDGER }).message).toMatch(/^This manifest is for a logic/);
    expect(refusal({ ...TAX, manifest: NO_KIND }).message).toBe(`The manifest's kind must be "asset", as a compiled asset manifest says; it has no kind. ${NOTHING}`);
    expect(refusal({ ...TAX, manifest: BOGUS_KIND }).message).toBe(`The manifest's kind must be "asset", as a compiled asset manifest says; got "bogus". ${NOTHING}`);
  });

  it("a manifest over either size cap is refused", () => {
    const big = { ...TAXTOKEN, padding: "x".repeat(140_000) };
    expect(refusal({ ...TAX, manifest: big }).message).toMatch(/too large: \d+ characters of JSON/);
    const heavy = { ...TAXTOKEN, elements: [...TAXTOKEN.elements.slice(0, -1), ...Array.from({ length: 400 }, (_, i) => ({ ptr: 100 + i, kind: "literal", data: { type: "string", value: "y".repeat(100) } })), TAXTOKEN.elements.at(-1)] };
    expect(refusal({ ...TAX, manifest: heavy }).message).toMatch(/too large: it encodes to \d+ bytes, and this tool takes at most 32768\./);
  });

  it("the same call with args in another key order, or an integer as a number and as a decimal string, gives the same text and binding", () => {
    const a = plan(TAX);
    const b = plan({ ...TAX, args: { initial_supply: 1_000_000, bps: "300", treasury_addr: ACCOUNT } });
    expect(b.masx!.argsLine).toBe(a.masx!.argsLine);
    expect(fingerprint(b.binding)).toBe(fingerprint(a.binding));
  });

  it("the binding of a MASX call holds the digest of the encoded manifest, the callsite and the calldata, and never the manifest itself", () => {
    const p = plan(TAX);
    expect(p.binding).toMatchObject({ standard: "MASX", symbol: "TAX", supply: "1000000", manifestSha256: digestOf(encodedTax), callsite: "Init", calldata: p.masx!.payload.calldata });
    expect(p.binding).not.toHaveProperty("manifest");
    expect(JSON.stringify(p.binding)).not.toContain(encodedTax.slice(2, 60));
    const other = plan({ ...TAX, manifest: { ...TAXTOKEN, elements: TAXTOKEN.elements.map((e) => (e["kind"] === "literal" ? { ...e, data: { ...(e["data"] as object), value: "0x032711" } } : e)) } });
    expect(fingerprint(other.binding)).not.toBe(fingerprint(p.binding));
  });
});

describe("what the confirm token binds", () => {
  it("a MAS0 or MAS2 call without decimals and the same call with decimals 0 have the same binding", () => {
    for (const standard of ["MAS0", "MAS2"]) {
      expect(fingerprint(plan({ symbol: "T", standard, supply: "5" }).binding)).toBe(fingerprint(plan({ symbol: "T", standard, supply: "5", decimals: 0 }).binding));
    }
  });

  it("a number and a string supply, and args {} and no args, bind the same; any real difference changes it", () => {
    const at = (over: Record<string, unknown>) => fingerprint(plan({ symbol: "T", supply: "5", ...over }).binding);
    expect(at({ supply: 5 })).toBe(at({}));
    expect(at({ args: {} })).toBe(at({}));
    for (const over of [{ symbol: "U" }, { supply: "6" }, { standard: "MAS2" }, { dimension: 1 }, { storageFund: "8000000000" }, { decimals: 2 }, { isStateful: true }]) {
      expect(at(over), JSON.stringify(over)).not.toBe(at({}));
    }
    expect(fingerprint(plan({ symbol: "T", standard: "MAS1" }).binding)).not.toBe(at({}));
  });
});

describe("describeCreate", () => {
  const ID = "0x1003000100000000000000000000000000000000000000000000000000000000";
  const FUND = 10_000_000_000n;
  const FEE = 22_450n;

  it("names the standard in plain words: MAS1 is one unit identified by token id, with no supply and no decimals", () => {
    const d = describeCreate(plan({ symbol: "NFTA", standard: "MAS1" }), ID, FUND, FEE);
    expect(d.description).toBe(
      "Create a MAS1 asset NFTA: one unit, identified by token id, with no supply and no decimals. 10 KMOI moves from your account into it to pay for its storage. The standard cannot be changed after the asset is created.",
    );
    expect(d.details["Standard"]).toBe("MAS1");
    expect(d.details["What this standard means (this server's words, not on the phone)"]).toBe(STANDARD_WORDS.MAS1);
    expect(STANDARD_WORDS.MAS1).toMatch(/^One unit, identified by token id\./);
    expect(d.details["Max supply in base units"]).toBe("1");
    expect(d.details["Decimals"]).toBe("none");
    expect(d.details).not.toHaveProperty("Max supply");
  });

  it("MAS0 and MAS2 say the supply and the decimals; MAS2 says fungible units under token ids", () => {
    const mas0 = describeCreate(plan({ symbol: "TST", supply: "1000", decimals: 2 }), ID, FUND, FEE);
    expect(mas0.description).toBe(
      "Create a MAS0 asset TST with a maximum supply of 1000, and move 10 KMOI from your account into it to pay for its storage. The standard cannot be changed after the asset is created.",
    );
    expect(mas0.details).toMatchObject({ "Max supply": "1000", "Max supply in base units": "100000", Decimals: "2", Standard: "MAS0" });
    const mas2 = describeCreate(plan({ symbol: "GOLD", standard: "MAS2", supply: "1000", decimals: 2 }), ID, 7_000_000_000n, FEE);
    expect(mas2.description).toBe(
      "Create a MAS2 asset GOLD: fungible units under token ids, with a maximum supply of 1000 and 2 decimals. 7 KMOI moves from your account into it to pay for its storage. The standard cannot be changed after the asset is created.",
    );
  });

  it("MASX says the manifest's routine count, the digest start, the deploy routine, the fee and that the code cannot be shown", () => {
    const d = describeCreate(plan(TAX), ID, FUND, FEE);
    expect(d.description).toBe(
      `Create a MASX asset TAX from a manifest of 2 routines (SHA-256 starting aae74411b3bb), running its deploy routine Init when the asset is created, and move 10 KMOI from your account into it to pay for its storage. ` +
        "This server cannot show what the asset's code does: the deploy routine runs at once with your account as the sender, as a logic's does, and the manifest decides what the asset's routines do afterwards. " +
        "Create from a manifest you got from a source you trust. The standard cannot be changed after the asset is created. The fuel costs at most 0.00002245 KMOI.",
    );
    expect(Object.keys(d.details)).toEqual([
      "Operation",
      "Symbol",
      "Standard",
      "What this standard means (this server's words, not on the phone)",
      "Max supply in base units",
      "Decimals",
      "Dimension (0 Economic, 1 Possession)",
      "New asset's id, predicted (the funding below is paid to it)",
      "Storage fund, KMOI base units (deposited into the asset's own account, not spent)",
      "Deploy routine (the callsite)",
      "Arguments",
      "Manifest, read by this server (the phone shows only its bytes)",
    ]);
    const none = describeCreate(plan({ symbol: "PLAIN", standard: "MASX", supply: "5", manifest: PLAIN_ASSET }), ID, FUND, FEE);
    expect(none.description).toMatch(/from a manifest of 2 routines \(SHA-256 starting [0-9a-f]{12}\), with no deploy routine to run, and move 10 KMOI/);
  });

  it("keeps the keys of the lines it had, in order, with the storage fund as a bare base-unit string and the id it was given", () => {
    const d = describeCreate(plan({ symbol: "TST", supply: "1000", decimals: 2 }), ID, FUND, FEE);
    expect(Object.keys(d.details)).toEqual([
      "Operation",
      "Symbol",
      "Standard",
      "What this standard means (this server's words, not on the phone)",
      "Max supply",
      "Max supply in base units",
      "Decimals",
      "Dimension (0 Economic, 1 Possession)",
      "New asset's id, predicted (the funding below is paid to it)",
      "Storage fund, KMOI base units (deposited into the asset's own account, not spent)",
    ]);
    expect(d.details["Storage fund, KMOI base units (deposited into the asset's own account, not spent)"]).toBe("10000000000");
    expect(d.details["New asset's id, predicted (the funding below is paid to it)"]).toBe(ID);
    expect(d.details["Operation"]).toBe("Create asset");
  });

  it("gives the same details for the same plan whatever the fee, so the confirm step does not see a number that only the fuel estimate moved", () => {
    for (const raw of [{ symbol: "A", supply: "5" }, { symbol: "B", standard: "MAS1" }, TAX]) {
      const p = plan(raw);
      expect(fingerprint(describeCreate(p, ID, FUND, 1n).details)).toBe(fingerprint(describeCreate(p, ID, FUND, 99_999_999n).details));
    }
    for (const [key, value] of Object.entries(describeCreate(plan(TAX), ID, FUND, 123_456_789n).details)) {
      expect(`${key} ${value}`, key).not.toContain("0.123456789");
    }
  });
});

describe("these files stay pure", () => {
  it("create-plan.ts and create-masx.ts reach nothing under src/tools, src/wc or the journal", () => {
    for (const file of ["src/capabilities/assets/create-plan.ts", "src/capabilities/assets/create-masx.ts"]) {
      const graph = importGraph(file);
      expect(graph.files.length, file).toBeGreaterThan(3);
      const reached = graph.files.filter((f) => f.startsWith("src/tools/") || f.startsWith("src/wc/") || f === "src/journal.ts");
      expect(reached.map((name) => graph.chain(name).join(" -> ")), file).toEqual([]);
    }
  });
});
