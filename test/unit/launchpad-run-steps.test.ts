/**
 * The steps that start a Launchpad agent (src/applications/launchpad/run-steps.ts): their order, the one place the
 * command is built, and the rule that nothing in them breaks when the model relays it as JSON text or copies a command.
 */
import { describe, expect, it } from "vitest";

import {
  afterCreate,
  afterRegister,
  downloadCommand,
  forSetupScript,
  GROQ_KEYS_URL,
  SETUP_FILE,
} from "../../src/applications/launchpad/run-steps.js";

const LINK = "https://mcp.example.com/launchpad/download/Ab-_Cd0123456789";
const ALL = { afterCreate: afterCreate("rec-1"), afterRegister: afterRegister("rec-1"), forSetupScript: forSetupScript(LINK) };
const ANCHORS = ["1. Have an AI API key ready first", "2. Check that Node.js 18 or newer", "3. ", "4. When the script has finished, delete it with rm"];

describe("the steps that start a Launchpad agent", () => {
  it.each(Object.entries(ALL))("%s gives the four steps in order, each on its own line", (_name, text) => {
    const at = ANCHORS.map((a) => text.indexOf(a));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // A step starts a line.
    for (const a of ANCHORS) expect(text).toContain(`\n${a}`);
  });

  it.each(Object.entries(ALL))("%s says the agent runs only once its setup script has been run on a machine", (_name, text) => {
    expect(text).toMatch(/runs only once (its|this) (setup )?script has been run on a machine/);
  });

  it.each(Object.entries(ALL))("%s names where to make a key, the Node.js version and that the script holds the private key", (_name, text) => {
    expect(text).toContain(GROQ_KEYS_URL);
    expect(text).toContain("Google AI or OpenAI");
    expect(text).toContain("Node.js 18 or newer");
    expect(text).toContain("because it holds the agent's private key");
    expect(text).toContain(`rm ${SETUP_FILE}`);
  });

  it.each(Object.entries(ALL))("%s uses plain sentences: no em dash, no bold, no double quote, no markup", (_name, text) => {
    expect(text).not.toMatch(/[—–"`#|]/);
    expect(text).not.toContain("**");
    expect(text).toBe(text.trim());
  });

  it("the create and register versions show the command with the word LINK, never a bracketed placeholder", () => {
    for (const text of [ALL.afterCreate, ALL.afterRegister]) {
      expect(text).toContain(`curl -fL -o ${SETUP_FILE} LINK && bash ${SETUP_FILE}`);
      expect(text).not.toMatch(/[<>]/);
      expect(text).toContain("moi_launchpad_setup_script with agentId rec-1");
    }
  });

  it("the setup-script version has the real link in the command and nothing after the command on its line", () => {
    const command = `curl -fL -o ${SETUP_FILE} ${LINK} && bash ${SETUP_FILE}`;
    const line = ALL.forSetupScript.split("\n").find((l) => l.includes(command))!;
    expect(line).toBeDefined();
    expect(line.endsWith(command)).toBe(true);
    expect(ALL.forSetupScript).not.toContain("LINK");
  });

  it("the create and register versions also end their command line with the command", () => {
    for (const text of [ALL.afterCreate, ALL.afterRegister]) {
      const line = text.split("\n").find((l) => l.startsWith("3. "))!;
      expect(line.endsWith(`curl -fL -o ${SETUP_FILE} LINK && bash ${SETUP_FILE}`)).toBe(true);
    }
  });

  it("says that the link works with curl, serves once, and that nothing else may open it first", () => {
    for (const text of Object.values(ALL)) {
      expect(text).toContain("The link works with curl because it needs no cookie or header");
      expect(text).toContain("it serves the script only once");
      expect(text).toContain("neither a browser tab nor curl -I");
      expect(text).toContain("Do not pipe it into bash, because the script asks for the AI API key at the terminal");
    }
  });

  it("puts the key before the download, because the link's ten minutes start at the call", () => {
    expect(ALL.forSetupScript).toContain("The ten minutes started when this tool was called");
    expect(ALL.afterCreate.indexOf("Have an AI API key ready first")).toBeLessThan(ALL.afterCreate.indexOf("Call moi_launchpad_setup_script"));
  });

  it("the create version tells the model to say now that registering does not start the agent", () => {
    expect(ALL.afterCreate).toMatch(/^Registering does not start the agent/);
    expect(ALL.afterRegister).toMatch(/^The agent is registered but it is not running yet/);
  });
});

describe("downloadCommand", () => {
  it("is curl -fL -o to a fixed file name, then bash on that file, and never a pipe into bash", () => {
    expect(downloadCommand(LINK)).toBe(`curl -fL -o moi-agent-setup.sh ${LINK} && bash moi-agent-setup.sh`);
    expect(downloadCommand(LINK)).not.toMatch(/\|/);
  });

  it("leaves a link made of safe characters unquoted", () => {
    expect(downloadCommand("http://localhost:8080/launchpad/download/abc_-1")).toBe(
      "curl -fL -o moi-agent-setup.sh http://localhost:8080/launchpad/download/abc_-1 && bash moi-agent-setup.sh",
    );
  });

  it.each([
    ["a space", "https://x.test/a b", "'https://x.test/a b'"],
    ["a semicolon", "https://x.test/a;rm", "'https://x.test/a;rm'"],
    ["a query string", "https://x.test/a?b=1&c=2", "'https://x.test/a?b=1&c=2'"],
    ["a single quote", "https://x.test/it's", "'https://x.test/it'\\''s'"],
  ])("wraps a link with %s in single quotes", (_what, link, word) => {
    expect(downloadCommand(link)).toBe(`curl -fL -o moi-agent-setup.sh ${word} && bash moi-agent-setup.sh`);
  });

  it("uses the same file name to download, to run and to delete", () => {
    expect(SETUP_FILE).toBe("moi-agent-setup.sh");
    const text = ALL.forSetupScript;
    expect(text).toContain(`-o ${SETUP_FILE}`);
    expect(text).toContain(`bash ${SETUP_FILE}`);
    expect(text).toContain(`rm ${SETUP_FILE}`);
  });
});
