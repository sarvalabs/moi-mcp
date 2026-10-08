/**
 * What the Launchpad tools tell the model about starting an agent. Creating an agent and registering it on chain do not run it:
 * it runs only once its setup script has been run on a machine. The create, register and setup-script results give the four steps
 * in order (src/applications/launchpad/run-steps.ts, tested on its own in launchpad-run-steps.test.ts), in the text of the result
 * as well as in the structured value, because claude.ai gives its model the text and not the structure. The rest of the tools
 * is in launchpad-tools.test.ts, which this file shares its fake Launchpad and helpers with.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GROQ_KEYS_URL } from "../../src/applications/launchpad/run-steps.js";
import { resetRegistryCache } from "../../src/capabilities/reads/registry.js";
import type { runWrite } from "../../src/tools/hosted-writes.js";
import { PreviewRegistry } from "../../src/tools/preview.js";
import { send, structured, USER } from "../helpers/hosted.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import {
  callTool,
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

/** The four steps that start an agent, as the opening words of each, with `third` as the third. */
const stepAnchors = (third: string) => [
  "1. Have an AI API key ready first",
  "2. Check that Node.js 18 or newer",
  third,
  "4. When the script has finished, delete it with rm moi-agent-setup.sh",
];

/** Every part is in `text`, and they appear in the order given. */
function expectInOrder(text: string, parts: string[]) {
  const at = parts.map((part) => text.indexOf(part));
  expect(at.map((i, n) => (i < 0 ? `missing: ${parts[n]}` : "found"))).toEqual(parts.map(() => "found"));
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(new Set(at).size).toBe(at.length);
}

/** The text block of a result: the only part claude.ai gives its model. */
const textOf = (res: object) => (res as { content: Array<{ text: string }> }).content[0]!.text;

const callSetupStep = `3. Call moi_launchpad_setup_script with agentId ${RECORD_ID}`;
const signedIn = () => fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));

describe("moi_launchpad_create_agent", () => {
  const NEW = { templateId: "weather_brief", name: "Rain Check", config: { city: "Bengaluru", time: "07:30" } };
  const rig = () => connectLaunchpad(launchpadDeps(fake, wallet(true, new PreviewRegistry({ maxPerUser: 50 })), signedIn()));

  it("says registering is not the end and gives the four steps in order, in the structure and in the text", async () => {
    const res = await send(await rig(), "moi_launchpad_create_agent", NEW);
    const out = structured<{ agent: { id: string }; next: string }>(res);
    expect(out.next).toMatch(/moi_launchpad_register_agent/);
    expect(out.next).toContain("runs only once its setup script has been run on a machine");
    expect(out.next).not.toMatch(/It runs only once registered/);
    expectInOrder(out.next, stepAnchors(callSetupStep));
    expect(out.next).toContain(GROQ_KEYS_URL);
    expect(out.next).toContain("Google AI or OpenAI");
    expect(out.next).toContain("curl -fL -o moi-agent-setup.sh LINK && bash moi-agent-setup.sh");
    expect(out.next).toContain("private key");
    expect(JSON.parse(textOf(res)).next).toBe(out.next);
  });

  it("gives no steps in the preview, because nothing exists yet", async () => {
    const res = await callTool(await rig(), "moi_launchpad_create_agent", NEW);
    expect(structured<{ next?: string }>(res).next).toBeUndefined();
    expect(textOf(res)).not.toContain("moi-agent-setup.sh");
  });
});

describe("moi_launchpad_register_agent", () => {
  const HASH = "0x" + "ab".repeat(32);
  type Sent = { status: string; hash: string; registryAgentId?: string; launchpadStatus: string; note?: string; next?: string };

  /** Stands in for the phone and the node: previews, then reports "sent" after running `onSend`. */
  function fakeWrite(onSend: () => void = () => {}) {
    return vi.fn(async (_deps, _auth, _kind, _args, confirm) => {
      if (!confirm) {
        const value = { status: "preview", confirm: "tok", summary: "Register agent", details: {}, fuel: "x", network: "custom", expiresAt: new Date().toISOString() };
        return { content: [{ type: "text" as const, text: "preview" }], structuredContent: value };
      }
      onSend();
      const value = { status: "sent", hash: HASH, explorerUrl: `https://voyage.moi.technology/interactions/${HASH}`, summary: "Register agent" };
      return { content: [{ type: "text" as const, text: "sent" }], structuredContent: value };
    }) as unknown as typeof runWrite;
  }
  const connect = (write: typeof runWrite) => connectLaunchpad(launchpadDeps(fake, wallet(), signedIn(), { write }));

  it("gives the four steps once registered, in the structure and in the text the model reads", async () => {
    let registered = false;
    primeRegistry(() => registered);
    const client = await connect(fakeWrite(() => (registered = true)));

    const preview = structured<{ status: string; confirm: string; next?: string }>(await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID }));
    expect(preview.status).toBe("preview");
    expect(preview.next).toBeUndefined();

    const res = await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID, confirm: preview.confirm });
    const sent = structured<Sent>(res);
    expect(sent).toMatchObject({ status: "sent", hash: HASH, registryAgentId: "agent_9", launchpadStatus: "active" });
    expect(sent.note).toBeUndefined();
    // Registered is not running: the result says so and gives the steps.
    expect(sent.next).toMatch(/^The agent is registered but it is not running yet\./);
    expectInOrder(sent.next!, stepAnchors(callSetupStep));
    expect(JSON.parse(textOf(res)).next).toBe(sent.next);
  });

  it("gives them when the agent was already in the registry and the phone was skipped, in the text too", async () => {
    primeRegistry(() => true);
    const write = fakeWrite();
    const res = await callTool(await connect(write), "moi_launchpad_register_agent", { agentId: RECORD_ID });
    const out = structured<Sent>(res);
    expect(out.note).toMatch(/already in the registry/);
    expectInOrder(out.next!, stepAnchors(callSetupStep));
    // This path's text used to be the note alone. The model reads the text, so the steps are in it.
    expect(textOf(res)).toBe(`${out.note} ${out.next}`);
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves the steps out when the Launchpad did not record the registration", async () => {
    // The phone signs and the interaction is sent, but the Launchpad answers register-confirm with a 409 (it already thinks the
    // agent is active), so the agent is still pending_grant as far as this tool can tell.
    primeRegistry(() => false);
    const client = await connect(fakeWrite(() => (fake.state.agentStatus = "active")));
    const res = await callTool(client, "moi_launchpad_register_agent", { agentId: RECORD_ID, confirm: "tok" });
    const out = structured<Sent>(res);
    expect(out.launchpadStatus).toBe("pending_grant");
    expect(out.note).toMatch(/Call moi_launchpad_register_agent again/);
    expect(out.next).toBeUndefined();
    expect(textOf(res)).not.toContain("moi-agent-setup.sh");
  });
});

describe("moi_launchpad_setup_script", () => {
  it("gives the exact command with the real link and the four steps in order, before what the script does", async () => {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), signedIn()));
    const text = textOf(await callTool(client, "moi_launchpad_setup_script", { agentId: RECORD_ID }));
    const link = `https://mcp.test/launchpad/download/tok-${RECORD_ID}`;
    // The link has no quotes: it is made of characters a shell takes as they are.
    expect(text).toContain(`curl -fL -o moi-agent-setup.sh ${link} && bash moi-agent-setup.sh`);
    expectInOrder(text, [...stepAnchors("3. Have the person run this on the host machine now."), "What the script does:"]);
    expect(text).toContain(GROQ_KEYS_URL);
    // It says whether the link works with curl, and what must not open it first.
    expect(text).toContain("The link works with curl because it needs no cookie or header");
    expect(text).toContain("neither a browser tab nor curl -I");
    expect(text).toContain("Do not pipe it into bash");
    expect(text).toContain("rm moi-agent-setup.sh");
    expect(text).not.toContain("very-secret");
  });
});

describe("what the descriptions tell the model about starting an agent", () => {
  async function descriptions(): Promise<Record<string, string>> {
    const client = await connectLaunchpad(launchpadDeps(fake, wallet(), fakeSessions()));
    const { tools } = await client.listTools();
    return Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
  }

  it("the setup-script description says to have the AI API key and Node.js ready before calling", async () => {
    const d = (await descriptions())["moi_launchpad_setup_script"]!;
    expect(d).toContain(GROQ_KEYS_URL);
    expect(d).toContain("Google AI or OpenAI key");
    expect(d).toContain("Node.js 18 or newer");
    expect(d).toContain("the ten minutes start at the call");
    expect(d).toContain("curl");
    expect(d).toContain("delete the script");
  });

  it("the create and register descriptions no longer say registering makes the agent run", async () => {
    const all = await descriptions();
    expect(all["moi_launchpad_create_agent"]).toContain("its setup script has been run on a machine");
    expect(all["moi_launchpad_register_agent"]).toContain("runs only once its setup script has been run on a machine");
    expect(all["moi_launchpad_create_agent"]).not.toContain("makes the agent live");
    expect(all["moi_launchpad_register_agent"]).not.toContain("makes the agent live");
  });
});
