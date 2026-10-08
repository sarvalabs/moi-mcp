/**
 * The moi_launchpad_* tools against a fake Launchpad (test/helpers/launchpad.ts)
 * over a real McpServer, with the wallet side faked the way the hosted write
 * tests fake it: a store with a paired session, a hub whose phone always
 * signs, and a journal that records.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { dappOrigin } from "../../src/public-fetch.js";
import { FileDappSessionStore } from "../../src/applications/dapp/store.js";
import { LaunchpadClient, type FetchLike } from "../../src/applications/launchpad/client.js";
import { resetRegistryCache } from "../../src/capabilities/reads/registry.js";
import { ErrorCode } from "../../src/schema.js";
import type { runWrite } from "../../src/tools/hosted-writes.js";
import { PreviewRegistry } from "../../src/tools/preview.js";
import { authFor, fakeHub, send, structured, USER } from "../helpers/hosted.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import {
  AGENT_WALLET,
  callTool,
  COOKIE,
  connectDapp,
  connectLaunchpad,
  fakeSessions,
  launchpadDeps,
  primeRegistry,
  RECORD_ID,
  REGISTRY,
  resetFake,
  signedInRecord,
  startFakeLaunchpad,
  wallet,
  type FakeLaunchpad,
} from "../helpers/launchpad.js";
import { ACCOUNT } from "../helpers/mock-node.js";

let fake: FakeLaunchpad;
beforeAll(async () => {
  applyEnv("http://127.0.0.1:1", tempHome(), { MOI_AGENT_REGISTRY_LOGIC_ID: REGISTRY });
  fake = await startFakeLaunchpad();
});
afterAll(async () => {
  await fake.close();
  restoreEnv();
});
beforeEach(() => resetFake(fake));
afterEach(() => resetRegistryCache());

describe("moi_launchpad_status", () => {
  it("says so when not signed in, and lists agents when it is", async () => {
    const sessions = fakeSessions();
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    // Signed out, it says how to get in: the generic tool, with this Launchpad's URL.
    expect(structured(await callTool(client, "moi_launchpad_status"))).toEqual({
      launchpad: fake.url,
      signedIn: false,
      note: expect.stringContaining(`Call moi_dapp_sign_in with url ${fake.url} first`),
    });

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
    expect(out.note).toContain(`moi_dapp_sign_in with url ${fake.url} to sign in again`);
    expect(sessions.records.size).toBe(0);
  });

  it("treats an expired session as signed out", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url, { expiresAt: Math.floor(Date.now() / 1000) - 5 })]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const out = structured<{ signedIn: boolean; note?: string }>(await callTool(client, "moi_launchpad_status"));
    expect(out.signedIn).toBe(false);
    expect(out.note).toMatch(/expired/);
    expect(out.note).toContain(`moi_dapp_sign_in with url ${fake.url} to sign in again`);
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
  type Preview = { status?: string; confirm?: string; summary?: string; details?: Record<string, string>; note?: string; agent?: unknown };
  const NEW = { templateId: "weather_brief", name: "Rain Check", config: { city: "Bengaluru", time: "07:30" } };
  const posts = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/api/agents");
  const NOTE = /did not match/;

  async function rig(over: { sessions?: ReturnType<typeof fakeSessions> } = {}) {
    const sessions = over.sessions ?? fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const previews = new PreviewRegistry({ maxPerUser: 50 });
    const writes = wallet(true, previews);
    const client = await connectLaunchpad(launchpadDeps(fake, writes, sessions));
    return { client, sessions, previews, writes };
  }

  it("creates nothing on the first call, and shows what would be created", async () => {
    const { client, previews } = await rig();
    const res = await callTool(client, "moi_launchpad_create_agent", { ...NEW, visibility: "public", category: "weather", price: 5 });
    expect(res.isError).toBeFalsy();
    const out = structured<Preview>(res);
    expect(out.status).toBe("preview");
    expect(out.confirm).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(out.agent).toBeUndefined();
    expect(out.details).toMatchObject({
      Launchpad: fake.url,
      Action: "Create agent",
      As: "0xowner",
      Template: "weather_brief",
      Name: "Rain Check",
      Config: '{"city":"Bengaluru","time":"07:30"}',
      Visibility: "public",
      Category: "weather",
      Price: "5",
    });
    expect(out.details!["Effect"]).toMatch(/does not run until registered/);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain(`Nothing has been sent to ${fake.url}`);
    expect(posts()).toHaveLength(0);
    expect(previews.size).toBe(1);
  });

  it("creates the agent with the session cookie once confirmed, and says what comes next", async () => {
    const { client } = await rig();
    const res = await send(client, "moi_launchpad_create_agent", NEW);
    expect(res.isError).toBeFalsy();
    const out = structured<{ agent: { id: string; status: string }; next: string }>(res);
    expect(out.agent).toMatchObject({ id: RECORD_ID, name: "Rain Check", address: AGENT_WALLET, template: "weather_brief", status: "pending_grant" });
    expect(out.next).toMatch(/moi_launchpad_register_agent/);

    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.cookie).toBe(`moi_session=${COOKIE}`);
    expect(post.body).toMatchObject({ templateId: "weather_brief", name: "Rain Check", config: { city: "Bengaluru", time: "07:30" } });
    expect((post.body as { avatarSeed: string }).avatarSeed).toMatch(/^[0-9a-f]{16}$/);
  });

  it("works once per token", async () => {
    const { client } = await rig();
    const first = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", NEW));
    expect(structured<Preview>(await callTool(client, "moi_launchpad_create_agent", { ...NEW, confirm: first.confirm })).agent).toBeDefined();
    const replay = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", { ...NEW, confirm: first.confirm }));
    expect(replay.status).toBe("preview");
    expect(replay.note).toMatch(NOTE);
    expect(posts()).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ["the name", { name: "Rain Check 2" }],
    ["the template", { templateId: "job_search" }],
    ["a config value", { config: { city: "Mumbai", time: "07:30" } }],
    ["an extra config field", { config: { city: "Bengaluru", time: "07:30", extra: "x" } }],
    ["the visibility", { visibility: "public" }],
    ["the category", { category: "weather" }],
    ["the price", { price: 1 }],
  ])("gives a fresh preview and creates nothing when %s changed between the calls", async (_what, change) => {
    const { client } = await rig();
    const first = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", NEW));
    const res = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", { ...NEW, ...change, confirm: first.confirm }));
    expect(res.status).toBe("preview");
    expect(res.note).toMatch(NOTE);
    expect(posts()).toHaveLength(0);
    // The token the person saw is still good for what they saw.
    expect(structured<Preview>(await callTool(client, "moi_launchpad_create_agent", { ...NEW, confirm: first.confirm })).agent).toBeDefined();
    expect(posts()).toHaveLength(1);
  });

  it("gives a fresh preview when the person signed in again as another wallet", async () => {
    const { client, sessions } = await rig();
    const first = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", NEW));
    await sessions.set(signedInRecord(fake.url, { walletAddress: "0xsomeoneelse" }));
    const res = structured<Preview>(await callTool(client, "moi_launchpad_create_agent", { ...NEW, confirm: first.confirm }));
    expect(res.status).toBe("preview");
    expect(res.note).toMatch(NOTE);
    expect(res.details!["As"]).toBe("0xsomeoneelse");
    expect(posts()).toHaveLength(0);
  });

  it("will not let another person redeem the token", async () => {
    const sessions = fakeSessions(
      new Map([
        ["a", signedInRecord(fake.url)],
        ["b", signedInRecord(fake.url, { userId: "user-b" })],
      ]),
    );
    const owner = await rig({ sessions });
    const first = structured<Preview>(await callTool(owner.client, "moi_launchpad_create_agent", NEW));
    const writes = wallet(true, owner.previews);
    const other = await connectLaunchpad(launchpadDeps(fake, writes, sessions), authFor("user-b"));
    const res = structured<Preview>(await callTool(other, "moi_launchpad_create_agent", { ...NEW, confirm: first.confirm }));
    expect(res.status).toBe("preview");
    expect(res.note).toMatch(NOTE);
    expect(posts()).toHaveLength(0);
  });

  it("refuses without a Launchpad session, before touching the Launchpad and before any token", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()));
    const res = await callTool(client, "moi_launchpad_create_agent", { templateId: "weather_brief", name: "Rain Check" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain(`Call moi_dapp_sign_in with url ${fake.url} first`);
    expect(fake.requests).toHaveLength(0);
  });

  it("passes a taken name back as the Launchpad's own refusal, after the confirm", async () => {
    const { client, previews } = await rig();
    const res = await send(client, "moi_launchpad_create_agent", { templateId: "weather_brief", name: "Taken" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/name_taken/);
    expect(posts()).toHaveLength(1);
    expect(previews.size).toBe(0);
  });

  it("asks for no tap on the phone", async () => {
    const { client, writes } = await rig();
    await send(client, "moi_launchpad_create_agent", NEW);
    expect((writes.hub as ReturnType<typeof fakeHub>).signInteractionFor).not.toHaveBeenCalled();
    expect((writes.hub as ReturnType<typeof fakeHub>).signMessageFor).not.toHaveBeenCalled();
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
    // The handler's second argument is what lets the write path tell a client that the phone is still being waited on.
    expect(vi.mocked(write).mock.calls[0]?.[6]).toMatchObject({ sendNotification: expect.any(Function) });

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
    // One call, no confirm, no preview: it only mints a code the person has to open by hand, so it is not gated.
    const res = await callTool(client, "moi_launchpad_telegram_link");
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ link: "https://t.me/moinetworkbot?start=abc-123", alreadyLinked: false });
    expect(structured<{ status?: string }>(res).status).toBeUndefined();
    expect(fake.requests.filter((r) => r.path === "/api/telegram/link")).toHaveLength(1);
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

describe("what the Launchpad answers is read with a limit", () => {
  /** A Launchpad that answers one path from a hand-built Response and everything else from the fake. */
  const answering = (suffix: string, make: () => Response) => {
    const fetchImpl: FetchLike = (input, init) => (input.endsWith(suffix) ? Promise.resolve(make()) : fetch(input, init));
    return new LaunchpadClient(fake.url, fetchImpl);
  };
  const text = (res: Awaited<ReturnType<typeof callTool>>) => (res.content as Array<{ text: string }>)[0]!.text;
  const SCRIPT = `/api/agents/${RECORD_ID}/setup-script`;
  const scriptBody = (bytes: number) => "#!/usr/bin/env bash\nAGENT_KEY=very-secret\n".padEnd(bytes, "#");

  describe("the setup script", () => {
    it("is refused over 256 KB, whether it declares its length or not, without signing the person out or leaking it", async () => {
      for (const headers of [{}, { "content-length": "300000" }] as Array<Record<string, string>>) {
        const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
        const d = launchpadDeps(fake, wallet(), sessions, { client: answering(SCRIPT, () => new Response(scriptBody(300_000), { headers })) });
        const res = await callTool(await connectLaunchpad(d), "moi_launchpad_setup_script", { agentId: RECORD_ID });
        expect(res.isError).toBe(true);
        expect(text(res)).toMatch(/\[LAUNCHPAD_ERROR\]/);
        expect(text(res)).toContain("The Launchpad's setup script is too large: it is over 256 KB");
        expect(text(res)).not.toContain("very-secret");
        expect(d.createDownloadLink).not.toHaveBeenCalled();
        // An oversize answer is not a rejected session.
        expect(sessions.records.size).toBe(1);
      }
    });

    it("reads one that is large but within the cap", async () => {
      const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
      const d = launchpadDeps(fake, wallet(), sessions, { client: answering(SCRIPT, () => new Response(scriptBody(200_000))) });
      const res = await callTool(await connectLaunchpad(d), "moi_launchpad_setup_script", { agentId: RECORD_ID });
      expect(res.isError).toBeFalsy();
      expect(d.createDownloadLink).toHaveBeenCalledWith(USER, RECORD_ID);
      expect(structured<{ script: { previewTruncated: boolean } }>(res).script.previewTruncated).toBe(true);
    });

    it("stops at the declared length without reading the body", async () => {
      let pulls = 0;
      const body = () =>
        new ReadableStream<Uint8Array>(
          {
            pull() {
              pulls++;
              throw new Error("the body should not be read");
            },
          },
          // Nothing is pulled before the first read.
          { highWaterMark: 0 },
        );
      const client = answering(SCRIPT, () => new Response(body(), { headers: { "content-length": "300000" } }));
      const err = await client.setupScript(COOKIE, RECORD_ID).then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ code: ErrorCode.LAUNCHPAD_ERROR });
      expect(pulls).toBe(0);
    });
  });

  describe("a JSON answer", () => {
    const templates = (make: () => Response) => connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions(), { client: answering("/api/templates", make) }), null);

    it("says it is too large over 1 MB, not that it is not JSON", async () => {
      const huge = `{"templates":[],"pad":"${"x".repeat(2 * 1024 * 1024)}"}`;
      const res = await callTool(await templates(() => new Response(huge)), "moi_launchpad_templates");
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("/api/templates is too large: it is over 1 MB");
      expect(text(res)).not.toMatch(/something other than JSON/);
    });

    it("keeps a short refusal's message, and falls back to the status when the refusal is over 64 KB", async () => {
      const short = await callTool(await templates(() => new Response('{"error":"name_taken"}', { status: 500 })), "moi_launchpad_templates");
      expect(text(short)).toMatch(/refused: name_taken$/);
      const long = await callTool(await templates(() => new Response(JSON.stringify({ error: "x".repeat(100_000) }), { status: 500 })), "moi_launchpad_templates");
      expect(long.isError).toBe(true);
      expect(text(long)).toMatch(/refused: HTTP 500$/);
      expect(text(long).length).toBeLessThan(500);
    });
  });
});

describe("signing in to the Launchpad is moi_dapp_sign_in's job", () => {
  const NEW = { templateId: "weather_brief", name: "Rain Check", config: { city: "Bengaluru", time: "07:30" } };
  /** The four tools that need a session, each with arguments that get past input validation. */
  const NEEDS_SESSION: Array<[string, Record<string, unknown>]> = [
    ["moi_launchpad_create_agent", NEW],
    ["moi_launchpad_register_agent", { agentId: RECORD_ID }],
    ["moi_launchpad_telegram_link", {}],
    ["moi_launchpad_setup_script", { agentId: RECORD_ID }],
  ];
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const text = (res: Awaited<ReturnType<typeof callTool>>) => (res.content as Array<{ text: string }>)[0]!.text;

  /** What server.ts builds: one store behind both the generic dapp tools and the Launchpad tools, one paired wallet. */
  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), "moi-launchpad-tools-"));
    dirs.push(dir);
    const sessions = new FileDappSessionStore(dir);
    const writes = wallet(true, new PreviewRegistry({ maxPerUser: 50 }));
    const dapp = await connectDapp({ sessions, writes, allowInsecure: true });
    const launchpad = await connectLaunchpad(launchpadDeps(fake, writes, sessions));
    return { dapp, launchpad };
  }

  it("stores a session that every Launchpad tool then reads", async () => {
    const { dapp, launchpad } = await rig();
    expect(structured(await callTool(launchpad, "moi_launchpad_status"))).toMatchObject({ launchpad: fake.url, signedIn: false });

    // Whatever follows the origin in the address is dropped: the session belongs to the origin.
    const res = await callTool(dapp, "moi_dapp_sign_in", { url: `${fake.url}/dashboard` });
    expect(res.isError).toBeFalsy();

    const on = structured<{ signedIn: boolean; wallet: string; agents: unknown[] }>(await callTool(launchpad, "moi_launchpad_status"));
    expect(on).toMatchObject({ signedIn: true, wallet: ACCOUNT });
    expect(on.agents).toHaveLength(1);
    const preview = structured<{ status: string; details: Record<string, string> }>(await callTool(launchpad, "moi_launchpad_create_agent", NEW));
    expect(preview.status).toBe("preview");
    expect(preview.details["As"]).toBe(ACCOUNT);
    expect(structured(await callTool(launchpad, "moi_launchpad_telegram_link"))).toMatchObject({ link: "https://t.me/moinetworkbot?start=abc-123" });
    const withSession = fake.requests.filter((r) => ["/api/me", "/api/agents", "/api/telegram/link"].includes(r.path));
    expect(withSession.length).toBeGreaterThan(0);
    expect(withSession.every((r) => r.cookie === `moi_session=${COOKIE}`)).toBe(true);
  });

  it("is ended by moi_dapp_sign_out for the Launchpad tools too, and they then say how to sign in again", async () => {
    const { dapp, launchpad } = await rig();
    await callTool(dapp, "moi_dapp_sign_in", { url: fake.url });
    expect((await callTool(dapp, "moi_dapp_sign_out", { url: fake.url })).isError).toBeFalsy();
    expect(fake.requests.at(-1)?.path).toBe("/api/auth/logout");
    expect(structured(await callTool(launchpad, "moi_launchpad_status"))).toMatchObject({ launchpad: fake.url, signedIn: false });
    const res = await callTool(launchpad, "moi_launchpad_create_agent", NEW);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("[LAUNCHPAD_NOT_SIGNED_IN]");
    expect(text(res)).toContain(`Call moi_dapp_sign_in with url ${fake.url} first`);
  });

  it("tells a person whose session has expired to sign in again the same way, and forgets the session", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url, { expiresAt: Math.floor(Date.now() / 1000) - 5 })]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), sessions));
    const res = await callTool(client, "moi_launchpad_create_agent", NEW);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("has expired");
    expect(text(res)).toContain(`Call moi_dapp_sign_in with url ${fake.url} to sign in again`);
    expect(sessions.records.size).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  // Each tool shows a refusal its own way: create_agent, telegram_link and setup_script throw, register_agent answers with a
  // result that carries the code. All four end with the same instruction.
  it.each(NEEDS_SESSION)("%s with no session says to call moi_dapp_sign_in with the Launchpad's URL, and sends nothing", async (name, args) => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()));
    const res = await callTool(client, name, args);
    expect(JSON.stringify(res)).toContain("LAUNCHPAD_NOT_SIGNED_IN");
    expect(JSON.stringify(res)).toContain(`Call moi_dapp_sign_in with url ${fake.url} first`);
    expect(fake.requests).toHaveLength(0);
  });

  // The Launchpad's own 401 (the session was ended there) is a message of the shared client, which only this client reaches.
  it.each(NEEDS_SESSION)("%s, when the Launchpad rejects the stored session, ends with the same instruction and forgets it", async (name, args) => {
    fake.state.cookieValid = false;
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(true, new PreviewRegistry({ maxPerUser: 50 })), sessions));
    const res = await send(client, name, args);
    expect(JSON.stringify(res)).toContain(`no longer recognises this session. Call moi_dapp_sign_in with url ${fake.url} to sign in again.`);
    expect(sessions.records.size).toBe(0);
  });

  it("lists no sign-in or sign-out tool of its own, and each tool that needs a session says how to get one", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "moi_launchpad_status",
      "moi_launchpad_templates",
      "moi_launchpad_create_agent",
      "moi_launchpad_register_agent",
      "moi_launchpad_telegram_link",
      "moi_launchpad_setup_script",
    ]);
    for (const [name] of NEEDS_SESSION) {
      expect(tools.find((t) => t.name === name)!.description, name).toContain(
        `Needs a session: call moi_dapp_sign_in with url ${fake.url} first.`,
      );
    }
  });

  // A message or comment that names a tool that no longer exists sends a model to a call that fails. A tripwire on text.
  it("has no source file that still names the removed tools", () => {
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const named = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((rel) => rel.endsWith(".ts"))
      .filter((rel) => /moi_launchpad_sign_(in|out)/.test(readFileSync(join(src, rel), "utf8")));
    expect(named).toEqual([]);
  });
});

describe("the Launchpad client's address", () => {
  // The key moi_dapp_sign_in files a session under is dappOrigin(url); the Launchpad tools read it under this baseUrl.
  it.each<[string, string]>([
    ["https://launchpad.moi.technology", "https://launchpad.moi.technology"],
    ["HTTPS://Launchpad.MOI.Technology.:443//", "https://launchpad.moi.technology"],
  ])("is the origin moi_dapp_sign_in files a session under, for %s", (spelled, origin) => {
    expect(new LaunchpadClient(spelled).baseUrl).toBe(origin);
    expect(dappOrigin(spelled)).toBe(origin);
  });

  it.each(["https://launchpad.moi.technology/lp", "https://launchpad.moi.technology/?x=1", "https://launchpad.moi.technology/#top"])(
    "refuses an address that is more than an origin, %s, rather than dropping the rest",
    (spelled) => {
      expect(() => new LaunchpadClient(spelled)).toThrow(/must be an origin/);
    },
  );

  it("still takes a local, plain-http Launchpad, which moi_dapp_sign_in refuses: the one cost of the step", () => {
    expect(new LaunchpadClient("http://127.0.0.1:3000/").baseUrl).toBe("http://127.0.0.1:3000");
    expect(() => dappOrigin("http://127.0.0.1:3000")).toThrow(/https/);
  });
});
