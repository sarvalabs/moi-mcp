/**
 * What a pairing's lifetime actually does on the write path.
 *
 * Every write here goes preview, then confirm, the way a model performs it
 * (see helpers/hosted.ts#send); the preview step itself is pinned in
 * preview.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";
import { fakeWallet, installWallet, startHarness, type Harness } from "../helpers/harness.js";
import { connect, deps, fakeHub, fakeStore, send, session, structured, TOPIC, USER } from "../helpers/hosted.js";

let node: MockNode;
let h: Harness;

const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };
const soon = () => Math.floor(Date.now() / 1000) + 600;

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  installWallet(h.home, fakeWallet());
});

afterEach(async () => {
  await h.close();
  await node.close();
});

describe("a once-only pairing", () => {
  it("is forgotten the moment its transaction is signed and broadcast", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: soon() })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ hash?: string }>(await send(client, "moi_transfer", TRANSFER));

    expect(out.hash).toBe(SENT_HASH);
    expect(store.delete).toHaveBeenCalledWith(USER);
    expect(records.has(USER)).toBe(false);
    expect(hub.disconnect).toHaveBeenCalledWith(TOPIC);
  });

  it("cannot be used a second time", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: soon() })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    await send(client, "moi_transfer", TRANSFER);
    const out = structured<{ status?: string }>(await send(client, "moi_transfer", TRANSFER));

    expect(out.status).not.toBe("sent");
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });
});

describe("a persistent pairing", () => {
  it("survives being used", async () => {
    const records = new Map([[USER, session({ mode: "persistent", expiresAt: soon() })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ hash?: string }>(await send(client, "moi_transfer", TRANSFER));
    expect(out.hash).toBe(SENT_HASH);

    expect(store.delete).not.toHaveBeenCalled();
    expect(hub.disconnect).not.toHaveBeenCalled();
    expect(records.has(USER)).toBe(true);
  });
});

describe("a day pairing", () => {
  it("survives being used", async () => {
    const records = new Map([[USER, session({ mode: "day", expiresAt: soon() })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ hash?: string }>(await send(client, "moi_transfer", TRANSFER));
    expect(out.hash).toBe(SENT_HASH);

    expect(store.delete).not.toHaveBeenCalled();
    expect(hub.disconnect).not.toHaveBeenCalled();
    expect(records.has(USER)).toBe(true);
  });
});

describe("an expired pairing", () => {
  it("is refused before anything reaches the phone, and tidied up", async () => {
    const records = new Map([[USER, session({ mode: "persistent", expiresAt: Math.floor(Date.now() / 1000) - 1 })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ status?: string; reason?: string; message?: string }>(
      await send(client, "moi_transfer", TRANSFER),
    );

    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(out.message).toMatch(/expired/i);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith(USER);
  });

  it("of mode day is refused before anything reaches the phone", async () => {
    const records = new Map([[USER, session({ mode: "day", expiresAt: Math.floor(Date.now() / 1000) - 1 })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ status?: string; reason?: string; message?: string }>(
      await send(client, "moi_transfer", TRANSFER),
    );

    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(out.message).toMatch(/expired/i);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith(USER);
  });

  it("with no expiresAt at all is aged from its creation date", async () => {
    // A record from before lifetimes existed, created eight days ago.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const records = new Map([[USER, session({ createdAt: eightDaysAgo })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const out = structured<{ status?: string; reason?: string }>(await send(client, "moi_transfer", TRANSFER));
    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });
});
