/**
 * Which source files and packages a file can reach, found by reading its import
 * statements. Nothing is built or run, so the answer does not depend on what a
 * bundler keeps, and a test can say "this entry point never reaches that code"
 * about the source tree itself.
 *
 * Every kind of edge counts, because a missed edge is a hole in the claim and a
 * spurious one costs a glance:
 *   - import ... from "x" and export ... from "x", on one line or several
 *   - import "x", for its side effects
 *   - import type, which the build erases but which still names the file
 *   - import("x") with a string literal, which is how src/tools/wallet.ts loads
 *     src/wc/qr.ts
 * The first two forms are read only where a line STARTS with import or export, so
 * a comment that talks about an import is not an edge. Not followed: require()
 * (the one use reads package.json) and import() with a computed argument. If
 * either ever carries code, this walker has to learn it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** This file is test/helpers/import-graph.ts, so the repository root is two levels up. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// [^"';]*? lets a clause run over several lines but stops at the first quote or
// semicolon, so an exported function is never read on into its body looking for a "from".
const FROM_CLAUSE = /^[ \t]*(?:import|export)\b[^"';]*?\bfrom[ \t]*["']([^"']+)["']/gm;
const SIDE_EFFECT = /^[ \t]*import[ \t]*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

export interface ImportGraph {
  /** Every source file reached, the entry included: repo-relative, forward slashes, sorted. */
  files: string[];
  /** Every package or builtin named along the way, as written ("zod", "node:fs", "@walletconnect/sign-client"), sorted. */
  packages: string[];
  /** How a file or package was first reached, entry first. For failure messages. */
  chain(name: string): string[];
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [FROM_CLAUSE, SIDE_EFFECT, DYNAMIC]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

/** The .ts file a relative specifier names: ./x.js is ./x.ts, and ./dir is ./dir/index.ts. */
function sourceFor(from: string, specifier: string): string | undefined {
  const target = resolve(dirname(from), specifier);
  const candidates = [target.replace(/\.js$/, ".ts"), `${target}.ts`, join(target, "index.ts")];
  return candidates.find((candidate) => candidate.endsWith(".ts") && existsSync(candidate));
}

export function importGraph(entry: string, root: string = REPO_ROOT): ImportGraph {
  const start = resolve(root, entry);
  if (!existsSync(start)) throw new Error(`importGraph: ${entry} does not exist under ${root}`);

  const files = new Set<string>();
  const packages = new Set<string>();
  const firstSeenFrom = new Map<string, string>();
  const named = (file: string): string => relative(root, file).split(sep).join("/");

  const visit = (file: string): void => {
    const here = named(file);
    files.add(here);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        if (!packages.has(specifier)) {
          packages.add(specifier);
          firstSeenFrom.set(specifier, here);
        }
        continue;
      }
      const next = sourceFor(file, specifier);
      if (!next) {
        if (specifier.endsWith(".json")) continue; // data, not code
        throw new Error(`importGraph: ${here} imports ${specifier}, which is not a .ts file the walker can find`);
      }
      if (!files.has(named(next))) {
        firstSeenFrom.set(named(next), here);
        visit(next);
      }
    }
  };
  visit(start);

  return {
    files: [...files].sort(),
    packages: [...packages].sort(),
    chain(name) {
      const path = [name];
      for (let at = firstSeenFrom.get(name); at !== undefined; at = firstSeenFrom.get(at)) path.unshift(at);
      return path;
    },
  };
}
