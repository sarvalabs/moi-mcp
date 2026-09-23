/**
 * MCP resources: reference material an agent can read without a tool call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NETWORKS } from "../moi/provider.js";
import { DEFAULT_REGISTRY_LOGIC_ID, registryLogicId } from "../moi/registry.js";

const QUICKSTART = `# MOI MCP — quickstart

Give your agent a MOI wallet. The server never holds a private key: it reads
chain state directly, and every state change is signed on your phone in MOI
Wallet over WalletConnect.

## 1. Configure

\`\`\`json
{ "mcpServers": { "moi": { "command": "npx", "args": ["-y", "@moi-protocol/mcp-server"],
  "env": { "MOI_NETWORK": "voyage", "WC_PROJECT_ID": "<from cloud.reown.com>" } } } }
\`\`\`

## 2. Read without pairing

Reads need no wallet. Ask your agent:

- "what's in MOI account 0x…" → \`moi_get_account\`
- "what asset is 0x…" → \`moi_get_asset\`
- "did interaction 0x… land" → \`moi_get_interaction\`
- "what routines does logic 0x… expose" → \`moi_get_logic\`
- "find the agent called pricefeed-01" → \`moi_resolve_agent\`
- "which agents has 0x… registered" → \`moi_list_agents\`

## 3. Pair, then write

\`moi_connect_wallet\` returns a QR code. Scan it with MOI Wallet on your phone.
Then \`moi_transfer\`, \`moi_create_asset\` and \`moi_call_logic\` build an
interaction here and send it to your phone for approval. Nothing moves until
you tap Send.

## Vocabulary

MOI uses its own terms. Interaction = transaction. Tesseract = block.
Logic = smart contract (written in Cocolang). Fuel = gas. Participant = an
account whose state an interaction may touch — it must be declared up front.
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "networks",
    "moi://networks",
    {
      title: "MOI networks",
      description:
        "The MOI networks this server can reach, with RPC endpoint, explorer, and the CAIP-2 " +
        "chain id used for WalletConnect pairing.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              networks: Object.values(NETWORKS),
              agentRegistry: {
                logicId: registryLogicId(),
                isDefault: registryLogicId() === DEFAULT_REGISTRY_LOGIC_ID,
                overrideWith: "MOI_AGENT_REGISTRY_LOGIC_ID",
              },
              notes: [
                "mainnet has no published RPC URL or CAIP-2 id; use MOI_NETWORK=custom with MOI_RPC_URL.",
                "Amounts are decimal strings scaled by the asset's decimals.",
                "An interaction may carry at most 3 operations.",
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "quickstart",
    "moi://docs/quickstart",
    {
      title: "MOI MCP quickstart",
      description: "How to pair a wallet and what each MOI tool is for.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: QUICKSTART }],
    }),
  );
}
