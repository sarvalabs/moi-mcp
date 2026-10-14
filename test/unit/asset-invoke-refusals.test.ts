/**
 * What moi_asset_invoke refuses, and what it does for a standard or a manifest it was not written around: MASN, MAS1,
 * MAS2, a custom (MASX) asset, drifting or hostile manifests. The MAS1, MAS2 and MASX manifests here are synthetic (see
 * test/helpers/asset-fixtures.ts): nothing about those standards has been run against a node.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MAS1AssetLogic, MAS2AssetLogic } from "js-moi-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAS1_MANIFEST,
  MAS2_MANIFEST,
  MASX_MANIFEST,
  PIXEL,
  callReceipt,
  callable,
  encodeOutputs,
  manifestHex,
  syntheticManifest,
  type ManifestLike,
} from "../helpers/asset-fixtures.js";
import {
  fakeWallet,
  installWallet,
  seedSession,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";
import {
  KMOI,
  MAS1_ASSET,
  MAS2_ASSET,
  MASX_ASSET,
  OTHER,
  RpcFailure,
  UNKNOWN_STANDARD_ASSET,
  startMockNode,
  type MockNode,
} from "../helpers/mock-node.js";

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

const invoke = (assetId: string, routine: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  h.call("moi_asset_invoke", { assetId, routine, args, ...extra });
const serve = (manifest: ManifestLike) => node.on("moi.LogicManifest", () => manifestHex(manifest));
const signedIx = () => wallet.requests[0]!.request.params[0] as Record<string, unknown>;
const callsite = (ix: Record<string, unknown>) => (ix["ix_operations"] as Array<{ payload: Record<string, unknown> }>)[0]!.payload;
const sdkCalldata = (hex: unknown) => String(hex).replace(/^0x/, "");

/** A copy of a manifest with one callable's data changed. */
function patched(manifest: ManifestLike, name: string, change: (data: Record<string, unknown>) => void): ManifestLike {
  const copy = structuredClone(manifest);
  const el = copy.elements.find((e) => e["kind"] === "callable" && (e["data"] as { name: string }).name === name);
  change(el!["data"] as Record<string, unknown>);
  return copy;
}

describe("an unknown routine", () => {
  it("is refused with the names the manifest has, and an offer of the right case, before anything is built", async () => {
    seedSession(h.home);
    const result = await invoke(PIXEL, "Nope", { amount: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[LOGIC_ROUTINE_NOT_FOUND\] /);
    expect(result.text).toMatch(/Its routines are: .*Transfer.*BalanceOf/);

    const near = await invoke(PIXEL, "transfer", { beneficiary: OTHER, amount: 1 });
    expect(near.text).toContain('did you mean "Transfer"');
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.Call");
    expect(node.methods()).not.toContain("moi.PendingInteractionCount");
  });
});

describe("a node with no manifest", () => {
  it("is refused with no fallback, whether it errors, answers empty, or lists nothing to invoke", async () => {
    seedSession(h.home);
    const answers: Array<() => unknown> = [
      () => {
        throw new RpcFailure("logic not found");
      },
      () => "0x",
      () => manifestHex(syntheticManifest([callable(0, "Make", "dynamic", [], [], "deploy")])),
    ];
    for (const answer of answers) {
      node.reset();
      node.on("moi.LogicManifest", answer);
      const result = await invoke(PIXEL, "Burn", { amount: 1 });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^\[RPC_ERROR\] /);
      expect(result.text).toMatch(/no fallback/);
      expect(node.methods()).not.toContain("moi.PendingInteractionCount");
      expect(node.methods().filter((m) => m === "moi.LogicManifest")).toHaveLength(1);
    }
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("the native asset", () => {
  it("refuses mint and burn before the manifest is read, even when the manifest would fail", async () => {
    seedSession(h.home);
    node.on("moi.LogicManifest", () => {
      throw new RpcFailure("must not be asked");
    });
    for (const [routine, args] of [
      ["Mint", { beneficiary: OTHER, amount: 1 }],
      ["Burn", { amount: 1 }],
      ["MintWithMetadata", { beneficiary: OTHER, amount: 1, static_metadata: {} }],
    ] as const) {
      const result = await invoke(KMOI, routine, args);
      expect(result.isError, routine).toBe(true);
      expect(result.text, routine).toMatch(/^\[INVALID_ARGS\] /);
      expect(result.text, routine).toMatch(/The native asset cannot be minted or burned/);
      expect(result.text, routine).toMatch(/Nothing was sent to your wallet/);
    }
    const metadata = await invoke(KMOI, "SetStaticMetadata", { key: "k", value: "0x01" });
    expect(metadata.text).toMatch(/metadata cannot be changed/);
    expect(node.methods()).not.toContain("moi.LogicManifest");
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("says no such routine, with the 15 it has, for a name that is merely unknown", async () => {
    const result = await invoke(KMOI, "Frobnicate");
    expect(result.text).toMatch(/^\[LOGIC_ROUTINE_NOT_FOUND\] /);
    const listed = /Its routines are: ([^.]*)\./.exec(result.text)?.[1]?.split(", ") ?? [];
    expect(listed).toHaveLength(15);
    expect(listed).not.toContain("Mint");
  });
});

describe("MAS1 (written from the SDK, not run against a node)", () => {
  it("previews a transfer with the token id, and signs what the SDK's class writes for a burn", async () => {
    seedSession(h.home);
    const preview = await invoke(MAS1_ASSET, "Transfer", { token_id: 12, beneficiary: OTHER });
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: `Transfer token #12 of KMOI to ${OTHER}`,
      details: { "Token id": "12", To: OTHER },
    });
    const mint = await invoke(MAS1_ASSET, "Mint", { beneficiary: OTHER });
    expect(mint.structuredContent).toMatchObject({ status: "preview", details: { "Token id": "not part of the call" } });

    await h.send("moi_asset_invoke", { assetId: MAS1_ASSET, routine: "Burn", args: { token_id: 12 } });
    const sdk = new MAS1AssetLogic(MAS1_ASSET, {} as never).burn(12);
    expect(callsite(signedIx())["calldata"]).toBe(sdkCalldata(sdk.payload().calldata));
    expect(signedIx()["participants"]).toEqual([{ id: MAS1_ASSET, lock_type: 0, notary: false }]);
  });

  it("refuses an amount before the manifest is read, and a missing token id by name", async () => {
    seedSession(h.home);
    const amount = await invoke(MAS1_ASSET, "Transfer", { token_id: 12, beneficiary: OTHER, amount: 1 });
    expect(amount.isError).toBe(true);
    expect(amount.text).toMatch(/MAS1 asset has no amounts/);
    expect(node.methods()).not.toContain("moi.LogicManifest");

    const missing = await invoke(MAS1_ASSET, "Transfer", { beneficiary: OTHER });
    expect(missing.text).toMatch(/Missing input "token_id"/);
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("MAS2 (written from the SDK, not run against a node)", () => {
  it("previews a burn with the token id and the amount, and signs what the SDK's class writes", async () => {
    seedSession(h.home);
    const preview = await invoke(MAS2_ASSET, "Burn", { token_id: 12, amount: 3 });
    expect(preview.structuredContent).toMatchObject({ status: "preview", summary: "Burn 3 of token #12 of KMOI" });
    await h.send("moi_asset_invoke", { assetId: MAS2_ASSET, routine: "Burn", args: { token_id: 12, amount: 3 } });
    const sdk = new MAS2AssetLogic(MAS2_ASSET, {} as never).burn(12, 3);
    expect(callsite(signedIx())["calldata"]).toBe(sdkCalldata(sdk.payload().calldata));
  });

  it("refuses a missing token id or a missing amount", async () => {
    seedSession(h.home);
    expect((await invoke(MAS2_ASSET, "Burn", { amount: 3 })).text).toMatch(/Missing input "token_id"/);
    expect((await invoke(MAS2_ASSET, "Burn", { token_id: 12 })).text).toMatch(/Missing input "amount"/);
  });
});

describe("a custom (MASX) asset, whose routines only its own manifest knows", () => {
  it("needs participants for a write, says plainly it has no description, and carries what the caller declared", async () => {
    seedSession(h.home);
    const bare = await invoke(MASX_ASSET, "Deposit", { amount: 5 });
    expect(bare.isError).toBe(true);
    expect(bare.text).toMatch(/no description for Deposit/);
    expect(bare.text).toMatch(/participants/);
    expect(wallet.request).not.toHaveBeenCalled();

    const empty = await invoke(MASX_ASSET, "Deposit", { amount: 5 }, { participants: [] });
    expect(empty.structuredContent).toMatchObject({
      status: "preview",
      summary: "Call Deposit on asset KMOI",
      details: { Routine: "Deposit", Arguments: '{"amount":"5"}' },
    });
    expect(String((empty.structuredContent?.["details"] as Record<string, string>)["Description"])).toMatch(/no description for the routine Deposit/);

    const withOne = await h.send("moi_asset_invoke", {
      assetId: MASX_ASSET,
      routine: "Deposit",
      args: { amount: 5 },
      participants: [{ id: OTHER, lock: "mutate" }],
    });
    expect(withOne.structuredContent?.["status"]).toBe("sent");
    expect(signedIx()["participants"]).toEqual(expect.arrayContaining([{ id: OTHER, lock_type: 0, notary: false }]));
  });

  it("accepts the token when an undescribed routine's arguments arrive in another key order", async () => {
    seedSession(h.home);
    const args = { asset: OTHER, amount: 1 };
    const first = await invoke(MASX_ASSET, "Swap", args, { participants: [] });
    const sent = await invoke(MASX_ASSET, "Swap", { amount: 1, asset: OTHER }, { participants: [], confirm: first.structuredContent?.["confirm"] });
    expect(sent.structuredContent?.["status"]).toBe("sent");
  });

  it("runs a routine that only reads, with no participants and no preview", async () => {
    node.on("moi.Call", () => callReceipt({ outputs: encodeOutputs({ total: { kind: "integer" } }, { total: 9 }) }));
    const result = await invoke(MASX_ASSET, "Total");
    expect(result.structuredContent).toMatchObject({ routine: "Total", outputs: { total: "9" }, truncated: false });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.PendingInteractionCount");
  });
});

describe("a standard the SDK cannot name", () => {
  it("works through the manifest, undescribed: a write needs participants", async () => {
    seedSession(h.home);
    serve(MASX_MANIFEST);
    const bare = await invoke(UNKNOWN_STANDARD_ASSET, "Deposit", { amount: 5 });
    expect(bare.text).toMatch(/no description for Deposit on a UNKNOWN\(9\) asset/);
    const declared = await invoke(UNKNOWN_STANDARD_ASSET, "Deposit", { amount: 5 }, { participants: [] });
    expect(declared.structuredContent?.["status"]).toBe("preview");
  });
});

describe("a routine described for a standard, with the caller's own participants", () => {
  it("signs the standard's accounts and the caller's, and shows the caller's in the preview", async () => {
    seedSession(h.home);
    const participants = [{ id: OTHER.replace("0707", "0808"), lock: "read" }];
    const preview = await invoke(PIXEL, "Transfer", { beneficiary: OTHER, amount: 5 }, { participants });
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      details: { "Other participants": `${participants[0]!.id} (read)` },
    });
    await h.send("moi_asset_invoke", { assetId: PIXEL, routine: "Transfer", args: { beneficiary: OTHER, amount: 5 }, participants });
    const ids = (signedIx()["participants"] as Array<{ id: string; lock_type: number }>).map((p) => [p.id, p.lock_type]);
    expect(ids).toEqual(expect.arrayContaining([[PIXEL, 2], [OTHER, 0], [participants[0]!.id, 1]]));
  });
});

describe("a manifest that drifted from what a description was written for", () => {
  it("makes a MAS1 Transfer that takes tokenId undescribed: it needs participants and names the routine", async () => {
    seedSession(h.home);
    serve(patched(MAS1_MANIFEST, "Transfer", (d) => ((d["accepts"] as Array<Record<string, unknown>>)[0]!["label"] = "tokenId")));
    const result = await invoke(MAS1_ASSET, "Transfer", { tokenId: 12, beneficiary: OTHER });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no description for Transfer/);
  });

  it("does the same for an amount typed as a string", async () => {
    seedSession(h.home);
    serve(patched(MAS2_MANIFEST, "Burn", (d) => ((d["accepts"] as Array<Record<string, unknown>>)[1]!["type"] = "string")));
    const result = await invoke(MAS2_ASSET, "Burn", { token_id: 12, amount: "3" });
    expect(result.text).toMatch(/no description for Burn/);
  });
});

describe("a hostile manifest", () => {
  it("a write named constructor is undescribed and refused without participants, and does not crash", async () => {
    seedSession(h.home);
    serve(syntheticManifest([callable(0, "constructor", "dynamic", [["amount", "u256"]])]));
    const result = await invoke(MASX_ASSET, "constructor", { amount: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no description for constructor/);
  });

  it("a name that is also a deploy routine is not a routine of the asset", async () => {
    serve(
      syntheticManifest([
        callable(0, "Pay", "dynamic", [["a", "u64"]]),
        callable(1, "Pay", "dynamic", [["note", "string"]], [], "deploy"),
        callable(2, "Other", "dynamic", []),
      ]),
    );
    const result = await invoke(MASX_ASSET, "Pay", { a: 1 });
    expect(result.text).toMatch(/^\[LOGIC_ROUTINE_NOT_FOUND\] /);
  });

  it("a name that shares a slot with another is not usable, and the refusal says some routines are not", async () => {
    serve(syntheticManifest([callable(5, "Transfer", "dynamic", [["a", "u64"]]), callable(5, "Other", "dynamic", [])]));
    const result = await invoke(MASX_ASSET, "Transfer", { a: 1 });
    expect(result.text).toMatch(/^\[LOGIC_ROUTINE_NOT_FOUND\] /);
    expect(result.text).toMatch(/1 further routine in the manifest is not usable by this server/);
  });

  it("two routines of one name resolve as the coder resolves them: the later one's inputs are required, and they encode", async () => {
    seedSession(h.home);
    serve(
      syntheticManifest([
        callable(0, "Deposit", "dynamic", [["amount", "u256"]]),
        callable(1, "Deposit", "dynamic", [["amount", "u256"], ["note", "string"]]),
      ]),
    );
    const short = await invoke(MASX_ASSET, "Deposit", { amount: 1 }, { participants: [] });
    expect(short.text).toMatch(/Missing input "note"/);
    const full = await invoke(MASX_ASSET, "Deposit", { amount: 1, note: "hi" }, { participants: [] });
    expect(full.structuredContent).toMatchObject({ status: "preview", details: { Arguments: '{"amount":"1","note":"hi"}' } });
  });

  it("an unknown mode is a write: it is previewed, not run", async () => {
    seedSession(h.home);
    serve(syntheticManifest([callable(0, "Odd", "weird", [["x", "u64"]])]));
    const result = await invoke(MASX_ASSET, "Odd", { x: 1 }, { participants: [] });
    expect(result.structuredContent).toMatchObject({ status: "preview", summary: "Call Odd on asset KMOI" });
    expect(node.calls.filter((c) => c.method === "moi.Call").length).toBe(1); // the simulation of the write, nothing more
  });
});

describe("arguments are checked before anything is built", () => {
  it("a bad identifier, a negative amount, an amount past 64 bits and a key the coder would alter each name their input", async () => {
    seedSession(h.home);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["Transfer", { beneficiary: "0x1234", amount: 1 }, /Input "beneficiary" must be a MOI identifier/],
      ["Burn", { amount: -1 }, /Input "amount" cannot be negative/],
      ["Burn", { amount: "18446744073709551616" }, /Input "amount" is too large/],
      ["SetStaticMetadata", { key: "0xabc", value: "0x01" }, /Input "key" would not reach the chain as given/],
    ];
    for (const [routine, args, pattern] of cases) {
      const result = await invoke(PIXEL, routine, args);
      expect(result.isError, routine).toBe(true);
      expect(result.text, routine).toMatch(/^\[INVALID_ARGS\] /);
      expect(result.text, routine).toMatch(pattern);
    }
    expect(node.methods()).not.toContain("moi.PendingInteractionCount");
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("the SDK's asset driver is not used", () => {
  it("is named by no import in the tool file or anywhere under src/capabilities/assets", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = [
      ...(readdirSync(`${root}src/capabilities/assets`, { recursive: true }) as string[])
        .filter((name) => name.endsWith(".ts"))
        .map((name) => `src/capabilities/assets/${name.split("\\").join("/")}`),
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      // Comments say why the driver is not used, so they are removed before the import statements are read.
      const code = readFileSync(`${root}${file}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const imports = code.match(/^\s*import\b[^;]*;/gm) ?? [];
      for (const statement of imports) {
        expect(statement, `${file} must not import the SDK's asset driver`).not.toMatch(/AssetDriver|getAssetDriver/);
      }
    }
  });
});
