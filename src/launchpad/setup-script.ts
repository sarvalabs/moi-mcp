/**
 * What a Launchpad setup script does, told from the script itself, with its
 * secrets blanked. The script is a bash file the Launchpad generates per
 * agent (lib/setup-script.ts there): it embeds the agent's private key, so
 * the file itself is only ever handed to a browser through the one-time
 * download link. What the model gets is this description.
 */

const MAX_PREVIEW_LINES = 160;
const MAX_PREVIEW_BYTES = 12 * 1024;

/** Values that must not leave: the key field, and any long hex run. */
export function redactSetupScript(body: string): string {
  return body
    .replace(/("agentPrivateKey"\s*:\s*")[^"]*(")/g, "$1<redacted>$2")
    .replace(/("(?:groqKey|geminiKey|openaiKey)"\s*:\s*")[^"]+(")/g, "$1<redacted>$2")
    .replace(/\b(?:0x)?[0-9a-fA-F]{48,}\b/g, "<redacted>")
    .replace(/^(\s*(?:export\s+)?[A-Za-z_]*(?:KEY|SECRET|TOKEN|PRIVATE)[A-Za-z_]*=)(.*)$/gm, "$1<redacted>");
}

/** The steps the script takes, read off its own markers so drift shows. */
export function summarizeSetupScript(body: string): string[] {
  const steps: string[] = [];
  const dir = /AGENT_DIR="([^"]+)"/.exec(body)?.[1];
  if (dir) steps.push(`Installs into ${dir.replace(/\\\$/g, "$")} on the machine it runs on, readable only by that user.`);
  if (/command -v node/.test(body)) steps.push("Requires Node.js 18 or newer and stops if it is missing.");
  if (/read -r -s -p/.test(body)) {
    steps.push("Asks for an AI API key (Groq, Google AI or OpenAI) and keeps it in a local file for the next install; it is never sent to the Launchpad.");
  }
  if (/agent\.config\.json/.test(body)) {
    steps.push("Writes agent.config.json with the agent's address, template, settings, schedule, the relay URL and the agent's private key, file mode 600.");
  }
  if (/runtime\.cjs/.test(body)) steps.push("Downloads the single-file agent runtime from the Launchpad; no package registry is involved.");
  if (/pm2/.test(body)) {
    steps.push("Starts the agent under pm2, installing pm2 inside the agent folder if it is not already on the machine, so it keeps running after reboots.");
  }
  if (/private key/i.test(body)) steps.push("Tells the person to delete the script after install, since it contains the key.");
  if (steps.length === 0) steps.push("Its shape is not the Launchpad's usual setup script; read the preview.");
  return steps;
}

export interface SetupScriptDescription {
  summary: string[];
  /** The script with secrets blanked, cut to a readable length. */
  preview: string;
  previewTruncated: boolean;
}

export function describeSetupScript(body: string): SetupScriptDescription {
  const redacted = redactSetupScript(body);
  const lines = redacted.split("\n");
  let preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
  let truncated = lines.length > MAX_PREVIEW_LINES;
  if (preview.length > MAX_PREVIEW_BYTES) {
    preview = preview.slice(0, MAX_PREVIEW_BYTES);
    truncated = true;
  }
  return { summary: summarizeSetupScript(body), preview, previewTruncated: truncated };
}
