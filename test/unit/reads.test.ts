import { AssetStandard, createParticipantId, deriveAssetId, KMOI_ASSET_ID, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  assetStandardName,
  capReceipt,
  capRecord,
  clampChainText,
  MAX_LEAF_CHARS,
  normalizeAmount,
  opTypeName,
  pageBalances,
  senderId,
  toBigInt,
} from "../../src/moi/reads.js";

const participant = createParticipantId({
  fingerprint: new Uint8Array(24).fill(7),
  variant: 0,
  tag: ParticipantTagV0,
});

function assetIdFor(standard: number): string {
  return deriveAssetId({ id: participant.toHex(), sequence: 0, key_id: 0 }, standard).toHex();
}

describe("toBigInt", () => {
  it("reads the hex quantities the MOI RPC actually returns", () => {
    expect(toBigInt("0x1e")).toBe(30n);
    expect(toBigInt("0x0")).toBe(0n);
  });

  it("reads decimal strings, numbers and bigints", () => {
    expect(toBigInt("42")).toBe(42n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(42n)).toBe(42n);
  });

  it("treats empty and malformed values as zero rather than throwing mid-read", () => {
    expect(toBigInt("")).toBe(0n);
    expect(toBigInt("not-a-number")).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt(null)).toBe(0n);
  });
});

describe("normalizeAmount", () => {
  it("dimension 0 leaves the integer untouched", () => {
    expect(normalizeAmount(1500n, 0)).toBe("1500");
    expect(normalizeAmount("0x1e", 0)).toBe("30");
  });

  it("dimension 6 scales and trims trailing zeros", () => {
    expect(normalizeAmount(1_234n, 6)).toBe("0.001234");
    expect(normalizeAmount(1_000_000n, 6)).toBe("1");
    expect(normalizeAmount(1_500_000n, 6)).toBe("1.5");
    expect(normalizeAmount(0n, 6)).toBe("0");
  });

  it("dimension 18 stays exact past the float53 boundary", () => {
    // 2^70 would lose precision as a double; this must be exact.
    expect(normalizeAmount((2n ** 70n).toString(), 18)).toBe("1180.591620717411303424");
    expect(normalizeAmount(10n ** 18n, 18)).toBe("1");
    expect(normalizeAmount(10n ** 18n + 1n, 18)).toBe("1.000000000000000001");
  });

  it("always satisfies the schema Amount regex", () => {
    const AMOUNT = /^\d+(\.\d+)?$/;
    for (const [raw, dim] of [
      [0n, 0],
      [1n, 18],
      [10n ** 18n, 18],
      [123456789n, 6],
      [(2n ** 64n).toString(), 12],
    ] as const) {
      expect(normalizeAmount(raw, dim)).toMatch(AMOUNT);
    }
  });

  it("guards against a nonsense dimension instead of producing NaN", () => {
    expect(normalizeAmount(100n, Number.NaN)).toBe("100");
    expect(normalizeAmount(100n, -5)).toBe("100");
  });
});

describe("assetStandardName", () => {
  it("decodes the standard out of the asset identifier itself", () => {
    expect(assetStandardName(assetIdFor(AssetStandard.MAS0))).toBe("MAS0");
    expect(assetStandardName(assetIdFor(AssetStandard.MAS1))).toBe("MAS1");
    expect(assetStandardName(assetIdFor(AssetStandard.MAS2))).toBe("MAS2");
  });

  it("returns empty string for something that is not an asset id", () => {
    expect(assetStandardName("0xdeadbeef")).toBe("");
  });
});

describe("interaction rendering", () => {
  it("names the operation type instead of emitting a bare enum value", () => {
    // An agent can act on "ASSET_INVOKE"; "5" tells it nothing.
    expect(opTypeName(5)).toBe("ASSET_INVOKE");
    expect(opTypeName("0x5")).toBe("ASSET_INVOKE");
    expect(opTypeName(4)).toBe("ASSET_CREATE");
    expect(opTypeName(12)).toBe("LOGIC_INVOKE");
  });

  it("falls back to the raw value for an unknown op", () => {
    expect(opTypeName(999)).toBe("999");
    expect(opTypeName(undefined)).toBe("unknown");
  });

  it("extracts the participant id from a sender object", () => {
    // Regression: the interaction's `sender` is an object, and stringifying it
    // produced the literal "[object Object]" in tool output.
    expect(senderId({ id: "0xabc", sequence: 1, key_id: 0 })).toBe("0xabc");
    expect(senderId("0xdef")).toBe("0xdef");
    expect(senderId({ id: { toHex: () => "0x123" } })).toBe("0x123");
  });

  it("degrades to 0x0 rather than emitting garbage", () => {
    expect(senderId(undefined)).toBe("0x0");
    expect(senderId({})).toBe("0x0");
  });
});

describe("clampChainText", () => {
  it("removes control characters and collapses whitespace", () => {
    expect(clampChainText("a\u0000b\n\n c")).toBe("a b c");
  });

  it("cuts at 64 by default and at a given max, with exactly one ellipsis", () => {
    expect(clampChainText("x".repeat(100))).toBe(`${"x".repeat(64)}\u2026`);
    expect(clampChainText("x".repeat(100), 5)).toBe("xxxxx\u2026");
    expect(clampChainText("x".repeat(5), 5)).toBe("xxxxx");
  });

  it("reads null and undefined as empty text", () => {
    expect(clampChainText(null)).toBe("");
    expect(clampChainText(undefined)).toBe("");
  });
});

describe("capRecord", () => {
  const id = "0x" + "ab".repeat(32);

  it("gives a small record back equal, and says nothing was cut", () => {
    const record = { asset_id: id, callsite: "Transfer", calldata: "0e" };
    expect(capRecord(record, 1_000)).toEqual({ value: record, truncated: false, replaced: false });
  });

  it("turns a bigint into its decimal digits instead of throwing", () => {
    const out = capRecord({ amount: 2n ** 70n }, 1_000);
    expect(out.value).toEqual({ amount: "1180591620717411303424" });
    expect(out.replaced).toBe(false);
  });

  it("holds the limit exactly, with texts too short to be shortened", () => {
    // {"a":"<92 x>"} is 100 characters of JSON.
    const fits = capRecord({ a: "x".repeat(92) }, 100);
    expect(fits).toEqual({ value: { a: "x".repeat(92) }, truncated: false, replaced: false });

    const over = capRecord({ a: "x".repeat(93) }, 100);
    expect(over.replaced).toBe(true);
    expect(over.truncated).toBe(true);
    expect(over.value).toEqual({ truncated: true, chars: 101, preview: expect.any(String) });
    expect((over.value as { preview: string }).preview).toHaveLength(100);
  });

  it("tier 1: shortens the long texts and keeps every key, id and status where it was", () => {
    const out = capRecord({ id, status: "ok", calldata: "ab".repeat(50_000) }, 1_000);
    expect(out.replaced).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.value["id"]).toBe(id);
    expect(out.value["status"]).toBe("ok");
    const calldata = out.value["calldata"] as string;
    expect(calldata).toHaveLength(MAX_LEAF_CHARS + 1);
    expect(calldata.endsWith("\u2026")).toBe(true);
  });

  it("tier 2: a record that shortening cannot save is replaced by its length and a preview", () => {
    const record = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, "v".repeat(100)]));
    const full = JSON.stringify(record).length;
    const out = capRecord(record, 1_000);
    expect(out.replaced).toBe(true);
    expect(out.truncated).toBe(true);
    expect((out.value as { chars: number }).chars).toBe(full);
    expect((out.value as { preview: string }).preview).toHaveLength(1_000);
    expect(out.value["truncated"]).toBe(true);
  });

  it("reads undefined and null as an empty record, and a string or a list as { value }", () => {
    expect(capRecord(undefined, 1_000).value).toEqual({});
    expect(capRecord(null, 1_000).value).toEqual({});
    expect(capRecord("text", 1_000).value).toEqual({ value: "text" });
    expect(capRecord([1, 2], 1_000).value).toEqual({ value: [1, 2] });
  });

  it("does not overflow the stack on a record nested a hundred thousand deep", () => {
    const deep = JSON.parse('{"a":'.repeat(100_000) + "1" + "}".repeat(100_000));
    const out = capRecord(deep, 1_000);
    expect(out.truncated).toBe(true);
    expect(out.replaced).toBe(false);
    expect(JSON.stringify(out.value)).toContain("nested more than 20 levels deep");
  });

  it("does not leave half an emoji at the cut", () => {
    // The emoji's two halves straddle the cut at 50; max is under 200, so no text is shortened first.
    const max = 50;
    const out = capRecord({ a: "x".repeat(max - 7) + "\u{1F600}" }, max);
    expect(out.replaced).toBe(true);
    const preview = (out.value as { preview: string }).preview;
    expect(preview.length).toBeLessThanOrEqual(max);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("capReceipt", () => {
  const id = "0x" + "ab".repeat(32);
  /** One participant as the SDK types it, with 66-character ids: about 660 characters of JSON. */
  const participant = (i: number) => ({
    address: id,
    height: `0x${(0x1a2b + i).toString(16)}`,
    transitive_link: id,
    prev_context: id,
    latest_context: id,
    context_delta: { role: 0, behavioural_nodes: [id, id], random_nodes: null, replaced_nodes: null },
    state_hash: id,
  });
  /** A deploy receipt: the deploy operation first, carrying data.logic_id, then the funding transfer. */
  const deployReceipt = (participants: number) => ({
    ix_hash: id,
    from: id,
    status: 0,
    fuel_used: "0x12b",
    ix_index: "0x0",
    ts_hash: id,
    ix_operations: [
      { tx_type: "0xb", status: 0, data: { logic_id: id, error: "0x" } },
      { tx_type: "0x5", status: 0, data: { error: "0x" } },
    ],
    participants: Array.from({ length: participants }, (_, i) => participant(i)),
  });
  const smallOp = { tx_type: "0x5", status: 0, data: { error: "0x" } };

  it("gives a receipt with one participant back whole", () => {
    const receipt = deployReceipt(1);
    expect(JSON.stringify(receipt).length).toBeLessThan(2_000);
    const out = capReceipt(receipt, 2_000);
    expect(out).toEqual({ value: receipt, truncated: false, replaced: false });
  });

  it("drops the participants of a long deploy receipt and keeps what each operation did", () => {
    const out = capReceipt(deployReceipt(4), 2_000);
    expect(JSON.stringify(deployReceipt(4)).length).toBeGreaterThan(2_000);
    expect(out.replaced).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.value).not.toHaveProperty("participants");
    expect(out.value["participantsOmitted"]).toBe(4);
    const ops = out.value["ix_operations"] as Array<{ status: number; data: { logic_id?: string } }>;
    expect(ops[0]?.data.logic_id).toBe(id);
    expect(ops[1]?.status).toBe(0);
    expect(JSON.stringify(out.value).length).toBeLessThanOrEqual(2_000);
  });

  it("replaces a receipt whose operations alone are too long by its preview", () => {
    const out = capReceipt({ status: 0, ix_operations: Array.from({ length: 300 }, () => smallOp) }, 2_000);
    expect(out.replaced).toBe(true);
    expect((out.value as { preview: string }).preview).toHaveLength(2_000);
  });

  it("describes the whole receipt, not the slimmed one, when it still has to be replaced", () => {
    const receipt = { status: 0, ix_operations: Array.from({ length: 300 }, () => smallOp), participants: [participant(0), participant(1), participant(2), participant(3)] };
    const out = capReceipt(receipt, 2_000);
    expect(out.replaced).toBe(true);
    expect((out.value as { chars: number }).chars).toBe(JSON.stringify(receipt).length);
  });

  it("does not throw on a receipt whose participants is not a list", () => {
    const out = capReceipt({ status: 0, participants: "x".repeat(5_000) }, 2_000);
    expect(out.value).toBeDefined();
    expect(out.truncated).toBe(true);
  });
});

describe("pageBalances", () => {
  const KMOI = String(KMOI_ASSET_ID);
  // Ids that sort before KMOI's, so KMOI is last without the pin.
  const asset = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const row = (assetId: string, tokenId = "0", amount = "1") => ({ assetId, tokenId, amount });
  const account = (balances: ReturnType<typeof row>[]) => ({
    address: "0xabc",
    nonce: 3,
    balances,
    isRegistered: true,
    deeds: [{ assetId: KMOI, symbol: "KMOI" }],
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(asset(i + 1)));

  it("puts KMOI first even when its id sorts last, then the rest by asset id, then by token id as a number", () => {
    const out = pageBalances(
      account([row(asset(5), "10"), row(KMOI), row(asset(5), "9"), row(asset(2))]),
    );
    expect(out.balances.map((b) => [b.assetId, b.tokenId])).toEqual([
      [KMOI, "0"],
      [asset(2), "0"],
      [asset(5), "9"],
      [asset(5), "10"],
    ]);
  });

  it("compares asset ids without regard to letter case", () => {
    const upper = `0x${"B".repeat(64)}`;
    const lower = `0x${"a".repeat(64)}`;
    const out = pageBalances(account([row(upper), row(lower), row(KMOI.toUpperCase().replace("0X", "0x"))]));
    expect(out.balances.map((b) => b.assetId)).toEqual([KMOI.toUpperCase().replace("0X", "0x"), lower, upper]);
  });

  it("returns 50 rows by default with the total and where the next page starts", () => {
    const out = pageBalances(account(many(120)));
    expect(out.balances).toHaveLength(50);
    expect(out.total).toBe(120);
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBe(50);
  });

  it("gives the last page with its total and neither truncated nor nextOffset", () => {
    const out = pageBalances(account(many(120)), { offset: 50, limit: 100 });
    expect(out.balances).toHaveLength(70);
    expect(out.total).toBe(120);
    expect(out).not.toHaveProperty("truncated");
    expect(out).not.toHaveProperty("nextOffset");
  });

  it("gives an empty page past the end, still with the total", () => {
    const out = pageBalances(account(many(120)), { offset: 500 });
    expect(out.balances).toEqual([]);
    expect(out.total).toBe(120);
    expect(out).not.toHaveProperty("nextOffset");
  });

  it("clamps the limit to 1..100", () => {
    expect(pageBalances(account(many(300)), { limit: 500 }).balances).toHaveLength(100);
    expect(pageBalances(account(many(300)), { limit: 0 }).balances).toHaveLength(1);
  });

  it("returns only the asset's rows for assetId, in token id order, whatever the letter case", () => {
    const wanted = `0x${"A".repeat(64)}`;
    const out = pageBalances(account([...many(120), row(wanted, "3"), row(wanted, "1")]), { assetId: wanted.toLowerCase() });
    expect(out.balances.map((b) => [b.assetId, b.tokenId])).toEqual([
      [wanted, "1"],
      [wanted, "3"],
    ]);
    expect(out).not.toHaveProperty("total");
    expect(out).not.toHaveProperty("truncated");
  });

  it("gives an empty list, and no total, for an asset the account does not hold", () => {
    const out = pageBalances(account(many(120)), { assetId: asset(9_999) });
    expect(out.balances).toEqual([]);
    expect(out).not.toHaveProperty("total");
  });

  it("leaves a small account's keys exactly as they were", () => {
    const small = account([row(KMOI), row(asset(1))]);
    const out = pageBalances(small);
    expect(Object.keys(out).sort()).toEqual(Object.keys(small).sort());
    expect(out.deeds).toEqual(small.deeds);
    expect(out.nonce).toBe(3);
  });

  it("does not reorder or shorten the account it was given", () => {
    const rows = [row(asset(3)), row(KMOI), row(asset(1))];
    const before = rows.map((r) => r.assetId);
    pageBalances(account(rows), { limit: 1 });
    expect(rows.map((r) => r.assetId)).toEqual(before);
  });
});
