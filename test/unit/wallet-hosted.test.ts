/**
 * The hosted pairing tool as a model sees it: through a real McpServer over an in-memory transport, so the client checks
 * structuredContent against the tool's output schema the way a strict client does.
 *
 * claude.ai gives its model the content text of a result and not structuredContent, so what the model must do is asserted
 * on the text, and on the description it reads before calling.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { hostedWalletTools, type HostedWalletDeps } from "../../src/tools/wallet-hosted.js";
import { toBlockText } from "../../src/wc/qr.js";
import type { StoredWalletSession } from "../../src/wc/store.js";
import { ACCOUNT } from "../helpers/mock-node.js";
import { authFor, fakeHub, fakeStore, session, USER } from "../helpers/hosted.js";

/** A pairing URI of the real shape: 64 hex topic, 64 hex key, a ten digit expiry. */
function realUri(): string {
  return `wc:${randomBytes(32).toString("hex")}@2?relay-protocol=irn&symKey=${randomBytes(32).toString("hex")}&expiryTimestamp=1790000000`;
}

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

/** What a model sends: the lifetime the person chose. */
type Args = Record<string, unknown>;

async function connect(records: Map<string, StoredWalletSession> = new Map(), args: Args = { lifetime: "week" }) {
  const uri = realUri();
  // The deps carry no createPairingLink: the tool must not need one.
  const deps: HostedWalletDeps = {
    store: fakeStore(records),
    hub: fakeHub(),
    startPairing: vi.fn(async () => ({ uri, expiresAt: Math.floor(Date.now() / 1000) + 300 })),
  };
  const server = new McpServer({ name: "t", version: "0" });
  for (const def of hostedWalletTools(deps, authFor(USER))) server.registerTool(def.name, def.config as never, def.handler as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  // Listing first lets the client validate structuredContent against each tool's output schema on the call.
  const { tools } = await client.listTools();
  const description = tools.find((t) => t.name === "moi_connect_wallet")?.description ?? "";
  const connectTool = tools.find((t) => t.name === "moi_connect_wallet");
  const result = await client.callTool({ name: "moi_connect_wallet", arguments: args });
  const content = result.content as Content;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return { uri, deps, client, connectTool, description, result, content, text };
}

describe("moi_connect_wallet shows the code in the chat", () => {
  it("begins the text with a fenced code block holding the QR text", async () => {
    const { uri, text } = await connect();
    const expected = await toBlockText(uri);
    expect(text.startsWith("```\n" + expected + "\n```\n")).toBe(true);
  });

  it("tells the model to show the block unchanged before anything else, in the result and in the description", async () => {
    const { text, description } = await connect();
    expect(text).toContain("exactly as it is, unchanged, in a code block, before anything else you say");
    expect(text).toContain("Keep every space at the start and end of each line");
    expect(description).toContain("exactly as given, unchanged, in a code block, before any other text");
    expect(description).toContain("keep every space at the start and end of each line");
  });

  it("keeps the image block, first", async () => {
    const { content } = await connect();
    expect(content[0]?.type).toBe("image");
    expect(content[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(content[0]?.data ?? "", "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(content[1]?.type).toBe("text");
  });

  it("has no pairing page link and does not mention a page", async () => {
    const { uri, text, description, result } = await connect();
    const pageWords = /pair\/|https?:\/\/|web page|\bpage\b|link/i;
    expect(text).not.toMatch(pageWords);
    expect(description).not.toMatch(pageWords);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured["pairingUrl"]).toBeUndefined();
    expect(structured["uri"]).toBe(uri);
    expect(uri.startsWith("wc:")).toBe(true);
  });

  it("keeps the raw wc: pairing string out of the text, the description and the instruction to the model", async () => {
    const { uri, text, description } = await connect();
    // The string carries the key to join the pairing, so it is a secret in a transcript and noise next to the code. The
    // code is the only place the text spells it, and only as block characters.
    expect(text).not.toContain("wc:");
    expect(text).not.toContain(uri);
    expect(text).not.toContain("symKey");
    expect(description).not.toContain("wc:");
    expect(description).not.toMatch(/pairing string|connect-by-URI|connect via URI/i);
    expect(text).not.toMatch(/pairing string|connect-by-URI|connect via URI/i);
  });

  it("still returns the pairing string in structuredContent, as before", async () => {
    const { uri, result } = await connect();
    expect((result.structuredContent as Record<string, unknown>)["uri"]).toBe(uri);
  });

  it("does not call createPairingLink, which its deps do not have", async () => {
    const { deps, result } = await connect();
    expect("createPairingLink" in deps).toBe(false);
    expect(result.isError).toBeFalsy();
    expect(deps.startPairing).toHaveBeenCalledTimes(1);
  });

  it("passes the lifetime it was asked for to the pairing it starts", async () => {
    const { deps } = await connect();
    expect(deps.startPairing).toHaveBeenCalledWith(USER, "persistent");
  });

  it("states the lifetime in the text when it replaces a live pairing", async () => {
    const { text } = await connect(new Map([[USER, session({ address: ACCOUNT })]]), { lifetime: "day" });
    expect(text).toContain("You stay connected for 24 hours after you approve it.");
  });

  it("names a live pairing as replaced, after the block", async () => {
    const { text } = await connect(new Map([[USER, session({ address: ACCOUNT })]]));
    const lines = text.split("\n");
    const note = lines.findIndex((line) => line.includes(`already paired to this account (${ACCOUNT})`));
    expect(note).toBeGreaterThan(lines.lastIndexOf("```"));
  });

  it("says nothing that claims the code scans", async () => {
    const { text, description } = await connect();
    const claim = /scannable|will scan|scans reliably/i;
    expect(text).not.toMatch(claim);
    expect(description).not.toMatch(claim);
  });
});

describe("moi_connect_wallet asks how long the connection should stay open", () => {
  const startedCount = (r: Awaited<ReturnType<typeof connect>>) => (r.deps.startPairing as ReturnType<typeof vi.fn>).mock.calls.length;

  it("refuses a call without lifetime, and a call that still sends remember", async () => {
    for (const args of [{}, { remember: true }, { remember: false }]) {
      const r = await connect(new Map(), args);
      expect(r.result.isError).toBe(true);
      const text = (r.content.find((c) => c.type === "text")?.text ?? "").toLowerCase();
      expect(text).toContain("lifetime");
      expect(startedCount(r)).toBe(0);
    }
  });

  it("refuses a lifetime it does not offer", async () => {
    for (const lifetime of ["forever", "month", "persistent", "Week", "", 7]) {
      const r = await connect(new Map(), { lifetime });
      expect(r.result.isError).toBe(true);
      expect(startedCount(r)).toBe(0);
    }
  });

  it("publishes lifetime as a required enum of once, day and week", async () => {
    const { connectTool } = await connect();
    const schema = connectTool?.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[]; type?: string }> };
    expect(schema.required).toEqual(["lifetime"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["lifetime"]);
    expect(schema.properties?.["lifetime"]?.enum).toEqual(["once", "day", "week"]);
  });

  it("tells the model to ask first, in the description and in the input", async () => {
    const { description, connectTool } = await connect();
    expect(description).toContain("ask the person how long the connection should stay open");
    expect(description).toMatch(/once, which ends after the next approved transaction or after 15 minutes/);
    expect(description).toMatch(/day, which is 24 hours/);
    expect(description).toMatch(/week, which is 7 days/);
    expect(description).toContain("Do not assume an answer");
    expect(description).toContain("do not call this tool until the person has given one");
    // The sentence comes straight after the first one, before anything about the code.
    expect(description.indexOf("ask the person")).toBeLessThan(description.indexOf("QR"));

    const input = (connectTool?.inputSchema as { properties: Record<string, { description?: string }> }).properties["lifetime"]?.description ?? "";
    expect(input).toContain("never choose for them");
    expect(input).toContain("required");
    // Complete sentences: every sentence starts with a capital letter and ends with a full stop.
    expect(input).toMatch(/^[A-Z].*\.$/);
    for (const sentence of input.split(/(?<=\.) /)) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });

  it.each([
    ["once", "once", "once", /next approved transaction/, /15 minutes after you approve it/],
    ["day", "day", "day", /24 hours after you approve it/, undefined],
    ["week", "persistent", "week", /7 days after you approve it/, undefined],
  ] as const)("lifetime %s starts a %s pairing and the result says so", async (lifetime, mode, word, says, also) => {
    const r = await connect(new Map(), { lifetime });
    expect(r.result.isError).toBeFalsy();
    expect(r.deps.startPairing).toHaveBeenCalledWith(USER, mode);
    expect((r.result.structuredContent as Record<string, unknown>)["lifetime"]).toBe(word);
    expect((r.result.structuredContent as Record<string, unknown>)["mode"]).toBeUndefined();
    expect(r.text).toMatch(says);
    if (also) expect(r.text).toMatch(also);
    expect(r.text).toContain('Say "disconnect my wallet" to end it sooner.');
    // The sentences for the other lifetimes are not in this result.
    if (lifetime !== "week") expect(r.text).not.toMatch(/\bweek\b|7 days/);
    if (lifetime !== "day") expect(r.text).not.toContain("24 hours");
    if (lifetime !== "once") expect(r.text).not.toContain("next approved transaction");
  });

  it("states the clocks as starting at approval, not at the call", async () => {
    for (const lifetime of ["once", "day", "week"]) {
      const { text } = await connect(new Map(), { lifetime });
      expect(text).toMatch(/after you approve it/);
    }
  });
});

describe("moi_wallet_status reports the lifetime in the tool's words", () => {
  async function status(records: Map<string, StoredWalletSession>) {
    const { client } = await connect(records, { lifetime: "week" });
    // Listing happened in connect(), so the client validates this result against the published output schema.
    return client.callTool({ name: "moi_wallet_status", arguments: {} });
  }
  const soon = () => Math.floor(Date.now() / 1000) + 600;

  it.each([
    [{ mode: "persistent" as const }, "week"],
    [{ mode: "day" as const }, "day"],
    [{ mode: "once" as const }, "once"],
    [{}, "week"],
  ])("record %j reports %s with an expiry", async (over, lifetime) => {
    const expiresAt = soon();
    const r = await status(new Map([[USER, session({ ...over, expiresAt })]]));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ connected: true, address: ACCOUNT, lifetime, expiresAt });
    expect((r.structuredContent as Record<string, unknown>)["mode"]).toBeUndefined();
  });

  it("ages a record with no expiresAt from its creation, as a week", async () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const r = await status(new Map([[USER, session({ createdAt })]]));
    const created = Math.floor(new Date(createdAt).getTime() / 1000);
    expect(r.structuredContent).toMatchObject({ connected: true, lifetime: "week", expiresAt: created + 7 * 24 * 60 * 60 });
  });

  it("deletes an expired record and reports disconnected", async () => {
    const records = new Map([[USER, session({ mode: "day", expiresAt: Math.floor(Date.now() / 1000) - 1 })]]);
    const r = await status(records);
    expect(r.structuredContent).toEqual({ connected: false });
    expect(records.has(USER)).toBe(false);
  });
});
