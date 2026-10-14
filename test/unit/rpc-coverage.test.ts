/**
 * The method table (src/capabilities/reads/rpc-methods.ts) against the provider the server is built on.
 *
 * The provider is read, not run, in two ways that must agree with each other and with the table. First, every compiled file
 * of it is scanned for the "moi.", "ixpool." and "net." string literals, which is every JSON-RPC method it can name. Second,
 * every this.execute(...) call in base-provider.js is found, with the provider method it sits in and the name it passes,
 * which must be a plain literal: a name built at run time would slip past the first scan, so it fails here instead. A method
 * the provider has and the table lacks is a node method nobody decided about; a row the provider no longer has is a tool that
 * can only fail; a row paired with the wrong provider method would call the wrong thing. Each is a failing test, so a provider
 * upgrade shows up here and not in front of a user.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { JsonRpcProvider } from "js-moi-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RPC_METHODS, toolNameFor, type RpcGroup } from "../../src/capabilities/reads/rpc-methods.js";

/** A method name as a string literal: letters, digits and underscores after the namespace, in any quotes. */
const NAME = /["'`]((?:moi|ixpool|net)\.[A-Za-z0-9_]+)["'`]/g;

/**
 * What the node pushes down a websocket. websocket-provider.js compares the notification's method with it; it is not a method
 * the provider calls, so it has no row.
 */
const PUSHED = ["moi.subscription"];

const NOT_A_MEMBER = ["if", "for", "while", "switch", "catch", "return"];

/** The method names a source file writes as string literals, sorted. */
function literalNames(source: string): string[] {
  return [...new Set([...source.matchAll(NAME)].map((match) => match[1] as string))].sort();
}

/**
 * Every this.execute( call in a source file: the class member it sits in (a line with four spaces of indent, which is how the
 * compiled class lays its members out) and the name it passes, or undefined when that is not a plain string literal.
 */
function callSitesIn(source: string): Array<{ method: string; wire: string | undefined }> {
  let method = "";
  const sites: Array<{ method: string; wire: string | undefined }> = [];
  for (const line of source.split("\n")) {
    const member = /^ {4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1];
    if (member !== undefined && !NOT_A_MEMBER.includes(member)) method = member;
    if (line.includes("this.execute(")) {
      sites.push({ method, wire: /this\.execute\(\s*(["'`])((?:moi|ixpool|net)\.[A-Za-z0-9_]+)\1/.exec(line)?.[2] });
    }
  }
  return sites;
}

/** The compiled files of the installed provider (no maps, no typings). Resolved through js-moi-sdk, which is what depends on it. */
function providerSources(): Array<{ name: string; source: string }> {
  const fromHere = createRequire(import.meta.url);
  const fromSdk = createRequire(fromHere.resolve("js-moi-sdk"));
  const dir = join(dirname(fromSdk.resolve("js-moi-providers/package.json")), "lib.esm");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), "utf8") }));
}

/** Every method name any file of the installed provider writes as a literal, sorted, without the one the node pushes. */
function providerMethods(): string[] {
  const names = providerSources().flatMap(({ source }) => literalNames(source));
  return [...new Set(names)].filter((name) => !PUSHED.includes(name)).sort();
}

/** The this.execute( calls of base-provider.js, where the provider class sends every method. */
function callSites(): Array<{ method: string; wire: string | undefined }> {
  return callSitesIn(providerSources().find((file) => file.name === "base-provider.js")?.source ?? "");
}

const OUT = [
  "moi.GetFilterChanges",
  "moi.NewLogFilter",
  "moi.NewTesseractFilter",
  "moi.NewTesseractsByAccountFilter",
  "moi.PendingIxnsFilter",
  "moi.RemoveFilter",
  "moi.Subscribe",
];

/** The 34 tool names, in the order the table lists them and the gateway registers them. */
const TOOL_NAMES = [
  "moi_rpc_account_state",
  "moi_rpc_account_meta_info",
  "moi_rpc_account_keys",
  "moi_rpc_balance",
  "moi_rpc_tdu",
  "moi_rpc_interaction_count",
  "moi_rpc_pending_interaction_count",
  "moi_rpc_sub_account_count",
  "moi_rpc_deeds",
  "moi_rpc_context_info",
  "moi_rpc_syncing",
  "moi_rpc_asset_info_by_asset_id",
  "moi_rpc_storage_metric",
  "moi_rpc_storage_pricing",
  "moi_rpc_logic_manifest",
  "moi_rpc_logic_storage",
  "moi_rpc_logic_ids",
  "moi_rpc_call",
  "moi_rpc_fuel_estimate",
  "moi_rpc_interaction_by_hash",
  "moi_rpc_interaction_by_tesseract",
  "moi_rpc_interaction_receipt",
  "moi_rpc_tesseract",
  "moi_rpc_access_policy",
  "moi_rpc_access_policies",
  "moi_rpc_get_logs",
  "moi_rpc_ixpool_content",
  "moi_rpc_ixpool_content_from",
  "moi_rpc_ixpool_status",
  "moi_rpc_ixpool_inspect",
  "moi_rpc_ixpool_wait_time",
  "moi_rpc_net_peers",
  "moi_rpc_net_version",
  "moi_rpc_net_info",
];

const tools = RPC_METHODS.flatMap((row) => (row.status === "tool" ? [row] : []));

describe("the table and the provider", () => {
  it("agree: every method the provider calls has a row, and every row is a method it calls", () => {
    const provider = providerMethods();
    const table = RPC_METHODS.map((row) => row.wire).sort();
    // One expect on both lists: the first of two expects to fail would stop the test and hide the other list.
    // missing: the provider calls these and src/capabilities/reads/rpc-methods.ts has no row (add one: tool, internal or out).
    // stale: rows for methods the provider no longer calls (remove them).
    expect({
      missing: provider.filter((name) => !table.includes(name)),
      stale: table.filter((name) => !provider.includes(name)),
    }).toEqual({ missing: [], stale: [] });
  });

  it("is looking at something: the scan finds the three namespaces, in more than one file", () => {
    const provider = providerMethods();
    expect(provider).toEqual(expect.arrayContaining(["moi.AccountState", "moi.SendInteractions", "ixpool.Content", "net.Peers"]));
    for (const prefix of ["moi.", "ixpool.", "net."]) expect(provider.filter((name) => name.startsWith(prefix)).length, prefix).toBeGreaterThan(0);
    expect(providerSources().map((file) => file.name)).toEqual(
      expect.arrayContaining(["base-provider.js", "jsonrpc-provider.js", "websocket-provider.js"]),
    );
  });

  it("names a provider method that exists for every row, and no method or wire name twice", () => {
    const prototype = JsonRpcProvider.prototype as unknown as Record<string, unknown>;
    for (const row of RPC_METHODS) expect(typeof prototype[row.method], `${row.wire} -> ${row.method}`).toBe("function");
    expect(new Set(RPC_METHODS.map((row) => row.wire)).size).toBe(RPC_METHODS.length);
    expect(new Set(RPC_METHODS.map((row) => row.method)).size).toBe(RPC_METHODS.length);
  });

  it("calls every node method by a plain string literal, each from one provider method", () => {
    const sites = callSites();
    expect(sites.length, "no this.execute( calls found: the scan no longer matches the provider's source").toBeGreaterThan(30);
    // A name built at run time, or written in an unusual way, cannot be matched to a row. That is a failure, not a skip.
    expect(sites.filter((site) => site.wire === undefined).map((site) => site.method), "calls whose name is not a string literal").toEqual([]);
    // Two provider methods sending one name would leave one of them out of the pairing test below.
    expect(new Set(sites.map((site) => site.wire)).size).toBe(sites.length);
    // And the calls are all of the names any file mentions: nothing is named somewhere the call scan does not look.
    expect(sites.map((site) => site.wire).sort()).toEqual(providerMethods());
  });

  it("pairs every row with the provider method that sends it", () => {
    const sent = Object.fromEntries(callSites().map((site) => [site.wire ?? "?", site.method]));
    expect(Object.fromEntries(RPC_METHODS.map((row) => [row.wire, row.method]))).toEqual(sent);
  });

  it("is strict: it sees a name with a digit, and flags a name built in a template or passed as a variable", () => {
    const source = [
      "    async getFoo(id) {",
      '        const response = await this.execute("moi.Foo2", params);',
      "    }",
      "    async getBar(id) {",
      "        const response = await this.execute(`${namespace}.Bar`, params);",
      "    }",
      "    async getBaz(id) {",
      "        const response = await this.execute(name, params);",
      "    }",
    ].join("\n");
    expect(literalNames(source)).toEqual(["moi.Foo2"]);
    expect(callSitesIn(source)).toEqual([
      { method: "getFoo", wire: "moi.Foo2" },
      { method: "getBar", wire: undefined },
      { method: "getBaz", wire: undefined },
    ]);
  });
});

describe("what becomes of each method", () => {
  it("is 34 tools, one internal method and seven that are out", () => {
    expect(RPC_METHODS).toHaveLength(42);
    expect(tools).toHaveLength(34);
    expect(RPC_METHODS.filter((row) => row.status === "internal").map((row) => row.wire)).toEqual(["moi.SendInteractions"]);
    expect(RPC_METHODS.filter((row) => row.status === "out").map((row) => row.wire).sort()).toEqual(OUT);
    expect(RPC_METHODS.filter((row) => row.wire.startsWith("moi.")).length).toBe(34);
    expect(RPC_METHODS.filter((row) => row.wire.startsWith("ixpool.")).length).toBe(5);
    expect(RPC_METHODS.filter((row) => row.wire.startsWith("net.")).length).toBe(3);
  });

  it("says why for every row that is not a tool, and the submit method is not read-only", () => {
    for (const row of RPC_METHODS) {
      if (row.status === "tool") continue;
      expect(row.why.length, row.wire).toBeGreaterThan(30);
    }
    const submit = RPC_METHODS.find((row) => row.wire === "moi.SendInteractions");
    expect(submit?.status === "internal" ? submit.why : "").toMatch(/read-only/);
    for (const wire of OUT) {
      const row = RPC_METHODS.find((r) => r.wire === wire);
      expect(row?.status === "out" ? row.why : "").toMatch(/state on the node/);
    }
  });

  it("groups the tools as the README does, and every group is used", () => {
    const count = (group: RpcGroup) => tools.filter((row) => row.group === group).length;
    expect({
      account: count("account"),
      asset: count("asset"),
      logic: count("logic"),
      interaction: count("interaction"),
      tesseract: count("tesseract"),
      access: count("access"),
      logs: count("logs"),
      pool: count("pool"),
      network: count("network"),
      submit: count("submit"),
    }).toEqual({ account: 11, asset: 3, logic: 3, interaction: 5, tesseract: 1, access: 2, logs: 1, pool: 5, network: 3, submit: 0 });
    // Submit has the one internal row, the filter group the seven that are out.
    expect(RPC_METHODS.filter((row) => row.group === "submit").map((row) => row.wire)).toEqual(["moi.SendInteractions"]);
    expect(RPC_METHODS.filter((row) => row.group === "filter")).toHaveLength(7);
  });

  it("gives every row its parameters as a zod shape, the eight rows with no tool included", () => {
    for (const row of RPC_METHODS) {
      for (const [name, schema] of Object.entries(row.params)) expect(schema instanceof z.ZodType, `${row.wire}.${name}`).toBe(true);
    }
    const noTool = RPC_METHODS.flatMap((row) => (row.status === "tool" ? [] : [row]));
    expect(Object.fromEntries(noTool.map((row) => [row.wire, Object.keys(row.params)]))).toEqual({
      "moi.SendInteractions": ["ix_args", "signatures"],
      "moi.NewLogFilter": ["id", "start_height", "end_height", "topics"],
      "moi.NewTesseractFilter": [],
      "moi.NewTesseractsByAccountFilter": ["id"],
      "moi.PendingIxnsFilter": [],
      "moi.GetFilterChanges": ["filter_id"],
      "moi.RemoveFilter": ["filter_id"],
      "moi.Subscribe": ["event", "id"],
    });
  });
});

describe("tool names", () => {
  it("are the pinned 34, in table order, and each is moi_rpc_ and the method in snake case", () => {
    expect(tools.map((row) => row.tool)).toEqual(TOOL_NAMES);
    expect(new Set(TOOL_NAMES).size).toBe(34);
    for (const name of TOOL_NAMES) expect(name).toMatch(/^moi_rpc_[a-z0-9_]+$/);
  });

  it("keep the namespace of a method that is not moi.", () => {
    expect(toolNameFor("moi.AccountState")).toBe("moi_rpc_account_state");
    expect(toolNameFor("moi.TDU")).toBe("moi_rpc_tdu");
    expect(toolNameFor("moi.LogicIDs")).toBe("moi_rpc_logic_ids");
    expect(toolNameFor("moi.AssetInfoByAssetID")).toBe("moi_rpc_asset_info_by_asset_id");
    expect(toolNameFor("ixpool.ContentFrom")).toBe("moi_rpc_ixpool_content_from");
    expect(toolNameFor("net.Peers")).toBe("moi_rpc_net_peers");
  });
});

describe("descriptions", () => {
  it("each says it is the raw node method and what it returns", () => {
    for (const row of tools) expect(row.description, row.tool).toMatch(new RegExp(`^Raw node method ${row.wire.replace(".", "\\.")}: returns .+\\.`));
  });

  it("say plainly that moi.Call and moi.FuelEstimate need a full interaction object and that the write tools are what a person wants", () => {
    for (const wire of ["moi.Call", "moi.FuelEstimate"]) {
      const row = tools.find((r) => r.wire === wire);
      expect(row?.description, wire).toMatch(/must supply the whole interaction object/);
      expect(row?.description, wire).toMatch(/write tools/);
    }
  });
});
