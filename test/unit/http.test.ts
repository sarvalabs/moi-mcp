import { describe, expect, it } from "vitest";

import { buildReadOnlyServer, MCP_PATH, resolvePort } from "../../src/http.js";

describe("read-only HTTP server", () => {
  it("builds without a wallet or a project id", () => {
    // Reads need only an RPC endpoint; the HTTP half must never require
    // WC_PROJECT_ID, which is what makes it hostable.
    expect(() => buildReadOnlyServer()).not.toThrow();
  });

  it("serves MCP at /mcp", () => {
    expect(MCP_PATH).toBe("/mcp");
  });

  it("does not import the write or wallet modules at all", async () => {
    // The write path must be unreachable over HTTP by construction, not by
    // configuration. Checked against import statements, not prose — the file
    // mentions these modules in a comment explaining why it avoids them.
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("../../src/http.ts", import.meta.url), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+"/.test(line))
      .join("\n");

    for (const forbidden of [
      "tools/writes",
      "tools/wallet",
      "tools/hosted-writes",
      "tools/local-writes",
      "applications/registry/tools",
      "wc/client",
      "wc/session",
    ]) {
      expect(imports, `http.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exposes exactly the read surface", async () => {
    const registered: string[] = [];
    const server = buildReadOnlyServer() as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    for (const name of Object.keys(server._registeredTools ?? {})) registered.push(name);

    expect(registered).toContain("moi_get_account");
    expect(registered).toContain("moi_get_history");
    expect(registered).toContain("moi_asset_routines");
    expect(registered).toContain("moi_rpc_account_state");
    expect(registered).not.toContain("moi_rpc_send_interactions");
    expect(registered).not.toContain("moi_asset_invoke");
    expect(registered).not.toContain("moi_transfer");
    expect(registered).not.toContain("moi_create_asset");
    expect(registered).not.toContain("moi_connect_wallet");
  });
});

describe("resolvePort", () => {
  it("defaults to 8787 when PORT is unset", () => {
    expect(resolvePort({})).toBe(8787);
  });

  it("falls back to the default when PORT is empty or whitespace", () => {
    expect(resolvePort({ PORT: "" })).toBe(8787);
    expect(resolvePort({ PORT: "   " })).toBe(8787);
  });

  it("parses a valid PORT", () => {
    expect(resolvePort({ PORT: "3000" })).toBe(3000);
  });

  it("rejects a non-numeric PORT instead of producing NaN", () => {
    expect(() => resolvePort({ PORT: "invalid" })).toThrow(/Invalid PORT/);
  });

  it("rejects zero and negative ports instead of silently binding an ephemeral one", () => {
    expect(() => resolvePort({ PORT: "0" })).toThrow(/Invalid PORT/);
    expect(() => resolvePort({ PORT: "-1" })).toThrow(/Invalid PORT/);
  });
});
