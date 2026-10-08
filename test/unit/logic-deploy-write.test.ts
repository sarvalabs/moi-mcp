/**
 * moi_deploy_logic, end to end: the one write path (simulate, preview, confirm token, phone, journal), with the node and
 * the phone faked. The handlers are the hosted ones run with the stdio adapters, so a write is two calls: h.call is the
 * first (a preview, or a refusal), h.send is both. The stdio server does not look for the receipt (deployWaitMs 0), so a
 * deploy there ends with the hash and a note; the tests that need the receipt read use the hosted registration with a
 * short wait, further down.
 *
 * The mock node answers moi.Call and moi.FuelEstimate for any interaction, so these tests show what is built, simulated,
 * previewed, signed and reported, and not that devnet would accept a LOGIC_DEPLOY (see HONEST LIMIT in deploy.ts).
 */

import { deriveLogicId, ManifestCoder } from "js-moi-sdk";
import { Depolorizer } from "js-polo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeException } from "../helpers/asset-fixtures.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, session, structured, TOPIC, USER } from "../helpers/hosted.js";
import { fakeWallet, installWallet, journalLines, seedSession, signatureFor, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { COUNTER, deployReceipt, LOCK_LEDGER, PREDICTED_LOGIC_ID } from "../helpers/logic-fixtures.js";
import { ACCOUNT, KMOI, OTHER, RpcFailure, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

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

const receiptLooks = () => node.methods().filter((m) => m === "moi.InteractionReceipt").length;
const MANIFEST_HEX = ManifestCoder.encodeManifest(LOCK_LEDGER as never);
const LEDGER = { manifest: LOCK_LEDGER, args: { name: "MOI Ledger", symbol: "MOI", supply: "1000" } };
const FUND_KEY = "KMOI moved into the new logic, base units";
const FUND_LINE = `10000000000 (10 KMOI) to ${PREDICTED_LOGIC_ID}, the address the new logic will get. This server cannot take it back and the protocol docs describe no way to: only the logic's own code could send it on.`;

/** Who the funding transfer pays and how much, read out of the signed operation's calldata. */
function funded(op: Op): { beneficiary: string; amount: bigint } {
  const decoded = new Depolorizer(Buffer.from(String(op.payload["calldata"]), "hex")).depolorize({
    kind: "struct",
    fields: { beneficiary: { kind: "bytes" }, amount: { kind: "integer" } },
  }) as { beneficiary: Uint8Array; amount: bigint };
  return { beneficiary: `0x${Buffer.from(decoded.beneficiary).toString("hex")}`, amount: BigInt(decoded.amount) };
}

describe("a deploy, end to end", () => {
  it("previews first: the consequences in the sentence, the lines with the address and the digest, the fuel, and nothing to the phone", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_deploy_logic", LEDGER);
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary:
        "Deploy a new logic (4 routines), running its deploy routine Seed, and move 10 KMOI from your account into it. " +
        "This server has no way to take that KMOI back or to remove the logic, and the protocol docs describe none; they say a logic that is not sealed " +
        "can be updated in place, and the manifest does not say whether this one is. " +
        "This server cannot show what the logic's code does: the deploy routine runs at once with your account as the sender, and anyone can call the logic " +
        "afterwards. Deploy only a manifest you got from a source you trust. " +
        "The fuel costs at most 0.00002245 KMOI.",
      fuel: "up to 449 at price 50",
      details: {
        Operation: "Deploy a new logic, and move KMOI into it",
        [FUND_KEY]: FUND_LINE,
        "Deploy routine (the callsite)": "Seed (the only deploy routine in the manifest)",
        Arguments: '{"name":"MOI Ledger","symbol":"MOI","supply":"1000"}',
      },
    });
    const details = preview.structuredContent?.["details"] as Record<string, string>;
    expect(Object.keys(details)).toEqual([
      "Operation",
      FUND_KEY,
      "Deploy routine (the callsite)",
      "Arguments",
      "Manifest, read by this server (the phone shows only its bytes)",
    ]);
    expect(details["Manifest, read by this server (the phone shows only its bytes)"]).toMatch(/^4 routines .*; 780 bytes encoded; SHA-256 of those bytes [0-9a-f]{64}; no name, because /);
    expect(preview.text).toMatch(/^PREVIEW\. Nothing has been sent to the phone\./);
    expect(typeof preview.structuredContent?.["confirm"]).toBe("string");
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).toContain("moi.Call"); // simulated before the person is asked
    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(receiptLooks()).toBe(0);
  });

  it("simulates the deploy and the funding transfer together, after the nonce, the fuel estimate and the balance", async () => {
    seedSession(h.home);
    await h.call("moi_deploy_logic", LEDGER);
    const simulated = simulatedOps();
    expect(simulated.map((o) => o.type)).toEqual([11, 5]);
    expect(simulated[0]!.payload).toContain(MANIFEST_HEX.slice(2));
    const methods = node.methods();
    const at = (m: string) => methods.indexOf(m);
    expect(at("moi.PendingInteractionCount")).toBeGreaterThanOrEqual(0);
    expect(at("moi.FuelEstimate")).toBeGreaterThan(at("moi.PendingInteractionCount"));
    expect(at("moi.TDU")).toBeGreaterThan(at("moi.FuelEstimate"));
    expect(at("moi.Call")).toBeGreaterThan(at("moi.TDU"));
  });

  it("then signs on the phone once, broadcasts the signed bytes, journals every step as deploy_logic, and on stdio returns the hash without looking for the receipt", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_deploy_logic", LEDGER);
    expect(sent.structuredContent).toMatchObject({
      status: "sent",
      summary: "The interaction was broadcast, and it is not known whether a logic was created.",
      hash: SENT_HASH,
      explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
      deployed: "unknown",
    });
    expect(sent.structuredContent?.["logicId"]).toBeUndefined();
    expect(String(sent.structuredContent?.["note"])).toMatch(/moi_get_interaction with this hash.*LOGIC_DEPLOY, tx_type 0xb.*data\.logic_id.*Do not call moi_deploy_logic again/);
    expect(receiptLooks()).toBe(0);
    expect(wallet.request).toHaveBeenCalledTimes(1);

    const ix = signedIx();
    expect(ix["sender"]).toEqual({ id: ACCOUNT, sequence: 5, key_id: 0 });
    expect(ix["fuel_limit"]).toBe(449);
    const ops = opsOf(ix);
    expect(ops.map((o) => o.type)).toEqual([11, 5]);
    expect(ops[0]!.payload).toEqual({
      manifest: MANIFEST_HEX,
      callsite: "Seed",
      calldata: new ManifestCoder(LOCK_LEDGER as never).encodeArguments("Seed", "MOI Ledger", "MOI", 1000),
    });
    expect(ops[1]!.payload["asset_id"]).toBe(KMOI);
    expect(funded(ops[1]!)).toEqual({ beneficiary: PREDICTED_LOGIC_ID, amount: 10_000_000_000n });
    // The SDK's normalisation adds KMOI, which the funding transfer touches, and the new logic is not declared: it does not exist yet.
    expect(ix["participants"]).toEqual([{ id: KMOI, lock_type: 0, notary: false }]);

    expect(node.calls.find((c) => c.method === "moi.SendInteractions")?.params).toEqual(signatureFor(wallet.requests[0]!));
    const lines = journalLines(h.home);
    expect(lines.map((l) => l["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    for (const line of lines) expect(line).toMatchObject({ kind: "deploy_logic", userId: "local" });
  });

  // Coco 0.9.0 writes no kind into a logic manifest. What is simulated and what the phone signs is the encoding with the kind in it.
  it("a manifest with no kind is deployed as a logic: simulated, signed and sent with kind logic encoded", async () => {
    seedSession(h.home);
    const { kind: _kind, ...noKind } = LOCK_LEDGER;
    const args = { manifest: noKind, args: LEDGER.args };

    const preview = await h.call("moi_deploy_logic", args);
    expect(preview.structuredContent).toMatchObject({ status: "preview" });
    expect(simulatedOps()[0]!.payload).toContain(MANIFEST_HEX.slice(2));

    const sent = await h.send("moi_deploy_logic", args);
    expect(sent.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(opsOf(signedIx())[0]!.payload["manifest"]).toBe(MANIFEST_HEX);
  });

  it("declares the participants given as accounts the new code may move, and runs a deploy routine that takes numbers", async () => {
    seedSession(h.home);
    const args = { manifest: COUNTER, args: { initial_value: 7 }, participants: [{ id: OTHER, lock: "mutate" }] };
    const preview = await h.call("moi_deploy_logic", args);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      details: { Arguments: '{"initial_value":"7"}', "Other participants (the new code may move these)": `${OTHER} (mutate)` },
    });
    await h.send("moi_deploy_logic", args);
    expect(signedIx()["participants"]).toEqual([
      { id: KMOI, lock_type: 0, notary: false },
      { id: OTHER, lock_type: 0, notary: false },
    ]);
  });

  it("funds 10 KMOI and no other amount, even when the caller passes a storageFund, which the schema drops", async () => {
    seedSession(h.home);
    const args = { ...LEDGER, storageFund: "18000000000000000000" };
    const preview = await h.call("moi_deploy_logic", args);
    expect((preview.structuredContent?.["details"] as Record<string, string>)[FUND_KEY]).toBe(FUND_LINE);
    await h.send("moi_deploy_logic", args);
    expect(funded(opsOf(signedIx())[1]!).amount).toBe(10_000_000_000n);
  });
});

describe("what the model is told about the tool", () => {
  // A deploy ran on the devnet on 7 October 2026 and succeeded, so the tool must not say it is untested (preview finding 8).
  // The quickstart words it as "has not been run against a node yet, so try it on devnet first", hence the wider pattern.
  const STALE = /been run against a node|supervised run|try\s+it\s+on\s+devnet/;

  it("the description no longer says the tool is untested, and still ends with the shared approval protocol", async () => {
    const { tools } = await h.client.listTools();
    const description = tools.find((t) => t.name === "moi_deploy_logic")?.description ?? "";
    expect(description).toMatch(/creates a second logic and moves more KMOI\. Two calls, always\./);
    expect(description).not.toMatch(STALE);
  });

  it("the quickstart paragraph on the tool does not say so either", async () => {
    const { contents } = await h.client.readResource({ uri: "moi://docs/quickstart" });
    const text = (contents[0] as { text?: string }).text ?? "";
    // The paragraph that starts with the tool's name, up to the next blank line. moi_configure_account has its own.
    const paragraph = text.split(/\n\s*\n/).find((p) => p.startsWith("`moi_deploy_logic` deploys"));
    expect(paragraph, "expected a paragraph on moi_deploy_logic in the quickstart").toBeDefined();
    expect(paragraph).toMatch(/says where to look otherwise\.$/);
    expect(paragraph).not.toMatch(STALE);
  });
});

describe("fuel and the balance", () => {
  it("measured fuel: an account with the fund and the whole fuel limit is accepted, and one short of it is refused in KMOI before anything is simulated", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 10_000_022_449n; // 10 KMOI and one base unit short of the limit 449 at price 50
    const short = await h.call("moi_deploy_logic", LEDGER);
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/^\[INSUFFICIENT_BALANCE\] /);
    expect(short.text).toMatch(/moves 10000000000 base units of KMOI \(10 KMOI\) into it.*the whole fuel limit, up to 22450 \(0\.00002245 KMOI\).*holds 10000022449 \(10\.000022449 KMOI\)/);
    expect(node.methods()).not.toContain("moi.Call");
    expect(wallet.request).not.toHaveBeenCalled();

    node.state.kmoiBalance = 10_000_022_450n;
    expect((await h.call("moi_deploy_logic", LEDGER)).structuredContent).toMatchObject({ status: "preview" });
  });

  it("no estimate: a deploy gets its own, larger fuel limit, shows the fee in KMOI, and needs the balance to cover it", async () => {
    seedSession(h.home);
    node.on("moi.FuelEstimate", () => {
      throw new RpcFailure("execution reverted");
    });
    const preview = await h.call("moi_deploy_logic", LEDGER);
    expect(preview.structuredContent).toMatchObject({ status: "preview", fuel: "up to 2000000 at price 50" });
    expect(String(preview.structuredContent?.["summary"])).toMatch(/The fuel costs at most 0\.1 KMOI\.$/);

    node.state.kmoiBalance = 10_050_000_000n; // the fund and 0.05 KMOI: the old reserve of 0.001 KMOI would have passed it
    const short = await h.call("moi_deploy_logic", LEDGER);
    expect(short.text).toMatch(/up to 100000000 \(0\.1 KMOI\)/);
    expect(node.methods().filter((m) => m === "moi.Call")).toHaveLength(1); // the first preview's, and not this one's

    node.state.kmoiBalance = 10_100_000_000n;
    await h.send("moi_deploy_logic", LEDGER);
    expect(signedIx()["fuel_limit"]).toBe(2_000_000);
  });
});

describe("refusals, before the phone is asked", () => {
  it("a manifest that cannot be deployed is refused even before the wallet is looked at, with no node traffic", async () => {
    const result = await h.call("moi_deploy_logic", { manifest: { ...LOCK_LEDGER, kind: "asset" } });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[INVALID_ARGS\] .*moi_create_asset.*Nothing was sent to your wallet\.$/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });

  it("a manifest with no deploy routine is refused the same way", async () => {
    const { NO_DEPLOY } = await import("../helpers/logic-fixtures.js");
    const result = await h.call("moi_deploy_logic", { manifest: NO_DEPLOY });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[INVALID_ARGS\] The manifest has no deploy routine\..*Nothing was sent to your wallet\.$/);
    expect(node.calls).toHaveLength(0);
  });

  it("unpaired: rejected as every write is, with no node traffic and nothing signed", async () => {
    const result = await h.call("moi_deploy_logic", LEDGER);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });

  it("a deploy the node says would fail is refused with its status and a hint that names fuel and payer Logic and offers no larger fund", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;
    const result = await h.call("moi_deploy_logic", LEDGER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[INVALID_ARGS\] /);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/payer Logic/);
    expect(result.text).toMatch(/the fuel limit is too low for a deploy \(449 here, the node's estimate with headroom\)/);
    expect(result.text).toMatch(/this server moves no more\./);
    expect(result.text).not.toMatch(/storageFund/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("on another network or with an expired pairing, is refused as every write is", async () => {
    seedSession(h.home, { network: "voyage", chainId: "moi:14" });
    expect((await h.call("moi_deploy_logic", LEDGER)).structuredContent).toMatchObject({ status: "rejected", reason: "network_mismatch" });
    seedSession(h.home, { expiry: Math.floor(Date.now() / 1000) - 10 });
    expect((await h.call("moi_deploy_logic", LEDGER)).structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("the preview is bound to the call, manifest included", () => {
  const token = (r: { structuredContent?: Record<string, unknown> }) => String(r.structuredContent?.["confirm"]);

  it("a confirm with a changed manifest gets a fresh preview and a note, even when nothing the preview says has changed", async () => {
    seedSession(h.home);
    const first = await h.call("moi_deploy_logic", LEDGER);
    // The encoder ignores an unknown key, so the person would read the same preview; the token still refuses.
    const again = await h.call("moi_deploy_logic", { ...LEDGER, manifest: { ...LOCK_LEDGER, extra: 1 }, confirm: token(first) });
    expect(again.structuredContent).toMatchObject({ status: "preview" });
    expect(String(again.structuredContent?.["note"])).toMatch(/did not match this call/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("a confirm with other inputs is refused the same way", async () => {
    seedSession(h.home);
    const first = await h.call("moi_deploy_logic", LEDGER);
    const other = await h.call("moi_deploy_logic", { ...LEDGER, args: { ...LEDGER.args, supply: "2000" }, confirm: token(first) });
    expect(String(other.structuredContent?.["note"])).toMatch(/did not match this call/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("accepts the token when the same call comes in another key order", async () => {
    seedSession(h.home);
    const first = await h.call("moi_deploy_logic", LEDGER);
    const sent = await h.call("moi_deploy_logic", {
      confirm: token(first),
      args: { supply: "1000", symbol: "MOI", name: "MOI Ledger" },
      manifest: Object.fromEntries(Object.entries(LOCK_LEDGER).reverse()),
    });
    expect(sent.structuredContent?.["status"]).toBe("sent");
    expect(wallet.request).toHaveBeenCalledTimes(1);
  });

  it("refuses the token when another interaction from the account has moved the address the phone will show, and shows the new one", async () => {
    seedSession(h.home);
    const first = await h.call("moi_deploy_logic", LEDGER);
    expect((first.structuredContent?.["details"] as Record<string, string>)[FUND_KEY]).toContain(PREDICTED_LOGIC_ID);
    node.on("moi.PendingInteractionCount", () => "0x6");
    const again = await h.call("moi_deploy_logic", { ...LEDGER, confirm: token(first) });
    expect(again.structuredContent).toMatchObject({ status: "preview" });
    expect(String(again.structuredContent?.["note"])).toMatch(/The numbers changed since the preview/);
    const line = (again.structuredContent?.["details"] as Record<string, string>)[FUND_KEY]!;
    expect(line).not.toContain(PREDICTED_LOGIC_ID);
    expect(line).toMatch(new RegExp(`^10000000000 \\(10 KMOI\\) to ${deriveLogicId({ id: ACCOUNT as `0x${string}`, sequence: 6, key_id: 0 }).toHex()}, `));
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("what the phone and the network can do", () => {
  it("a refusal on the phone is rejected/user_rejected, and nothing is broadcast", async () => {
    seedSession(h.home);
    wallet.request.mockRejectedValueOnce({ code: 5000, message: "User rejected the request" });
    const result = await h.send("moi_deploy_logic", LEDGER);
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "user_rejected" });
    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(journalLines(h.home).map((l) => l["state"])).toEqual(["proposed", "failed"]);
  });

  it("a broadcast that fails after the tap is an error, and no receipt is looked for", async () => {
    seedSession(h.home);
    node.on("moi.SendInteractions", () => {
      throw new Error("ixpool full");
    });
    const result = await h.send("moi_deploy_logic", LEDGER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/approved the interaction but broadcasting it failed/);
    expect(receiptLooks()).toBe(0);
  });
});

describe("on the hosted server, which watches for the receipt", () => {
  /** A deploy through the hosted registration with a wait of `waitMs`: the preview, then the confirm. */
  async function hostedDeploy(waitMs: number) {
    const store = fakeStore(new Map([[USER, session()], ["user-b", session({ userId: "user-b", topic: "topic-b" })]]));
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal), undefined, { deployWaitMs: waitMs });
    const first = await client.callTool({ name: "moi_deploy_logic", arguments: LEDGER });
    const confirm = (structured(first) as { confirm: string }).confirm;
    const started = Date.now();
    const sent = await client.callTool({ name: "moi_deploy_logic", arguments: { ...LEDGER, confirm } });
    return { client, hub, journal, store, first, sent, result: structured(sent) as Record<string, unknown>, tookMs: Date.now() - started };
  }

  it("goes through the user's own pairing: one request to their topic, one journal entry of its kind, and the new logic's id", async () => {
    node.on("moi.InteractionReceipt", () => deployReceipt({ logicId: PREDICTED_LOGIC_ID }));
    const { client, hub, journal, store, first, result } = await hostedDeploy(2_000);
    try {
      expect(structured(first)).toMatchObject({ status: "preview" });
      expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
      expect(hub.signInteractionFor.mock.calls[0]![0]).toBe(TOPIC);
      expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ kind: "deploy_logic", userId: USER }));
      expect(store.delete).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: "sent",
        summary: `Deployed a new logic. Its id is ${PREDICTED_LOGIC_ID}. 10 KMOI moved into it.`,
        hash: SENT_HASH,
        explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
        deployed: "yes",
        logicId: PREDICTED_LOGIC_ID,
      });
    } finally {
      await client.close();
    }
  });

  it("a receipt that says it failed: deployed no, with the reason the chain gave, the status still sent, and no logic id", async () => {
    node.on("moi.InteractionReceipt", () => deployReceipt({ status: 1, error: encodeException({ class: "runtime", error: "supply must be positive" }) }));
    const { client, result } = await hostedDeploy(2_000);
    try {
      expect(result).toMatchObject({ status: "sent", hash: SENT_HASH, deployed: "no" });
      expect(result["logicId"]).toBeUndefined();
      expect(String(result["summary"])).not.toMatch(/^Deployed/);
      expect(String(result["note"])).toMatch(/receipt says the interaction failed \(status 1\): "runtime: supply must be positive"\./);
      expect(String(result["note"])).toMatch(/Do not call moi_deploy_logic again/);
    } finally {
      await client.close();
    }
  });

  it("a receipt without an id, or with another id than the address that was funded, is unknown, and the predicted id is never reported", async () => {
    // The mock's default receipt has one operation, an ASSET_INVOKE.
    const plain = await hostedDeploy(2_000);
    try {
      expect(plain.result).toMatchObject({ deployed: "unknown" });
      expect(plain.result["logicId"]).toBeUndefined();
      expect(String(plain.result["note"])).toMatch(/does not list exactly one deploy operation/);
    } finally {
      await plain.client.close();
    }
    node.on("moi.InteractionReceipt", () => deployReceipt({ logicId: `0x20${"ab".repeat(31)}` }));
    const other = await hostedDeploy(2_000);
    try {
      expect(other.result).toMatchObject({ deployed: "unknown" });
      expect(other.result["logicId"]).toBeUndefined();
      expect(String(other.result["note"])).toMatch(/is not the address the KMOI was sent to/);
    } finally {
      await other.client.close();
    }
  });

  it("a receipt that never comes: deployed unknown after the wait, and no longer, with the hash", async () => {
    node.on("moi.InteractionReceipt", () => {
      throw new RpcFailure("receipt not found");
    });
    const { client, result, tookMs } = await hostedDeploy(150);
    try {
      expect(result).toMatchObject({ status: "sent", hash: SENT_HASH, deployed: "unknown" });
      expect(String(result["note"])).toMatch(/No receipt was read before this returned/);
      expect(receiptLooks()).toBeGreaterThanOrEqual(1);
      expect(tookMs).toBeLessThan(3_000);
    } finally {
      await client.close();
    }
  });
});
