import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { expandHome, loadConfig, loadHostedConfig } from "../../src/config.js";

const created: string[] = [];

function tempHome(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "moi-mcp-test-")), "home");
  created.push(dir);
  return dir;
}

/** Minimum viable env: everything else must come from schema defaults. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { WC_PROJECT_ID: "test-project-id", MOI_MCP_HOME: tempHome(), ...overrides };
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("applies schema defaults when only the required vars are present", () => {
    const cfg = loadConfig(baseEnv());

    expect(cfg.MOI_NETWORK).toBe("voyage");
    // Under the MCP client's 60s timeout on purpose — see schema.ts.
    expect(cfg.REQUEST_TIMEOUT_MS).toBe(55_000);
    expect(cfg.LOG_LEVEL).toBe("error");
    expect(cfg.MOI_EXPLORER_URL).toBe("https://voyage.moi.technology");
  });

  it("creates MOI_MCP_HOME with 0700 permissions", () => {
    const cfg = loadConfig(baseEnv());

    const mode = statSync(cfg.home).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("coerces REQUEST_TIMEOUT_MS from the string the environment always gives us", () => {
    const cfg = loadConfig(baseEnv({ REQUEST_TIMEOUT_MS: "60000" }));

    expect(cfg.REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("treats an empty value as unset so a blank .env line falls back to the default", () => {
    const cfg = loadConfig(baseEnv({ MOI_NETWORK: "", MOI_RPC_URL: "" }));

    expect(cfg.MOI_NETWORK).toBe("voyage");
    expect(cfg.MOI_RPC_URL).toBeUndefined();
  });

  it("rejects a missing WC_PROJECT_ID with an actionable message", () => {
    expect(() => loadConfig({ MOI_MCP_HOME: tempHome() })).toThrow(/WC_PROJECT_ID/);
  });

  it("rejects an unknown network", () => {
    expect(() => loadConfig(baseEnv({ MOI_NETWORK: "testnet" }))).toThrow(/MOI_NETWORK/);
  });

  it("requires MOI_RPC_URL when the network is custom", () => {
    expect(() => loadConfig(baseEnv({ MOI_NETWORK: "custom" }))).toThrow(/MOI_RPC_URL/);
  });

  it("accepts a custom network once an RPC URL is supplied", () => {
    const cfg = loadConfig(baseEnv({ MOI_NETWORK: "custom", MOI_RPC_URL: "https://rpc.example.com" }));

    expect(cfg.MOI_NETWORK).toBe("custom");
    expect(cfg.MOI_RPC_URL).toBe("https://rpc.example.com");
  });
});

describe("MOI_SIGNED_CHECK", () => {
  it("defaults to warn, so a real phone is never refused before one write has shown what it signs", () => {
    expect(loadConfig(baseEnv()).MOI_SIGNED_CHECK).toBe("warn");
  });

  it("treats a blank line in .env as unset", () => {
    expect(loadConfig(baseEnv({ MOI_SIGNED_CHECK: "" })).MOI_SIGNED_CHECK).toBe("warn");
    expect(loadConfig(baseEnv({ MOI_SIGNED_CHECK: "  " })).MOI_SIGNED_CHECK).toBe("warn");
  });

  it.each(["warn", "enforce"] as const)("accepts %s", (mode) => {
    expect(loadConfig(baseEnv({ MOI_SIGNED_CHECK: mode })).MOI_SIGNED_CHECK).toBe(mode);
  });

  // A refused value fails the whole load, as a bad MOI_NETWORK does, so a typo for enforce cannot quietly leave the check on warn.
  it.each(["enforced", "ENFORCE", "Warn", "off", "none", "true", "1", "warn,enforce"])("rejects %s, naming the variable", (value) => {
    expect(() => loadConfig(baseEnv({ MOI_SIGNED_CHECK: value }))).toThrow(/MOI_SIGNED_CHECK: must be warn or enforce/);
  });
});

describe("expandHome", () => {
  it("expands a bare tilde", () => {
    expect(expandHome("~")).toBe(process.env.HOME);
  });

  it("expands a tilde-prefixed path", () => {
    expect(expandHome("~/.moi-mcp")).toBe(join(process.env.HOME!, ".moi-mcp"));
  });

  it("leaves an absolute path untouched", () => {
    expect(expandHome("/var/tmp/moi")).toBe("/var/tmp/moi");
  });
});

describe("request timeout stays under the client's", () => {
  /**
   * The MCP client gives up after 60s by default. If the server waits longer,
   * the client reports a timeout while the approval is still live on the
   * phone — and a later tap broadcasts an interaction the user thinks was
   * cancelled.
   */
  it("defaults below the SDK's 60s client timeout", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("still allows an explicit longer wait for non-MCP callers like the CLI", () => {
    const cfg = loadConfig(baseEnv({ REQUEST_TIMEOUT_MS: "300000" }));
    expect(cfg.REQUEST_TIMEOUT_MS).toBe(300_000);
  });
});

describe("loadHostedConfig: the faucet settings", () => {
  /** A MOI_DATA_DIR in a temp dir, because a successful load creates it. */
  const env = (over: Record<string, string> = {}) => ({ MOI_DATA_DIR: tempHome(), ...over });

  it("has no default for either: both are undefined when unset", () => {
    // No default for the address in particular: a wrong default would send MOI_FAUCET_KEY to the wrong host.
    const cfg = loadHostedConfig(env());
    expect(cfg.MOI_FAUCET_URL).toBeUndefined();
    expect(cfg.MOI_FAUCET_KEY).toBeUndefined();
  });

  it("treats a blank or whitespace-only value as unset", () => {
    for (const value of ["", "   ", "\n"]) {
      const cfg = loadHostedConfig(env({ MOI_FAUCET_URL: value, MOI_FAUCET_KEY: value }));
      expect(cfg.MOI_FAUCET_URL, JSON.stringify(value)).toBeUndefined();
      expect(cfg.MOI_FAUCET_KEY, JSON.stringify(value)).toBeUndefined();
    }
  });

  it("returns both, trimmed, and does not judge them", () => {
    // The rules (https only, a public host, no query or credentials, a usable key) belong to FaucetClient and faucetDepsFor,
    // which turn a bad value into "tool off" plus one log line. If config.ts judged them too, a typo in an optional feature
    // would stop the whole write gateway at boot. This test is what stops that strictness coming back by accident.
    for (const url of ["http://example.test/x", "not a url", "https://u:p@example.test/"]) {
      expect(loadHostedConfig(env({ MOI_FAUCET_URL: `  ${url}\n` })).MOI_FAUCET_URL, url).toBe(url);
    }
    for (const key of ["..", ".", "k".repeat(300)]) {
      expect(loadHostedConfig(env({ MOI_FAUCET_KEY: ` ${key} ` })).MOI_FAUCET_KEY).toBe(key);
    }
  });

  it("leaves the shared config alone: loadConfig has neither key", () => {
    const keys = Object.keys(loadConfig(baseEnv({ MOI_FAUCET_URL: "https://faucet.example.test/x", MOI_FAUCET_KEY: "k" })));
    expect(keys).not.toContain("MOI_FAUCET_URL");
    expect(keys).not.toContain("MOI_FAUCET_KEY");
  });
});
