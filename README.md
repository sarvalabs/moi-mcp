# MOI MCP server

An MCP server for the MOI blockchain. MCP (Model Context Protocol) is the standard that lets a chat assistant such as Claude call typed tools; this server exposes MOI reads and writes as those tools, the chat proposes each action, your phone approves it, and the server holds no private keys. It runs two ways: as a hosted connector you add to claude.ai by URL, and as a local server that talks to the MCP client over standard input and output (stdio), for desktop MCP clients such as Claude Desktop (`src/server.ts` and `src/index.ts`).

MOI uses its own words. An interaction is a transaction. A tesseract is a block. A logic is a smart contract, written in Cocolang. Fuel is the fee an interaction pays. A participant is an account whose state an interaction may touch.

## Use it from claude.ai

1. In claude.ai, open Settings, then Connectors, and add a custom connector with the server URL. A custom connector is a third party MCP server that claude.ai talks to over HTTP. Use the URL the operator gives you (the server is moving to a permanent domain, so the URL is a placeholder here).
2. Sign in on the consent page the connector opens. The server runs its own OAuth 2.1 flow (`src/auth/`). OAuth is the protocol claude.ai uses to get a token that proves it acts for you. There are no accounts and no passwords; your identity is a browser cookie named `moi_uid` (`src/auth/routes.ts:22`).
3. In a chat, ask Claude to connect your wallet. Claude calls `moi_connect_wallet`, and the tool returns a QR code image in the chat (`src/server.ts:198`).
4. Scan the QR code with the MOI Wallet app on your phone and approve the pairing there. The pairing uses WalletConnect v2, a protocol that links a phone wallet to another program through a relay server, so the two never need a direct connection. The QR code expires in about 5 minutes; if it does, call `moi_connect_wallet` again. By default the pairing lasts a week (`src/server.ts`).
5. Chat. Reads work immediately. Balances, assets, interactions, logics, and the agent registry all come straight from the chain.

Every write is two tool calls (`src/tools/hosted-writes.ts`). On the first call Claude shows you a preview: one sentence, the exact values the wallet will display, the fuel, and a confirm token that is bound to you, the tool, and the arguments, works once, and lives ten minutes (`src/tools/preview.ts:28`). When you say yes, Claude makes the second call with the token, your phone shows the request, and nothing is sent until you tap Approve there.

If a write fails with "The wallet pairing has expired", call `moi_connect_wallet` and pair again (`src/tools/hosted-writes.ts:125`).

## Run it locally

The local stdio server runs as a child process of your MCP client and registers all 13 tools (`src/index.ts`).

You need Node.js 20 or later (`package.json` engines) and the MOI Wallet app on your phone for writes. Reads work without the wallet. The default network, `voyage`, is MOI's devnet, a test network where currency has no real value; KMOI there is test currency, claimable from the [Voyage faucet](https://voyage.moi.technology/faucet/).

Add this to your MCP client config. For Claude Desktop the file is `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`, Linux: `~/.config/Claude/`). If the file already has an `mcpServers` block, add `"moi"` as a new key inside it.

```json
{
  "mcpServers": {
    "moi": {
      "command": "npx",
      "args": ["-y", "@moi-protocol/mcp-server"],
      "env": { "MOI_NETWORK": "voyage", "WC_PROJECT_ID": "REPLACE_WITH_YOUR_PROJECT_ID" }
    }
  }
}
```

`WC_PROJECT_ID` is a WalletConnect project id. Get a free one at [cloud.reown.com](https://cloud.reown.com); it is a public identifier, and the server rejects placeholder values (`src/config.ts`). Ready made configs for Claude Desktop, Cursor, and OpenClaw live in [`examples/`](./examples).

Restart the client completely, then pair once from the terminal:

```bash
npx -y -p @moi-protocol/mcp-server moi-mcp pair
```

The command prints a QR code in the terminal; scan it with MOI Wallet. This command shows the session afterwards:

```bash
npx -y -p @moi-protocol/mcp-server moi-mcp status
```

Environment variables, validated by `src/config.ts` against the schema at `src/schema.ts:465`:

| Variable | Default | Notes |
|---|---|---|
| `MOI_NETWORK` | `voyage` | `voyage`, `mainnet`, or `custom` |
| `MOI_RPC_URL` | none | Required when `MOI_NETWORK=custom` |
| `WC_PROJECT_ID` | none | Required for the stdio server; Reown ids are 32 hex characters, and the server warns on other shapes and rejects placeholders (`src/config.ts:36`) |
| `MOI_MCP_HOME` | `~/.moi-mcp` | Session and WalletConnect keystore, created `0700` |
| `MOI_EXPLORER_URL` | `https://voyage.moi.technology` | Builds explorer links in write results |
| `REQUEST_TIMEOUT_MS` | `55000` | How long to wait for the phone tap; keep it under the MCP client's own 60s timeout |
| `LOG_LEVEL` | `error` | `silent`, `error`, `info`, `debug`; all logs go to stderr |

The server also loads a `.env` from its working directory; see `.env.example`. Three more variables are read where they are used: `MOI_AGENT_REGISTRY_LOGIC_ID` (registry override), `MOI_READ_CALLER` (caller identity for read only logic simulation), and `MOI_WC_PARAM_STYLE` (set to `ix_args` to switch the WalletConnect parameter encoding; the default is positional, `src/wc/client.ts:41`).

A read only HTTP gateway also exists (`src/http.ts`). It registers `ping` and the five read tools, holds no wallet code, and needs no `WC_PROJECT_ID`:

```bash
PORT=8787 npx -y -p @moi-protocol/mcp-server moi-mcp-http
```

```bash
curl localhost:8787/health
```

```json
{"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}
```

A 503 response with `ok: false` means the config failed to load (`src/http.ts:128`).

If pairing fails with "The WalletConnect relay refused the pairing", the `WC_PROJECT_ID` is almost always invalid. If a write fails with `NETWORK_MISMATCH` ("Wallet is on \<caip2\>, expected \<network\>"), your wallet and `MOI_NETWORK` disagree; switch networks in MOI Wallet or change the variable.

## Tools

The hosted server and the local stdio server each list 13 tools. Reads are defined in `src/tools/reads.ts`, the wallet surface in `src/server.ts` (hosted) and `src/tools/wallet.ts` (stdio), and writes in `src/tools/hosted-writes.ts` (hosted) and `src/tools/writes.ts` (stdio).

| Tool | Phone approval | What it does |
|---|---|---|
| `ping` | no | Health check: server version, network, config status |
| `moi_get_account` | no | The account's nonce (the count of interactions the account has sent), whether it is registered on chain, and its balance in every asset |
| `moi_get_asset` | no | Asset symbol, standard, supply, decimals, dimension (0 Economic, 1 Possession), owner |
| `moi_get_interaction` | no | Interaction status, sender, operations, and fuel used, by hash |
| `moi_get_logic` | no | A deployed logic's callable routines with input and output types |
| `moi_resolve_agent` | no | Look up an AI agent in the on chain registry by handle, name, or address |
| `moi_list_agents` | no | Page through the on chain registry: every agent, or those one account registered |
| `moi_connect_wallet` | pairing tap | Returns a QR code to pair MOI Wallet over WalletConnect |
| `moi_wallet_status` | no | Whether a wallet is paired, and which account |
| `moi_disconnect_wallet` | no | Forget the pairing |
| `moi_transfer` | yes | Propose an asset transfer; balance checked first |
| `moi_create_asset` | yes | Propose a new asset; funds its storage and previews the amount |
| `moi_mint` | yes | Propose minting more of an asset the paired wallet manages |
| `moi_call_logic` | view: no, invoke: yes | Call a logic routine; `view` reads, `invoke` changes state |
| `moi_create_account` | yes | Register and fund a brand-new account from the paired wallet |
| `moi_launchpad_templates` | no | The MOI Agent Launchpad's templates and the config each needs (hosted server) |
| `moi_launchpad_sign_in` | message tap | Sign in to the Launchpad as the paired wallet; the session lasts a week |
| `moi_launchpad_status` | no | Launchpad session, Telegram link state, and the wallet's agents there |
| `moi_launchpad_create_agent` | no | Create an agent from a template; it runs once registered |
| `moi_launchpad_register_agent` | yes | Register the agent in the on chain registry and tell the Launchpad |
| `moi_launchpad_telegram_link` | no | The bot link that connects Telegram to the Launchpad account |
| `moi_launchpad_setup_script` | no | A one-time download link for the agent's setup script; the key never enters the chat |
| `moi_launchpad_sign_out` | no | Forget the Launchpad session |

Two MCP resources are also exposed: `moi://networks` and `moi://docs/quickstart` (`src/resources/`).

On `moi_create_asset`: a new MOI asset must hold KMOI to pay for its own storage, so the tool bundles the creation with a KMOI transfer to the asset's own account. The `storageFund` argument is optional; omitted, the server sizes it from your balance. See `docs/upstream-issues.md` on where that deposit sits.

## Security model

- The server never generates, stores, or accepts a private key or mnemonic; the only `Signer` class in the codebase throws when asked to sign.
- Your phone approves every write. The wallet signs (`moi.signInteraction`) and the server broadcasts the signed interaction to the node, because the wallet's combined sign and send call crashes the wallet (`docs/upstream-issues.md`).
- OAuth access tokens are stored as SHA-256 hashes, never in plain text (`src/auth/index.ts:71`).
- The confirm token binds the preview you read to the write that is sent: same user, same tool, same arguments, ten minutes, one use (`src/tools/preview.ts`).
- Wallet pairings expire: after a week by default, or after one approved transaction or 15 minutes with `remember: false` (`src/server.ts`).
- Every hosted response carries security headers (`src/security-headers.ts`), and the MCP endpoint and every auth endpoint are rate limited (`src/server.ts:436`, `src/auth/rate-limit.ts`).

Every write is also simulated against the node first and refused locally if it would fail, so nothing that would burn fuel for nothing reaches your phone. Writes are recorded through proposed, signed, broadcast, and confirmed states in a journal (`src/journal.ts`).

## Documentation

- [docs/OVERVIEW.md](./docs/OVERVIEW.md): the whole picture in one document; read this first
- [docs/how-it-works.md](./docs/how-it-works.md): the full explanation from zero, every piece and every step
- [docs/handoff-infra.md](./docs/handoff-infra.md): deploying and operating the hosted server
- [docs/reviewer-guide.md](./docs/reviewer-guide.md): the code review guide
- [docs/quickstart.md](./docs/quickstart.md): the shortest path to a first read and a first write with the local server
- [docs/findings.md](./docs/findings.md): what building the server turned up about MOI's integration surface
- [docs/deploy-voyage.md](./docs/deploy-voyage.md): deployment against the voyage devnet
- [docs/upstream-issues.md](./docs/upstream-issues.md): known gaps in the wallet and SDK, with evidence

## Development

```bash
git clone https://github.com/sarvalabs-adithya/moi-mcp
```

```bash
cd moi-mcp
```

```bash
npm ci
```

```bash
npm test
```

`npm test` runs the hermetic suite with vitest. Hermetic means the tests touch no network and no real wallet: real tool handlers run over an in-memory MCP transport against a fake node and a fake wallet (`package.json` scripts, `docs/testing-plan.md`).

```bash
npm run typecheck
```

```bash
npm run build
```

`npm run test:e2e` runs live reads against the voyage devnet, `npm run inspect` opens the MCP Inspector against the local source, and `npm run pair` and `npm run status` manage the local wallet session from a clone.

## License

MIT