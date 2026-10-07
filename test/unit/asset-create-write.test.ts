/**
 * moi_create_asset for MAS0, MAS1 and MAS2, end to end: the one write path (simulate, preview, confirm token, phone, journal),
 * with the node and the phone faked. The handlers are the hosted ones run with the stdio adapters, so a write is two calls:
 * h.call is the first (a preview, or a refusal), h.send is both. The stdio server does not look for the receipt, so a create
 * there ends with the hash and a note; the receipt is tested in asset-create-result.test.ts and MASX in
 * asset-create-masx-write.test.ts.
 *
 * The mock node answers moi.Call and moi.FuelEstimate for any interaction, so these tests show what is built, simulated,
 * previewed, signed and reported, and not that devnet accepts a create; the dry runs recorded in the plan do that.
 */

import { Depolorizer } from "js-polo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { predictedAssetId } from "../helpers/asset-create-fixtures.js";
import { fakeWallet, installWallet, journalLines, seedSession, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { ACCOUNT, KMOI, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

type Op = { type: number; payload: Record<string, unknown> };

function signedIx(index = 0): Record<string, unknown> {
  const req = wallet.requests[index];
  expect(req, `expected a wallet request #${index}`).toBeDefined();
  expect(req!.request.method).toBe("moi.signInteraction");
  return req!.request.params[0] as Record<string, unknown>;
}
const opsOf = (ix: Record<string, unknown>) => ix["ix_operations"] as Op[];

/** The operations the node was asked to dry-run in the last moi.Call. */
function simulatedOps(): Array<{ type: number; payload: string }> {
  const call = node.calls.findLast((c) => c.method === "moi.Call");
  expect(call, "expected a moi.Call simulation").toBeDefined();
  return (call!.params["ix_args"] as { ix_operations: Array<{ type: number; payload: string }> }).ix_operations;
}

/** Who the funding transfer pays and how much, read out of the signed operation's calldata. */
function funded(op: Op): { beneficiary: string; amount: bigint } {
  const decoded = new Depolorizer(Buffer.from(String(op.payload["calldata"]), "hex")).depolorize({
    kind: "struct",
    fields: { beneficiary: { kind: "bytes" }, amount: { kind: "integer" } },
  }) as { beneficiary: Uint8Array; amount: bigint };
  return { beneficiary: `0x${Buffer.from(decoded.beneficiary).toString("hex")}`, amount: BigInt(decoded.amount) };
}

const FUND_KEY = "Storage fund, KMOI base units (deposited into the asset's own account, not spent)";
const ID_KEY = "New asset's id, predicted (the funding below is paid to it)";
const MEANING_KEY = "What this standard means (this server's words, not on the phone)";
const MAS1 = { symbol: "NFTA", standard: "MAS1" };
const MAS2 = { symbol: "GOLD", standard: "MAS2", supply: "1000", decimals: 2 };
const MAS0 = { symbol: "TST", supply: "1000", decimals: 2 };
const token = (r: { structuredContent?: Record<string, unknown> }) => String(r.structuredContent?.["confirm"]);

describe("a MAS1 create, end to end", () => {
  it("previews first: the standard in plain words, the predicted id, the fund, the fuel, and nothing to the phone or the journal", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_create_asset", MAS1);
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary:
        "Create a MAS1 asset NFTA: one unit, identified by token id, with no supply and no decimals. 10 KMOI moves from your account into it to pay for its storage. " +
        "The standard cannot be changed after the asset is created.",
      fuel: "up to 449 at price 50",
      details: {
        Operation: "Create asset",
        Symbol: "NFTA",
        Standard: "MAS1",
        [MEANING_KEY]: expect.stringMatching(/^One unit, identified by token id\./),
        "Max supply in base units": "1",
        Decimals: "none",
        "Dimension (0 Economic, 1 Possession)": "0",
        [ID_KEY]: predictedAssetId("MAS1"),
        [FUND_KEY]: "10000000000",
      },
    });
    const details = preview.structuredContent?.["details"] as Record<string, string>;
    expect(details).not.toHaveProperty("Max supply");
    expect(preview.text).toMatch(/^PREVIEW\. Nothing has been sent to the phone\./);
    expect(typeof preview.structuredContent?.["confirm"]).toBe("string");
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("simulates the interaction the phone signs, two operations of types 4 and 5, after the nonce, the fuel estimate and the balance", async () => {
    seedSession(h.home);
    await h.call("moi_create_asset", MAS1);
    expect(simulatedOps().map((o) => o.type)).toEqual([4, 5]);
    const methods = node.methods();
    const at = (m: string) => methods.indexOf(m);
    expect(at("moi.PendingInteractionCount")).toBeGreaterThanOrEqual(0);
    expect(at("moi.FuelEstimate")).toBeGreaterThan(at("moi.PendingInteractionCount"));
    expect(at("moi.Call")).toBeGreaterThan(at("moi.FuelEstimate"));
  });

  it("then signs once: standard 1, max_supply 1, no decimals, the Init logic payload; the funding pays the MAS1 id for the sequence", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_create_asset", MAS1);
    expect(sent.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(wallet.request).toHaveBeenCalledTimes(1);

    const ix = signedIx();
    expect(ix["sender"]).toEqual({ id: ACCOUNT, sequence: 5, key_id: 0 });
    const ops = opsOf(ix);
    expect(ops.map((o) => o.type)).toEqual([4, 5]);
    expect(ops[0]!.payload).toEqual({
      symbol: "NFTA",
      max_supply: 1,
      dimension: 0,
      standard: 1,
      enable_events: false,
      manager: ACCOUNT,
      logic_payload: { manifest: "0x", callsite: "Init" },
    });
    expect(ops[0]!.payload).not.toHaveProperty("decimals");
    expect(ops[1]!.payload["asset_id"]).toBe(KMOI);
    expect(funded(ops[1]!)).toEqual({ beneficiary: predictedAssetId("MAS1"), amount: 10_000_000_000n });
    expect(journalLines(h.home).map((l) => l["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    for (const line of journalLines(h.home)) expect(line).toMatchObject({ kind: "create_asset", userId: "local" });
  });

  it("passes dimension and isStateful through, as MAS0 always did", async () => {
    seedSession(h.home);
    await h.send("moi_create_asset", { ...MAS1, dimension: 1, isStateful: true });
    expect(opsOf(signedIx())[0]!.payload).toMatchObject({ dimension: 1, enable_events: true, standard: 1 });
  });
});

describe("a MAS2 create, end to end", () => {
  it("previews the standard in plain words with the supply and the decimals, then signs the scaled supply, the decimals and the Init payload", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_create_asset", MAS2);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary:
        "Create a MAS2 asset GOLD: fungible units under token ids, with a maximum supply of 1000 and 2 decimals. 10 KMOI moves from your account into it to pay for its storage. " +
        "The standard cannot be changed after the asset is created.",
      details: { Standard: "MAS2", "Max supply": "1000", "Max supply in base units": "100000", Decimals: "2", [ID_KEY]: predictedAssetId("MAS2") },
    });
    expect(wallet.request).not.toHaveBeenCalled();

    await h.send("moi_create_asset", MAS2);
    const ops = opsOf(signedIx());
    expect(ops[0]!.payload).toEqual({
      symbol: "GOLD",
      max_supply: 100_000,
      decimals: 2,
      dimension: 0,
      standard: 2,
      enable_events: false,
      manager: ACCOUNT,
      logic_payload: { manifest: "0x", callsite: "Init" },
    });
    expect(funded(ops[1]!)).toEqual({ beneficiary: predictedAssetId("MAS2"), amount: 10_000_000_000n });
  });
});

describe("a MAS0 create signs what it signed before", () => {
  it("standard 0, the scaled supply, the decimals and no logic payload; the funding pays the MAS0 id", async () => {
    seedSession(h.home);
    await h.send("moi_create_asset", MAS0);
    const ops = opsOf(signedIx());
    expect(ops[0]!.payload).toEqual({ symbol: "TST", max_supply: 100_000, decimals: 2, dimension: 0, standard: 0, enable_events: false, manager: ACCOUNT });
    expect(funded(ops[1]!)).toEqual({ beneficiary: predictedAssetId("MAS0"), amount: 10_000_000_000n });
  });
});

describe("refusals, before the wallet or the node is touched", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["MAS1 with a supply", { ...MAS1, supply: "1" }, /^\[INVALID_ARGS\] A MAS1 asset takes no supply\. MAS1 is single-unit/],
    ["MAS1 with decimals 0", { ...MAS1, decimals: 0 }, /^\[INVALID_ARGS\] A MAS1 asset takes no decimals\. A MAS1 unit is never divided/],
    ["MAS0 with no supply", { symbol: "TST" }, /^\[INVALID_ARGS\] A MAS0 asset needs a `supply`/],
    ["MAS0 with a supply of zero", { symbol: "TST", supply: "0" }, /^\[INVALID_ARGS\] A supply of 0 cannot be created/],
    ["MAS2 with no supply", { symbol: "GOLD", standard: "MAS2" }, /^\[INVALID_ARGS\] A MAS2 asset needs a `supply`/],
    ["MAS1 with a manifest", { ...MAS1, manifest: { kind: "asset" } }, /^\[INVALID_ARGS\] `manifest` only applies to the MASX standard/],
    ["MAS0 with a routine", { symbol: "TST", supply: "1", routine: "Init" }, /^\[INVALID_ARGS\] `routine` only applies to the MASX standard/],
  ];
  for (const [name, args, message] of cases) {
    it(`${name} is refused with its reason, with no wallet or node traffic, no journal line, and the SDK-style result`, async () => {
      seedSession(h.home);
      const result = await h.call("moi_create_asset", args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "error", code: "INVALID_ARGS" });
      expect(result.text).toMatch(message);
      expect(result.text).toMatch(/Nothing was sent to your wallet\.$/);
      expect(wallet.request).not.toHaveBeenCalled();
      expect(node.calls).toHaveLength(0);
      expect(journalLines(h.home)).toEqual([]);
    });
  }

  it("is refused even with no wallet paired, because planning touches neither (the order moi_deploy_logic has)", async () => {
    const result = await h.call("moi_create_asset", { ...MAS1, supply: "1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/A MAS1 asset takes no supply/);
    expect(node.calls).toHaveLength(0);
  });

  it.each(["MAS9", "MASN"])("standard %s is refused by the schema, in its own words, before any node or wallet traffic", async (standard) => {
    seedSession(h.home);
    const result = await h.call("moi_create_asset", { symbol: "TST", supply: "1000", standard });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/standard must be one of MAS0, MAS1, MAS2 or MASX \(default MAS0\)\. MASN is reserved for the native asset and cannot be created\./);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });

  it("unpaired: a valid MAS1 create is rejected with wallet_disconnected before any node traffic", async () => {
    const result = await h.call("moi_create_asset", MAS1);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });
});

describe("the advertised input schema", () => {
  it("lists the four creatable standards, no longer requires supply, and gives decimals no default", async () => {
    const { tools } = await h.client.listTools();
    const create = tools.find((t) => t.name === "moi_create_asset")!;
    const schema = create.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[]; default?: unknown }> };
    expect(schema.properties["standard"]!.enum).toEqual(["MAS0", "MAS1", "MAS2", "MASX"]);
    expect(schema.required).toEqual(["symbol"]);
    expect(schema.properties["decimals"]).not.toHaveProperty("default");
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["manifest", "routine", "args", "supply", "decimals", "storageFund"]));
  });
});

describe("the confirm token binds what will be sent", () => {
  it("a token from a MAS1 preview does not confirm a MAS2 call, and the answer is a fresh preview with the no-match note", async () => {
    seedSession(h.home);
    const first = await h.call("moi_create_asset", MAS1);
    const other = await h.call("moi_create_asset", { ...MAS2, symbol: "NFTA", confirm: token(first) });
    expect(other.structuredContent).toMatchObject({ status: "preview" });
    expect(String(other.structuredContent?.["note"])).toMatch(/did not match this call/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("a token from a MAS0 preview without decimals confirms the same call with decimals 0, and for MAS2 too", async () => {
    seedSession(h.home);
    for (const [standard, symbol] of [["MAS0", "TST"], ["MAS2", "GOLD"]] as const) {
      const first = await h.call("moi_create_asset", { symbol, standard, supply: "5" });
      const sent = await h.call("moi_create_asset", { symbol, standard, supply: "5", decimals: 0, confirm: token(first) });
      expect(sent.structuredContent?.["status"], standard).toBe("sent");
    }
    expect(wallet.request).toHaveBeenCalledTimes(2);
  });

  it("when the account's next sequence moves between the preview and the confirm, the predicted id changes and the person sees a fresh preview", async () => {
    seedSession(h.home);
    const first = await h.call("moi_create_asset", MAS1);
    expect((first.structuredContent?.["details"] as Record<string, string>)[ID_KEY]).toBe(predictedAssetId("MAS1", 5));
    node.on("moi.PendingInteractionCount", () => "0x6");
    const again = await h.call("moi_create_asset", { ...MAS1, confirm: token(first) });
    expect(again.structuredContent).toMatchObject({ status: "preview" });
    expect(String(again.structuredContent?.["note"])).toMatch(/The numbers changed since the preview/);
    expect((again.structuredContent?.["details"] as Record<string, string>)[ID_KEY]).toBe(predictedAssetId("MAS1", 6));
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("the storage fund, by standard", () => {
  it("MAS1 and MAS2 are funded with exactly the default, and a balance that would give a MAS0 create the 7 KMOI fallback is refused for them", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 7_500_000_000n; // MAS0 would fund 7 KMOI; the devnet's dry run refused 7 KMOI for MAS1 and MAS2
    const mas0 = await h.call("moi_create_asset", MAS0);
    expect((mas0.structuredContent?.["details"] as Record<string, string>)[FUND_KEY]).toBe("7000000000");
    for (const args of [MAS1, MAS2]) {
      const refused = await h.call("moi_create_asset", args);
      expect(refused.isError, args.standard).toBe(true);
      expect(refused.text).toMatch(new RegExp(`^\\[INSUFFICIENT_BALANCE\\] Creating a ${args.standard} asset moves 10000000000 base units of KMOI \\(10 KMOI\\) into it`));
      expect(refused.text).toMatch(/holds 7500000000 \(7\.5 KMOI\)/);
    }
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("a balance that carries the default plus the whole fuel limit is accepted, and one base unit short of it is not", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 10_000_022_449n; // the limit is 449 at price 50
    expect((await h.call("moi_create_asset", MAS1)).text).toMatch(/INSUFFICIENT_BALANCE/);
    node.state.kmoiBalance = 10_000_022_450n;
    expect((await h.call("moi_create_asset", MAS1)).structuredContent).toMatchObject({ status: "preview" });
  });

  it("an explicit storageFund is used as given for MAS1 and MAS2, and reaches the funding", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 7_500_000_000n;
    await h.send("moi_create_asset", { ...MAS1, storageFund: "7000000000" });
    await h.send("moi_create_asset", { ...MAS2, storageFund: "8000000000" });
    expect(funded(opsOf(signedIx(0))[1]!).amount).toBe(7_000_000_000n);
    expect(funded(opsOf(signedIx(1))[1]!).amount).toBe(8_000_000_000n);
  });
});

describe("a node that says the create would fail", () => {
  it("MAS1 and MAS2 are refused before the phone with the hint of their standard: the floor was measured for MAS0 and the fund is not blamed", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    for (const args of [MAS1, MAS2]) {
      const result = await h.call("moi_create_asset", args);
      expect(result.isError, args.standard).toBe(true);
      expect(result.text).toMatch(/would fail \(receipt status 1\)/);
      expect(result.text).toContain(`was measured for a MAS0 create. A ${args.standard} create also stores a logic payload`);
      expect(result.text).toMatch(/refused a MAS1 and a MAS2 create funded with 7 KMOI and accepted both with 8 KMOI/);
      expect(result.text).toMatch(/This server funded 10 KMOI, above what the dry run accepted, so the fund is unlikely to be the cause/);
      expect(result.text).not.toMatch(/probably not the cause/);
      expect(result.text).not.toMatch(/Below about 6\.1 KMOI the chain refuses the create/);
    }
    const explicit = await h.call("moi_create_asset", { ...MAS1, storageFund: "7000000000" });
    expect(explicit.text).toMatch(/You passed 7 KMOI\. Leave `storageFund` out and this server funds 10 KMOI for a MAS1 create, or pass at least 8 KMOI\./);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("MAS0's hint is the text it always had", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    const result = await h.call("moi_create_asset", MAS0);
    expect(result.text).toMatch(/Below about 6\.1 KMOI the chain refuses the create/);
    expect(result.text).toMatch(/This server funded 10 KMOI, which is above that floor .* so the fund is probably not the cause\./);
  });
});

describe("the result on the stdio server, which does not look for the receipt", () => {
  it("is the hash with created unknown and a note that says how to read the id, for every standard", async () => {
    seedSession(h.home);
    for (const args of [MAS0, MAS1, MAS2]) {
      const sent = await h.send("moi_create_asset", args);
      expect(sent.structuredContent).toMatchObject({
        status: "sent",
        summary: "The interaction was broadcast, and it is not known whether an asset was created.",
        hash: SENT_HASH,
        explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
        created: "unknown",
      });
      expect(sent.structuredContent?.["assetId"]).toBeUndefined();
      expect(String(sent.structuredContent?.["note"])).toMatch(/moi_get_interaction with this hash.*ASSET_CREATE, tx_type 0x4.*data\.asset_id.*Do not call moi_create_asset again/);
    }
    expect(node.methods().filter((m) => m === "moi.InteractionReceipt")).toHaveLength(0);
  });
});
