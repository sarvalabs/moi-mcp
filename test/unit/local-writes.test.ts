/**
 * The adapters that put the stdio server on the hosted write path, tested directly. Only the phone is a fake: the
 * session file, the journal and the config are real, in a temp MOI_MCP_HOME.
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WriteJournal } from "../../src/journal.js";
import { buildTransfer } from "../../src/moi/ix-builder.js";
import { isMoiError, type MoiError } from "../../src/moi-error.js";
import { LOCAL_AUTH, localWriteDeps } from "../../src/tools/local-writes.js";
import { registerLocalWriteTools } from "../../src/tools/register.js";
import { sessionPath } from "../../src/wc/session.js";
import { StoredWalletSession } from "../../src/wc/store.js";
import { ACCOUNT, KMOI, OTHER } from "../helpers/mock-node.js";
import {
  applyEnv,
  fakeWallet,
  installWallet,
  restoreEnv,
  seedSession,
  signatureFor,
  tempHome,
  type FakeWallet,
} from "../helpers/harness.js";

let home: string;
let wallet: FakeWallet;

beforeEach(() => {
  home = tempHome();
  applyEnv("http://127.0.0.1:1", home); // nothing here reaches the node
  wallet = fakeWallet();
  installWallet(home, wallet);
});

afterEach(() => {
  restoreEnv();
  rmSync(home, { recursive: true, force: true });
});

/** The MoiError a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<MoiError> {
  try {
    await promise;
  } catch (err) {
    expect(isMoiError(err)).toBe(true);
    return err as MoiError;
  }
  throw new Error("expected a refusal");
}

const transfer = () => buildTransfer({ id: ACCOUNT, sequence: 1, keyId: 0 }, { to: OTHER, assetId: KMOI, amount: 1n });

describe("LOCAL_AUTH", () => {
  it("is one constant user with both scopes, and never expires", () => {
    expect(LOCAL_AUTH).toEqual({
      userId: "local",
      clientId: "stdio",
      scopes: ["moi:read", "moi:write"],
      expiresAt: expect.any(Number),
    });
    expect(LOCAL_AUTH.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("the store adapter", () => {
  it("maps the session.json the wallet client keeps to a stored session, and leaves the file as it was", async () => {
    seedSession(home, { topic: "topic-x", expiry: 4_102_444_800 });
    const before = readFileSync(sessionPath(home), "utf8");

    const stored = await localWriteDeps().store.get("local");

    expect(stored).toEqual({
      version: 1,
      userId: "local",
      topic: "topic-x",
      caip2: "moi:custom",
      address: ACCOUNT,
      sessionData: {},
      createdAt: expect.any(String),
      mode: "persistent",
      expiresAt: 4_102_444_800,
    });
    expect(() => StoredWalletSession.parse(stored)).not.toThrow();
    expect(readFileSync(sessionPath(home), "utf8")).toBe(before);
  });

  it("knows no other user, and builds no wallet client to say so", async () => {
    seedSession(home);
    await expect(localWriteDeps().store.get("someone-else")).resolves.toBeUndefined();
    expect(wallet.factory).not.toHaveBeenCalled();
  });

  it("unpaired: refuses in stdio's words, which name moi_connect_wallet", async () => {
    const err = await refusal(localWriteDeps().store.get("local"));
    expect(err.code).toBe("WALLET_NOT_CONNECTED");
    expect(err.message).toMatch(/moi_connect_wallet/);
  });

  it("paired on another network: refuses as a network mismatch", async () => {
    seedSession(home, { network: "voyage", chainId: "moi:14" });
    const err = await refusal(localWriteDeps().store.get("local"));
    expect(err.code).toBe("NETWORK_MISMATCH");
    expect(err.message).toMatch(/voyage/);
  });

  it("expired: refuses as not connected", async () => {
    seedSession(home, { expiry: Math.floor(Date.now() / 1000) - 10 });
    const err = await refusal(localWriteDeps().store.get("local"));
    expect(err.code).toBe("WALLET_NOT_CONNECTED");
    expect(err.message).toMatch(/expired/i);
  });

  it("delete forgets the pairing for the local user and for no one else", async () => {
    seedSession(home);
    const { store } = localWriteDeps();
    await store.delete("someone-else");
    expect(existsSync(sessionPath(home))).toBe(true);
    await store.delete("local");
    expect(existsSync(sessionPath(home))).toBe(false);
  });
});

describe("the hub adapter", () => {
  it("signs on the paired session: its topic and chain, and the phone's answer comes back", async () => {
    seedSession(home);
    const signed = await localWriteDeps().hub.signInteractionFor("topic-test", transfer(), { description: "x" });

    expect(wallet.requests).toHaveLength(1);
    expect(wallet.requests[0]).toMatchObject({
      topic: "topic-test",
      chainId: "moi:custom",
      request: { method: "moi.signInteraction" },
    });
    expect(signed).toEqual(signatureFor(wallet.requests[0]!));
  });

  it("refuses a topic that is not the paired one, without asking the phone", async () => {
    seedSession(home);
    const err = await refusal(localWriteDeps().hub.signInteractionFor("some-other-topic", transfer()));
    expect(err.code).toBe("WALLET_NOT_CONNECTED");
    expect(err.message).toMatch(/no longer valid/);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("refuses when no pairing is on disk, and reads the file rather than opening the relay", async () => {
    const err = await refusal(localWriteDeps().hub.signInteractionFor("topic-test", transfer()));
    expect(err.code).toBe("WALLET_NOT_CONNECTED");
    expect(wallet.factory).not.toHaveBeenCalled();
  });

  it("disconnects the paired topic and no other", async () => {
    seedSession(home);
    const { hub } = localWriteDeps();

    await hub.disconnect("some-other-topic");
    expect(wallet.disconnect).not.toHaveBeenCalled();
    expect(existsSync(sessionPath(home))).toBe(true);

    await hub.disconnect("topic-test");
    expect(wallet.disconnect).toHaveBeenCalledTimes(1);
    expect(wallet.disconnect).toHaveBeenCalledWith({
      topic: "topic-test",
      reason: { code: 6000, message: "User requested disconnect" },
    });
    expect(existsSync(sessionPath(home))).toBe(false);
  });
});

describe("the journal adapter", () => {
  it("creates journal.jsonl on first use, readable only by its owner", async () => {
    const { journal } = localWriteDeps();
    const file = join(home, "journal.jsonl");
    expect(existsSync(file)).toBe(false);

    await journal.append({ id: "w1", userId: "local", kind: "transfer", state: "proposed" });
    await journal.update("w1", "signed");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const current = await new WriteJournal(home).current();
    expect(current.map((entry) => [entry.id, entry.state, entry.userId])).toEqual([["w1", "signed", "local"]]);
  });
});

describe("registration", () => {
  it("is lazy: a bad config, no wallet client and no journal at registration, and still all eleven tools", () => {
    applyEnv("http://127.0.0.1:1", home, { WC_PROJECT_ID: "replace_me" }); // getConfig() now throws
    installWallet(home, wallet); // applyEnv drops the installed client

    const server = new McpServer({ name: "t", version: "0" });
    expect(() => localWriteDeps()).not.toThrow();
    expect(() => registerLocalWriteTools(server)).not.toThrow();

    expect(wallet.factory).not.toHaveBeenCalled();
    expect(existsSync(join(home, "journal.jsonl"))).toBe(false);
    expect(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual([
      "moi_transfer",
      "moi_create_account",
      "moi_configure_account",
      "moi_create_asset",
      "moi_mint",
      "moi_call_logic",
      "moi_deploy_logic",
      "moi_asset_invoke",
      "moi_register_agent",
      "moi_set_agent_status",
      "moi_transfer_agent",
    ]);
  });
});
