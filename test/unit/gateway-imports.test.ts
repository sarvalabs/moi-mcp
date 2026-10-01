/**
 * The read gateway must not be able to reach wallet or write code, through any
 * chain of imports.
 *
 * http.test.ts already checks the import lines of src/http.ts itself. That
 * cannot see a path that runs through another file (http.ts imports reads.ts,
 * reads.ts imports something that imports the wallet), which is how an isolation
 * property usually breaks. This reads source files all the way down, without
 * building anything.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importGraph } from "../helpers/import-graph.js";

/** What the gateway must never reach: the wallet client tree, the write tools, and WalletConnect itself. */
function isWalletOrWriteCode(name: string): boolean {
  return (
    name.startsWith("src/wc/") ||
    name === "src/tools/wallet.ts" ||
    name === "src/tools/writes.ts" ||
    name === "src/tools/hosted-writes.ts" ||
    name === "src/tools/local-writes.ts" ||
    name === "src/tools/registry-writes.ts" ||
    name === "src/tools/registry-core.ts" ||
    name === "src/tools/write-core.ts" ||
    name === "src/tools/asset-invoke.ts" ||
    name === "src/tools/preview.ts" ||
    name === "src/journal.ts" ||
    name === "@walletconnect" ||
    name.startsWith("@walletconnect/")
  );
}

describe("the read gateway's module graph", () => {
  it("never reaches wallet or write code, however many files it goes through", () => {
    const graph = importGraph("src/http.ts");

    // A walker that finds nothing proves nothing, so check it walked.
    expect(graph.files.length).toBeGreaterThan(10);
    expect(graph.files).toEqual(expect.arrayContaining(["src/http.ts", "src/config.ts", "src/schema.ts"]));
    expect(graph.packages).toEqual(expect.arrayContaining(["zod", "@modelcontextprotocol/sdk/server/mcp.js"]));

    const reached = [...graph.files, ...graph.packages].filter(isWalletOrWriteCode);
    expect(
      reached.map((name) => graph.chain(name).join(" -> ")),
      "src/http.ts must stay a read-only entry point",
    ).toEqual([]);
  });

  it("is looking for names that exist: the stdio and hosted entry points do reach them", () => {
    // If a folder is renamed, the check above would pass by looking for the old name. Here the same
    // names must show up in the graphs that are supposed to contain them.
    const stdio = importGraph("src/index.ts");
    expect(stdio.files).toEqual(
      expect.arrayContaining([
        "src/tools/local-writes.ts",
        "src/tools/hosted-writes.ts",
        "src/tools/registry-writes.ts",
        "src/tools/asset-invoke.ts",
        "src/tools/wallet.ts",
        "src/wc/client.ts",
        "src/journal.ts",
        "src/capabilities/assets/routines.ts",
        "src/capabilities/assets/codec.ts",
        "src/capabilities/assets/standards/index.ts",
      ]),
    );
    // The gateway serves the read half of the asset tools, so it does reach those files; the isolation check above is
    // looking at real names.
    expect(importGraph("src/http.ts").files).toEqual(
      expect.arrayContaining([
        "src/capabilities/assets/routines.ts",
        "src/capabilities/assets/codec.ts",
        "src/capabilities/assets/standards/index.ts",
      ]),
    );
    // The hosted and read-only entry points start themselves when loaded. Bundled into the stdio entry point they
    // would start a second server inside it.
    expect(stdio.files).not.toContain("src/server.ts");
    expect(stdio.files).not.toContain("src/http.ts");
    expect(stdio.packages).toContain("@walletconnect/sign-client");
    expect(importGraph("src/server.ts").files).toContain("src/tools/hosted-writes.ts");
    expect(importGraph("src/server.ts").files).toContain("src/tools/asset-invoke.ts");
    // moi_asset_invoke is write code: the read gateway must not reach the file that runs it.
    expect(importGraph("src/http.ts").files).not.toContain("src/tools/asset-invoke.ts");
  });
});

describe("the capabilities folder", () => {
  it("imports nothing from src/tools, src/wc or the journal, in any file and through any chain", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = (readdirSync(`${root}src/capabilities`, { recursive: true }) as string[])
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/capabilities/${name.split("\\").join("/")}`);
    // A walk over nothing proves nothing.
    expect(files).toEqual(
      expect.arrayContaining(["src/capabilities/assets/invoke.ts", "src/capabilities/assets/routines.ts", "src/capabilities/assets/standards/index.ts"]),
    );
    for (const file of files) {
      const graph = importGraph(file);
      const reached = graph.files.filter((f) => f.startsWith("src/tools/") || f.startsWith("src/wc/") || f === "src/journal.ts");
      expect(reached.map((name) => graph.chain(name).join(" -> ")), `${file} must stay free of write code`).toEqual([]);
    }
    const invoke = importGraph("src/capabilities/assets/invoke.ts");
    expect(invoke.files).toEqual(
      expect.arrayContaining(["src/capabilities/assets/routines.ts", "src/capabilities/assets/codec.ts", "src/capabilities/assets/standards/index.ts"]),
    );
    expect(invoke.packages.filter((name) => name.startsWith("@walletconnect"))).toEqual([]);
  });
});

describe("importGraph", () => {
  let root: string;
  const put = (path: string, text: string): void => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "moi-import-graph-"));
    put(
      "src/entry.ts",
      [
        "/**",
        ' * import { prose } from "./in-a-comment.js" is a sentence here, not an edge.',
        " */",
        '// import { line } from "./in-a-line-comment.js";',
        'import { a } from "./a.js";',
        "import {",
        "  b,",
        '} from "./b.js";',
        'import type { C } from "./c.js";',
        'import data from "./data.json";',
        'import { f } from "./pkg";',
        'import { z } from "zod";',
        'import { readFileSync } from "node:fs";',
        'import "./side.js";',
        'export * from "./star.js";',
        'export { d } from "./dir/index.js";',
        'export type { E } from "./typeonly.js";',
        "export async function lazy() {",
        '  return (await import("./lazy.js")).x;',
        "}",
      ].join("\n"),
    );
    put("src/a.ts", 'import { deep } from "./deep.js";\nexport const a = deep;\n');
    put("src/deep.ts", 'import { w } from "@walletconnect/sign-client";\nexport const deep = w;\n');
    for (const leaf of ["b", "c", "side", "star", "typeonly", "lazy", "dir/index", "pkg/index"]) put(`src/${leaf}.ts`, "export const x = 1;\n");
    put("src/data.json", "{}\n");
    put("src/broken.ts", 'import { gone } from "./missing.js";\n');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("follows every way a file can import another, and nothing a comment says", () => {
    const graph = importGraph("src/entry.ts", root);
    expect(graph.files).toEqual(
      ["entry", "a", "deep", "b", "c", "side", "star", "typeonly", "lazy", "dir/index", "pkg/index"].map((f) => `src/${f}.ts`).sort(),
    );
    expect(graph.packages).toEqual(["@walletconnect/sign-client", "node:fs", "zod"]);
  });

  it("says how it got to a file or a package", () => {
    const graph = importGraph("src/entry.ts", root);
    expect(graph.chain("@walletconnect/sign-client")).toEqual(["src/entry.ts", "src/a.ts", "src/deep.ts", "@walletconnect/sign-client"]);
    expect(graph.chain("src/entry.ts")).toEqual(["src/entry.ts"]);
  });

  it("refuses an import it cannot resolve, rather than skipping it", () => {
    expect(() => importGraph("src/broken.ts", root)).toThrow(/missing\.js/);
    expect(() => importGraph("src/nowhere.ts", root)).toThrow(/does not exist/);
  });
});
