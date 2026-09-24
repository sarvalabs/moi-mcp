import { describe, expect, it } from "vitest";

import { describeSetupScript, redactSetupScript } from "../../src/launchpad/setup-script.js";

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
#  NOTE: this file contains the agent's private key — delete it after install.
AGENT_DIR="\\$HOME/.moi-agent/rain-check-abc12345"
if ! command -v node >/dev/null 2>&1; then exit 1; fi
read -r -s -p "  Paste your key: " BYOKEY || BYOKEY=""
cat > "\\$AGENT_DIR/agent.config.json" <<'JSON'
{
  "agentAddress": "0x000000002497e599b212a83896919005863b05511d46d0a32ad0af8600000000",
  "agentPrivateKey": "${KEY}",
  "ownerAddress": "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000",
  "relayUrl": "https://launchpad.moi.technology",
  "groqKey": "gsk_live_abc",
  "geminiKey": ""
}
JSON
curl -fsSL "https://launchpad.moi.technology/runtime.cjs" -o "\\$AGENT_DIR/runtime.cjs"
if ! command -v pm2 >/dev/null 2>&1; then ( cd "\\$AGENT_DIR" && npm install pm2 ); fi
"\\$PM2" start "\\$AGENT_DIR/runtime.cjs" --name "moi-rain-check-abc12345"
`;

describe("setup script description", () => {
  it("blanks the key and any pasted API key, and keeps the addresses", () => {
    const out = redactSetupScript(SCRIPT);
    expect(out).not.toContain(KEY);
    expect(out).toContain('"agentPrivateKey": "<redacted>"');
    expect(out).toContain('"groqKey": "<redacted>"');
    expect(out).toContain('"geminiKey": ""');
    // Addresses are 64 hex plus the 0x prefix, and are not secret; but the
    // rule is by length, so they go too. The summary names them instead.
    expect(out).not.toContain("a27d9a3e793f6b548f7553dd4a0ea528");
  });

  it("reads the steps off the script's own markers", () => {
    const { summary, preview, previewTruncated } = describeSetupScript(SCRIPT);
    expect(summary.join("\n")).toMatch(/Installs into \$HOME\/\.moi-agent\/rain-check-abc12345/);
    expect(summary.join("\n")).toMatch(/Node\.js 18/);
    expect(summary.join("\n")).toMatch(/Asks for an AI API key/);
    expect(summary.join("\n")).toMatch(/agent\.config\.json .* private key/);
    expect(summary.join("\n")).toMatch(/Downloads the single-file agent runtime/);
    expect(summary.join("\n")).toMatch(/pm2/);
    expect(summary.join("\n")).toMatch(/delete the script/);
    expect(preview).not.toContain(KEY);
    expect(previewTruncated).toBe(false);
  });

  it("marks an unfamiliar script as such and cuts a long preview", () => {
    const long = Array.from({ length: 400 }, (_, i) => `echo line ${i}`).join("\n");
    const { summary, previewTruncated } = describeSetupScript(long);
    expect(summary).toEqual(["Its shape is not the Launchpad's usual setup script; read the preview."]);
    expect(previewTruncated).toBe(true);
  });
});
