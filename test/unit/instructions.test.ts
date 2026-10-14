/**
 * The server instructions: what each of the three servers tells its client's model at initialize.
 *
 * src/instructions.ts holds the three texts. The first half of this file reads the texts themselves: each is short plain
 * prose, says the rules that apply to its server, and names only tools its server lists (checked against the pinned lists
 * in test/unit/__snapshots__). The second half asks real servers for their initialize answer. The hosted server's is in
 * server.test.ts, which already runs that server over HTTP.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { buildReadOnlyServer } from "../../src/http.js";
import { GROQ_KEYS_URL } from "../../src/applications/launchpad/run-steps.js";
import { GATEWAY_INSTRUCTIONS, HOSTED_INSTRUCTIONS, STDIO_INSTRUCTIONS } from "../../src/instructions.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { importGraph } from "../helpers/import-graph.js";

type Mode = "gateway" | "stdio" | "hosted";

/**
 * About 1,500 characters a text: a short read in every conversation. The hosted text is the one that explains an
 * application workflow (the Launchpad's four steps), so its ceiling is higher; the other two do not move.
 */
const MAX_CHARS: Record<Mode, number> = { gateway: 1500, stdio: 1500, hosted: 2400 };
const TEXTS: Record<Mode, string> = {
  gateway: GATEWAY_INSTRUCTIONS,
  stdio: STDIO_INSTRUCTIONS,
  hosted: HOSTED_INSTRUCTIONS,
};
const MODES = Object.keys(TEXTS) as Mode[];

const VOCABULARY = [
  /an interaction is a transaction/,
  /a tesseract is a block/,
  /a logic is a smart contract/,
  /a participant is an account/,
];
const WRITE_RULES = [
  /two calls/,
  /without confirm, sends nothing and returns a preview and a token/,
  /plus confirm, asks the person's phone/,
  /nothing happens until they approve in MOI Wallet/,
  /refused before the phone is asked/,
  /base units/,
  /decimals/,
  /moi_get_asset/,
  /list its routines with moi_asset_routines/,
];
const GATEWAY_RULES = [
  /only reads/,
  /moi_rpc_ tools are the node's own methods/,
  /raw node answers/,
  /moi_get_ tools/,
  /one useful answer/,
  /what a person normally wants/,
  /recent heights/,
];
const HOSTED_RULES = [
  /one-time sign-in/,
  /Connect button/,
  /linking this chat to the MOI Wallet/,
  /creates no account/,
  /no key ever leaves the phone/,
  /every transaction still needs their tap/,
  /The moi_get_ tools need no sign-in/,
];

/** The patterns `text` does not match, as strings, so a failure names what is missing. */
const missing = (text: string, patterns: RegExp[]): string[] => patterns.filter((p) => !p.test(text)).map(String);

/** The names a server of this mode lists, from its pinned tools/list. */
function listed(mode: Mode): string[] {
  const file = new URL(`./__snapshots__/tools-${mode}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as Array<{ name: string }>).map((tool) => tool.name);
}

describe("the instruction texts", () => {
  it.each(MODES)("%s stays under the length ceiling and is not empty", (mode) => {
    expect(TEXTS[mode].length).toBeGreaterThan(200);
    expect(TEXTS[mode].length).toBeLessThanOrEqual(MAX_CHARS[mode]);
  });

  it.each(MODES)("%s is one paragraph of plain sentences: no markdown, no table, no bullets", (mode) => {
    const text = TEXTS[mode];
    expect(text).not.toMatch(/[\n|`#*]/);
    expect(text).toBe(text.trim());
    expect(text).toMatch(/\.$/);
  });

  it("are three different texts", () => {
    expect(new Set(Object.values(TEXTS)).size).toBe(3);
  });

  it("the gateway says it only reads, what the two kinds of tool are, and that history is recent", () => {
    expect(missing(GATEWAY_INSTRUCTIONS, GATEWAY_RULES)).toEqual([]);
    // It has no wallet, so nothing about writes, the phone or signing in belongs here.
    expect(GATEWAY_INSTRUCTIONS).not.toMatch(/two calls|confirm|MOI Wallet|phone|Connect|sign-in/);
  });

  it.each(["stdio", "hosted"] as const)(
    "%s says the vocabulary, the two-call write, the units and to list routines first",
    (mode) => {
      expect(missing(TEXTS[mode], [...VOCABULARY, ...WRITE_RULES])).toEqual([]);
    },
  );

  it("the hosted text says what the Connect step is and that approving it links this chat to the paired wallet", () => {
    expect(missing(HOSTED_INSTRUCTIONS, HOSTED_RULES)).toEqual([]);
  });

  it("the hosted text gives the Launchpad steps in order, in one sentence", () => {
    const text = HOSTED_INSTRUCTIONS;
    const patterns = [
      /runs only once its setup script has been run on a machine/,
      /once the agent is registered/,
      /AI API key ready/,
      /Node\.js 18 or newer/,
      /moi_launchpad_setup_script/,
      /curl -fL -o/,
      /run it with bash/,
      /delete the script/,
      /private key/,
    ];
    expect(missing(text, patterns)).toEqual([]);
    expect(text).toContain(GROQ_KEYS_URL);
    expect(text).toContain("Google AI or OpenAI key");
    expect(text).toContain("the download link works once and expires after ten minutes");
    const order = ["AI API key ready", "Node.js 18", "moi_launchpad_setup_script", "delete the script"].map((p) => text.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // One sentence: the Launchpad's text starts after a full stop and runs to the end with no full stop inside it
    // other than in the URL, the version number and the file names.
    const sentence = text.slice(text.indexOf("An agent made on the MOI Agent Launchpad"));
    expect(sentence.endsWith("private key.")).toBe(true);
    expect(sentence.replace(/console\.groq\.com|Node\.js/g, "").slice(0, -1)).not.toContain(".");
  });

  it("the gateway and stdio texts do not mention the Launchpad, which only the hosted server has", () => {
    expect(GATEWAY_INSTRUCTIONS).not.toMatch(/Launchpad|moi_launchpad/);
    expect(STDIO_INSTRUCTIONS).not.toMatch(/Launchpad|moi_launchpad/);
  });

  it("the stdio text says nothing about a connector or a Connect step, which only the hosted server has", () => {
    expect(STDIO_INSTRUCTIONS).not.toMatch(/Connect|sign-in|connector/);
  });

  it.each(MODES)("%s names only tools its server lists", (mode) => {
    const names = listed(mode);
    const mentioned = TEXTS[mode].match(/moi_[a-z_]+/g) ?? [];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      // A name ending in an underscore is a family (moi_get_, moi_rpc_): some listed tool starts with it.
      const found = name.endsWith("_") ? names.some((n) => n.startsWith(name)) : names.includes(name);
      expect(found, `the ${mode} text names ${name}, which the ${mode} server does not list`).toBe(true);
    }
  });
});

describe("where the texts come from", () => {
  it("src/instructions.ts imports nothing, so the read gateway can share it without reaching wallet code", () => {
    const graph = importGraph("src/instructions.ts");
    expect(graph.files).toEqual(["src/instructions.ts"]);
    expect(graph.packages).toEqual([]);
  });

  it("all three entry points reach it", () => {
    for (const entry of ["src/http.ts", "src/server.ts", "src/index.ts"]) {
      expect(importGraph(entry).files, entry).toContain("src/instructions.ts");
    }
  });
});

describe("what initialize carries", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  // Nothing is read from the node by initialize or tools/list; the address only has to parse.
  const NODE = "http://127.0.0.1:1";

  it("the read gateway hands over its own text", async () => {
    harness = await startHarness(NODE, { build: () => buildReadOnlyServer() });
    expect(harness.client.getInstructions()).toBe(GATEWAY_INSTRUCTIONS);
  });

  it("the stdio server hands over its own text, as the test harness builds it", async () => {
    harness = await startHarness(NODE);
    expect(harness.client.getInstructions()).toBe(STDIO_INSTRUCTIONS);
  });

  it("src/index.ts, which a test cannot build because it starts itself when imported, passes that same text", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain('import { STDIO_INSTRUCTIONS } from "./instructions.js";');
    expect(source).toContain("instructions: STDIO_INSTRUCTIONS");
  });
});
