/**
 * moi_create_asset with standard MASX, end to end: a compiled asset manifest, the deploy routine that runs when the asset is
 * created, and its inputs, through the one write path with the node and the phone faked. The manifests are the compiled
 * TaxToken and PlainAsset (test/fixtures/assets) and shapes built from them. As in asset-create-write.test.ts, the mock node
 * answers any dry run, so these tests show what is built, previewed, signed and refused; the dry runs on the devnet are in the
 * plan.
 */

import { ManifestCoder } from "js-moi-sdk";
import { Depolorizer } from "js-polo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCK_LEDGER, PLAIN_ASSET, predictedAssetId, TAX_ARGS, TAX_CREATE, TAXTOKEN, TWO_DEPLOYS_ASSET } from "../helpers/asset-create-fixtures.js";
import { fakeWallet, installWallet, journalLines, seedSession, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { ACCOUNT, KMOI, RpcFailure, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

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
const signedIx = (index = 0) => wallet.requests[index]!.request.params[0] as Record<string, unknown>;
const opsOf = (ix: Record<string, unknown>) => ix["ix_operations"] as Op[];
const token = (r: { structuredContent?: Record<string, unknown> }) => String(r.structuredContent?.["confirm"]);

function simulatedOps(): Array<{ type: number; payload: string }> {
  const call = node.calls.findLast((c) => c.method === "moi.Call");
  expect(call, "expected a moi.Call simulation").toBeDefined();
  return (call!.params["ix_args"] as { ix_operations: Array<{ type: number; payload: string }> }).ix_operations;
}

function funded(op: Op): { beneficiary: string; amount: bigint } {
  const decoded = new Depolorizer(Buffer.from(String(op.payload["calldata"]), "hex")).depolorize({
    kind: "struct",
    fields: { beneficiary: { kind: "bytes" }, amount: { kind: "integer" } },
  }) as { beneficiary: Uint8Array; amount: bigint };
  return { beneficiary: `0x${Buffer.from(decoded.beneficiary).toString("hex")}`, amount: BigInt(decoded.amount) };
}

const TAX_HEX = ManifestCoder.encodeManifest(TAXTOKEN as never);
const FUND_KEY = "Storage fund, KMOI base units (deposited into the asset's own account, not spent)";
const MANIFEST_KEY = "Manifest, read by this server (the phone shows only its bytes)";
const PLAIN = { symbol: "PLAIN", standard: "MASX", supply: "5", manifest: PLAIN_ASSET };

describe("a MASX create, end to end", () => {
  it("previews first: the manifest's routines, size and digest, the deploy routine and its inputs, the fund, the id, and nothing to the phone", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_create_asset", TAX_CREATE);
    expect(preview.isError).toBeFalsy();
    const body = preview.structuredContent as { summary: string; details: Record<string, string>; fuel: string };
    expect(body).toMatchObject({ status: "preview", fuel: "up to 449 at price 50" });
    expect(body.summary).toMatch(/^Create a MASX asset TAX from a manifest of 2 routines \(SHA-256 starting aae74411b3bb\), running its deploy routine Init when the asset is created, and move 10 KMOI from your account into it/);
    expect(body.summary).toMatch(/This server cannot show what the asset's code does: the deploy routine runs at once with your account as the sender/);
    expect(body.summary).toMatch(/The fuel costs at most 0\.00002245 KMOI\.$/);
    expect(body.details).toMatchObject({
      Operation: "Create asset",
      Standard: "MASX",
      "Max supply in base units": "1000000",
      Decimals: "none",
      [FUND_KEY]: "10000000000",
      "New asset's id, predicted (the funding below is paid to it)": predictedAssetId("MASX"),
      "Deploy routine (the callsite)": "Init (the only deploy routine in the manifest)",
      Arguments: JSON.stringify({ treasury_addr: ACCOUNT, bps: "300", initial_supply: "1000000" }),
    });
    expect(body.details[MANIFEST_KEY]).toMatch(/^2 routines \(1 deploy, 1 invoke\): Init, Transfer; 541 bytes encoded; SHA-256 of those bytes aae74411[0-9a-f]{56}; the symbol above is the asset's only name/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("simulates the create and its funding together, with the manifest in the first operation", async () => {
    seedSession(h.home);
    await h.call("moi_create_asset", TAX_CREATE);
    const simulated = simulatedOps();
    expect(simulated.map((o) => o.type)).toEqual([4, 5]);
    expect(simulated[0]!.payload).toContain(TAX_HEX.slice(2));
  });

  it("signs once: the manifest, the callsite Init and the calldata; the funding pays the MASX id and moves exactly the default", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_create_asset", TAX_CREATE);
    expect(sent.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH, created: "unknown" });
    expect(wallet.request).toHaveBeenCalledTimes(1);
    const ops = opsOf(signedIx());
    expect(ops.map((o) => o.type)).toEqual([4, 5]);
    expect(ops[0]!.payload).toEqual({
      symbol: "TAX",
      max_supply: 1_000_000,
      dimension: 0,
      standard: 0xffff,
      enable_events: false,
      manager: ACCOUNT,
      logic_payload: {
        manifest: TAX_HEX,
        callsite: "Init",
        calldata: new ManifestCoder(TAXTOKEN as never).encodeArguments("Init", ACCOUNT, 300, 1_000_000),
      },
    });
    expect(ops[0]!.payload).not.toHaveProperty("decimals");
    expect(ops[1]!.payload["asset_id"]).toBe(KMOI);
    expect(funded(ops[1]!)).toEqual({ beneficiary: predictedAssetId("MASX"), amount: 10_000_000_000n });
    expect(journalLines(h.home).map((l) => l["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    for (const line of journalLines(h.home)) expect(line["kind"]).toBe("create_asset");
  });

  it("with two deploy routines needs the name, and runs the one named", async () => {
    seedSession(h.home);
    const both = { ...TAX_CREATE, manifest: TWO_DEPLOYS_ASSET };
    const refused = await h.call("moi_create_asset", both);
    expect(refused.text).toMatch(/^\[INVALID_ARGS\] The manifest has 2 deploy routines: Init, Reinit\. Pass routine to say which one runs when the asset is created\./);
    await h.send("moi_create_asset", { ...both, routine: "Reinit", args: { bps: 5 } });
    expect((opsOf(signedIx())[0]!.payload["logic_payload"] as Record<string, unknown>)["callsite"]).toBe("Reinit");
  });

  it("with no deploy routine signs a logic payload of the manifest alone, and says so in the preview", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_create_asset", PLAIN);
    const details = preview.structuredContent?.["details"] as Record<string, string>;
    expect(details["Deploy routine (the callsite)"]).toMatch(/^none: the manifest has no deploy routine/);
    expect(details["Arguments"]).toBe("none");
    expect(String(preview.structuredContent?.["summary"])).toMatch(/with no deploy routine to run, and move 10 KMOI/);
    await h.send("moi_create_asset", PLAIN);
    const logicPayload = opsOf(signedIx())[0]!.payload["logic_payload"] as Record<string, unknown>;
    expect(logicPayload).toEqual({ manifest: ManifestCoder.encodeManifest(PLAIN_ASSET as never) });
    expect(Object.keys(logicPayload)).toEqual(["manifest"]);
  });
});

describe("the confirm token binds the manifest by its digest", () => {
  it("a manifest that differs by one byte does not redeem the token, even when the preview would read the same", async () => {
    seedSession(h.home);
    const first = await h.call("moi_create_asset", TAX_CREATE);
    // One byte of the Init routine's bytecode differs: the names, counts and sizes the preview shows are the same.
    const flipped = JSON.parse(JSON.stringify(TAXTOKEN)) as typeof TAXTOKEN;
    const init = flipped.elements.find((e) => e["kind"] === "callable" && (e["data"] as { name: string }).name === "Init") as { data: { executes: { bin: number[] } } };
    init.data.executes.bin[init.data.executes.bin.length - 1] = init.data.executes.bin.at(-1)! + 1;
    const again = await h.call("moi_create_asset", { ...TAX_CREATE, manifest: flipped, confirm: token(first) });
    expect(again.structuredContent).toMatchObject({ status: "preview" });
    expect(String(again.structuredContent?.["note"])).toMatch(/did not match this call/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("the same call in another key order, with an integer as a number or a string, redeems it", async () => {
    seedSession(h.home);
    const first = await h.call("moi_create_asset", TAX_CREATE);
    const sent = await h.call("moi_create_asset", {
      confirm: token(first),
      args: { initial_supply: 1_000_000, bps: "300", treasury_addr: ACCOUNT },
      manifest: Object.fromEntries(Object.entries(TAXTOKEN).reverse()),
      supply: 1_000_000,
      standard: "MASX",
      symbol: "TAX",
    });
    expect(sent.structuredContent?.["status"]).toBe("sent");
  });
});

describe("refusals, before the wallet or the node is touched", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no manifest", { symbol: "TAX", standard: "MASX", supply: "5" }, /^\[INVALID_ARGS\] A MASX asset is created from a compiled asset manifest\. Pass `manifest`/],
    ["decimals", { ...TAX_CREATE, decimals: 2 }, /^\[INVALID_ARGS\] A MASX create sends no decimals/],
    ["a storageFund", { ...TAX_CREATE, storageFund: "10000000000" }, /^\[INVALID_ARGS\] A MASX create funds the new asset with exactly 10 KMOI.*takes no `storageFund`/],
    ["a logic manifest", { ...TAX_CREATE, manifest: LOCK_LEDGER }, /^\[INVALID_ARGS\] This manifest is for a logic .* To deploy a logic use moi_deploy_logic\./],
    ["an unknown routine", { ...TAX_CREATE, routine: "Nope" }, /^\[LOGIC_ROUTINE_NOT_FOUND\] The manifest has no deploy routine "Nope"\. Its deploy routines are: Init\./],
    ["a missing input", { ...TAX_CREATE, args: { treasury_addr: ACCOUNT, bps: 300 } }, /^\[INVALID_ARGS\] .*Missing input.*initial_supply/],
    ["a routine for a manifest with none", { ...PLAIN, routine: "Init" }, /^\[INVALID_ARGS\] The manifest has no deploy routine, so nothing runs when the asset is created/],
    ["a zero supply", { ...TAX_CREATE, supply: "0" }, /^\[INVALID_ARGS\] A supply of 0 cannot be created/],
  ];
  for (const [name, args, message] of cases) {
    it(`${name} is refused with no wallet or node traffic and no journal line`, async () => {
      seedSession(h.home);
      const result = await h.call("moi_create_asset", args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(message);
      expect(result.text).toMatch(/Nothing was sent to your wallet\.$/);
      expect(wallet.request).not.toHaveBeenCalled();
      expect(node.calls).toHaveLength(0);
      expect(journalLines(h.home)).toEqual([]);
    });
  }

  it("unpaired: rejected as every write is, with no node traffic", async () => {
    const result = await h.call("moi_create_asset", TAX_CREATE);
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(node.calls).toHaveLength(0);
  });
});

describe("fuel and the balance", () => {
  it("with the node's estimate the limit is that with headroom; with none it is the deploy fallback of 2 000 000, and the fee is shown in KMOI", async () => {
    seedSession(h.home);
    expect((await h.call("moi_create_asset", TAX_CREATE)).structuredContent).toMatchObject({ fuel: "up to 449 at price 50" });
    node.on("moi.FuelEstimate", () => {
      throw new RpcFailure("execution reverted");
    });
    const preview = await h.call("moi_create_asset", TAX_CREATE);
    expect(preview.structuredContent).toMatchObject({ status: "preview", fuel: "up to 2000000 at price 50" });
    expect(String(preview.structuredContent?.["summary"])).toMatch(/The fuel costs at most 0\.1 KMOI\.$/);
    await h.send("moi_create_asset", TAX_CREATE);
    expect(signedIx()["fuel_limit"]).toBe(2_000_000);
  });

  it("a balance below the fund plus the whole fuel limit is refused with the numbers before anything is simulated, and nothing is sent", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 10_000_022_449n; // the limit is 449 at price 50
    const short = await h.call("moi_create_asset", TAX_CREATE);
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/^\[INSUFFICIENT_BALANCE\] Creating a MASX asset moves 10000000000 base units of KMOI \(10 KMOI\) into it/);
    expect(short.text).toMatch(/up to 22450 \(0\.00002245 KMOI\).*holds 10000022449 \(10\.000022449 KMOI\)/);
    expect(node.methods()).not.toContain("moi.Call");
    expect(wallet.request).not.toHaveBeenCalled();
    node.state.kmoiBalance = 10_000_022_450n;
    expect((await h.call("moi_create_asset", TAX_CREATE)).structuredContent).toMatchObject({ status: "preview" });
  });

  it("a balance that would give a MAS0 create the 7 KMOI fallback does not give a MASX create one", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 7_500_000_000n;
    const result = await h.call("moi_create_asset", TAX_CREATE);
    expect(result.text).toMatch(/^\[INSUFFICIENT_BALANCE\] Creating a MASX asset/);
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("a node that says the create would fail", () => {
  it("is refused before the phone with the MASX hint: payer Logic, the routine's checks, the fixed fund and the fuel limit; no larger fund is offered", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    const result = await h.call("moi_create_asset", TAX_CREATE);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/funded with exactly 10 KMOI, the SDK's default, for its own storage, and this server moves no more/);
    expect(result.text).toMatch(/writes state without `payer Logic`/);
    expect(result.text).toMatch(/writes to an account other than yours \(a create declares no participants, and the devnet's dry run refused a deploy routine that minted to another account with "unable to fetch state object"\)/);
    expect(result.text).toMatch(/no floor was measured for a MASX create/);
    expect(result.text).toMatch(/the fuel limit is too low for a deploy \(449 here, the node's estimate with headroom\)/);
    expect(result.text).not.toMatch(/pass at least|try a larger/);
    expect(wallet.request).not.toHaveBeenCalled();
  });
});
