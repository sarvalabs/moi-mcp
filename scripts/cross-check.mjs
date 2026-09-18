#!/usr/bin/env node
/**
 * Cross-implementation consistency check.
 *
 * Runs the TypeScript stdio server (dist/index.js) and the Go binary
 * (~/moi-mcp-go/bin/moi-mcp) side by side over stdio, calls the three read
 * tools both implement on fixed devnet ids, and diffs the intersection of
 * fields. Needs network access to the MOI devnet.
 *
 *   npm run cross-check        # exit 1 on any mismatch
 *
 * Env: the TS server loads ~/moi-mcp/.env itself via dotenv (cwd = repo root).
 * WC_PROJECT_ID is never printed here. Override paths with MOI_MCP_GO_DIR /
 * MOI_MCP_GO_BIN if the Go repo lives elsewhere.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GO_DIR = process.env.MOI_MCP_GO_DIR ?? path.join(homedir(), "moi-mcp-go");
const GO_BIN = process.env.MOI_MCP_GO_BIN ?? path.join(GO_DIR, "bin", "moi-mcp");
const GO_PATH = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;

// Fixed devnet (voyage) fixtures.
const FIXTURES = {
  account: "0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000",
  asset: "0x1080fffe4cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000",
  interaction: "0x3c568254d339090d1e0ec256f9ac46fe288aab7d7739275e2267ddff3fdbc009",
};

// Tool -> input, and the normalised fields we compare (intersection only).
const CHECKS = [
  {
    tool: "moi_get_account",
    args: { address: FIXTURES.account },
    normalise: (r) => ({
      nonce: num(r.nonce),
      isRegistered: bool(r.isRegistered ?? r.is_registered ?? r.registered),
      balances: (r.balances ?? [])
        .map((b) => `${hex(b.assetId ?? b.asset_id)}=${str(b.amount)}`)
        .sort()
        .join(","),
    }),
  },
  {
    tool: "moi_get_asset",
    args: { assetId: FIXTURES.asset },
    normalise: (r) => ({
      symbol: str(r.symbol),
      standard: str(r.standard).toUpperCase(),
      supply: str(r.supply),
      dimension: num(r.dimension),
    }),
  },
  {
    tool: "moi_get_interaction",
    args: { hash: FIXTURES.interaction },
    normalise: (r) => ({
      status: str(r.status).toLowerCase(),
      fuelUsed: num(r.fuelUsed ?? r.fuel_used),
      "operations[].type": (r.operations ?? r.ops ?? [])
        .map((op) => str(op.type ?? op.kind).toUpperCase())
        .join(","),
    }),
  },
];

// --- normalisation helpers (casing / bigint-vs-string / hex-prefix only) ---
function str(v) {
  return v === undefined || v === null ? "<missing>" : String(v);
}
function num(v) {
  if (v === undefined || v === null) return "<missing>";
  const n = typeof v === "bigint" ? v : BigInt(String(v));
  return n.toString();
}
function bool(v) {
  return v === undefined || v === null ? "<missing>" : String(Boolean(v));
}
function hex(v) {
  const s = str(v).toLowerCase();
  return s.startsWith("0x") ? s : `0x${s}`;
}

// --- build if missing ---
function ensureBuilt() {
  if (!existsSync(path.join(TS_DIR, "dist", "index.js"))) {
    console.error("[cross-check] dist/index.js missing — running npm run build");
    const r = spawnSync("npm", ["run", "build"], { cwd: TS_DIR, stdio: "inherit" });
    if (r.status !== 0) throw new Error("npm run build failed");
  }
  if (!existsSync(GO_BIN)) {
    console.error(`[cross-check] ${GO_BIN} missing — running go build`);
    const r = spawnSync("go", ["build", "-o", GO_BIN, "./cmd/moi-mcp"], {
      cwd: GO_DIR,
      stdio: "inherit",
      env: { ...process.env, PATH: GO_PATH },
    });
    if (r.status !== 0) throw new Error("go build failed");
  }
}

// --- MCP client over stdio ---
async function connect(name, command, args, cwd, env) {
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: "pipe" });
  const client = new Client({ name: `cross-check/${name}`, version: "0.0.0" });
  const stderrChunks = [];
  transport.stderr?.on("data", (d) => stderrChunks.push(d));
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = Buffer.concat(stderrChunks).toString().trim();
    throw new Error(`${name} failed to start: ${err.message}${tail ? `\n${tail}` : ""}`);
  }
  return {
    name,
    client,
    async call(tool, args) {
      const res = await client.callTool({ name: tool, arguments: args });
      if (res.isError) {
        const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
        throw new Error(`${name} ${tool} returned error: ${text}`);
      }
      if (res.structuredContent) return res.structuredContent;
      const text = (res.content ?? []).find((c) => c.type === "text")?.text;
      if (!text) throw new Error(`${name} ${tool}: no structuredContent and no text`);
      return JSON.parse(text);
    },
    close: () => client.close(),
  };
}

// Only forward a minimal env to child processes; the TS server reads .env
// itself. Never echo WC_PROJECT_ID.
function childEnv() {
  const keep = ["PATH", "HOME", "MOI_NETWORK", "MOI_RPC_URL", "MOI_READ_CALLER", "MOI_EXPLORER_URL", "LOG_LEVEL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.env.WC_PROJECT_ID) env.WC_PROJECT_ID = process.env.WC_PROJECT_ID; // forwarded, not printed
  return env;
}

function printTable(rows) {
  const headers = ["tool", "field", "ts", "go", "match"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

async function main() {
  ensureBuilt();
  const env = childEnv();
  const ts = await connect("ts", process.execPath, [path.join(TS_DIR, "dist", "index.js")], TS_DIR, env);
  const go = await connect("go", GO_BIN, [], GO_DIR, { ...env, PATH: GO_PATH });

  const rows = [];
  let mismatches = 0;
  try {
    for (const check of CHECKS) {
      const [tsRaw, goRaw] = await Promise.all([ts.call(check.tool, check.args), go.call(check.tool, check.args)]);
      const a = check.normalise(tsRaw);
      const b = check.normalise(goRaw);
      for (const field of Object.keys(a)) {
        const ok = a[field] === b[field];
        if (!ok) mismatches++;
        rows.push([check.tool, field, clip(a[field]), clip(b[field]), ok ? "yes" : "NO"]);
      }
    }
  } finally {
    await Promise.allSettled([ts.close(), go.close()]);
  }

  printTable(rows);
  console.log();
  if (mismatches > 0) {
    console.log(`cross-check: ${mismatches} mismatch(es)`);
    process.exit(1);
  }
  console.log(`cross-check: all ${rows.length} fields match`);
}

function clip(s, max = 72) {
  s = String(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

main().catch((err) => {
  console.error(`cross-check failed: ${err.message}`);
  process.exit(1);
});
