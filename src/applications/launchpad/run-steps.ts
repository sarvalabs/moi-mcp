/**
 * The steps that start a Launchpad agent, as text for the model to relay.
 *
 * Creating an agent and registering it on chain do not run it. An agent runs only once its setup script has been run on a
 * machine, and a model that was not told so said there was nothing left to do (docs/preview-test-findings.md, issue 5).
 * These strings are given after create, after register and in the setup-script result, in the same order every time:
 * an AI API key first, because the download link works once and its ten minutes start when the setup-script tool is
 * called; then Node.js; then the download and run; then deleting the script, which holds the agent's private key.
 *
 * Strings only. They are written as plain sentences with no quotes and no markup, because the create and register results
 * reach the model as JSON text, where a quote arrives escaped, and the command must be copyable as it stands. claude.ai gives
 * its model the text of a result and not the structured value, so the steps are in the text of every result that has them.
 *
 * src/instructions.ts carries the same steps as one sentence of its own, since that file may import nothing;
 * test/unit/instructions.test.ts checks that the two agree.
 */

export const GROQ_KEYS_URL = "https://console.groq.com/keys";
/** The name the steps give the downloaded file, so that the last step can name the exact file to delete. */
export const SETUP_FILE = "moi-agent-setup.sh";

/** Characters that need no quoting in a shell word. A link the connector builds (origin, path, base64url token) is all of them. */
const SAFE_IN_SHELL = /^[A-Za-z0-9._~:/-]+$/;

/**
 * The terminal command that downloads the script and runs it. curl -fL -o writes the body to the named file and ignores the
 * download route's Content-Disposition header; -f turns a spent or expired link (410) into a failure with nothing saved,
 * instead of an error page saved as the script. It is not piped into bash because the script asks for the AI API key at
 * the terminal. A link with a character the shell treats specially is wrapped in single quotes.
 */
export function downloadCommand(link: string): string {
  const word = SAFE_IN_SHELL.test(link) ? link : `'${link.replace(/'/g, `'\\''`)}'`;
  return `curl -fL -o ${SETUP_FILE} ${word} && bash ${SETUP_FILE}`;
}

const KEY_STEP =
  `1. Have an AI API key ready first. A Groq key is made at ${GROQ_KEYS_URL}, and a Google AI or OpenAI key works too. ` +
  "The setup script asks for the key in the terminal, so it never goes in this chat. This comes before step 3 because " +
  "the download link works once and expires after ten minutes.";

const NODE_STEP =
  "2. Check that Node.js 18 or newer is installed on the machine that will host the agent: have the person run " +
  "node --version there.";

const LINK_RULES =
  "The link works with curl because it needs no cookie or header, but it serves the script only once, so nothing else " +
  "may open it first, neither a browser tab nor curl -I. Do not pipe it into bash, because the script asks for the AI " +
  "API key at the terminal.";

const DELETE_STEP =
  `4. When the script has finished, delete it with rm ${SETUP_FILE}, because it holds the agent's private key.`;

/** The command is last in its step, with nothing after it, so a trailing full stop cannot be copied into the shell. */
function stepsWith(runStep: string): string {
  return [KEY_STEP, NODE_STEP, runStep, DELETE_STEP].join("\n");
}

/** Step 3 when the link does not exist yet: the model must call the setup-script tool to get one. */
function callSetupTool(agentId: string): string {
  return (
    `3. Call moi_launchpad_setup_script with agentId ${agentId}. Its result has the download link. ${LINK_RULES} ` +
    `The person runs this on the host machine, with the link from that result in place of LINK: ${downloadCommand("LINK")}`
  );
}

/** What the create result says: registering is next and is not the end. */
export function afterCreate(agentId: string): string {
  return (
    "Registering does not start the agent: it runs only once its setup script has been run on a machine. Tell the person " +
    "this now, and once the agent is registered walk them through these steps in this order.\n" +
    stepsWith(callSetupTool(agentId))
  );
}

/** What the register result says, only once the Launchpad has recorded the registration: until then the agent is still pending. */
export function afterRegister(agentId: string): string {
  return (
    "The agent is registered but it is not running yet. It runs only once its setup script has been run on a machine. " +
    "Walk the person through these steps in this order.\n" +
    stepsWith(callSetupTool(agentId))
  );
}

/**
 * What the setup-script tool's description says to do before calling it, so that the key and Node.js are ready before the ten
 * minutes start. It sits here with the steps it summarises; the tool's own result gives the full steps (forSetupScript).
 */
export const BEFORE_SETUP_SCRIPT =
  `Before calling this, have an AI API key ready (a Groq key from ${GROQ_KEYS_URL}, or a Google AI or OpenAI key) and Node.js 18 or ` +
  "newer on the machine that will host the agent, because the ten minutes start at the call. The result gives the curl and bash " +
  "command that fetches and runs the script, and says to delete the script afterwards.";

/** What the setup-script result says, with the real link in the command. */
export function forSetupScript(downloadUrl: string): string {
  return (
    "The agent runs only once this script has been run on a machine. Walk the person through these steps in this order. " +
    "The ten minutes started when this tool was called, so if step 1 or step 2 is not done yet, do them first and call " +
    "this tool again for a fresh link when they are.\n" +
    stepsWith(
      "3. Have the person run this on the host machine now. " +
        `${LINK_RULES} If the person opens the link in a browser instead, the script is saved under a name the Launchpad ` +
        "chooses; they run that file with bash and delete that file in step 4. " +
        `The command: ${downloadCommand(downloadUrl)}`,
    )
  );
}
