/**
 * MOI_SIGNED_CHECK on the write path: what happens between the phone's answer and the broadcast.
 *
 * The comparison itself is pinned in signed-check.test.ts. Here the whole path runs, on the hosted server (the real runWrite,
 * with a fake store, hub and journal) and on the stdio server (a fake phone behind the real wallet client, and the real
 * journal file), against the mock node. Every honest phone in these tests returns the bytes of the interaction it was asked
 * to sign; the one that is not honest changes the fuel limit by one, which is the smallest change a person could not see.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { toPoloHex, toWireJson, type UnsignedInteraction } from "../../src/moi/ix-builder.js";
import {
  fakeWallet,
  installWallet,
  journalLines,
  seedSession,
  signatureFor,
  startHarness,
  type Harness,
  type WcRequest,
} from "../helpers/harness.js";
import { connect, deps, fakeHub, fakeJournal, fakeStore, send, session, structured, USER } from "../helpers/hosted.js";
import { KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };
const CREATE = { symbol: "TST", supply: "1000" };
const SIGNATURES = "0x" + "2".repeat(128);
const soon = () => Math.floor(Date.now() / 1000) + 600;

/** The bytes a phone signs for `ix`, with a change the person could not see on the screen. */
const signedWithFuelPlusOne = (ix: UnsignedInteraction) =>
  toPoloHex(toWireJson({ ...ix, fuel_limit: ix.fuel_limit + 1 }) as never);

let node: MockNode;
let h: Harness | undefined;
let lines: string[];
let stderr: MockInstance;

/** Every line the server logged that is about this check. The level is info, so a match is seen as well as a mismatch. */
const checkLines = () => lines.filter((line) => line.includes("signed check"));

/** The write tools on the hosted server's path, for a user with a persistent pairing. */
async function hosted(mode: "warn" | "enforce") {
  h = await startHarness(node.url, { env: { MOI_SIGNED_CHECK: mode, LOG_LEVEL: "info" } });
  const hub = fakeHub();
  const journal = fakeJournal();
  const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
  const client = await connect(deps(store, hub, journal));
  return { hub, journal, client };
}

/** The stdio server, whose phone is `respond`. The default is honest. */
async function stdio(mode: "warn" | "enforce", respond?: (req: WcRequest) => unknown) {
  h = await startHarness(node.url, { env: { MOI_SIGNED_CHECK: mode, LOG_LEVEL: "info" } });
  seedSession(h.home);
  const wallet = fakeWallet(respond);
  installWallet(h.home, wallet);
  return { harness: h, wallet };
}

const sentToNode = () => node.calls.find((c) => c.method === "moi.SendInteractions");

beforeEach(async () => {
  node = await startMockNode();
  lines = [];
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  stderr.mockRestore();
  await h?.close();
  h = undefined;
  await node.close();
});

describe.each(["warn", "enforce"] as const)("with MOI_SIGNED_CHECK=%s, an answer that is the previewed interaction", (mode) => {
  it("is broadcast as it came, and the match is logged at info level without the bytes", async () => {
    const { hub, journal, client } = await hosted(mode);

    const out = structured<{ status: string; hash?: string }>(await send(client, "moi_transfer", TRANSFER));

    expect(out).toMatchObject({ status: "sent", hash: SENT_HASH });
    const answer = (await hub.signInteractionFor.mock.results[0]!.value) as { ix_args: string; signatures: string };
    expect(sentToNode()?.params).toEqual({ ix_args: answer.ix_args, signatures: answer.signatures });
    expect(journal.update.mock.calls.map((c) => c[1])).toEqual(["signed", "broadcast", "confirmed"]);

    expect(checkLines()).toHaveLength(1);
    expect(checkLines()[0]).toContain(`signed check (${mode})`);
    expect(checkLines()[0]).toMatch(/matches the preview as the wire and full-width encodings, which are the same bytes/);
    expect(checkLines()[0]).toContain(`${answer.ix_args.length} hex characters`);
    expect(lines.join("")).not.toContain(answer.ix_args.slice(0, 24));
  });

  it("is accepted in either integer width, and the log says which", async () => {
    const { hub, client } = await hosted(mode);
    node.state.kmoiBalance = 50_000_000_000n;
    // A create carries a bigint, so the two encodings differ. A wallet that revives integers as bigints signs the second.
    hub.signInteractionFor.mockImplementationOnce(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: toPoloHex(structuredClone(ix)),
      signatures: SIGNATURES,
    }));

    expect(structured<{ status: string }>(await send(client, "moi_create_asset", CREATE)).status).toBe("sent");
    expect(checkLines()[0]).toMatch(/matches the preview as the full-width encoding/);

    hub.signInteractionFor.mockClear();
    lines.length = 0;
    expect(structured<{ status: string }>(await send(client, "moi_create_asset", CREATE)).status).toBe("sent");
    expect(checkLines()[0]).toMatch(/matches the preview as the wire encoding/);
  });

  it("is broadcast on the stdio server too, and journaled to its end", async () => {
    const { harness, wallet } = await stdio(mode);

    const result = await harness.send("moi_transfer", TRANSFER);

    expect(result.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(sentToNode()?.params).toEqual(signatureFor(wallet.requests[0]!));
    expect(journalLines(harness.home).map((e) => e["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    expect(checkLines()[0]).toContain(`signed check (${mode})`);
  });
});

describe("with MOI_SIGNED_CHECK=warn, an answer that is not the previewed interaction", () => {
  it("is broadcast anyway, and logged as a mismatch with lengths and no bytes", async () => {
    const { hub, journal, client } = await hosted("warn");
    hub.signInteractionFor.mockImplementation(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: signedWithFuelPlusOne(ix),
      signatures: SIGNATURES,
    }));

    const out = structured<{ status: string; hash?: string }>(await send(client, "moi_transfer", TRANSFER));

    // As before the check existed: the phone's bytes go to the node unread.
    expect(out).toMatchObject({ status: "sent", hash: SENT_HASH });
    const answer = (await hub.signInteractionFor.mock.results[0]!.value) as { ix_args: string };
    expect(sentToNode()?.params).toEqual({ ix_args: answer.ix_args, signatures: SIGNATURES });
    expect(journal.update.mock.calls.map((c) => c[1])).toEqual(["signed", "broadcast", "confirmed"]);

    expect(checkLines()).toHaveLength(1);
    const line = checkLines()[0]!;
    expect(line).toContain("signed check (warn)");
    expect(line).toMatch(/not byte for byte the one that was previewed/);
    expect(line).toContain(`the answer is ${answer.ix_args.length} hex characters, the wire form is ${answer.ix_args.length} and the full-width form is ${answer.ix_args.length}`);
    expect(line).toMatch(/broadcasting it anyway because MOI_SIGNED_CHECK is warn/);
    expect(lines.join("")).not.toContain(answer.ix_args.slice(0, 24));
  });

  it("is the default: with nothing set, a mismatch is broadcast", async () => {
    // startHarness sets enforce for the suite. A blank value is what an operator who never heard of the setting has: it
    // counts as unset, so the default applies. Blank rather than deleted, because a deleted key would be filled in from the
    // developer's own .env by dotenv (see applyEnv in helpers/harness.ts).
    h = await startHarness(node.url, { env: { MOI_SIGNED_CHECK: "", LOG_LEVEL: "info" } });
    const hub = fakeHub();
    hub.signInteractionFor.mockImplementation(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: signedWithFuelPlusOne(ix),
      signatures: SIGNATURES,
    }));
    const store = fakeStore(new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]));
    const client = await connect(deps(store, hub, fakeJournal()));

    expect(structured<{ status: string }>(await send(client, "moi_transfer", TRANSFER)).status).toBe("sent");
    expect(checkLines()[0]).toContain("signed check (warn)");
  });

  it("is broadcast on the stdio server too", async () => {
    const { harness } = await stdio("warn", (req) => ({
      ...signatureFor(req),
      ix_args: signedWithFuelPlusOne(structuredClone(req.request.params[0]) as UnsignedInteraction),
    }));

    const result = await harness.send("moi_transfer", TRANSFER);

    expect(result.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    expect(sentToNode()).toBeDefined();
    expect(journalLines(harness.home).map((e) => e["state"])).toEqual(["proposed", "signed", "broadcast", "confirmed"]);
    expect(checkLines()[0]).toContain("signed check (warn)");
  });
});

describe("with MOI_SIGNED_CHECK=enforce, an answer that is not the previewed interaction", () => {
  it("is refused: nothing is broadcast, the entry ends orphaned with the reason, and the person is told", async () => {
    const { hub, journal, client } = await hosted("enforce");
    hub.signInteractionFor.mockImplementation(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: signedWithFuelPlusOne(ix),
      signatures: SIGNATURES,
    }));

    const result = await send(client, "moi_transfer", TRANSFER);

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(
      /^\[RPC_ERROR\] MOI Wallet returned a different interaction than the one that was previewed\. Nothing was sent to the network/,
    );
    expect(text).toMatch(/signature was discarded/);
    expect(structured(result)).toMatchObject({ status: "error", code: "RPC_ERROR" });

    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
    // The phone had signed by then, so the entry is orphaned and never failed, broadcast or confirmed.
    expect(journal.update.mock.calls.map((c) => c[1])).toEqual(["signed", "orphaned"]);
    const orphaned = journal.update.mock.calls.find((c) => c[1] === "orphaned")!;
    expect(orphaned[2]).toEqual({ detail: expect.stringMatching(/different interaction than the one that was previewed/) });

    expect(checkLines()).toHaveLength(1);
    expect(checkLines()[0]).toContain("signed check (enforce)");
    expect(checkLines()[0]).toMatch(/refusing to broadcast it/);
    const answer = (await hub.signInteractionFor.mock.results[0]!.value) as { ix_args: string };
    expect(lines.join("")).not.toContain(answer.ix_args.slice(0, 24));
  });

  it("is refused for a recipient that was swapped, not only for fuel", async () => {
    const { hub, journal, client } = await hosted("enforce");
    // The phone signs a transfer to someone else: same sender, sequence and fuel, another beneficiary.
    hub.signInteractionFor.mockImplementation(async (_topic: string, ix: UnsignedInteraction) => {
      const swapped = structuredClone(ix);
      const calldata = String(swapped.ix_operations[0]!.payload["calldata"]);
      swapped.ix_operations[0]!.payload["calldata"] = calldata.replace(OTHER.slice(2), "5".repeat(OTHER.length - 2));
      expect(swapped.ix_operations[0]!.payload["calldata"]).not.toBe(calldata);
      return { ix_args: toPoloHex(toWireJson(swapped) as never), signatures: SIGNATURES };
    });

    const result = await send(client, "moi_transfer", TRANSFER);

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/different interaction/);
    expect(node.methods()).not.toContain("moi.SendInteractions");
    expect(journal.update.mock.calls.map((c) => c[1])).toEqual(["signed", "orphaned"]);
  });

  it("spends the confirm token: a retry with it is a fresh preview", async () => {
    const { hub, client } = await hosted("enforce");
    hub.signInteractionFor.mockImplementationOnce(async (_topic: string, ix: UnsignedInteraction) => ({
      ix_args: signedWithFuelPlusOne(ix),
      signatures: SIGNATURES,
    }));
    const preview = structured<{ confirm: string }>(await client.callTool({ name: "moi_transfer", arguments: TRANSFER }));
    const args = { ...TRANSFER, confirm: preview.confirm };

    expect((await client.callTool({ name: "moi_transfer", arguments: args })).isError).toBe(true);
    const again = structured<{ status: string; note?: string }>(await client.callTool({ name: "moi_transfer", arguments: args }));

    expect(again.status).toBe("preview");
    expect(again.note).toMatch(/did not match/);
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });

  it("is refused on the stdio server too, and the journal file says why", async () => {
    const { harness } = await stdio("enforce", (req) => ({
      ...signatureFor(req),
      ix_args: signedWithFuelPlusOne(structuredClone(req.request.params[0]) as UnsignedInteraction),
    }));

    const result = await harness.send("moi_transfer", TRANSFER);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[RPC_ERROR\] MOI Wallet returned a different interaction/);
    expect(node.methods()).not.toContain("moi.SendInteractions");
    const entries = journalLines(harness.home);
    expect(entries.map((e) => e["state"])).toEqual(["proposed", "signed", "orphaned"]);
    expect(entries.at(-1)?.["detail"]).toMatch(/different interaction than the one that was previewed/);
  });
});
