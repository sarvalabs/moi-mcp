/**
 * The folder layout's two rules, kept by reading the source tree.
 *
 *   1. Only src/tools/register.ts registers a tool that can change something. Every other file that calls registerTool
 *      registers a read-only tool. A tool that is not read-only is built with defineTool (src/tools/define.ts) in the
 *      capability or application that owns it, and register.ts hands it to the server. The one other file that registers by
 *      a computed name is src/capabilities/reads/rpc-tools.ts, which registers the node methods in a loop over its table; a
 *      test of its own checks that everything it can register is read-only in the pinned gateway list.
 *   2. Nothing under src/capabilities reaches src/applications, directly or through any chain of imports.
 *
 * Both fail the moment a file breaks the rule, whatever the pinned tool lists say.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RPC_METHODS } from "../../src/capabilities/reads/rpc-methods.js";
import { registerTools } from "../../src/tools/register.js";
import { importGraph } from "../helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REGISTER = "src/tools/register.ts";
/** The one other file that registers a tool by a computed name: it registers the node methods in a loop over the table in rpc-methods.ts. */
const RPC_TOOLS = "src/capabilities/reads/rpc-tools.ts";

/** Every .ts file under a repo-relative directory, repo-relative with forward slashes. */
function sourceFiles(dir: string): string[] {
  return (readdirSync(`${ROOT}${dir}`, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${dir}/${name.split("\\").join("/")}`);
}

/** A source text without its comments, so prose that talks about registerTool is not a call. Line numbers are kept. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
}

interface Registration {
  line: number;
  /** The tool's name when the call gives it as a string literal. */
  name: string | undefined;
}

/**
 * Every use of registerTool, or of the deprecated server.tool, in a source text, however it is written: a call with or
 * without type arguments, .bind or .call, an alias, a destructuring, a bracket access. `name` is the tool's name when the
 * use is a call whose first argument is a string literal, and undefined for any other use, which the rule refuses
 * because a scan cannot tell what it registers. The word registerTools (plural) is not a use.
 *
 * This is a tripwire for an accidental registration, not a lock: it reads text, so a call built from pieces gets past it,
 * a block-comment opener inside a string literal hides the code up to the next closer, and a trailing line comment is kept
 * (a false alarm at worst). The three pinned tool lists are the second net.
 */
function registrationsIn(source: string): Registration[] {
  const code = withoutComments(source);
  const found: Registration[] = [];
  for (const match of code.matchAll(/\bregisterTool\b|\bserver\s*\.\s*tool\b/g)) {
    const after = code.slice(match.index + match[0].length);
    const call = /^\s*(?:<[^()]*>)?\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)/.exec(after);
    const line = code.slice(0, match.index).split("\n").length;
    found.push({ line, name: call ? (call[1] ?? call[2] ?? call[3]) : undefined });
  }
  return found;
}

/** The names of the read-only tools, as the three pinned lists say. */
function readOnlyNames(): Set<string> {
  const names = new Set<string>();
  for (const mode of ["gateway", "stdio", "hosted"]) {
    const tools = JSON.parse(readFileSync(`${ROOT}test/unit/__snapshots__/tools-${mode}.json`, "utf8")) as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    for (const tool of tools) if (tool.annotations?.readOnlyHint === true) names.add(tool.name);
  }
  return names;
}

/** What the rule forbids in `files` (path to source): a registration outside register.ts that is not a read-only tool named by a literal. */
function violations(files: Record<string, string>, readOnly: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (file === REGISTER) continue;
    for (const { line, name } of registrationsIn(source)) {
      // The generator takes its names from its table, so the test after "holds for every file under src" checks what it can register.
      if (name === undefined && file === RPC_TOOLS) continue;
      if (name === undefined) found.push(`${file}:${line} uses registerTool without a string literal for the tool name`);
      else if (!readOnly.has(name)) found.push(`${file}:${line} registers ${name}, which is not a read-only tool in the pinned lists`);
    }
  }
  return found;
}

describe("a tool that can change something is registered only in src/tools/register.ts", () => {
  const files = Object.fromEntries(sourceFiles("src").map((file) => [file, readFileSync(`${ROOT}${file}`, "utf8")]));

  it("holds for every file under src", () => {
    const readOnly = readOnlyNames();
    // A scan that finds nothing proves nothing: the read tools and the two pings register themselves, where they are defined.
    const seen = new Set<string>();
    for (const [file, source] of Object.entries(files)) {
      if (file !== REGISTER) for (const { name } of registrationsIn(source)) if (name) seen.add(name);
    }
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "ping", "moi_get_account", "moi_get_history", "moi_get_asset", "moi_asset_routines", "moi_get_interaction",
        "moi_get_logic", "moi_resolve_agent", "moi_list_agents",
      ]),
    );
    expect(violations(files, readOnly), "only src/tools/register.ts may register a tool that is not read-only").toEqual([]);
    // register.ts is the one place: a single call, which takes each name from the definition it is handed.
    expect(files[REGISTER], `${REGISTER} must exist`).toBeDefined();
    expect(registrationsIn(files[REGISTER] as string)).toHaveLength(1);
  });

  it("lets the node-method generator register by a computed name, because every name it can register is read-only", () => {
    // One registration, in a loop, with its name taken from the table.
    const uses = registrationsIn(files[RPC_TOOLS] as string);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.name).toBeUndefined();
    expect(files[RPC_TOOLS]).not.toMatch(/readOnlyHint:\s*false/);
    // What it can register is the table's rows with status tool, and the pinned gateway list holds each one as read-only.
    const gateway = JSON.parse(readFileSync(`${ROOT}test/unit/__snapshots__/tools-gateway.json`, "utf8")) as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    const registrable = RPC_METHODS.flatMap((row) => (row.status === "tool" ? [row.tool] : []));
    expect(registrable).toHaveLength(34);
    for (const name of registrable) {
      const listed = gateway.find((tool) => tool.name === name);
      expect(listed, `${name} is not in the pinned gateway list`).toBeDefined();
      expect(listed?.annotations?.readOnlyHint, `${name} must be read-only`).toBe(true);
    }
  });

  it("flags a write registered anywhere else, and every way of registering that hides the name", () => {
    const readOnly = new Set(["moi_get_account"]);
    const synthetic = {
      "src/a.ts": 'server.registerTool(\n  "moi_transfer",\n  { annotations: WRITE_ANNOTATIONS },\n  cb,\n);',
      "src/b.ts": "server.registerTool(name, config, cb);",
      "src/c.ts": 'server.tool("moi_get_account", cb);',
      "src/d.ts": 'server.registerTool("moi_get_account", { annotations: READ_ONLY }, cb);',
      "src/e.ts": 'server.registerTool<typeof Out, typeof In>("moi_mint", config, cb);',
      "src/f.ts": 'server.registerTool.call(server, "moi_mint", config, cb);',
      "src/g.ts": "const add = server.registerTool.bind(server);",
      "src/h.ts": 'server["registerTool"]("moi_mint", config, cb);',
      "src/i.ts": "const { registerTool } = server;",
      "src/j.ts": "registerTools(server, ctx);",
    };
    expect(violations(synthetic, readOnly)).toEqual([
      "src/a.ts:1 registers moi_transfer, which is not a read-only tool in the pinned lists",
      "src/b.ts:1 uses registerTool without a string literal for the tool name",
      "src/e.ts:1 registers moi_mint, which is not a read-only tool in the pinned lists",
      "src/f.ts:1 uses registerTool without a string literal for the tool name",
      "src/g.ts:1 uses registerTool without a string literal for the tool name",
      "src/h.ts:1 uses registerTool without a string literal for the tool name",
      "src/i.ts:1 uses registerTool without a string literal for the tool name",
    ]);
  });

  it("does not count a comment that talks about registerTool", () => {
    const source = '// server.registerTool("moi_transfer", cfg, cb)\n/* server.registerTool("moi_mint") */\nconst x = 1;';
    expect(registrationsIn(source)).toEqual([]);
    expect(registrationsIn(`/* one\n two */\nserver.registerTool("moi_a", c, h);`)).toEqual([{ line: 3, name: "moi_a" }]);
  });
});

/** The chains by which a file reaches src/applications, as "a -> b -> c" strings. */
function reachesApplications(file: string, root: string = ROOT): string[] {
  const graph = importGraph(file, root);
  return graph.files.filter((name) => name.startsWith("src/applications/")).map((name) => graph.chain(name).join(" -> "));
}

describe("nothing under src/capabilities imports from src/applications", () => {
  it("holds for every file, directly or through any chain of imports", () => {
    const files = sourceFiles("src/capabilities");
    // A walk over nothing proves nothing.
    expect(files).toEqual(
      expect.arrayContaining([
        "src/capabilities/accounts/create-participant.ts",
        "src/capabilities/assets/create.ts",
        "src/capabilities/assets/shortcuts.ts",
        "src/capabilities/assets/execute.ts",
        "src/capabilities/assets/routines.ts",
        "src/capabilities/logics/invoke.ts",
        "src/capabilities/logics/view.ts",
        "src/capabilities/reads/tools.ts",
        "src/capabilities/reads/registry.ts",
      ]),
    );
    for (const file of files) expect(reachesApplications(file), `${file} must not reach src/applications`).toEqual([]);
    // The rule is not vacuous: the applications are built on the capabilities, the other way round.
    expect(importGraph("src/applications/registry/tools.ts").files).toContain("src/capabilities/logics/invoke.ts");
  });

  describe("the check itself", () => {
    let root: string;
    const put = (path: string, text: string): void => {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "moi-layout-"));
      put("src/applications/app.ts", "export const app = 1;\n");
      put("src/moi/lib.ts", "export const lib = 1;\n");
      put("src/capabilities/direct.ts", 'import { app } from "../applications/app.js";\nexport const d = app;\n');
      put("src/capabilities/helper.ts", 'import { app } from "../applications/app.js";\nexport const h = app;\n');
      put("src/capabilities/via.ts", 'import { h } from "./helper.js";\nexport const v = h;\n');
      put("src/capabilities/clean.ts", 'import { lib } from "../moi/lib.js";\nexport const c = lib;\n');
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("sees an import of an application, and a chain through another file, and passes a clean file", () => {
      expect(reachesApplications("src/capabilities/direct.ts", root)).toEqual([
        "src/capabilities/direct.ts -> src/applications/app.ts",
      ]);
      expect(reachesApplications("src/capabilities/via.ts", root)).toEqual([
        "src/capabilities/via.ts -> src/capabilities/helper.ts -> src/applications/app.ts",
      ]);
      expect(reachesApplications("src/capabilities/clean.ts", root)).toEqual([]);
    });
  });
});

describe("registerTools", () => {
  it("builds the stdio server as the tests' harness does, with ping in front", () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { mode: "stdio" });
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const pinned = (JSON.parse(readFileSync(`${ROOT}test/unit/__snapshots__/tools-stdio.json`, "utf8")) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(["ping", ...pinned]);
  });
});
