/**
 * What each server tells its client's model at initialize: the `instructions` option of the MCP server.
 *
 * The tool descriptions carry the detail of each tool. These texts carry what is true of the whole server, so a model
 * has the rules before it picks a tool and without having to read a resource: the read gateway only reads, a write is
 * two calls and nothing happens until the person approves on the phone, amounts have units, and the hosted server has a
 * Connect step. They are short on purpose (test/unit/instructions.test.ts holds each under 1,500 characters, and the
 * hosted one under 2,400 because it also carries the Launchpad's steps), plain sentences with no markdown, and they must
 * not say anything a tool description contradicts. A tool is named here only if every server using the text lists it;
 * the same test checks that against the pinned tool lists.
 *
 * Strings only, and no imports: the read gateway (src/http.ts) must not reach wallet or write code, and this is the one
 * file it shares with the signing servers.
 */

const VOCABULARY =
  "MOI uses its own words: an interaction is a transaction, a tesseract is a block, a logic is a smart contract and " +
  "a participant is an account.";

const WRITE_RULES =
  "Every write that sends a transaction is two calls. The first, without confirm, sends nothing and returns a preview " +
  "and a token: show the person its summary and values and get an explicit yes. The second, with the same arguments " +
  "plus confirm, asks the person's phone, and nothing happens until they approve in MOI Wallet. A write that would " +
  "fail is refused before the phone is asked. Balances and the amounts an asset routine takes are in the asset's base " +
  "units; moi_transfer and moi_mint take whole tokens, which the server scales by the asset's decimals, so read the " +
  "asset's decimals with moi_get_asset first. Before acting on an asset, list its routines with moi_asset_routines.";

const SIGN_IN =
  "Anything that uses the person's wallet needs a one-time sign-in to this connector, and the first such call shows " +
  "a Connect button in the chat. Before making that call, tell the person in one or two sentences what it is: " +
  "pressing Connect opens a MOI page in their browser where they approve linking this chat to the MOI Wallet they pair " +
  "on their phone next. It creates no account, no key ever leaves the phone, and every transaction still needs their tap " +
  "in MOI Wallet. The moi_get_ tools need no sign-in.";

/**
 * The steps that start a Launchpad agent, in one sentence. The same four steps, in the same order, are in
 * src/applications/launchpad/run-steps.ts, which this file cannot import; test/unit/instructions.test.ts checks that the
 * two agree. Hosted only: the other servers have no Launchpad tools.
 */
const LAUNCHPAD_STEPS =
  "An agent made on the MOI Agent Launchpad runs only once its setup script has been run on a machine, which creating " +
  "and registering it do not do, so once the agent is registered walk the person through four steps in this order: " +
  "first have an AI API key ready (a Groq key from https://console.groq.com/keys, or a Google AI or OpenAI key), " +
  "because the download link works once and expires after ten minutes; then check that Node.js 18 or newer is " +
  "installed on the machine that will host the agent; then call moi_launchpad_setup_script, have the person download " +
  "the script with curl -fL -o, which works because the link needs no cookie, and run it with bash; then have them " +
  "delete the script, because it holds the agent's private key.";

export const GATEWAY_INSTRUCTIONS =
  "This is a read gateway: it only reads. It has no wallet and cannot write, sign or send anything. The moi_rpc_ " +
  "tools are the node's own methods, one tool per method, and return raw node answers. The moi_get_ tools, with " +
  "moi_asset_routines, moi_resolve_agent and moi_list_agents, combine several node calls into one useful answer; " +
  "they are what a person normally wants, so start with them and use a moi_rpc_ tool only for what they do not show. " +
  "History covers only recent heights: moi_get_history reads an account's newest few heights, newest first, and older " +
  "history is not available.";

export const STDIO_INSTRUCTIONS = VOCABULARY + " " + WRITE_RULES;

export const HOSTED_INSTRUCTIONS =
  "The person's wallet is their identity; there is no MOI account to sign up for. " +
  SIGN_IN + " " + VOCABULARY + " " + WRITE_RULES + " " + LAUNCHPAD_STEPS;
