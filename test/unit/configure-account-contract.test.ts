/**
 * What moi_configure_account refuses or asks for again before the person is asked anything, apart from what the account's own keys
 * decide (configure-account-write.test.ts): the input schema, what the tool description tells the model, the confirm token, and the
 * hosted server. The handlers are the hosted ones run with the stdio adapters, so a write is two calls: h.call is the first.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APPROVAL_REWORDINGS, KEY_APPROVAL_PROTOCOL } from "../../src/capabilities/accounts/configure.js";
import { APPROVAL_PROTOCOL } from "../../src/tools/hosted-writes.js";
import { compressedKey, listedKey, serveKeys, type ServedKey } from "../helpers/account-keys.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, session, structured, TOPIC, USER } from "../helpers/hosted.js";
import { fakeWallet, installWallet, journalLines, seedSession, startHarness, type FakeWallet, type Harness } from "../helpers/harness.js";
import { SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

beforeEach(async () => {
  node = await startMockNode();
  // The tool is registered only when the operator turns it on (MOI_ACCOUNT_KEY_TOOLS, src/config.ts), and this file tests the tool.
  h = await startHarness(node.url, { env: { MOI_ACCOUNT_KEY_TOOLS: "on" } });
  wallet = fakeWallet();
  installWallet(h.home, wallet);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

const ONE: ServedKey[] = [{ id: 0, publicKey: listedKey("aa"), weight: 1000 }];
const TWO: ServedKey[] = [...ONE, { id: 1, publicKey: listedKey("bb"), weight: 1000 }];

const ADD = { add: [compressedKey("cc")] };
/** Revoking key 0 of an account that has only key 0: refused on every server, because it would revoke every key. */
const REVOKE_THE_ONLY_KEY = { revoke: [0] };

describe("what the schema refuses, before the session, the node or the phone", () => {
  async function expectSchemaRefusal(args: Record<string, unknown>, pattern: RegExp): Promise<void> {
    seedSession(h.home);
    const result = await h.call("moi_configure_account", args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(pattern);
    expect(node.calls).toHaveLength(0);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(journalLines(h.home)).toEqual([]);
  }

  it.each([
    ["a public key that is not 33 bytes", { add: [listedKey("aa")] }, /expected a compressed public key/],
    ["a public key with an uncompressed prefix", { add: [`0x04${"aa".repeat(32)}`] }, /expected a compressed public key/],
    ["a key given as an object with a weight, which is not an input", { add: [{ publicKey: compressedKey("cc"), weight: 500 }] }, /Expected string, received object/],
    ["a negative key id", { revoke: [-1] }, /a key id is not negative/],
    ["a key id that is not a whole number", { revoke: [0.5] }, /a key id is a whole number/],
    [
      "more than 5 keys to add",
      { add: Array.from({ length: 6 }, (_v, i) => compressedKey(`0${i}`)) },
      /At most 5 keys can be added in one call\./,
    ],
    ["more than 5 key ids to revoke", { revoke: [0, 1, 2, 3, 4, 5] }, /At most 5 keys can be revoked in one call\./],
  ])("%s", async (_why, args, pattern) => {
    await expectSchemaRefusal(args, pattern);
  });

  it("lists the keys as plain text, 5 as the most, and no weight, account or algorithm, in the schema the model reads", async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === "moi_configure_account")!;
    const props = tool.inputSchema.properties as Record<string, { items?: { type?: string }; maxItems?: number }>;
    expect(Object.keys(props).sort()).toEqual(["add", "confirm", "revoke"]);
    expect(props["add"]!.items!.type).toBe("string");
    expect(props["add"]!.maxItems).toBe(5);
    expect(props["revoke"]!.maxItems).toBe(5);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("tells the model to compare the key on the phone, and not the amount and address that an ACCOUNT_CONFIGURE does not have", async () => {
    const { tools } = await h.client.listTools();
    const description = tools.find((t) => t.name === "moi_configure_account")!.description!;
    expect(description).toContain("Tell the user to compare the key on the phone, if it shows one, with the public key in the preview before tapping.");
    expect(description).toContain("you get a one-sentence summary, the values of the interaction, with every key in full, and a confirm token.");
    expect(description).not.toMatch(/amount and address/);
    expect(description).not.toContain("the exact values the wallet will display");
    // The rest of the shared approval text is still there: two calls, a summary, a confirm token.
    expect(description).toContain("Two calls, always.");
    expect(description.endsWith(KEY_APPROVAL_PROTOCOL)).toBe(true);
  });

  it("rewords the shared approval text only where the shared text still says what is replaced", () => {
    // If the shared text is ever reworded, a replacement stops matching, and the sentence that does not fit comes back unseen.
    for (const [from, to] of APPROVAL_REWORDINGS) {
      expect(APPROVAL_PROTOCOL).toContain(from);
      expect(KEY_APPROVAL_PROTOCOL).not.toContain(from);
      expect(KEY_APPROVAL_PROTOCOL).toContain(to);
    }
    expect(KEY_APPROVAL_PROTOCOL).not.toBe(APPROVAL_PROTOCOL);
  });

  it("says how to see the account's keys, and that an account whose key 0 cannot sign, a revoked key and a pending interaction are refused", async () => {
    const { tools } = await h.client.listTools();
    const description = tools.find((t) => t.name === "moi_configure_account")!.description!;
    expect(description).toContain("Call with neither `add` nor `revoke` to see the account's keys and their ids: that call is refused, and the refusal lists them.");
    expect(description).toContain("an account whose key 0 cannot sign alone");
    expect(description).toContain("a revoked key is not added again");
    expect(description).toContain("an interaction of this account that is still waiting to land");
  });
});

describe("the confirm token", () => {
  it("is not sent when the account's keys changed since the preview: the person is shown the preview again", async () => {
    serveKeys(node, ONE);
    seedSession(h.home);
    const first = await h.call("moi_configure_account", ADD);
    const token = first.structuredContent?.["confirm"] as string;
    // A key was added in the meantime.
    serveKeys(node, TWO);
    const second = await h.call("moi_configure_account", { ...ADD, confirm: token });
    expect(second.structuredContent).toMatchObject({
      status: "preview",
      note: expect.stringMatching(/The numbers changed since the preview/) as unknown,
    });
    expect(second.structuredContent?.["details"]).toMatchObject({ "Current key 1": `${listedKey("bb")} (weight 1000, not revoked)` });
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("is not sent for other arguments: another key needs its own preview", async () => {
    serveKeys(node, ONE);
    seedSession(h.home);
    const first = await h.call("moi_configure_account", ADD);
    const token = first.structuredContent?.["confirm"] as string;
    const another = { add: [compressedKey("dd")], confirm: token };
    const second = await h.call("moi_configure_account", another);
    expect(second.structuredContent).toMatchObject({
      status: "preview",
      note: expect.stringMatching(/That confirm token did not match this call/) as unknown,
    });
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("on the hosted server", () => {
  it("a write goes through the user's own pairing: one request to their topic, one journal entry of its kind", async () => {
    serveKeys(node, ONE);
    const store = fakeStore(new Map([[USER, session()], ["user-b", session({ userId: "user-b", topic: "topic-b" })]]));
    const hub = fakeHub();
    const journal = fakeJournal();
    const client = await connect(deps(store, hub, journal));
    try {
      const first = await client.callTool({ name: "moi_configure_account", arguments: REVOKE_THE_ONLY_KEY });
      expect(structured(first)).toMatchObject({ status: "error", code: "INVALID_ARGS" });
      expect(hub.signInteractionFor).not.toHaveBeenCalled();

      const preview = await client.callTool({ name: "moi_configure_account", arguments: ADD });
      expect(structured(preview)).toMatchObject({ status: "preview" });
      expect(hub.signInteractionFor).not.toHaveBeenCalled();
      const confirm = (structured(preview) as { confirm: string }).confirm;
      const sent = await client.callTool({ name: "moi_configure_account", arguments: { ...ADD, confirm } });
      expect(structured(sent)).toMatchObject({ status: "sent", hash: SENT_HASH });
      expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
      expect(hub.signInteractionFor.mock.calls[0]![0]).toBe(TOPIC);
      expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ kind: "configure_account", userId: USER }));
      expect(store.delete).not.toHaveBeenCalled(); // neither user's pairing was touched
    } finally {
      await client.close();
    }
  });
});
