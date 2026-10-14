/**
 * Resolving and planning a call, with no node: the pure half of moi_asset_invoke, and the proof that the generic path
 * writes the same bytes as the shortcut builders (buildTransfer, buildMint) so the two cannot drift apart.
 */

import { LockType } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  planAssetCall,
  resolveFromManifest,
  type AssetCallInput,
  type AssetCallPlan,
} from "../../src/capabilities/assets/invoke.js";
import { readManifest, type AssetRef } from "../../src/capabilities/assets/routines.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { buildAssetInvoke, buildMint, buildTransfer, toPoloHex, type SenderInfo } from "../../src/moi/ix-builder.js";
import {
  MAS0_MANIFEST,
  MASN_MANIFEST,
  MASX_MANIFEST,
  PIXEL,
  callable,
  syntheticManifest,
  type ManifestLike,
} from "../helpers/asset-fixtures.js";
import { ACCOUNT, KMOI, LOGIC, MASX_ASSET, OTHER } from "../helpers/mock-node.js";

const SENDER: SenderInfo = { id: ACCOUNT, sequence: 3, keyId: 0 };
const PIXEL_REF: AssetRef = { assetId: PIXEL, symbol: "PIXEL", standard: "MAS0", decimals: 0 };
const KMOI_REF: AssetRef = { assetId: KMOI, symbol: "KMOI", standard: "MASN", decimals: 9 };
const MASX_REF: AssetRef = { assetId: MASX_ASSET, symbol: "KMOI", standard: "MASX", decimals: 0 };

function plan(manifest: ManifestLike, ref: AssetRef, routine: string, args: Record<string, unknown>, participants?: AssetCallInput["participants"]): AssetCallPlan {
  const target = resolveFromManifest(ref, readManifest(manifest, ref), routine);
  return planAssetCall(target, { assetId: ref.assetId, routine, args, ...(participants ? { participants } : {}) });
}

/** The error a call throws, so a test can read its code and its text. */
function refusal(fn: () => unknown): MoiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoiError);
    return err as MoiError;
  }
  throw new Error("expected a refusal");
}

describe("the generic path writes the same bytes as the shortcuts", () => {
  const AMOUNTS = [1n, 5n, 1_000_000n, 2n ** 40n, 2n ** 53n + 1n, 2n ** 64n - 1n];

  it("MAS0 Transfer, for the amounts that straddle where POLO changes width and for two recipients", () => {
    for (const to of [ACCOUNT, OTHER]) {
      for (const amount of AMOUNTS) {
        const p = plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: to, amount: amount.toString() });
        const generic = buildAssetInvoke(SENDER, { assetId: PIXEL, callsite: "Transfer", ...(p.calldata ? { calldata: p.calldata } : {}), participants: p.participants });
        const shortcut = buildTransfer(SENDER, { to, assetId: PIXEL, amount });
        const label = `${to.slice(0, 12)} ${amount}`;
        expect(generic.ix_operations, label).toEqual(shortcut.ix_operations);
        expect(generic.participants, label).toEqual(shortcut.participants);
        expect(toPoloHex(generic), label).toBe(toPoloHex(shortcut));
      }
    }
  });

  it("MASN Transfer on the native asset", () => {
    for (const to of [ACCOUNT, OTHER]) {
      for (const amount of AMOUNTS) {
        const p = plan(MASN_MANIFEST, KMOI_REF, "Transfer", { beneficiary: to, amount: amount.toString() });
        const generic = buildAssetInvoke(SENDER, { assetId: KMOI, callsite: "Transfer", ...(p.calldata ? { calldata: p.calldata } : {}), participants: p.participants });
        const shortcut = buildTransfer(SENDER, { to, assetId: KMOI, amount });
        expect(generic.ix_operations).toEqual(shortcut.ix_operations);
        expect(generic.participants).toEqual(shortcut.participants);
        expect(toPoloHex(generic)).toBe(toPoloHex(shortcut));
      }
    }
  });

  it("MAS0 Mint", async () => {
    for (const to of [ACCOUNT, OTHER]) {
      for (const amount of AMOUNTS) {
        const p = plan(MAS0_MANIFEST, PIXEL_REF, "Mint", { beneficiary: to, amount: amount.toString() });
        const generic = buildAssetInvoke(SENDER, { assetId: PIXEL, callsite: "Mint", ...(p.calldata ? { calldata: p.calldata } : {}), participants: p.participants });
        const shortcut = await buildMint({}, SENDER, { assetId: PIXEL, to, amount });
        expect(generic.ix_operations).toEqual(shortcut.ix_operations);
        expect(generic.participants).toEqual(shortcut.participants);
        expect(toPoloHex(generic)).toBe(toPoloHex(shortcut));
      }
    }
  });

  it("gives the same bytes for an amount sent as a number, as a decimal string, and as a string past the safe range", () => {
    const calldata = (amount: unknown) => plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: OTHER, amount }).calldata;
    expect(calldata(5)).toBe(calldata("5"));
    expect(calldata(Number.MAX_SAFE_INTEGER)).toBe(calldata(String(Number.MAX_SAFE_INTEGER)));
    expect(calldata("9007199254740993")).not.toBe(calldata("9007199254740992"));
  });
});

describe("resolveFromManifest", () => {
  it("refuses an unknown routine with the names the manifest has", () => {
    const err = refusal(() => resolveFromManifest(PIXEL_REF, readManifest(MAS0_MANIFEST, PIXEL_REF), "Nope"));
    expect(err.code).toBe(ErrorCode.LOGIC_ROUTINE_NOT_FOUND);
    expect(err.message).toContain('has no routine "Nope"');
    expect(err.message).toContain("Its routines are:");
    expect(err.message).toMatch(/Transfer.*BalanceOf/);
    expect(err.message).toContain("moi_asset_routines lists their inputs");
  });

  it("offers the right case of a name and does not apply it", () => {
    const err = refusal(() => resolveFromManifest(PIXEL_REF, readManifest(MAS0_MANIFEST, PIXEL_REF), "transfer"));
    expect(err.message).toContain('did you mean "Transfer"');
  });

  it("says a routine of the manifest is not usable when some were left out", () => {
    const clash = syntheticManifest([callable(5, "Transfer", "dynamic", []), callable(5, "Other", "dynamic", [])]);
    const err = refusal(() => resolveFromManifest(MASX_REF, readManifest(clash, MASX_REF), "Transfer"));
    expect(err.message).toMatch(/1 further routine in the manifest is not usable by this server/);
  });

  it("finds nothing under the names Object.prototype has", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(refusal(() => resolveFromManifest(PIXEL_REF, readManifest(MAS0_MANIFEST, PIXEL_REF), name)).code).toBe(
        ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      );
    }
  });

  it("cuts a long list of names and says how many more there are", () => {
    const many = syntheticManifest(Array.from({ length: 60 }, (_, i) => callable(i, `Op${i}`, "dynamic", [])));
    const err = refusal(() => resolveFromManifest(MASX_REF, readManifest(many, MASX_REF), "Nope"));
    expect(err.message).toContain("Op39");
    expect(err.message).not.toContain("Op40,");
    expect(err.message).toContain("and 20 more");
  });

  it("describes a write routine of a built-in standard and leaves a read without a spec", () => {
    const view = readManifest(MAS0_MANIFEST, PIXEL_REF);
    expect(resolveFromManifest(PIXEL_REF, view, "Burn").spec).toBeDefined();
    expect(resolveFromManifest(PIXEL_REF, view, "BalanceOf").spec).toBeUndefined();
  });
});

describe("planning a read", () => {
  it("takes no participants", () => {
    const err = refusal(() => plan(MAS0_MANIFEST, PIXEL_REF, "BalanceOf", { address: ACCOUNT }, []));
    expect(err.code).toBe(ErrorCode.INVALID_ARGS);
    expect(err.message).toMatch(/only reads, so it takes no participants/);
  });

  it("is refused when it returns a type this server cannot decode", () => {
    const odd = syntheticManifest([callable(0, "Peek", "static", [], [["thing", "class.Foo"]])]);
    expect(refusal(() => plan(odd, MASX_REF, "Peek", {})).message).toMatch(/returns "thing" as class\.Foo, which this server cannot decode yet/);
  });

  it("has no participants and no details, and a routine with no inputs has no calldata", () => {
    const p = plan(MAS0_MANIFEST, PIXEL_REF, "Symbol", {});
    expect(p).toEqual({ calldata: undefined, participants: [], description: "Read Symbol of PIXEL", details: {} });
    expect(plan(MAS0_MANIFEST, PIXEL_REF, "BalanceOf", { address: ACCOUNT }).calldata).toMatch(/^[0-9a-f]+$/);
  });

  it("plans a static routine as a read and an unknown mode as a write", () => {
    const manifest = syntheticManifest([callable(0, "Peek", "static", []), callable(1, "Odd", "weird", [["x", "u64"]])]);
    expect(plan(manifest, MASX_REF, "Peek", {}).participants).toEqual([]);
    expect(refusal(() => plan(manifest, MASX_REF, "Odd", { x: 1 })).message).toMatch(/no description for Odd/);
    expect(plan(manifest, MASX_REF, "Odd", { x: 1 }, []).description).toBe("Call Odd on asset KMOI");
  });
});

describe("planning a write this server does not describe", () => {
  it("is refused without participants, and plans with an empty list", () => {
    const err = refusal(() => plan(MASX_MANIFEST, MASX_REF, "Deposit", { amount: 5 }));
    expect(err.code).toBe(ErrorCode.INVALID_ARGS);
    expect(err.message).toMatch(/no description for Deposit/);
    expect(err.message).toMatch(/participants/);
    expect(err.message).toMatch(/Nothing was sent to your wallet/);
    expect(plan(MASX_MANIFEST, MASX_REF, "Deposit", { amount: 5 }, []).participants).toEqual([]);
  });

  it("shows the raw routine and its validated arguments, and says plainly it has no description", () => {
    const p = plan(MASX_MANIFEST, MASX_REF, "Deposit", { amount: 5 }, []);
    expect(p.description).toBe("Call Deposit on asset KMOI");
    expect(p.details).toEqual({
      Operation: "Invoke asset routine",
      Asset: `KMOI ${MASX_ASSET}`,
      Standard: "MASX",
      Routine: "Deposit",
      Arguments: '{"amount":"5"}',
      Description:
        "This server has no description for the routine Deposit on a MASX asset. The values above are the arguments after validation; nothing here says what the routine does.",
    });
    expect(p.hint).toMatch(/participants/);
  });

  it("renders the same text whatever the key order or the number's form, which the confirm step compares", () => {
    const manifest = syntheticManifest([callable(0, "Put", "dynamic", [["static_metadata", "map[string]bytes"], ["n", "u64"]])]);
    const text = (args: Record<string, unknown>) => plan(manifest, MASX_REF, "Put", args, []).details["Arguments"];
    const a = text({ static_metadata: { b: "0x02", a: "0x01" }, n: 5 });
    expect(a).toBe('{"static_metadata":{"a":"0x01","b":"0x02"},"n":"5"}');
    expect(text({ n: "5", static_metadata: { a: "0x01", b: "0x02" } })).toBe(a);
  });

  it("lists the arguments in the manifest's order, not the caller's", () => {
    const p = plan(MASX_MANIFEST, MASX_REF, "Swap", { amount: 1, asset: OTHER }, []);
    expect(p.details["Arguments"]).toBe(`{"asset":"${OTHER}","amount":"1"}`);
  });

  it("cuts a very long argument list in the preview", () => {
    const manifest = syntheticManifest([callable(0, "Put", "dynamic", [["names", "[]string"]])]);
    const p = plan(manifest, MASX_REF, "Put", { names: Array.from({ length: 200 }, () => "x".repeat(40)) }, []);
    expect(p.details["Arguments"]!.length).toBeLessThanOrEqual(2001);
    expect(p.details["Arguments"]).toMatch(/…$/);
  });

  it("keeps the caller's participants as given, shows them, and lets an undescribed call carry them", () => {
    const p = plan(MASX_MANIFEST, MASX_REF, "Swap", { asset: OTHER, amount: 1 }, [{ id: OTHER, lock: "mutate" }]);
    expect(p.participants).toEqual([{ id: OTHER, lock: "mutate" }]);
    expect(p.details["Other participants"]).toBe(`${OTHER} (mutate)`);
  });
});

describe("planning a write this server describes", () => {
  it("adds the caller's participants after the standard's and shows them", () => {
    const p = plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: OTHER, amount: 5 }, [{ id: LOGIC, lock: "read" }]);
    expect(p.participants).toEqual([
      { id: OTHER, lock: "mutate" },
      { id: PIXEL, lock: "none" },
      { id: LOGIC, lock: "read" },
    ]);
    expect(p.details["Other participants"]).toBe(`${LOGIC} (read)`);
    expect(plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: OTHER, amount: 5 }).details).not.toHaveProperty("Other participants");
  });

  it("keeps the strongest lock when a caller names an account the standard already lists", () => {
    const p = plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: OTHER, amount: 5 }, [{ id: PIXEL, lock: "mutate" }]);
    const ix = buildAssetInvoke(SENDER, { assetId: PIXEL, callsite: "Transfer", calldata: p.calldata ?? "", participants: p.participants });
    expect(ix.participants).toEqual([
      { id: OTHER, lock_type: LockType.MUTATE_LOCK },
      { id: PIXEL, lock_type: LockType.MUTATE_LOCK },
    ]);
  });

  it("uses the standard's sentence, details and hint", () => {
    const p = plan(MAS0_MANIFEST, PIXEL_REF, "Burn", { amount: 5 });
    expect(p.description).toBe("Burn 5 PIXEL");
    expect(p.details).toEqual({ Operation: "Burn", Asset: `PIXEL ${PIXEL}`, Amount: "5", "Amount in base units": "5" });
    expect(p.hint).toBe("You can only burn what the signing account holds.");
    expect(p.participants).toEqual([{ id: PIXEL, lock: "mutate" }]);
  });

  it("surfaces an input check of the standard: a zero amount and an empty key", () => {
    expect(refusal(() => plan(MAS0_MANIFEST, PIXEL_REF, "Burn", { amount: 0 })).message).toMatch(/Burn with an amount of 0 moves nothing/);
    expect(refusal(() => plan(MAS0_MANIFEST, PIXEL_REF, "SetStaticMetadata", { key: "", value: "0x01" })).message).toMatch(/needs a non-empty key/);
  });

  it("refuses an input the routine does not take, which is how an amount on a routine without one is refused", () => {
    expect(refusal(() => plan(MAS0_MANIFEST, PIXEL_REF, "Revoke", { beneficiary: OTHER, amount: 1 })).message).toMatch(/Revoke has no input "amount"/);
  });
});

describe("buildAssetInvoke over a plan", () => {
  it("makes one ASSET_INVOKE operation, with calldata that has no 0x, and one entry for an id named twice in two cases", () => {
    const p = plan(MAS0_MANIFEST, PIXEL_REF, "Transfer", { beneficiary: OTHER, amount: 5 }, [{ id: OTHER.toUpperCase().replace("0X", "0x"), lock: "none" }]);
    const ix = buildAssetInvoke(SENDER, { assetId: PIXEL, callsite: "Transfer", ...(p.calldata ? { calldata: p.calldata } : {}), participants: p.participants });
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(5);
    expect(String(ix.ix_operations[0]!.payload["calldata"])).toMatch(/^[0-9a-f]+$/);
    expect(ix.participants).toEqual([
      { id: OTHER, lock_type: LockType.MUTATE_LOCK },
      { id: PIXEL, lock_type: LockType.NO_LOCK },
    ]);
  });
});
