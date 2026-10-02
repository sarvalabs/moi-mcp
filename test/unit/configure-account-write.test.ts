/**
 * moi_configure_account, end to end through the one write path (read the account's keys, check nothing is pending, simulate,
 * preview, confirm token, phone, journal), with the node and the phone faked. The handlers are the hosted ones run with the stdio
 * adapters, so a write is two calls: h.call is the first (a preview, or a refusal), h.send is both.
 *
 * What is pinned here is the order and the words: the account's keys are read before anything else, every refusal of the request
 * itself comes before the node is asked for anything but the keys, every refusal comes before the node is asked to simulate and
 * before the phone is asked anything, and an add and a revoke are each one ACCOUNT_CONFIGURE operation written as the SDK writes
 * it. The mock node answers moi.Call and moi.FuelEstimate for any interaction, so these tests show what is read, checked, built,
 * simulated, previewed, signed and reported, and not that a chain accepts an ACCOUNT_CONFIGURE (see the header of
 * src/capabilities/accounts/configure.ts).
 */

import { AccountConfigure, toInteractionArgs } from "js-moi-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compressedKey, listedKey, serveKeys, type ServedKey } from "../helpers/account-keys.js";
import {
  fakeWallet,
  installWallet,
  journalLines,
  seedSession,
  signatureFor,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";
import { ACCOUNT, RpcFailure, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

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

/** The operations the node was asked to dry-run in the last moi.Call: their types and payloads, as the SDK sends them. */
function simulatedOps(): Array<{ type: number; payload: string }> {
  const call = node.calls.findLast((c) => c.method === "moi.Call");
  expect(call, "expected a moi.Call simulation").toBeDefined();
  return (call!.params["ix_args"] as { ix_operations: Array<{ type: number; payload: string }> }).ix_operations;
}

/** What the SDK builds for the same change, processed as the node is sent it: the operations it would simulate. */
async function sdkOps(build: (configure: AccountConfigure) => AccountConfigure) {
  const ix = await build(new AccountConfigure({} as never)).build().ixData({
    sender: { id: ACCOUNT as `0x${string}`, sequence: 5, key_id: 0 },
    fuel_limit: 449,
    fuel_price: 50,
  });
  return toInteractionArgs(ix as never).ix_operations;
}

const NOT_SENT = "Nothing was sent to your wallet.";
const WEIGHT_LINE = (before: number, after: number) =>
  `${before} now, ${after} after this change. An interaction is valid only when the weight of its signatures reaches the account's threshold, which the protocol docs give as 1000 ` +
  "by default and as the least any interaction needs; this server cannot read this account's own threshold.";

const ONE: ServedKey[] = [{ id: 0, publicKey: listedKey("aa"), weight: 1000 }];
const TWO: ServedKey[] = [...ONE, { id: 1, publicKey: listedKey("bb"), weight: 1000 }];
const LISTING_TWO = `This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 1000).`;

const ADD = { add: [compressedKey("cc")] };
const REVOKE_ONE = { revoke: [1] };

describe("adding a key", () => {
  beforeEach(() => serveKeys(node, ONE));

  it("previews what the brief asks for, the lines the phone will show, the account's keys as they are, and nothing to the phone", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_configure_account", ADD);
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: "Add a key to your account. Anyone who holds this key can sign for this account.",
      fuel: "up to 449 at price 50",
    });
    const details = preview.structuredContent?.["details"] as Record<string, string>;
    expect(details).toEqual({
      Operation: "Add a key to your account (ACCOUNT_CONFIGURE)",
      Account: ACCOUNT,
      "New key 1": `${compressedKey("cc")} (weight 1000, signature algorithm 0)`,
      "Combined weight of keys not revoked": WEIGHT_LINE(1000, 2000),
      "Current key 0": `${listedKey("aa")} (weight 1000, not revoked)`,
    });
    // The public keys are written out in full in what the model is told to show.
    expect(preview.text).toMatch(/^PREVIEW\. Nothing has been sent to the phone\./);
    expect(preview.text).toContain(`New key 1: ${compressedKey("cc")} (weight 1000, signature algorithm 0)`);
    expect(typeof preview.structuredContent?.["confirm"]).toBe("string");
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("reads the account's keys first, then the nonce, the count that landed, the fuel and the simulation, for the paired account", async () => {
    seedSession(h.home);
    await h.call("moi_configure_account", ADD);
    expect(node.methods()).toEqual(["moi.AccountKeys", "moi.PendingInteractionCount", "moi.InteractionCount", "moi.FuelEstimate", "moi.Call"]);
    expect(node.calls[0]!.params["id"]).toBe(ACCOUNT);
    expect(node.calls[2]!.params).toMatchObject({ id: ACCOUNT, key_id: 0 });
  });

  it("simulates one ACCOUNT_CONFIGURE operation, the one the SDK builds for the same key", async () => {
    seedSession(h.home);
    await h.call("moi_configure_account", ADD);
    const expected = await sdkOps((c) => c.addKey(compressedKey("cc") as never, 1000));
    expect(simulatedOps()).toEqual(expected);
    expect(simulatedOps().map((o) => o.type)).toEqual([2]);
    // The fuel was estimated for the same operation.
    const estimate = node.calls.findLast((c) => c.method === "moi.FuelEstimate");
    expect((estimate!.params["ix_args"] as { ix_operations: Array<{ type: number }> }).ix_operations.map((o) => o.type)).toEqual([2]);
  });

  it("signs the add on the phone, broadcasts the signed bytes, and journals it as configure_account", async () => {
    seedSession(h.home);
    const sent = await h.send("moi_configure_account", ADD);
    expect(sent.structuredContent).toMatchObject({
      status: "sent",
      summary: "Add a key to your account. Anyone who holds this key can sign for this account.",
      hash: SENT_HASH,
      explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
    });
    expect(wallet.request).toHaveBeenCalledTimes(1);
    const ix = signedIx();
    expect(ix["sender"]).toEqual({ id: ACCOUNT, sequence: 5, key_id: 0 });
    expect(opsOf(ix)).toEqual([
      { type: 2, payload: { add: [{ public_key: compressedKey("cc"), weight: 1000, signature_algorithm: 0 }], revoke: [] } },
    ]);
    // The SDK declares no participants for this operation, and neither does this.
    expect(ix["participants"]).toEqual([]);
    expect(node.calls.find((c) => c.method === "moi.SendInteractions")?.params).toEqual(signatureFor(wallet.requests[0]!));
    expect(journalLines(h.home).map((l) => [l["kind"], l["state"]])).toEqual([
      ["configure_account", "proposed"],
      ["configure_account", "signed"],
      ["configure_account", "broadcast"],
      ["configure_account", "confirmed"],
    ]);
  });

  it("signs weight 1000 and nothing else, whatever a caller passes besides the keys", async () => {
    seedSession(h.home);
    await h.send("moi_configure_account", { ...ADD, weight: 500, account: "0x00", signatureAlgorithm: 1 });
    expect(opsOf(signedIx())[0]!.payload).toEqual({ add: [{ public_key: compressedKey("cc"), weight: 1000, signature_algorithm: 0 }], revoke: [] });
  });

  it("adds several keys in one call, lower-cases them, and shows each in full", async () => {
    seedSession(h.home);
    const call = { add: [`0x02${"CC".repeat(32)}`, compressedKey("dd", "03")] };
    const preview = await h.call("moi_configure_account", call);
    expect(preview.structuredContent?.["summary"]).toBe("Add 2 keys to your account. Anyone who holds any one of these keys can sign for this account.");
    expect(preview.structuredContent?.["details"]).toMatchObject({
      Operation: "Add 2 keys to your account (ACCOUNT_CONFIGURE)",
      "New key 1": `${compressedKey("cc")} (weight 1000, signature algorithm 0)`,
      "New key 2": `${compressedKey("dd", "03")} (weight 1000, signature algorithm 0)`,
      "Combined weight of keys not revoked": WEIGHT_LINE(1000, 3000),
    });
    await h.send("moi_configure_account", call);
    expect((opsOf(signedIx())[0]!.payload["add"] as Array<{ public_key: string }>).map((k) => k.public_key)).toEqual([
      compressedKey("cc"),
      compressedKey("dd", "03"),
    ]);
  });

  it("reads the keys when the node sends ids and weights as hex quantities, as the protocol docs show", async () => {
    serveKeys(node, ONE, "hex");
    seedSession(h.home);
    const preview = await h.call("moi_configure_account", ADD);
    expect(preview.structuredContent?.["details"]).toMatchObject({
      "Combined weight of keys not revoked": WEIGHT_LINE(1000, 2000),
      "Current key 0": `${listedKey("aa")} (weight 1000, not revoked)`,
    });
  });
});

describe("revoking a key", () => {
  beforeEach(() => serveKeys(node, TWO));

  it("previews what the brief asks for: the key can no longer sign, with the key in full", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_configure_account", REVOKE_ONE);
    expect(preview.structuredContent).toMatchObject({
      status: "preview",
      summary: "Revoke key 1. That key can no longer sign for this account.",
      fuel: "up to 449 at price 50",
    });
    expect(preview.structuredContent?.["details"]).toEqual({
      Operation: "Revoke a key on your account (ACCOUNT_CONFIGURE)",
      Account: ACCOUNT,
      "Revoke key 1": `${listedKey("bb")} (weight 1000)`,
      "Combined weight of keys not revoked": WEIGHT_LINE(2000, 1000),
      "Current key 0": `${listedKey("aa")} (weight 1000, not revoked)`,
      "Current key 1": `${listedKey("bb")} (weight 1000, not revoked)`,
    });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("simulates and signs one ACCOUNT_CONFIGURE operation, the one the SDK builds for the same key id", async () => {
    seedSession(h.home);
    await h.call("moi_configure_account", REVOKE_ONE);
    expect(simulatedOps()).toEqual(await sdkOps((c) => c.revokeKey(1)));
    const sent = await h.send("moi_configure_account", REVOKE_ONE);
    expect(sent.structuredContent).toMatchObject({ status: "sent", summary: "Revoke key 1. That key can no longer sign for this account.", hash: SENT_HASH });
    expect(opsOf(signedIx())).toEqual([{ type: 2, payload: { add: [], revoke: [{ key_id: 1 }] } }]);
    expect(signedIx()["participants"]).toEqual([]);
    expect(journalLines(h.home).map((l) => [l["kind"], l["state"]])).toEqual([
      ["configure_account", "proposed"],
      ["configure_account", "signed"],
      ["configure_account", "broadcast"],
      ["configure_account", "confirmed"],
    ]);
  });

  it("names several keys, and is allowed to leave one", async () => {
    serveKeys(node, [...TWO, { id: 2, publicKey: listedKey("cc"), weight: 1000 }]);
    seedSession(h.home);
    const preview = await h.call("moi_configure_account", { revoke: [1, 2] });
    expect(preview.structuredContent?.["summary"]).toBe("Revoke keys 1 and 2. Those keys can no longer sign for this account.");
    expect(preview.structuredContent?.["details"]).toMatchObject({
      Operation: "Revoke 2 keys on your account (ACCOUNT_CONFIGURE)",
      "Combined weight of keys not revoked": WEIGHT_LINE(3000, 1000),
    });
    await h.send("moi_configure_account", { revoke: [1, 2] });
    expect(opsOf(signedIx())[0]!.payload).toEqual({ add: [], revoke: [{ key_id: 1 }, { key_id: 2 }] });
  });

  it("says that key 0 is the key the person's wallet signs with, before the person is asked, and still lets them do it", async () => {
    seedSession(h.home);
    const preview = await h.call("moi_configure_account", { revoke: [0] });
    expect(preview.structuredContent?.["summary"]).toBe(
      "Revoke key 0. That key can no longer sign for this account. " +
        "Key 0 is the key your MOI Wallet signs with here, so after this it can no longer sign for this account, and this server can send nothing more for it.",
    );
    expect(wallet.request).not.toHaveBeenCalled();
    await h.send("moi_configure_account", { revoke: [0] });
    expect(opsOf(signedIx())[0]!.payload).toEqual({ add: [], revoke: [{ key_id: 0 }] });
  });
});

describe("refusals: each is an error before the phone is asked, and most are before the node is asked for anything but the keys", () => {
  /** Call with `args` and expect the refusal `message`, with the keys the only thing read, nothing sent to the phone, nothing journaled. */
  async function expectRefused(args: Record<string, unknown>, message: string, code = "INVALID_ARGS"): Promise<void> {
    seedSession(h.home);
    node.calls.length = 0;
    const result = await h.call("moi_configure_account", args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code });
    expect(result.text).toBe(`[${code}] ${message}`);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
    expect(node.methods()).toEqual(["moi.AccountKeys"]);
  }

  beforeEach(() => serveKeys(node, TWO));

  it("an add and a revoke in one call, with the way to do it in two", async () => {
    await expectRefused(
      { add: [compressedKey("cc")], revoke: [1] },
      "One call can add keys or revoke keys, not both: the protocol docs say an AccountConfigure operation does either an add or a revoke, never both. " +
        `Add the new key first, check that it works, and then call again to revoke the old one. ${NOT_SENT}`,
    );
  });

  it("neither an add nor a revoke, which shows the account's keys so a key id can be picked", async () => {
    await expectRefused({}, `Name at least one key to add or one key id to revoke. ${LISTING_TWO} ${NOT_SENT}`);
    await expectRefused({ add: [], revoke: [] }, `Name at least one key to add or one key id to revoke. ${LISTING_TWO} ${NOT_SENT}`);
  });

  it("a key id the account does not have", async () => {
    await expectRefused({ revoke: [5] }, `This account has no key 5. ${LISTING_TWO} ${NOT_SENT}`);
  });

  it("a key id that is already revoked", async () => {
    serveKeys(node, [...ONE, { id: 1, publicKey: listedKey("bb"), weight: 500, revoked: true }]);
    await expectRefused(
      { revoke: [1] },
      `Key 1 is already revoked. This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 500, revoked). ${NOT_SENT}`,
    );
  });

  it("a key the account already has, written as 33 bytes with either prefix", async () => {
    const message = `That key is already on this account as key 1 (${listedKey("bb")}), and it is not revoked. ${LISTING_TWO} ${NOT_SENT}`;
    await expectRefused({ add: [compressedKey("bb")] }, message);
    await expectRefused({ add: [compressedKey("bb", "03")] }, message);
  });

  it("a key that was revoked on the account: a revoked key is not added again", async () => {
    serveKeys(node, [...ONE, { id: 1, publicKey: listedKey("bb"), weight: 1000, revoked: true }]);
    await expectRefused(
      { add: [compressedKey("bb")] },
      `That key is already on this account as key 1 (${listedKey("bb")}), and it is revoked. The protocol docs describe a revoke as for compromised and obsolete keys, ` +
        `so a revoked key is not added again: use a new key. This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 1000, revoked). ${NOT_SENT}`,
    );
  });

  it("the same key twice in add, and the same key id twice in revoke", async () => {
    await expectRefused(
      { add: [compressedKey("cc"), compressedKey("cc", "03")] },
      `add lists the same key twice (${compressedKey("cc")} and ${compressedKey("cc", "03")}); a key is added once. ${NOT_SENT}`,
    );
    await expectRefused({ revoke: [1, 1] }, `revoke lists key 1 twice; a key is revoked once. ${NOT_SENT}`);
  });

  it("a revoke of every key that is not revoked", async () => {
    await expectRefused(
      { revoke: [0, 1] },
      `That would revoke every key this account has that is not already revoked (0 and 1), and then nothing could sign for the account again. ${NOT_SENT}`,
    );
    serveKeys(node, ONE);
    await expectRefused(
      { revoke: [0] },
      `That would revoke every key this account has that is not already revoked (0), and then nothing could sign for the account again. ${NOT_SENT}`,
    );
  });

  it("a revoke that leaves the keys that remain under 1000", async () => {
    serveKeys(node, [...ONE, { id: 1, publicKey: listedKey("bb"), weight: 500 }]);
    await expectRefused(
      { revoke: [0] },
      "After this change the keys of this account that are not revoked would weigh 500 in total. " +
        "The signatures of an interaction have to weigh at least 1000 together (the protocol docs' floor, which is also their default account threshold), so nothing could sign for the account again. " +
        `This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 500). ${NOT_SENT}`,
    );
  });

  it("an account this server cannot sign for alone: key 0 revoked, or under 1000", async () => {
    const why = (problem: string, listing: string) =>
      `This server signs every interaction as key 0, and ${problem}. The signatures of an interaction have to weigh at least 1000 together ` +
      `(the protocol docs' floor, which is also their default account threshold), so nothing this server sends for this account can be valid. ${listing} ${NOT_SENT}`;
    serveKeys(node, [{ id: 0, publicKey: listedKey("aa"), weight: 1000, revoked: true }, { id: 1, publicKey: listedKey("bb"), weight: 1000 }]);
    await expectRefused(ADD, why("key 0 is revoked", `This account's keys: key 0 (${listedKey("aa")}, weight 1000, revoked); key 1 (${listedKey("bb")}, weight 1000).`));
    serveKeys(node, [{ id: 0, publicKey: listedKey("aa"), weight: 500 }, { id: 1, publicKey: listedKey("bb"), weight: 500 }]);
    await expectRefused(
      REVOKE_ONE,
      why("key 0 weighs 500, under 1000", `This account's keys: key 0 (${listedKey("aa")}, weight 500); key 1 (${listedKey("bb")}, weight 500).`),
    );
  });

  it("a node answer it cannot read, which is the node's error and not a guess", async () => {
    node.on("moi.AccountKeys", () => [{ id: 0, publicKey: "not hex", weight: 1000, revoked: false }]);
    await expectRefused(
      ADD,
      `moi.AccountKeys(${ACCOUNT}): the node's answer is not one this server can read (key 0 has no readable public key), and without it nothing can be said about what this would change. ${NOT_SENT}`,
      "RPC_ERROR",
    );
  });

  it("a node that fails the key read, whose words are quoted", async () => {
    node.on("moi.AccountKeys", () => {
      throw new RpcFailure("account not found");
    });
    await expectRefused(ADD, `moi.AccountKeys(${ACCOUNT}) failed: "account not found". ${NOT_SENT}`, "RPC_ERROR");
    expect(node.methods()).not.toContain("moi.Call");
  });

  it("an unpaired wallet, before the keys are read or anything else is asked of the node", async () => {
    const result = await h.call("moi_configure_account", ADD);
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "wallet_disconnected" });
    expect(node.calls).toHaveLength(0);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("an interaction of this account that is still waiting to land: the keys are read at the latest tesseract, so it is not in them", async () => {
    serveKeys(node, TWO);
    // The mock answers 5 to both counts; one more waiting than has landed is a pending interaction.
    node.on("moi.PendingInteractionCount", () => "0x6");
    seedSession(h.home);
    const result = await h.call("moi_configure_account", REVOKE_ONE);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(result.text).toBe(
      "[INVALID_ARGS] An interaction from this account is still waiting to be confirmed: key 0 has 5 confirmed and 6 counting the ones waiting. " +
        `The keys read here do not include it yet, so wait until it has landed and ask again. ${NOT_SENT}`,
    );
    expect(node.methods()).toEqual(["moi.AccountKeys", "moi.PendingInteractionCount", "moi.InteractionCount"]);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
  });

  it("the node's own refusal of the simulation, with what else can make it refuse", async () => {
    node.state.callStatus = 1;
    seedSession(h.home);
    const result = await h.call("moi_configure_account", ADD);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(result.text).toMatch(/^\[INVALID_ARGS\] The node says this interaction would fail \(receipt status 1\)/);
    expect(result.text).toContain("Not sending it to your wallet");
    expect(result.text).toContain(
      "Besides the checks made before this, too little KMOI to pay the fuel, or a key the chain does not accept, can make the node refuse an ACCOUNT_CONFIGURE.",
    );
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(journalLines(h.home)).toEqual([]);
  });
});
