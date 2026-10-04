import {
  AssetStandard,
  createParticipantId,
  deriveAssetId,
  KMOI_ASSET_ID,
  LockType,
  OpType,
  ParticipantTagV0,
} from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  assertSendable,
  buildAssetInvoke,
  buildCreateAsset,
  buildMint,
  chooseStorageFund,
  DEFAULT_STORAGE_FUND,
  FUEL_RESERVE,
  MEASURED_STORAGE_FLOOR,
  MIN_STORAGE_FUND,
  estimateFuelFor,
  buildCreateAccount,
  buildLogicInvoke,
  buildTransfer,
  MAX_OPERATIONS,
  parseAmount,
  simulate,
  toPoloHex,
  toWireJson,
  type SenderInfo,
} from "../../src/moi/ix-builder.js";
import { MoiError } from "../../src/moi-error.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const recipient = createParticipantId({ fingerprint: new Uint8Array(24).fill(9), variant: 0, tag: ParticipantTagV0 });
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);

const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

describe("parseAmount", () => {
  it("scales into base units", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("0", 6)).toBe(0n);
    expect(parseAmount("42", 0)).toBe(42n);
  });

  it("round-trips exactly past the float53 boundary", () => {
    expect(parseAmount("1180.591620717411303424", 18)).toBe(2n ** 70n);
  });

  it("refuses more decimal places than the asset has", () => {
    expect(() => parseAmount("1.1234567", 6)).toThrow(/dimension is 6/);
  });

  it("refuses non-decimal input rather than coercing it", () => {
    for (const bad of ["1e6", "-1", "abc", "", "0x10", "1.2.3"]) {
      expect(() => parseAmount(bad, 6)).toThrow(MoiError);
    }
  });
});

describe("buildTransfer", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });

  it("carries the sender's sequence so the wallet does not have to guess", () => {
    expect(ix.sender).toEqual({ id: sender.toHex(), sequence: 3, key_id: 0 });
  });

  it("emits a single ASSET_INVOKE operation", () => {
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("Transfer");
  });

  it("declares the recipient AND the asset as participants", () => {
    // MOI sandboxes state: an account not declared here cannot be touched.
    // The asset itself is a NO_LOCK participant — matched against the SDK's
    // own MAS0AssetLogic builder, which is what the reference dapp sends.
    expect(ix.participants).toEqual([
      { id: recipient.toHex(), lock_type: LockType.MUTATE_LOCK },
      { id: asset.toHex(), lock_type: LockType.NO_LOCK },
    ]);
  });

  it("carries no funds block — the amount lives in the calldata", () => {
    // The SDK builder omits `funds` for an asset transfer; including it is a
    // divergence from what the wallet is known to accept.
    expect(ix.funds).toBeUndefined();
  });

  it("emits calldata with no 0x prefix, as the SDK does", () => {
    expect(String(ix.ix_operations[0]!.payload["calldata"])).toMatch(/^[0-9a-f]+$/);
  });
});

describe("buildCreateAsset", () => {
  it("maps the standard name onto its numeric code", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "TEST", supply: 1000n, decimals: 2, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_CREATE);
    expect(ix.ix_operations[0]!.payload["standard"]).toBe(AssetStandard.MAS0);
    expect(ix.ix_operations[0]!.payload["manager"]).toBe(sender.toHex());
    // max_supply must be bigint, and there is no `supply` field in
    // AssetCreatePayload — a string here fails POLO inside the wallet.
    expect(typeof ix.ix_operations[0]!.payload["max_supply"]).toBe("bigint");
    expect(ix.ix_operations[0]!.payload).not.toHaveProperty("supply");
  });

  it("rejects an unknown standard", () => {
    expect(() =>
      buildCreateAsset(SENDER, {
        symbol: "X", supply: 1n, decimals: 0, dimension: 0, standard: "MAS9", isStateful: false, isFungible: true,
      }),
    ).toThrow(/MAS0, MAS1, MAS2, MASX/);
  });
});

describe("buildMint", () => {
  // MAS0AssetLogic.mint() never touches the signer to build calldata — it
  // only stamps it onto the returned InteractionContext — so a plain object
  // stands in for the real WalletConnect-backed signer used in production.
  const signer = {};

  it("delegates calldata to the SDK's MAS0AssetLogic.mint()", async () => {
    const ix = await buildMint(signer, SENDER, { assetId: asset.toHex(), to: recipient.toHex(), amount: 500n });

    expect(ix.sender).toEqual({ id: sender.toHex(), sequence: 3, key_id: 0 });
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("Mint");
    expect(ix.ix_operations[0]!.payload["asset_id"]).toBe(asset.toHex());
    // Emitted with no 0x prefix, matching every other builder's calldata.
    expect(String(ix.ix_operations[0]!.payload["calldata"])).toMatch(/^[0-9a-f]+$/);
  });

  it("declares the asset AND the beneficiary as MUTATE_LOCK participants", () => {
    return buildMint(signer, SENDER, { assetId: asset.toHex(), to: recipient.toHex(), amount: 1n }).then((ix) => {
      expect(ix.participants).toEqual([
        { id: asset.toHex(), lock_type: LockType.MUTATE_LOCK },
        { id: recipient.toHex(), lock_type: LockType.MUTATE_LOCK },
      ]);
    });
  });

  it("mints to the exact recipient and amount given, not the sender", async () => {
    const ix = await buildMint(signer, SENDER, { assetId: asset.toHex(), to: recipient.toHex(), amount: 42n });
    const participants = ix.participants ?? [];
    expect(participants.some((p) => p.id === recipient.toHex())).toBe(true);
    expect(participants.some((p) => p.id === sender.toHex())).toBe(false);
  });

  it("carries no funds block — the amount lives in the calldata", () => {
    return buildMint(signer, SENDER, { assetId: asset.toHex(), to: recipient.toHex(), amount: 1n }).then((ix) => {
      expect(ix.funds).toBeUndefined();
    });
  });

  it("wraps a build failure (e.g. a malformed beneficiary) as MoiError", async () => {
    await expect(
      buildMint(signer, SENDER, { assetId: asset.toHex(), to: "not-a-hex-address", amount: 1n }),
    ).rejects.toThrow(MoiError);
    await expect(
      buildMint(signer, SENDER, { assetId: asset.toHex(), to: "not-a-hex-address", amount: 1n }),
    ).rejects.toThrow(/Could not build a mint/);
  });
});

describe("buildCreateAccount", () => {
  it("matches the SDK's ParticipantCreate shape: one weighted key, a KMOI funding transfer, the asset declared", () => {
    const ix = buildCreateAccount(SENDER, {
      id: "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000",
      publicKey: "0x03a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f679e9b37c57edb9f",
      amount: 500_000_000_000n,
    });
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.PARTICIPANT_CREATE);
    const payload = ix.ix_operations[0]!.payload as {
      id: string;
      keys_payload: Array<{ public_key: string; weight: number; signature_algorithm: number }>;
      value: { asset_id: string; callsite: string; calldata: string };
    };
    expect(payload.id).toBe("0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000");
    expect(payload.keys_payload).toEqual([
      { public_key: "0x03a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f679e9b37c57edb9f", weight: 1000, signature_algorithm: 0 },
    ]);
    expect(payload.value.asset_id.toLowerCase()).toBe(KMOI_ASSET_ID.toLowerCase());
    expect(payload.value.callsite).toBe("Transfer");
    expect(payload.value.calldata).toMatch(/^0x[0-9a-f]+$/);
    // Only the asset is declared: the new account does not exist until this lands.
    expect(ix.participants).toEqual([{ id: KMOI_ASSET_ID, lock_type: LockType.NO_LOCK }]);
  });
});

describe("buildLogicInvoke", () => {
  it("emits LOGIC_INVOKE with the callsite", () => {
    const ix = buildLogicInvoke(SENDER, { logicId: "0xabc", callsite: "Increment", calldata: "0x0d5f" });
    expect(ix.ix_operations[0]!.type).toBe(OpType.LOGIC_INVOKE);
    expect(ix.ix_operations[0]!.payload).toMatchObject({
      logic_id: "0xabc", callsite: "Increment", calldata: "0x0d5f",
    });
  });

  it("omits calldata entirely for a no-argument routine", () => {
    const ix = buildLogicInvoke(SENDER, { logicId: "0xabc", callsite: "Ping" });
    expect(ix.ix_operations[0]!.payload).not.toHaveProperty("calldata");
  });

  it("declares no participants unless asked, so plain routines keep the old shape", () => {
    const ix = buildLogicInvoke(SENDER, { logicId: "0xabc", callsite: "Ping", participants: [] });
    expect(ix).not.toHaveProperty("participants");
  });

  it("declares the named participants with their locks and adds the logic as mutate", () => {
    // A DEX buy: the pool owner's balances change, the two assets are listed
    // so the asset engine can see them, and the logic's own reserves move.
    const ix = buildLogicInvoke(SENDER, {
      logicId: "0xABC",
      callsite: "Buy",
      calldata: "0x01",
      participants: [
        { id: "0xOWNER", lock: "mutate" },
        { id: "0xTOKEN", lock: "none" },
        { id: "0xBASE", lock: "none" },
      ],
    });
    expect(ix.participants).toEqual([
      { id: "0xowner", lock_type: LockType.MUTATE_LOCK },
      { id: "0xtoken", lock_type: LockType.NO_LOCK },
      { id: "0xbase", lock_type: LockType.NO_LOCK },
      { id: "0xabc", lock_type: LockType.MUTATE_LOCK },
    ]);
  });

  it("keeps the strongest lock when an id is named twice and respects an explicit lock on the logic", () => {
    const ix = buildLogicInvoke(SENDER, {
      logicId: "0xabc",
      callsite: "Buy",
      participants: [
        { id: "0xowner", lock: "none" },
        { id: "0xOWNER", lock: "mutate" },
        { id: "0xabc", lock: "read" },
      ],
    });
    expect(ix.participants).toEqual([
      { id: "0xowner", lock_type: LockType.MUTATE_LOCK },
      { id: "0xabc", lock_type: LockType.READ_LOCK },
    ]);
  });
});

describe("assertSendable", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1n });

  it("accepts a normal interaction", () => {
    expect(() => assertSendable(ix)).not.toThrow();
  });

  it("rejects an empty interaction", () => {
    expect(() => assertSendable({ ...ix, ix_operations: [] })).toThrow(/no operations/);
  });

  it("rejects more operations than the node allows", () => {
    const tooMany = Array.from({ length: MAX_OPERATIONS + 1 }, () => ix.ix_operations[0]!);
    expect(() => assertSendable({ ...ix, ix_operations: tooMany })).toThrow(/at most 3/);
  });
});

describe("simulate fails closed", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
  const answering = (response: unknown) => ({ call: async () => response });
  const NO_STATUS = /no readable receipt status/;

  it.each<[string, unknown]>([
    ["a number", { receipt: { status: 0 } }],
    ["a hex string", { receipt: { status: "0x0" } }],
    ["a hex string in capitals", { receipt: { status: "0X0" } }],
    ["a decimal string", { receipt: { status: "0" } }],
    ["a bigint", { receipt: { status: 0n } }],
  ])("passes a status of 0 given as %s", async (_name, response) => {
    await expect(simulate(answering(response), ix)).resolves.toMatchObject({ ok: true, status: 0 });
  });

  it("reads the fuel used the same way, and leaves it out when it cannot be read", async () => {
    await expect(simulate(answering({ receipt: { status: 0, fuel_used: "0x12b" } }), ix)).resolves.toEqual({
      ok: true,
      status: 0,
      fuelUsed: 299,
    });
    const unreadable = await simulate(answering({ receipt: { status: 0, fuel_used: "lots" } }), ix);
    expect(unreadable).toMatchObject({ ok: true, status: 0 });
    expect(unreadable.fuelUsed).toBeUndefined();
  });

  // Every shape below used to read as a pass (a missing status was 0) or threw a bare SyntaxError out of BigInt().
  it.each<[string, unknown]>([
    ["no response at all", undefined],
    ["a null response", null],
    ["a response with no receipt", {}],
    ["an undefined receipt", { receipt: undefined }],
    ["a null receipt", { receipt: null }],
    ["a receipt that is a string", { receipt: "0x0" }],
    ["a receipt that is an array", { receipt: [] }],
    ["an empty receipt", { receipt: {} }],
    ["a receipt with fuel but no status", { receipt: { fuel_used: "0x12b" } }],
    ["a null status", { receipt: { status: null } }],
    ["an empty status", { receipt: { status: "" } }],
    ["a status that is text", { receipt: { status: "abc" } }],
    ["a bare 0x", { receipt: { status: "0x" } }],
    ["a status with spaces round it", { receipt: { status: " 0 " } }],
    ["a negative string", { receipt: { status: "-1" } }],
    ["a negative number", { receipt: { status: -1 } }],
    ["a fraction", { receipt: { status: 0.5 } }],
    ["NaN", { receipt: { status: Number.NaN } }],
    ["a boolean", { receipt: { status: false } }],
    ["an object", { receipt: { status: {} } }],
    ["an array holding zero, which String() would read as 0", { receipt: { status: [0] } }],
    ["a number beyond 2^53", { receipt: { status: 2 ** 60 } }],
    ["a hex string beyond 2^53", { receipt: { status: `0x${"f".repeat(40)}` } }],
  ])("is a failure, with a reason and no throw, for %s", async (_name, response) => {
    const result = await simulate(answering(response), ix);
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.detail).toMatch(NO_STATUS);
  });

  it("still reports a status the node did give, with the operation's detail", async () => {
    const result = await simulate(
      answering({ receipt: { status: "0x1", ix_operations: [{ status: 1, data: { error: "0x" } }] } }),
      ix,
    );
    expect(result).toEqual({ ok: false, status: 1, fuelUsed: undefined, detail: "op status 1" });
  });

  it("does not throw on operations it cannot read, once the status is known to be a failure", async () => {
    for (const ix_operations of ["nope", { 0: 1 }, [null, 5, "x"]]) {
      const result = await simulate(answering({ receipt: { status: 1, ix_operations } }), ix);
      expect(result).toMatchObject({ ok: false, status: 1, detail: "" });
    }
  });

  it("returns the message of a call that throws, with no status", async () => {
    const result = await simulate({ call: async () => { throw new Error("execution reverted: boom"); } }, ix);
    expect(result).toEqual({ ok: false, detail: "execution reverted: boom" });
    const text = await simulate({ call: async () => { throw "plain text"; } }, ix);
    expect(text).toEqual({ ok: false, detail: "plain text" });
  });
});

describe("toPoloHex", () => {
  it("POLO-encodes without any key material", () => {
    const hex = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n }));
    // Deliberately UNPREFIXED. js-moi-wallet emits `ix_args: bytesToHex(...)`,
    // and the documented node payload is likewise bare hex
    // ("0e9f020ef604f3088309a009..."). Adding 0x here would break the wallet.
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.startsWith("0x")).toBe(false);
    expect(hex.length).toBeGreaterThan(100);
    // POLO documents are self-describing and start with a wire-type header.
    expect(hex.startsWith("0e")).toBe(true);
  });

  it("is deterministic — the same interaction encodes identically", () => {
    const make = () => buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
    expect(toPoloHex(make())).toBe(toPoloHex(make()));
  });

  it("changes when the amount changes", () => {
    const a = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n }));
    const b = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1001n }));
    expect(a).not.toBe(b);
  });
});


describe("every builder POLO-encodes", () => {
  /**
   * Regression for a live failure: buildCreateAsset emitted max_supply as a
   * decimal string plus a bogus `supply` field. POLO rejected it inside MOI
   * Wallet, which surfaced as "Failed to sign interaction" on the phone —
   * js-moi-sdk's own throw string, since the wallet uses the SDK internally.
   *
   * The old tests only POLO-encoded transfers, so nothing caught it. Encoding
   * is the contract with the wallet: every builder must pass.
   */
  const REGISTRY = "0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000";

  const builders: Array<[string, () => ReturnType<typeof buildTransfer>]> = [
    ["transfer", () => buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n })],
    ["createAsset", () => buildCreateAsset(SENDER, {
      symbol: "MCPTEST", supply: 1000n, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    })],
    ["logicInvoke", () => buildLogicInvoke(SENDER, { logicId: REGISTRY, callsite: "GetAgentCount" })],
    ["assetInvoke", () => buildAssetInvoke(SENDER, {
      assetId: asset.toHex(), callsite: "Burn", calldata: "0d2f06", participants: [{ id: asset.toHex(), lock: "mutate" }],
    })],
  ];

  for (const [name, make] of builders) {
    it(`${name} produces valid POLO bytes`, () => {
      const hex = toPoloHex(make());
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(hex.length).toBeGreaterThan(50);
    });
  }
});

describe("estimateFuelFor", () => {
  it("applies headroom to a measured estimate", async () => {
    const r = await estimateFuelFor({ estimateFuel: async () => 299 }, {} as never);
    expect(r).toEqual({ fuelLimit: Math.ceil(299 * 1.5), estimated: true });
  });

  it("falls back when the node cannot simulate, and says why", async () => {
    const r = await estimateFuelFor(
      { estimateFuel: async () => { throw new Error("ReceiptStateReverted"); } }, {} as never,
    );
    expect(r.estimated).toBe(false);
    expect(r.fuelLimit).toBe(200_000);
    expect(r.reason).toMatch(/Reverted/);
  });

  it("falls back on a nonsense estimate rather than sending fuel_limit 0", async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const r = await estimateFuelFor({ estimateFuel: async () => bad }, {} as never);
      expect(r.estimated).toBe(false);
      expect(r.fuelLimit).toBe(200_000);
    }
  });
});

describe("toWireJson — the bigint/JSON boundary", () => {
  /**
   * Regression for a live failure. POLO requires number|bigint for amounts,
   * but the WalletConnect transport is JSON and JSON.stringify throws on
   * bigint — the relay surfaced it only as an opaque request failure.
   */
  it("survives JSON.stringify, which the raw interaction does not", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "MCPTEST", supply: 1000n, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    expect(() => JSON.stringify(ix)).toThrow(/BigInt/);
    expect(() => JSON.stringify(toWireJson(ix))).not.toThrow();
  });

  it("keeps safe integers as numbers", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "T", supply: 1000n, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    const ops = toWireJson(ix)["ix_operations"] as Array<{ payload: Record<string, unknown> }>;
    expect(ops[0]!.payload["max_supply"]).toBe(1000);
  });

  it("promotes past-2^53 values to strings instead of losing precision", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "BIG", supply: 2n ** 70n, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    const ops = toWireJson(ix)["ix_operations"] as Array<{ payload: Record<string, unknown> }>;
    expect(ops[0]!.payload["max_supply"]).toBe("1180591620717411303424");
  });

  it("converts bigint amounts in an asset-create payload", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "T", supply: 10n ** 20n, decimals: 0, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    const ops = toWireJson(ix)["ix_operations"] as Array<{ payload: Record<string, unknown> }>;
    expect(ops[0]!.payload["max_supply"]).toBe("100000000000000000000");
  });

  it("leaves POLO encoding untouched — it still needs the bigint", () => {
    const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
    expect(() => toPoloHex(ix)).not.toThrow();
  });
});

describe("asset creation funds the new asset", () => {
  /**
   * A bare ASSET_CREATE does not work. MOI makes a new asset self-pay for its
   * storage at creation, and the derived asset account holds no KMOI, so the
   * create must be bundled with a transfer to the id it is about to produce.
   *
   * The failure mode is nasty: the ASSET_CREATE operation reports success and
   * returns a valid asset_id while the interaction fails with status 1 and no
   * diagnostic.
   */
  const make = (storageFund?: bigint) =>
    buildCreateAsset(SENDER, {
      symbol: "MCPTEST", supply: 1000n, decimals: 0, dimension: 0, standard: "MAS0",
      isStateful: false, isFungible: true, ...(storageFund ? { storageFund } : {}),
    });

  it("emits ASSET_CREATE plus a funding transfer", () => {
    const ix = make();
    expect(ix.ix_operations).toHaveLength(2);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_CREATE);
    expect(ix.ix_operations[1]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[1]!.payload["callsite"]).toBe("Transfer");
  });

  it("funds the asset id the create will actually produce", () => {
    // deriveAssetId mirrors the chain's derivation; a wrong prediction sends
    // KMOI to an account that will never exist.
    const expected = deriveAssetId(
      { id: SENDER.id as `0x${string}`, sequence: SENDER.sequence, key_id: 0 },
      AssetStandard.MAS0,
    ).toHex();
    expect(make().ix_operations[1]!.payload["asset_id"]).toBe(KMOI_ASSET_ID);
    expect(String(make().ix_operations[1]!.payload["calldata"])).toContain(expected.slice(2));
  });

  it("defaults to DEFAULT_STORAGE_FUND and honours an override", () => {
    expect(DEFAULT_STORAGE_FUND).toBe(10_000_000_000n); // the SDK default, 10 KMOI
    // Different funding amounts must produce different calldata.
    expect(make(10_000n).ix_operations[1]!.payload["calldata"])
      .not.toBe(make(50_000n).ix_operations[1]!.payload["calldata"]);
  });

  it("still POLO-encodes with both operations", () => {
    expect(() => toPoloHex(make(10_000n))).not.toThrow();
  });

  it("stays within the three-operation cap", () => {
    expect(() => assertSendable(make())).not.toThrow();
  });
});

describe("chooseStorageFund", () => {
  /**
   * A new MOI asset pays for its own storage at creation, and a fresh asset
   * account holds no KMOI — so the create must bundle a funding transfer. A
   * fund below the chain's floor is accepted by the node and then fails
   * opaquely: the ASSET_CREATE operation reports success while the
   * interaction reports status 1. Nobody creating a token should have to
   * reason about any of that, so the tool sizes it.
   *
   * The floor was measured by binary search against voyage devnet after the
   * September 2026 upgrade: 6,072,387,694 for a short symbol and 6,082,031,250
   * for the 12-character maximum, so it moves with the symbol's length.
   * MEASURED_STORAGE_FLOOR holds the larger figure, and MIN_STORAGE_FUND carries
   * margin over it.
   */
  it("prefers the SDK default when the balance can cover it", () => {
    expect(chooseStorageFund(50_000_000_000n)).toBe(DEFAULT_STORAGE_FUND); // 50 KMOI
  });

  it("funds the minimum rather than the whole balance when the default is out of reach", () => {
    // The earlier rule handed over everything above the fuel reserve, which
    // is how creating one test token ate half an account.
    expect(chooseStorageFund(8_000_000_000n)).toBe(MIN_STORAGE_FUND); // 8 KMOI
    expect(chooseStorageFund(9_500_000_000n)).toBe(MIN_STORAGE_FUND); // 9.5 KMOI
  });

  it("leaves the owner the bulk of a modest balance", () => {
    const balance = 21_596_000_000n; // 21.596 KMOI
    const spent = chooseStorageFund(balance);
    expect(balance - spent).toBeGreaterThan(balance / 2n);
  });

  it("stays above the measured floor at the smallest balance it accepts", () => {
    const smallest = MIN_STORAGE_FUND + FUEL_RESERVE;
    expect(chooseStorageFund(smallest)).toBeGreaterThanOrEqual(MIN_STORAGE_FUND);
    expect(chooseStorageFund(smallest)).toBeGreaterThan(MEASURED_STORAGE_FLOOR);
  });

  it("keeps MIN_STORAGE_FUND between 110 and 130 percent of the measured floor", () => {
    // Too close, and a small repricing makes every automatic create fail. Too far, and the tool refuses balances the
    // chain would accept. A re-measure that moves one of the two numbers and not the other fails here.
    expect(MIN_STORAGE_FUND * 100n).toBeGreaterThanOrEqual(MEASURED_STORAGE_FLOOR * 110n);
    expect(MIN_STORAGE_FUND * 100n).toBeLessThanOrEqual(MEASURED_STORAGE_FLOOR * 130n);
  });

  it("refuses clearly rather than building an interaction that fails opaquely", () => {
    // 7 KMOI - FUEL_RESERVE leaves less than MIN_STORAGE_FUND.
    expect(() => chooseStorageFund(7_000_000_000n)).toThrow(/base units of KMOI/);
    expect(() => chooseStorageFund(7_000_000_000n)).toThrow(/7 KMOI/); // reads in KMOI too
    expect(() => chooseStorageFund(0n)).toThrow(MoiError);
  });

  it("never returns something below the floor", () => {
    for (const balance of [8_000_000_001n, 9_000_000_000n, 12_000_000_000n, 500_000_000_000n]) {
      expect(chooseStorageFund(balance)).toBeGreaterThanOrEqual(MIN_STORAGE_FUND);
    }
  });
});
