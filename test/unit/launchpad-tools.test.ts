/**
 * The moi_launchpad_* tools against a fake Launchpad (test/helpers/launchpad.ts)
 * over a real McpServer, with the wallet side faked the way the hosted write
 * tests fake it: a store with a paired session, a hub whose phone always
 * signs, and a journal that records.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { primeRegistryDriverForTests, resetRegistryCache } from "../../src/moi/registry.js";
import { ErrorCode } from "../../src/schema.js";
import type { runWrite } from "../../src/tools/hosted-writes.js";
import { authFor, deps as writeDeps, fakeHub, fakeJournal, fakeStore, session, structured, TOPIC, USER } from "../helpers/hosted.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import {
  AGENT_WALLET,
  COOKIE,
  connectLaunchpad,
  fakeSessions,
  launchpadDeps,
  RECORD_ID,
  signedInRecord,
  startFakeLaunchpad,
  type FakeLaunchpad,
} from "../helpers/launchpad.js";
import { ACCOUNT } from "../helpers/mock-node.js";

const REGISTRY = "0x200000002f3e9469d94de695be18fc5839fb9535f543b381f903f7f800000000";
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

let fake: FakeLaunchpad;
beforeAll(async () => {
  applyEnv("http://127.0.0.1:1", tempHome(), { MOI_AGENT_REGISTRY_LOGIC_ID: REGISTRY });
  fake = await startFakeLaunchpad();
});
afterAll(async () => {
  await fake.close();
  restoreEnv();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.state.agentStatus = "pending_grant";
  fake.state.cookieValid = true;
  fake.state.keyReadable = true;
  fake.state.telegramLinked = false;
  fake.state.verifyOk = true;
});
afterEach(() => resetRegistryCache());

/** Registry that knows the agent's wallet only once `registered` flips. */
function primeRegistry(registered: () => boolean) {
  const routine = (impl: (...a: unknown[]) => unknown) =>
    vi.fn(async (...a: unknown[]) => ({ call: async () => ({ result: async () => impl(...a) }) }));
  primeRegistryDriverForTests(REGISTRY, {
    routines: {
      GetAgentsByOwner: routine(() => ({ output: registered() ? { ids: ["agent_9"], total: 1n } : { ids: [], total: 0n }, error: null })),
      GetAgentProfile: routine((id) => ({
        output:
          id === "agent_9"
            ? { profile: { agent_id: "agent_9", owner: bytes(ACCOUNT), agent_wallet: bytes(AGENT_WALLET), status: "ACTIVE", url: "", card_uri: "", score: 0n, created_at: 0n, updated_at: 0n }, found: true }
            : { profile: {}, found: false },
        error: null,
      })),
    },
  });
}

function wallet(paired = true) {
  const records = new Map([[USER, session()]]);
  if (!paired) records.clear();
  return writeDeps(fakeStore(records), fakeHub(), fakeJournal());
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

describe("moi_launchpad_sign_in", () => {
  it("asks the Launchpad for its message, has the phone sign it, and keeps the cookie", async () => {
    const writes = wallet();
    const sessions = fakeSessions();
    const client = await connectLaunchpad(launchpadDeps(fake, writes, sessions));

    const res = await callTool(client, "moi_launchpad_sign_in");
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ signedIn: true, wallet: ACCOUNT, launchpad: fake.url });

    // The phone signed exactly the Launchpad's text, as the paired account.
    const hub = writes.hub as ReturnType<typeof fakeHub>;
    expect(hub.signMessageFor).toHaveBeenCalledTimes(1);
    const [topic, account, message] = hub.signMessageFor.mock.calls[0] as [string, string, string];
    expect(topic).toBe(TOPIC);
    expect(account).toBe(ACCOUNT);
    expect(message).toContain(`Wallet: ${ACCOUNT}`);
    expect(message).toContain("Nonce: n1");

    const verify = fake.requests.find((r) => r.path === "/api/auth/verify")!;
    expect(verify.body).toEqual({ address: ACCOUNT, message, signature: "0xfeed" });

    const stored = [...sessions.records.values()].find((r) => r.userId === USER)!;
    expect(stored.cookie).toBe(COOKIE);
    expect(stored.baseUrl).toBe(fake.url);
    expect(stored.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 604_000);
  });

  it("needs a paired wallet first", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(false), fakeSessions()));
    const res = await callTool(client, "moi_launchpad_sign_in");
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No wallet paired/);
    expect(fake.requests).toHaveLength(0);
  });

  it("surfaces a refused signature without storing anything", async () => {
    fake.state.verifyOk = false;
    const sessions = fakeSessions();
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_sign_in");
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/invalid_signature/);
    expect(sessions.records.size).toBe(0);
  });
});

describe("moi_launchpad_status", () => {
  it("says so when not signed in, and lists agents when it is", async () => {
    const sessions = fakeSessions();
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    expect(structured(await callTool(client, "moi_launchpad_status"))).toEqual({ launchpad: fake.url, signedIn: false });

    await sessions.set(signedInRecord(fake.url));
    const on = structured<{ signedIn: boolean; telegramLinked: boolean; agents: Array<{ id: string; status: string }> }>(
      await callTool(client, "moi_launchpad_status"),
    );
    expect(on.signedIn).toBe(true);
    expect(on.telegramLinked).toBe(false);
    expect(on.agents).toEqual([expect.objectContaining({ id: RECORD_ID, name: "Rain Check", address: AGENT_WALLET, status: "pending_grant", keyReadable: true })]);
    expect(fake.requests.every((r) => r.cookie === `moi_session=${COOKIE}`)).toBe(true);
  });

  it("forgets a session the Launchpad no longer accepts", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    fake.state.cookieValid = false;
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const out = structured<{ signedIn: boolean; note?: string }>(await callTool(client, "moi_launchpad_status"));
    expect(out.signedIn).toBe(false);
    expect(out.note).toMatch(/sign_in again/);
    expect(sessions.records.size).toBe(0);
  });

  it("treats an expired session as signed out", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url, { expiresAt: Math.floor(Date.now() / 1000) - 5 })]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const out = structured<{ signedIn: boolean; note?: string }>(await callTool(client, "moi_launchpad_status"));
    expect(out.signedIn).toBe(false);
    expect(out.note).toMatch(/expired/);
    expect(sessions.records.size).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("moi_launchpad_templates", () => {
  it("lists templates with their config fields, without a sign-in", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()), null);
    const out = structured<{ templates: Array<Record<string, unknown>> }>(await callTool(client, "moi_launchpad_templates"));
    expect(out.templates).toHaveLength(2);
    expect(out.templates[0]).toMatchObject({
      id: "weather_brief",
      name: "Weather Brief",
      scopes: ["deliver:telegram", "read:weather"],
      available: true,
      configFields: [
        { key: "city", label: "City", type: "text", placeholder: "Mumbai" },
        { key: "time", label: "Delivery time", type: "time" },
      ],
    });
    expect(out.templates[1]).toMatchObject({ id: "job_search", available: false });
  });
});

describe("moi_launchpad_create_agent", () => {
  it("creates the agent with the session cookie and says what comes next", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_create_agent", {
      templateId: "weather_brief",
      name: "Rain Check",
      config: { city: "Bengaluru", time: "07:30" },
    });
    expect(res.isError).toBeFalsy();
    const out = structured<{ agent: { id: string; status: string }; next: string }>(res);
    expect(out.agent).toMatchObject({ id: RECORD_ID, name: "Rain Check", address: AGENT_WALLET, template: "weather_brief", status: "pending_grant" });
    expect(out.next).toMatch(/moi_launchpad_register_agent/);

    const post = fake.requests.find((r) => r.method === "POST" && r.path === "/api/agents")!;
    expect(post.cookie).toBe(`moi_session=${COOKIE}`);
    expect(post.body).toMatchObject({ templateId: "weather_brief", name: "Rain Check", config: { city: "Bengaluru", time: "07:30" } });
    expect((post.body as { avatarSeed: string }).avatarSeed).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses without a Launchpad session, before touching the Launchpad", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()));
    const res = await callTool(client, "moi_launchpad_create_agent", { templateId: "weather_brief", name: "Rain Check" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/moi_launchpad_sign_in/);
    expect(fake.requests).toHaveLength(0);
  });

  it("passes a taken name back as the Launchpad's own refusal", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_create_agent", { templateId: "weather_brief", name: "Taken" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/name_taken/);
  });
});

describe("moi_launchpad_register_agent", () => {
  const HASH = "0x" + "ab".repeat(32);

  /** Stands in for the phone and the node: previews, then reports "sent". */
  function fakeWrite() {
    let registered = false;
    const write = vi.fn(async (_deps, _auth, kind, _args, confirm) => {
      expect(kind).toBe("register_agent");
      if (!confirm) {
        const value = { status: "preview", confirm: "tok", summary: "Register agent", details: {}, fuel: "x", network: "custom", expiresAt: new Date().toISOString() };
        return { content: [{ type: "text" as const, text: "preview" }], structuredContent: value };
      }
      registered = true;
      const value = { status: "sent", hash: HASH, explorerUrl: `https://voyage.moi.technology/interactions/${HASH}`, summary: "Register agent" };
      return { content: [{ type: "text" as const, text: "sent" }], structuredContent: value };
    }) as unknown as typeof runWrite;
    return { write, registered: () => registered };
  }

  it("previews first, then registers on chain and tells the Launchpad with the registry id", async () => {
    const { write, registered } = fakeWrite();
    primeRegistry(registered);
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions, { write }));

    const preview = structured<{ status: string; confirm: string }>(await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID }));
    expect(preview.status).toBe("preview");
    expect(fake.requests.some((r) => r.path.endsWith("/register-intent"))).toBe(true);
    expect(fake.requests.some((r) => r.path.endsWith("/register-confirm"))).toBe(false);

    const sent = structured<{ status: string; hash: string; registryAgentId?: string; launchpadStatus: string; note?: string }>(
      await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID, confirm: preview.confirm }),
    );
    expect(sent).toMatchObject({ status: "sent", hash: HASH, registryAgentId: "agent_9", launchpadStatus: "active" });
    expect(sent.note).toBeUndefined();

    const confirm = fake.requests.find((r) => r.path.endsWith("/register-confirm"))!;
    expect(confirm.body).toEqual({ txHash: HASH, agentId: "agent_9" });
    expect(fake.state.agentStatus).toBe("active");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("confirms by hash alone when the registry has not listed the agent yet", async () => {
    const { write } = fakeWrite();
    primeRegistry(() => false);
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions, { write }));
    const sent = structured<{ status: string; registryAgentId?: string; launchpadStatus: string; note?: string }>(
      await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID, confirm: "tok" }),
    );
    expect(sent).toMatchObject({ status: "sent", launchpadStatus: "active" });
    expect(sent.registryAgentId).toBeUndefined();
    expect(sent.note).toMatch(/by hash/);
    expect(fake.requests.find((r) => r.path.endsWith("/register-confirm"))!.body).toEqual({ txHash: HASH });
  });

  it("skips the phone when the agent is already in the registry, and just tells the Launchpad", async () => {
    const { write } = fakeWrite();
    primeRegistry(() => true);
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions, { write }));
    const out = structured<{ status: string; registryAgentId?: string; launchpadStatus: string; note?: string }>(
      await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID }),
    );
    expect(out).toMatchObject({ status: "sent", registryAgentId: "agent_9", launchpadStatus: "active" });
    expect(out.note).toMatch(/already in the registry/);
    expect(write).not.toHaveBeenCalled();
    expect(fake.requests.find((r) => r.path.endsWith("/register-confirm"))!.body).toEqual({ txHash: "recovered:agent_9", agentId: "agent_9" });
  });

  it("refuses an agent that is not awaiting registration, without a preview", async () => {
    const { write } = fakeWrite();
    primeRegistry(() => false);
    fake.state.agentStatus = "active";
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions, { write }));
    const out = structured<{ status: string; code: string; message: string }>(await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID }));
    expect(out.status).toBe("error");
    expect(out.code).toBe(ErrorCode.INVALID_ARGS);
    expect(out.message).toMatch(/is active/);
    expect(write).not.toHaveBeenCalled();
  });

  it("needs both a Launchpad session and a paired wallet", async () => {
    const { write } = fakeWrite();
    primeRegistry(() => false);
    const noLaunchpad = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions(), { write }));
    expect(structured<{ status: string }>(await callTool(noLaunchpad, "moi_launchpad_register_agent", { agentId: RECORD_ID })).status).toBe("error");

    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const noWallet = await connectLaunchpad(launchpadDeps(fake, wallet(false), sessions, { write }));
    const out = structured<{ status: string; reason?: string; code?: string }>(await callTool(noWallet, "moi_launchpad_register_agent", { agentId: RECORD_ID }));
    expect(out.status === "rejected" || out.status === "error").toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("moi_launchpad_telegram_link", () => {
  it("returns the bot link as text and structure", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_telegram_link");
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ link: "https://t.me/moinetworkbot?start=abc-123", alreadyLinked: false });
    expect(JSON.stringify(res.content)).toContain("https://t.me/moinetworkbot?start=abc-123");
  });
});

describe("moi_launchpad_setup_script", () => {
  it("hands out a one-time download link and never the script", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const d = launchpadDeps(fake, wallet(), sessions);
    const client = await connectLaunchpad(d);
    const res = await callTool(client, "moi_launchpad_setup_script", { agentId: RECORD_ID });
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ downloadUrl: `https://mcp.test/launchpad/download/tok-${RECORD_ID}`, agent: { id: RECORD_ID } });
    expect(d.createDownloadLink).toHaveBeenCalledWith(USER, RECORD_ID);
    expect(JSON.stringify(res)).not.toContain("very-secret");
    // The script is read once to describe it, secrets blanked; the file itself only goes through the link.
    const script = structured<{ script: { summary: string[]; preview: string } }>(res).script;
    expect(script.summary.length).toBeGreaterThan(0);
    expect(script.preview).toContain("AGENT_KEY=<redacted>");
    expect(fake.requests.map((r) => r.path)).toEqual([`/api/agents/${RECORD_ID}`, `/api/agents/${RECORD_ID}/setup-script`]);
  });

  it("refuses when the Launchpad can no longer read the agent's key", async () => {
    fake.state.keyReadable = false;
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const d = launchpadDeps(fake, wallet(), sessions);
    const client = await connectLaunchpad(d);
    const res = await callTool(client, "moi_launchpad_setup_script", { agentId: RECORD_ID });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/no longer read the key/);
    expect(d.createDownloadLink).not.toHaveBeenCalled();
  });
});

describe("moi_launchpad_sign_out", () => {
  it("forgets the session and tells the Launchpad, best effort", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_sign_out");
    expect(res.isError).toBeFalsy();
    expect(sessions.records.size).toBe(0);
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/auth/logout"]);
  });
});
