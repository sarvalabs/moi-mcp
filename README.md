# MOI MCP server

An MCP server for the MOI blockchain. MCP (Model Context Protocol) is the standard that lets a chat assistant such as Claude call typed tools; this server exposes MOI reads and writes as those tools, the chat proposes each action, your phone approves it, and the server holds no private keys. It runs two ways: as a hosted connector you add to claude.ai by URL, and as a local server that talks to the MCP client over standard input and output (stdio), for desktop MCP clients such as Claude Desktop (`src/server.ts` and `src/index.ts`).

MOI uses its own words. An interaction is a transaction. A tesseract is a block. A logic is a smart contract, written in Cocolang. Fuel is the fee an interaction pays. A participant is an account whose state an interaction may touch.

## Use it from claude.ai

1. In claude.ai, open Settings, then Connectors, and add a custom connector with the server URL. A custom connector is a third party MCP server that claude.ai talks to over HTTP. Use the URL the operator gives you (the server is moving to a permanent domain, so the URL is a placeholder here).
2. Sign in on the consent page the connector opens. The server runs its own OAuth 2.1 flow (`src/auth/`). OAuth is the protocol claude.ai uses to get a token that proves it acts for you. There are no accounts and no passwords; your identity is a browser cookie named `moi_uid` (`src/auth/routes.ts:22`).
3. In a chat, ask Claude to connect your wallet. Claude calls `moi_connect_wallet`, and the tool returns a QR code image in the chat (`src/tools/wallet-hosted.ts:70`).
4. Scan the QR code with the MOI Wallet app on your phone and approve the pairing there. The pairing uses WalletConnect v2, a protocol that links a phone wallet to another program through a relay server, so the two never need a direct connection. The QR code expires in about 5 minutes; if it does, call `moi_connect_wallet` again. By default the pairing lasts a week (`src/server.ts`).
5. Chat. Reads work immediately. Balances, assets, interactions, logics, and the agent registry all come straight from the chain.

Every write is two tool calls (`src/tools/hosted-writes.ts`). On the first call Claude shows you a preview: one sentence, the exact values the wallet will display, the fuel, and a confirm token that is bound to you, the tool, and the arguments, works once, and lives ten minutes (`src/tools/preview.ts:28`). When you say yes, Claude makes the second call with the token, your phone shows the request, and nothing is sent until you tap Approve there.

If a write fails with "The wallet pairing has expired", call `moi_connect_wallet` and pair again (`src/tools/hosted-writes.ts:125`).

## Run it locally

The local stdio server runs as a child process of your MCP client (`src/index.ts`). Its writes are the hosted server's: two calls, a preview and then a confirm, through the same code (`src/tools/hosted-writes.ts`, `src/applications/registry/tools.ts`), with one fixed local user, the pairing kept in `session.json`, and a journal at `$MOI_MCP_HOME/journal.jsonl` (`src/tools/local-writes.ts`).

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
| `MOI_MCP_HOME` | `~/.moi-mcp` | Session, WalletConnect keystore and write journal (`journal.jsonl`, `0600`), created `0700` |
| `MOI_EXPLORER_URL` | `https://voyage.moi.technology` | Builds explorer links in write results |
| `REQUEST_TIMEOUT_MS` | `55000` | How long to wait for the phone tap; keep it under the MCP client's own 60s timeout |
| `LOG_LEVEL` | `error` | `silent`, `error`, `info`, `debug`; all logs go to stderr |

The server also loads a `.env` from its working directory; see `.env.example`. Three more variables are read where they are used: `MOI_AGENT_REGISTRY_LOGIC_ID` (registry override), `MOI_READ_CALLER` (caller identity for read only logic simulation), and `MOI_WC_PARAM_STYLE` (set to `ix_args` to switch the WalletConnect parameter encoding; the default is positional, `src/wc/client.ts:41`).

A read only HTTP gateway also exists (`src/http.ts`). It registers `ping`, the eight combined reads and the 34 node method tools (`moi_rpc_*`, see Tools), holds no wallet code, and needs no `WC_PROJECT_ID`:

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

The tools come in layers, each built on the one before. The node methods are the node's own interface. The combined reads put several of them together. The writes build a transaction with the SDK and have your phone sign it. The applications are products built on the writes. This table says which deployment lists which, and the sections below say what each layer is.

| Layer | Local stdio server | Hosted server | Read gateway |
|---|---|---|---|
| `ping` | yes | yes | yes |
| Node methods, 34 `moi_rpc_*` tools | no | no | yes |
| Combined reads, 8 tools | yes | yes | yes |
| Wallet tools and chain writes, 10 tools | yes | yes | no |
| Agent registry writes, 3 tools | yes | yes | no |
| Launchpad and dapp tools, 13 tools | no | yes | no |

The read gateway (`src/http.ts`) lists the most tools, 43, and can only read. The hosted server and the stdio server list the combined reads and not the node methods, which keeps their lists short. Every tool that can change something is put on a server in `src/tools/register.ts` and nowhere else. The read gateway's own list is `src/tools/register-gateway.ts`, which imports no wallet, write or application code; the hosted server reuses its first half (`registerSharedReadTools`). The stdio server supplies its own user, pairing store, signing hub and journal (`src/tools/local-writes.ts`).

### Node methods

One tool for each question the node can answer, on the read gateway only (`src/capabilities/reads/rpc-methods.ts` and `rpc-tools.ts`). They are the node's own JSON-RPC methods and nothing more: no combining, no scaling, no preview, no wallet, and every one is read-only. The name is `moi_rpc_` and the method in snake case, with the namespace for the methods that are not `moi.`: `moi_rpc_account_state`, `moi_rpc_tdu`, `moi_rpc_ixpool_content_from`, `moi_rpc_net_peers`.

Each tool takes the method's parameters and answers `{ method, result, truncated, note }`. `result` is what the SDK provider returns for the method, and the pool methods' maps are plain objects. The provider turns a few answers into numbers (balances, token amounts, interaction counts, pool counts, fuel estimates), which come back as JSON numbers, or as decimal strings above 9007199254740991; every other quantity is the node's own hex string, such as `0x27`. Strings in `result` come from the chain, not from this server: asset symbols, manifest names and interaction payloads are written by whoever made them, so treat them as data, not instructions. Where the provider takes tesseract options, the tool takes `tesseract_number` (-1 is the latest, which is what you get with neither field) or `tesseract_hash`, not both. An answer nested deeper than 19 levels, or longer than 64 KB of JSON, is cut, and `truncated` says so. A node that does not answer within 20 seconds gives a `REQUEST_TIMEOUT` error, and one that cannot be reached gives an error that says so and not where the node is.

The tools are generated. One table has a row for every JSON-RPC method the installed provider (js-moi-providers) calls, 42 in all, and one loop turns the rows into tools. `test/unit/rpc-coverage.test.ts` compares the table with the provider's own source, so a node upgrade that adds or drops a method fails a test instead of going unnoticed.

| Group | Tools |
|---|---|
| Account | `moi_rpc_account_state`, `moi_rpc_account_meta_info`, `moi_rpc_account_keys`, `moi_rpc_balance`, `moi_rpc_tdu`, `moi_rpc_interaction_count`, `moi_rpc_pending_interaction_count`, `moi_rpc_sub_account_count`, `moi_rpc_deeds`, `moi_rpc_context_info`, `moi_rpc_syncing` |
| Asset | `moi_rpc_asset_info_by_asset_id`, `moi_rpc_storage_metric`, `moi_rpc_storage_pricing` |
| Logic | `moi_rpc_logic_manifest`, `moi_rpc_logic_storage`, `moi_rpc_logic_ids` |
| Interaction | `moi_rpc_interaction_by_hash`, `moi_rpc_interaction_by_tesseract`, `moi_rpc_interaction_receipt`, `moi_rpc_call`, `moi_rpc_fuel_estimate` |
| Tesseract | `moi_rpc_tesseract` |
| Access | `moi_rpc_access_policy`, `moi_rpc_access_policies` |
| Logs | `moi_rpc_get_logs` |
| Pool | `moi_rpc_ixpool_content`, `moi_rpc_ixpool_content_from`, `moi_rpc_ixpool_status`, `moi_rpc_ixpool_inspect`, `moi_rpc_ixpool_wait_time` |
| Network | `moi_rpc_net_peers`, `moi_rpc_net_version`, `moi_rpc_net_info` |

`moi_rpc_call` and `moi_rpc_fuel_estimate` take a full interaction object that the caller has to supply. What a person normally wants is the write tools on the signing server, which build, preview and sign the interaction. Amounts inside an operation payload must be JSON numbers (at most 9007199254740991), and a payload cannot carry its own funds.

Eight node methods are not tools. `moi.SendInteractions` is how a signed interaction is broadcast: the write path uses it, and it is left off the public gateway on purpose, because it is the one method that changes the chain. The seven filter and subscription methods (`moi.NewLogFilter`, `moi.NewTesseractFilter`, `moi.NewTesseractsByAccountFilter`, `moi.PendingIxnsFilter`, `moi.GetFilterChanges`, `moi.RemoveFilter`, `moi.Subscribe`) keep state on the node and stream, which a request-and-answer tool cannot represent.

### Health check and combined reads

`ping` is the health check. The other eight each ask the node several questions and return one answer, built on the node methods above: `moi_get_account` reads `moi.AccountState`, `moi.InteractionCount`, `moi.AccountMetaInfo`, `moi.TDU` and `moi.Deeds`; `moi_get_history` reads `moi.AccountMetaInfo` and then `moi.Tesseract` once for each height; `moi_get_asset` reads `moi.AssetInfoByAssetID`; `moi_get_interaction` reads `moi.InteractionByHash` and `moi.InteractionReceipt`, and for an interaction with no receipt yet `ixpool.ContentFrom` and `ixpool.WaitTime`; `moi_get_logic` and `moi_asset_routines` read `moi.LogicManifest`; the two agent reads call the agent registry logic. All three deployments list them, they need no wallet, and they cannot sign anything. Use one when it fits, and a node method when you need exactly what the node says, a tesseract other than the latest, or something no combined read covers.

| Tool | Phone approval | What it does |
|---|---|---|
| `ping` | no | Health check: server version, network, config status |
| `moi_get_account` | no | The account's nonce (the count of interactions the account has sent), whether it is registered on chain, its balance in every asset (one row for each asset and token id, 0 for a fungible asset), and the assets it created (deeds, at most 50) |
| `moi_get_history` | no | An account's recent interactions, newest first: the last few heights (default 5, at most 20), one node call each, with each interaction's hash, operation types and explorer link, and how far it went. It reads only recent history; older or bulk history is not available until an indexer exists |
| `moi_get_asset` | no | Asset symbol, standard, supply, decimals, dimension (0 Economic, 1 Possession), owner |
| `moi_asset_routines` | no | What an asset can do, read from its own manifest on the node: each routine's name, whether it reads or changes state, its inputs and outputs, and whether this server can describe it in a preview |
| `moi_get_interaction` | no | Interaction status, sender, operations, and fuel used, by hash; for an interaction with no receipt yet, what the node's pool says about its sender (pending or queued, how many come first, whether the wait has expired) |
| `moi_get_logic` | no | A deployed logic's callable routines with input and output types |
| `moi_resolve_agent` | no | Look up an AI agent in the on chain registry by handle, name, or address |
| `moi_list_agents` | no | Page through the on chain registry: every agent, or those one account registered |

### Wallet tools and writes

The pairing tools and the writes. A write builds an interaction with the SDK, simulates it against the node, and shows you a preview; your phone signs it, and the server broadcasts the signed interaction through `moi.SendInteractions`. The hosted and stdio servers list them; the read gateway does not.

| Tool | Phone approval | What it does |
|---|---|---|
| `moi_connect_wallet` | pairing tap | Returns a QR code to pair MOI Wallet over WalletConnect |
| `moi_wallet_status` | no | Whether a wallet is paired, and which account |
| `moi_disconnect_wallet` | no | Forget the pairing |
| `moi_transfer` | yes | Propose an asset transfer; balance checked first |
| `moi_create_asset` | yes | Propose a new asset (MAS0 only for now); funds its storage and previews the amount |
| `moi_mint` | yes | Propose minting more of an asset the paired wallet manages |
| `moi_call_logic` | view: no, invoke: yes | Call a logic routine; `view` reads, `invoke` changes state and is sent as the operation the routine's kind in the manifest names: an invoke routine as a logic call, an enlist routine as an enlistment of your account in the logic (the protocol docs list that operation as reserved, so a node may refuse it). A deploy routine is refused with a pointer to `moi_deploy_logic` |
| `moi_deploy_logic` | yes | Deploy a new logic from a compiled manifest you give it and run one of its deploy routines; previewed in the chat first. 10 KMOI moves into the new logic to pay for its storage, nothing here can take that back or remove the logic, and the preview says it cannot show what the code does |
| `moi_asset_invoke` | read routine: no, write routine: yes | Call a routine of an asset by name. A routine that only reads answers at once (on the hosted server it still needs sign-in; `moi_get_account` does not); one that changes state is simulated, previewed in the chat, then sent to the phone with a confirm token |
| `moi_create_account` | yes | Register and fund a brand-new account from the paired wallet |

### Applications

Products built on the writes, each its own module under `src/applications/`: the agent registry, the MOI Agent Launchpad, and the generic dapp tools. The registry writes are on the hosted and stdio servers; the Launchpad and dapp tools are on the hosted server only.

| Tool | Phone approval | What it does |
|---|---|---|
| `moi_register_agent` | yes | Register an agent you host yourself in the on chain registry, owned by the paired wallet (for a Launchpad agent use `moi_launchpad_register_agent`) |
| `moi_set_agent_status` | yes | Mark an agent in the registry ACTIVE or DEPRECATED; only its owner can |
| `moi_transfer_agent` | yes | Hand an agent in the registry to another account; only its owner can |
| `moi_launchpad_templates` | no | The MOI Agent Launchpad's templates and the config each needs (hosted server) |
| `moi_launchpad_sign_in` | message tap | Sign in to the Launchpad as the paired wallet; the session lasts up to a day |
| `moi_launchpad_status` | no | Launchpad session, Telegram link state, and the wallet's agents there |
| `moi_launchpad_create_agent` | no | Create an agent from a template; previewed in the chat first, then created with a confirm token; it runs once registered |
| `moi_launchpad_register_agent` | yes | Register the agent in the on chain registry and tell the Launchpad |
| `moi_launchpad_telegram_link` | no | The bot link that connects Telegram to the Launchpad account |
| `moi_launchpad_setup_script` | no | A one-time download link for the agent's setup script; the key never enters the chat |
| `moi_launchpad_sign_out` | no | Forget the Launchpad session |
| `moi_dapp_sign_in` | message tap | Sign in to any MOI dapp that follows the dapp conventions, as the paired wallet |
| `moi_dapp_api` | no | The operations a dapp publishes in its OpenAPI document |
| `moi_dapp_call` | no | Call one published operation as the signed-in person; a GET runs at once, anything else is previewed in the chat first and sent with a confirm token |
| `moi_dapp_sessions` | no | The dapps signed in to |
| `moi_dapp_sign_out` | no | Forget a dapp session |

What a dapp offers for the generic `moi_dapp_*` tools to work is in [docs/dapp-conventions.md](docs/dapp-conventions.md).

Two MCP resources are also exposed: `moi://networks` and `moi://docs/quickstart` (`src/resources/`).

On `moi_create_asset`: a new MOI asset must hold KMOI to pay for its own storage, so the tool bundles the creation with a KMOI transfer to the asset's own account. The `storageFund` argument is optional; omitted, the server sizes it from your balance. See `docs/upstream-issues.md` on where that deposit sits.

On `moi_call_logic`: `view` reads. `invoke` changes state, and the operation it sends is the one the SDK's own logic driver builds for the routine, which it chooses from the kind the logic's manifest declares: an invoke routine is a LOGIC_INVOKE, an enlist routine is a LOGIC_ENLIST, and a deploy routine is refused with a pointer to `moi_deploy_logic`, because it runs once, when a logic is deployed. `moi_get_logic` lists each routine with its kind. There is no tool of its own and no new input; the payload and the participants are the ones the SDK builds for the routine, and a test compares them key for key. The protocol docs describe enlisting as subscribing an account to a logic: it allocates a storage area for that logic inside the account's state and runs a setup routine the logic defines. Storage in your own account is paid for by you as collateral, KMOI that stays in the account but cannot be spent while the storage exists, and the docs list no operation that removes an enlistment. The preview says this, and that this server cannot show what the routine does. Limits, as of October 2026: the protocol docs list LogicEnlist as Reserved, not yet active, with a design that may change before activation; the Cocolang 0.9.2 release notes say MOI has no enlist interaction, that the compiler no longer accepts `endpoint enlist`, and that an account that was never written reads every field as zero, and they tell authors to call such a routine with invoke; the JSON-RPC docs still list `moi.LogicEnlisted`, which this server does not call, so it cannot say whether your account is already enlisted. The SDK this server uses (js-moi-sdk 0.9.0-rc2) still builds the operation, so it can be sent, but nothing here has run against a node, the mock node accepts any simulation, and a node may refuse it. Every write is simulated first, so a refusal shows before your phone is asked, and it says the operation itself may be the reason. Before this change an enlist routine was sent as a LOGIC_INVOKE; `moi_call_logic` has no input to choose that now, so if a node refuses the enlistment there is no way to send the routine through this tool. The agent registry's tools send invoke routines only and refuse an enlist routine. `LOGIC_UPGRADE` and `LOGIC_INTERACT` cannot be built: the installed SDK has no serialiser for them (it throws "Unsupported Ix type"), and a server that holds no key can send only what the SDK can encode.

On `moi_deploy_logic`: it takes the manifest `coco compile` writes, as the JSON object, and builds one LOGIC_DEPLOY operation with the KMOI transfer that funds the new logic's own account, which the chain needs the moment a logic is created (the SDK's `LogicFactory` bundles the same transfer, and a test compares the two byte for byte). The funding is always the SDK's default, 10 KMOI, and there is no argument to change it, so a caller cannot move more of your KMOI into code it wrote. The manifest is encoded with the SDK's `ManifestCoder`, decoded again, and the preview is read from the decoded copy: the routine count and names, the deploy routine and its inputs, the size and a SHA-256 of the encoded bytes. The preview does not show what the code does, because this server cannot, and says so: the deploy routine runs at once with your account as the sender, anyone can call the logic afterwards, and the KMOI that funds it moves into an account the logic's own code controls. The preview also names the address the funding goes to, which is the address in the interaction the phone signs, and the most the fuel can cost in KMOI. A manifest has no name and the chain stores none, so none is shown. A manifest with one deploy routine runs it, one with several needs `routine` to name one, and one with none is refused, because only the SDK's own comments say the chain accepts a deploy with nothing to run and that was not run. A manifest with two routines of one name, a routine whose name is not a plain identifier, or two elements with one `ptr` is refused, and so is one that encodes to more than 32 KiB (or is more than 128 KiB of JSON; real compiled manifests are under 5 KB). The inputs are validated by the same code as an asset routine's, so a type that code cannot encode (a class) is refused. The balance is checked after the fuel is known, against the fund plus the whole fuel limit, which the chain holds back; if the node cannot estimate the fuel, a deploy gets a limit of 2,000,000 (the SDK's own deploy example) and the preview says what that can cost. The result says whether a logic exists in `deployed` (`yes` with its id, `no`, or `unknown`) and tells the model not to deploy again until the receipt has been read, because a second call creates a second logic. The hosted server watches for the receipt for up to 30 seconds after the broadcast; the stdio server does not look, because a receipt right after a broadcast is rarely there and the tap has used most of the client's budget, and says how to read the id with `moi_get_interaction`. A receipt is read strictly: an id is reported only from a receipt that is a clean success with one deploy operation whose id is the address that was funded. Limits: nothing has been run against a node, the mock node answers any simulation, and the receipt layout and the address derivation are read from the SDK, so the first deploy should be a person's supervised run on devnet with a tiny manifest; a deploy routine that writes state without `payer Logic` is expected to fail, as the SDK's own comments say, and the preview cannot tell whether a manifest's does; whether the WalletConnect relay and the wallet take a manifest of tens of KB, and what the wallet shows for a LOGIC_DEPLOY, are not known; the protocol docs say a logic that is not sealed can be updated in place, and nothing here shows whether a deployed one is sealed; a deploy routine with a class-typed input cannot be called.

On `moi_asset_routines` and `moi_asset_invoke`: they work from the asset's own manifest, which the node returns; a node that returns none gets a refusal and there is no fallback. Integer inputs are whole numbers in base units (the preview shows whole tokens too), and a zero amount is refused. This server has a description (a preview sentence, input checks, and the accounts a routine locks) for the routines of MAS0, MAS1, MAS2 and the native asset, one file per standard in `src/capabilities/assets/standards/`; a routine without one still runs if you pass `participants`, and its preview says there is no description. `moi_transfer` and `moi_mint` stay as shortcuts and a test checks that they write the same bytes as the generic path for MAS0. Limits: MAS0 and the native asset were checked against real devnet manifests; MAS1, MAS2 and custom (MASX) assets were not seen on any node, and the MAS1 and MAS2 descriptions are written from the SDK; a routine that only reads was tested against a mock node only; the unit of `expires_at` and what Lockup and Release do on chain are not confirmed, so the preview shows the raw value and claims nothing more; integer inputs are limited to 64 bits by the wire encoding; the shortcuts allow a zero amount and the generic path does not; the native asset cannot be minted or burned.

## Security model

- The server never generates, stores, or accepts a private key or mnemonic; the only `Signer` class in the codebase throws when asked to sign.
- Your phone approves every write. The wallet signs (`moi.signInteraction`) and the server broadcasts the signed interaction to the node, because the wallet's combined sign and send call crashes the wallet (`docs/upstream-issues.md`).
- OAuth access tokens are stored as SHA-256 hashes, never in plain text (`src/auth/index.ts:71`).
- The confirm token binds the preview you read to the write that is sent: same user, same tool, same arguments, ten minutes, one use (`src/tools/preview.ts`).
- Wallet pairings expire: after a week by default, or after one approved transaction or 15 minutes with `remember: false` (`src/server.ts`).
- Every hosted response carries security headers (`src/security-headers.ts`), and the MCP endpoint and every auth endpoint are rate limited (`src/server.ts:436`, `src/auth/rate-limit.ts`).

Every write is also simulated against the node first and refused locally if it would fail, so nothing that would burn fuel for nothing reaches your phone. Writes are recorded through proposed, signed, broadcast, and confirmed states in a journal (`src/journal.ts`). The stdio server keeps its journal in `MOI_MCP_HOME`, the hosted one in its data directory.

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