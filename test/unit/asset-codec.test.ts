import { MAS0AssetLogic, ManifestCoder, buildTransferPayload, hexToBytes } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  MAX_BYTES_HEX,
  MAX_ENTRIES,
  MAX_OUT_ENTRIES,
  MAX_OUT_TEXT,
  MAX_TEXT,
  acceptsLine,
  coerceArgs,
  encodeCalldata,
  parseType,
  shapeOutputs,
  showValue,
  type Coerced,
  type Field,
} from "../../src/capabilities/assets/codec.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { MAS0_MANIFEST, PIXEL, callable, fieldsOf, syntheticManifest } from "../helpers/asset-fixtures.js";
import { ACCOUNT, OTHER } from "../helpers/mock-node.js";

const coder = new ManifestCoder(MAS0_MANIFEST as never);
const TRANSFER = fieldsOf(MAS0_MANIFEST, "Transfer");
const BURN = fieldsOf(MAS0_MANIFEST, "Burn");
const PLAIN = { decimals: 0 };

/** Run coerceArgs and return the MoiError it throws, so a test can read its code and its text. */
function refusal(fn: () => unknown): MoiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoiError);
    return err as MoiError;
  }
  throw new Error("expected a refusal");
}

const amountArgs = (amount: unknown) => ({ beneficiary: OTHER, amount });
const burn = (amount: unknown, asset = PLAIN) => () => coerceArgs("Burn", BURN.accepts, { amount }, asset);

describe("parseType", () => {
  it("knows the primitives, lists and maps of strings", () => {
    expect(parseType("identifier")).toEqual({ kind: "identifier" });
    expect(parseType("bytes")).toEqual({ kind: "bytes" });
    expect(parseType("string")).toEqual({ kind: "string" });
    expect(parseType("bool")).toEqual({ kind: "bool" });
    expect(parseType("u64")).toEqual({ kind: "int", signed: false });
    expect(parseType("u256")).toEqual({ kind: "int", signed: false });
    expect(parseType("i64")).toEqual({ kind: "int", signed: true });
    expect(parseType("i256")).toEqual({ kind: "int", signed: true });
    expect(parseType("bigint")).toEqual({ kind: "int", signed: true });
    expect(parseType("[]u64")).toEqual({ kind: "array", of: { kind: "int", signed: false } });
    expect(parseType("map[string]bytes")).toEqual({ kind: "map", of: { kind: "bytes" } });
    expect(parseType("[]map[string]u64")).toEqual({
      kind: "array",
      of: { kind: "map", of: { kind: "int", signed: false } },
    });
  });

  it("answers undefined, and never throws, for every other type", () => {
    for (const odd of ["[4]u64", "map[u64]string", "class.Foo", "mapx", "[]", "", null, undefined, 5, "map[string]", "[][]"]) {
      expect(parseType(odd as never)).toBeUndefined();
    }
  });
});

describe("coerceArgs", () => {
  it("turns Transfer's inputs into canonical values by label", () => {
    const got = coerceArgs("Transfer", TRANSFER.accepts, amountArgs("5"), PLAIN);
    expect(got).toEqual(new Map<string, Coerced>([["beneficiary", OTHER], ["amount", 5n]]));
  });

  it("encodes an amount the same whether it arrives as a number or a decimal string, and as the SDK's own builder does", () => {
    const sdkAmount = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
    const cases: Array<[number | string, string?]> = [
      [0, "0"],
      [1, "1"],
      [10 ** 6, "1000000"],
      [2 ** 40, String(2 ** 40)],
      [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
      ["9007199254740993"],
      ["18446744073709551615"],
    ];
    for (const [amount, asText] of cases) {
      const calldata = (v: unknown) =>
        encodeCalldata(coder, "Transfer", TRANSFER.accepts, coerceArgs("Transfer", TRANSFER.accepts, amountArgs(v), PLAIN));
      const mine = calldata(amount);
      if (asText !== undefined) expect(calldata(asText)).toBe(mine);
      const sdk = buildTransferPayload(PIXEL as never, OTHER as never, sdkAmount(BigInt(amount)) as never) as { calldata: string };
      expect(mine).toBe(String(sdk.calldata).replace(/^0x/, ""));
    }
  });

  it("refuses a missing input and says what the routine takes", () => {
    const err = refusal(() => coerceArgs("Transfer", TRANSFER.accepts, { beneficiary: OTHER }, PLAIN));
    expect(err.code).toBe(ErrorCode.INVALID_ARGS);
    expect(err.message).toMatch(/Missing input "amount" \(u256\) for Transfer/);
    expect(err.message).toContain("Transfer takes: beneficiary (identifier), amount (u256)");
    expect(err.message).toContain("Nothing was sent to your wallet.");
  });

  it("refuses an input the routine does not list, and counts undefined as missing", () => {
    expect(refusal(() => coerceArgs("Transfer", TRANSFER.accepts, { ...amountArgs(1), amnt: 1 }, PLAIN)).message).toMatch(
      /Transfer has no input "amnt"/,
    );
    expect(refusal(() => coerceArgs("Transfer", TRANSFER.accepts, amountArgs(undefined), PLAIN)).message).toMatch(
      /Missing input "amount"/,
    );
  });

  it("finds a label named __proto__ as an own key and not on the prototype", () => {
    // A zod-parsed record drops an own __proto__ key before a handler runs, so this is a test of the codec itself.
    const hostile = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    expect(refusal(() => coerceArgs("Transfer", TRANSFER.accepts, hostile, PLAIN)).message).toMatch(/no input "__proto__"/);
    const accepts: Field[] = [{ slot: 0, label: "__proto__", type: "u64" }];
    expect(coerceArgs("Odd", accepts, hostile, PLAIN).get("__proto__")).toBe(1n);
    expect(refusal(() => coerceArgs("Odd", accepts, {}, PLAIN)).message).toMatch(/Missing input "__proto__"/);
  });

  it("refuses anything but a whole number in base units, and says why", () => {
    const bad: unknown[] = ["1.5", 1.5, "1e3", "0x10", "", " 5", "+5", Number.NaN, Number.POSITIVE_INFINITY, null, true, {}];
    for (const value of bad) {
      const err = refusal(burn(value));
      expect(err.code).toBe(ErrorCode.INVALID_ARGS);
      expect(err.message).toMatch(/Input "amount" must be a whole number in base units \(a number or a decimal string\), got /);
    }
    // The decimals hint appears only for an asset that has decimals.
    expect(refusal(burn("1.5")).message).not.toMatch(/decimals/);
    expect(refusal(burn("1.5", { decimals: 9 })).message).toMatch(/This asset has 9 decimals, so one whole token is 10\^9 base units/);
    // A number past the safe range loses precision in JSON before it gets here.
    expect(refusal(burn(2 ** 53)).message).toMatch(/lose precision in JSON: send the value as a decimal string/);
    expect(refusal(burn("1.5")).message).not.toMatch(/lose precision/);
  });

  it("refuses a negative unsigned integer and one past 64 bits, and takes a negative signed one", () => {
    expect(refusal(burn("-1")).message).toMatch(/Input "amount" cannot be negative/);
    expect(refusal(burn(-1)).message).toMatch(/cannot be negative/);
    const tooBig = refusal(burn("18446744073709551616")).message;
    expect(tooBig).toMatch(/Input "amount" is too large/);
    expect(tooBig).toMatch(/18446744073709551615 \(64 bits\)/);
    const signed: Field[] = [{ slot: 0, label: "delta", type: "i64" }];
    expect(coerceArgs("Odd", signed, { delta: -7 }, PLAIN).get("delta")).toBe(-7n);
    expect(coerceArgs("Odd", signed, { delta: "-7" }, PLAIN).get("delta")).toBe(-7n);
  });

  it("takes an identifier in either case and refuses everything else", () => {
    const id: Field[] = [{ slot: 0, label: "who", type: "identifier" }];
    const upper = `0x${"AB".repeat(32)}`;
    expect(coerceArgs("Odd", id, { who: upper }, PLAIN).get("who")).toBe(upper);
    const bad: unknown[] = ["0x1234", OTHER.slice(2), OTHER.slice(0, -1), `${OTHER}0`, `0x${"zz".repeat(32)}`, 5, null, true];
    for (const who of bad) {
      expect(refusal(() => coerceArgs("Odd", id, { who }, PLAIN)).message).toMatch(
        /Input "who" must be a MOI identifier: 0x followed by 64 hex characters/,
      );
    }
  });

  it("takes bytes as 0x and an even number of hex digits, text as text, and a bool only as true or false", () => {
    const b: Field[] = [{ slot: 0, label: "v", type: "bytes" }];
    for (const v of ["0x0102", "0x"]) expect(coerceArgs("Odd", b, { v }, PLAIN).get("v")).toBe(v);
    for (const v of ["0x1", "0xzz", "0102", 1, `0x${"ab".repeat(MAX_BYTES_HEX / 2 + 1)}`]) {
      expect(refusal(() => coerceArgs("Odd", b, { v }, PLAIN)).message).toMatch(/Input "v" must be bytes: 0x followed by an even number/);
    }
    expect(coerceArgs("Odd", b, { v: `0x${"ab".repeat(MAX_BYTES_HEX / 2)}` }, PLAIN).has("v")).toBe(true);

    const s: Field[] = [{ slot: 0, label: "t", type: "string" }];
    expect(coerceArgs("Odd", s, { t: "hello" }, PLAIN).get("t")).toBe("hello");
    expect(refusal(() => coerceArgs("Odd", s, { t: "x".repeat(MAX_TEXT + 1) }, PLAIN)).message).toMatch(/Input "t" must be text/);
    expect(refusal(() => coerceArgs("Odd", s, { t: 5 }, PLAIN)).message).toMatch(/Input "t" must be text/);

    const f: Field[] = [{ slot: 0, label: "on", type: "bool" }];
    expect(coerceArgs("Odd", f, { on: false }, PLAIN).get("on")).toBe(false);
    expect(refusal(() => coerceArgs("Odd", f, { on: "true" }, PLAIN)).message).toMatch(/Input "on" must be true or false/);
  });
});

describe("maps and lists", () => {
  const MINT_META = fieldsOf(MAS0_MANIFEST, "MintWithMetadata");

  it("takes map[string]bytes as an object and writes what the SDK's mintWithMetadata writes", () => {
    const args = { beneficiary: OTHER, amount: 5, static_metadata: { k: "0x0102" } };
    const coerced = coerceArgs("MintWithMetadata", MINT_META.accepts, args, PLAIN);
    expect(coerced.get("static_metadata")).toEqual(new Map([["k", "0x0102"]]));
    const mine = encodeCalldata(coder, "MintWithMetadata", MINT_META.accepts, coerced);
    const sdk = new MAS0AssetLogic(PIXEL, {} as never).mintWithMetadata(OTHER, 5, { k: hexToBytes("0x0102") } as never);
    expect(mine).toBe(String(sdk.payload().calldata).replace(/^0x/, ""));
  });

  it("refuses a bad map, naming the path of the entry that is wrong", () => {
    const run = (static_metadata: unknown) => () =>
      coerceArgs("MintWithMetadata", MINT_META.accepts, { beneficiary: OTHER, amount: 5, static_metadata }, PLAIN);
    expect(refusal(run([])).message).toMatch(/Input "static_metadata" must be an object/);
    expect(refusal(run(null)).message).toMatch(/Input "static_metadata" must be an object/);
    expect(refusal(run({ k: "zz" })).message).toMatch(/Input "static_metadata\.k" must be bytes/);
    const many = Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "0x01"]));
    expect(refusal(run(many)).message).toMatch(/at most 256 entries/);
  });

  const ODD = syntheticManifest([
    callable(0, "Odd", "dynamic", [
      ["xs", "[]u64"],
      ["ids", "[]identifier"],
      ["flag", "bool"],
      ["delta", "i64"],
      ["nested", "map[string]map[string]u64"],
      ["names", "[]string"],
      ["blobs", "[]bytes"],
    ]),
  ]);
  const odd = fieldsOf(ODD, "Odd");
  const oddArgs = {
    xs: [1, "2", 3],
    ids: [OTHER, ACCOUNT],
    flag: true,
    delta: -4,
    nested: { a: { x: 1 }, b: {} },
    names: ["a", "", "b"],
    blobs: ["0x01", "0x"],
  };

  it("encodes lists, bools, signed integers and nested maps, and the round trip agrees", () => {
    const oddCoder = new ManifestCoder(ODD as never);
    const coerced = coerceArgs("Odd", odd.accepts, oddArgs, PLAIN);
    expect(coerced.get("xs")).toEqual([1n, 2n, 3n]);
    expect(encodeCalldata(oddCoder, "Odd", odd.accepts, coerced)).toMatch(/^[0-9a-f]+$/);
    const empties = coerceArgs("Odd", odd.accepts, { ...oddArgs, xs: [], ids: [], nested: {}, names: [], blobs: [] }, PLAIN);
    expect(encodeCalldata(oddCoder, "Odd", odd.accepts, empties)).toMatch(/^[0-9a-f]+$/);
  });

  it("refuses a non-list, a bad element named by its index, and a list that is too long", () => {
    const run = (patch: Record<string, unknown>) => () => coerceArgs("Odd", odd.accepts, { ...oddArgs, ...patch }, PLAIN);
    expect(refusal(run({ xs: "1,2" })).message).toMatch(/Input "xs" must be a list/);
    expect(refusal(run({ xs: [1, "x"] })).message).toMatch(/Input "xs\[1\]" must be a whole number/);
    expect(refusal(run({ ids: [OTHER, "0x12"] })).message).toMatch(/Input "ids\[1\]" must be a MOI identifier/);
    expect(refusal(run({ nested: { a: { x: -1 } } })).message).toMatch(/Input "nested\.a\.x" cannot be negative/);
    expect(refusal(run({ xs: Array.from({ length: MAX_ENTRIES + 1 }, () => 1) })).message).toMatch(/at most 256 entries/);
  });

  it("refuses a type it cannot encode instead of guessing", () => {
    for (const type of ["[2]u64", "class.Foo", "map[u64]string"]) {
      const accepts: Field[] = [{ slot: 0, label: "x", type }];
      expect(refusal(() => coerceArgs("Odd", accepts, { x: 1 }, PLAIN)).message).toMatch(
        new RegExp(`Input "x" has type ${type.replace(/[\][.]/g, "\\$&")}, which this server cannot encode yet`),
      );
    }
    // A null type reaches the same refusal: parseType answers undefined for it.
    expect(refusal(() => coerceArgs("Odd", [{ slot: 0, label: "x", type: null as never }], { x: 1 }, PLAIN)).message).toMatch(
      /cannot encode yet/,
    );
  });
});

describe("a routine with no inputs", () => {
  it("has no calldata at all, and its inputs read as none", () => {
    const symbol = fieldsOf(MAS0_MANIFEST, "Symbol");
    expect(encodeCalldata(coder, "Symbol", symbol.accepts, new Map())).toBeUndefined();
    expect(acceptsLine(symbol.accepts)).toBe("no inputs");
    expect(acceptsLine(TRANSFER.accepts)).toBe("beneficiary (identifier), amount (u256)");
  });
});

describe("the round trip", () => {
  const KV = fieldsOf(MAS0_MANIFEST, "SetStaticMetadata");
  const set = (key: string, value = "0x01") => () =>
    encodeCalldata(coder, "SetStaticMetadata", KV.accepts, coerceArgs("SetStaticMetadata", KV.accepts, { key, value }, PLAIN));

  it("refuses a string that is 0x and hex digits, because the coder would send it without the prefix", () => {
    const err = refusal(set("0xabc"));
    expect(err.code).toBe(ErrorCode.INVALID_ARGS);
    expect(err.message).toMatch(/Input "key" would not reach the chain as given/);
    expect(err.message).toContain('"0xabc"');
    expect(err.message).toContain('"abc"');
  });

  it("lets through the strings the coder leaves alone", () => {
    // "0x" alone is not hex digits and "" has none: neither is trimmed, so both reach the chain as given.
    for (const key of ["0xhello", "abc", "", "0x"]) expect(set(key)()).toMatch(/^[0-9a-f]+$/);
  });

  it("encodes by slot, not by position, when a manifest numbers its inputs out of order", () => {
    const manifest = syntheticManifest([
      {
        ...callable(0, "Swap", "dynamic", []),
        data: {
          name: "Swap",
          mode: "dynamic",
          kind: "invoke",
          accepts: [
            { slot: 1, label: "count", type: "u64" },
            { slot: 0, label: "who", type: "identifier" },
          ],
          returns: [],
          executes: { hex: "", asm: [] },
          catches: [],
        },
      },
    ]);
    const swap = fieldsOf(manifest, "Swap");
    const swapCoder = new ManifestCoder(manifest as never);
    const coerced = coerceArgs("Swap", swap.accepts, { who: OTHER, count: 9 }, PLAIN);
    const calldata = encodeCalldata(swapCoder, "Swap", swap.accepts, coerced) ?? "";
    expect(swapCoder.decodeArguments("Swap", `0x${calldata}`)).toEqual([9, hexToBytes(OTHER)]);
  });

  it("surfaces the SDK's refusal for a value past 64 bits that skipped coerceArgs, as an INVALID_ARGS", () => {
    const err = refusal(() => encodeCalldata(coder, "Burn", BURN.accepts, new Map<string, Coerced>([["amount", 2n ** 64n]])));
    expect(err.code).toBe(ErrorCode.INVALID_ARGS);
    expect(err.message).toMatch(/^Could not encode the inputs of Burn: .*byte array longer than desired length/);
  });

  it("does not rely on the round trip for a sign: a negative u256 survives it, so coerceArgs is what refuses it", () => {
    const encoded = coder.encodeArguments("Burn", -1);
    expect(coder.decodeArguments("Burn", encoded)).toEqual([-1]);
    expect(refusal(burn(-1)).message).toMatch(/cannot be negative/);
  });
});

describe("showValue", () => {
  it("renders a Map with its keys sorted, so the same call in another key order reads the same", () => {
    const a = new Map<string, Coerced>([["b", 1n], ["a", 2n]]);
    const b = new Map<string, Coerced>([["a", 2n], ["b", 1n]]);
    expect(JSON.stringify(showValue(a))).toBe('{"a":"2","b":"1"}');
    expect(JSON.stringify(showValue(a))).toBe(JSON.stringify(showValue(b)));
    expect(showValue([1n, "x", true])).toEqual(["1", "x", true]);
  });
});

describe("shapeOutputs", () => {
  const field = (label: string, type: string): Field => ({ slot: 0, label, type });

  it("writes integers, small and large, as decimal strings", () => {
    const returns = [field("a", "u256"), field("b", "u64")];
    expect(shapeOutputs(returns, { a: 7, b: 2n ** 63n })).toEqual({ outputs: { a: "7", b: "9223372036854775808" }, truncated: false });
  });

  it("writes identifiers and bytes as 0x hex and cuts a long one", () => {
    const id = new Uint8Array(32).fill(0xab);
    expect(shapeOutputs([field("who", "identifier")], { who: id }).outputs).toEqual({ who: `0x${"ab".repeat(32)}` });
    const long = shapeOutputs([field("blob", "bytes")], { blob: new Uint8Array(MAX_OUT_TEXT).fill(1) });
    expect(long.truncated).toBe(true);
    expect((long.outputs["blob"] as string).length).toBe(MAX_OUT_TEXT);
  });

  it("clamps text from a contract: control characters become spaces and a long text is cut", () => {
    const tidy = shapeOutputs([field("t", "string")], { t: "line one\nline\u0007two" });
    expect(tidy.outputs["t"]).toBe("line one line two");
    expect(tidy.truncated).toBe(false);
    const cut = shapeOutputs([field("t", "string")], { t: "x".repeat(5000) });
    expect(cut.truncated).toBe(true);
    expect((cut.outputs["t"] as string).length).toBe(MAX_OUT_TEXT + 1);
  });

  it("cuts lists and maps past 100 entries and says so, and keeps an own __proto__ key", () => {
    const list = shapeOutputs([field("tags", "[]string")], { tags: Array.from({ length: 300 }, (_, i) => `t${i}`) });
    expect(list.truncated).toBe(true);
    expect(list.outputs["tags"]).toHaveLength(MAX_OUT_ENTRIES);
    const map = new Map<string, Uint8Array>([["__proto__", new Uint8Array([1])], ...Array.from({ length: 150 }, (_, i) => [`k${i}`, new Uint8Array([2])] as [string, Uint8Array])]);
    const shaped = shapeOutputs([field("m", "map[string]bytes")], { m: map });
    expect(shaped.truncated).toBe(true);
    const out = shaped.outputs["m"] as Record<string, string>;
    expect(Object.keys(out)).toHaveLength(MAX_OUT_ENTRIES);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(out["k0"]).toBe("0x02");
  });

  it("shapes a list of identifiers element by element", () => {
    const ids = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    expect(shapeOutputs([field("who", "[]identifier")], { who: ids }).outputs["who"]).toEqual([`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`]);
  });

  it("answers an empty object for no outputs and ignores a label the answer lacks", () => {
    expect(shapeOutputs([], null)).toEqual({ outputs: {}, truncated: false });
    expect(shapeOutputs([field("a", "u64")], {})).toEqual({ outputs: {}, truncated: false });
  });
});
