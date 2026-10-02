import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { expandHome, loadConfig, loadHostedConfig } from "../../src/config.js";
import { hostedEnv, SESSION_SECRET } from "../helpers/hosted.js";

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

describe("loadHostedConfig", () => {
  /** A MOI_DATA_DIR in a temp dir, because a successful load creates it. */
  const env = (over: Record<string, string> = {}) => hostedEnv(tempHome(), over);
  /** Distinct enough to find in a message if the value were ever echoed. */
  const sentinel = (n: number) => "Z".repeat(n);

  it("returns the key it was given", () => {
    expect(loadHostedConfig(env()).MOI_SESSION_KEY).toBe(SESSION_SECRET);
  });

  it("fails at boot when the key is missing, and says how to make one", () => {
    const { MOI_SESSION_KEY: _gone, ...without } = env();
    expect(() => loadHostedConfig(without)).toThrow(/MOI_SESSION_KEY/);
    expect(() => loadHostedConfig(without)).toThrow(/openssl rand -base64 32/);
  });

  it("treats a blank or whitespace-only key as missing, so a blank .env line fails closed", () => {
    for (const value of ["", "   ", "\n"]) {
      expect(() => loadHostedConfig(env({ MOI_SESSION_KEY: value })), JSON.stringify(value)).toThrow(/MOI_SESSION_KEY: is required/);
    }
  });

  it("rejects a key shorter than 43 characters without echoing it", () => {
    const short = sentinel(42);
    let message = "";
    try {
      loadHostedConfig(env({ MOI_SESSION_KEY: short }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/MOI_SESSION_KEY: must be at least 43 characters/);
    expect(message).not.toContain(short);
    expect(message).not.toContain("ZZZZZ");
  });

  it("rejects a value that is not base64 or hex text, without echoing it", () => {
    for (const bad of [`${sentinel(30)} ${sentinel(30)}`, `${sentinel(50)}!`, `${sentinel(50)}\u00e9`]) {
      let message = "";
      try {
        loadHostedConfig(env({ MOI_SESSION_KEY: bad }));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(bad)).toMatch(/MOI_SESSION_KEY/);
      expect(message).not.toContain("ZZZZZ");
    }
  });

  it("accepts what openssl gives: 44 characters of base64, and 64 of hex", () => {
    const base64 = Buffer.alloc(32, 9).toString("base64");
    const hex = Buffer.alloc(32, 9).toString("hex");
    expect(base64).toHaveLength(44);
    expect(loadHostedConfig(env({ MOI_SESSION_KEY: base64 })).MOI_SESSION_KEY).toBe(base64);
    expect(loadHostedConfig(env({ MOI_SESSION_KEY: hex })).MOI_SESSION_KEY).toBe(hex);
    // The unpadded 43 characters and url-safe base64 too.
    expect(() => loadHostedConfig(env({ MOI_SESSION_KEY: "A".repeat(43) }))).not.toThrow();
    expect(() => loadHostedConfig(env({ MOI_SESSION_KEY: Buffer.alloc(32, 251).toString("base64url") }))).not.toThrow();
  });

  it("trims whitespace around the key before checking it", () => {
    expect(loadHostedConfig(env({ MOI_SESSION_KEY: `  ${SESSION_SECRET}\n` })).MOI_SESSION_KEY).toBe(SESSION_SECRET);
    // Trimming happens before the length check, so padding cannot make a short key pass.
    expect(() => loadHostedConfig(env({ MOI_SESSION_KEY: `   ${sentinel(42)}   ` }))).toThrow(/MOI_SESSION_KEY/);
  });

  it("leaves the shared config alone: stdio and the read gateway need no key", () => {
    expect(() => loadConfig(baseEnv())).not.toThrow();
    expect(Object.keys(loadConfig(baseEnv()))).not.toContain("MOI_SESSION_KEY");
  });
});

describe("loadHostedConfig: the faucet settings", () => {
  /** A MOI_DATA_DIR in a temp dir, because a successful load creates it. */
  const env = (over: Record<string, string> = {}) => hostedEnv(tempHome(), over);

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
