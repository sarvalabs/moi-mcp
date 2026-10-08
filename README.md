# MOI MCP server

An MCP server for the MOI blockchain. MCP (Model Context Protocol) is the standard that lets a chat assistant such as Claude call typed tools; this server exposes MOI reads and writes as those tools, the chat proposes each action, your phone approves it, and the server holds no private keys. It runs two ways: as a hosted connector you add to claude.ai by URL, and as a local server that talks to the MCP client over standard input and output (stdio), for desktop MCP clients such as Claude Desktop (`src/server.ts` and `src/index.ts`).

MOI uses its own words. An interaction is a transaction. A tesseract is a block. A logic is a smart contract, written in Cocolang. Fuel is the fee an interaction pays. A participant is an account whose state an interaction may touch.

## Use it from claude.ai

1. In claude.ai, open Settings, then Connectors, and add a custom connector with the server URL. A custom connector is a third party MCP server that claude.ai talks to over HTTP. Use the URL the operator gives you (the server is moving to a permanent domain, so the URL is a placeholder here).
2. Sign in on the consent page the connector opens. The server runs its own OAuth 2.1 flow (`src/auth/`). OAuth is the protocol claude.ai uses to get a token that proves it acts for you. There are no accounts and no passwords; your identity is a browser cookie named `moi_uid` (`src/auth/routes.ts:22`).
3. In a chat, ask Claude to connect your wallet. Claude calls `moi_connect_wallet`. The tool returns a QR code drawn as text, which Claude prints in a code block in the chat, and the same code as an image (`src/tools/wallet-hosted.ts`).
4. Scan the QR code with the MOI Wallet app on your phone and approve the pairing there. The pairing uses WalletConnect v2, a protocol that links a phone wallet to another program through a relay server, so the two never need a direct connection. The QR code expires in about 5 minutes; if it does, call `moi_connect_wallet` again. Before it pairs, Claude asks how long the pairing should stay open: once (ends after the next approved transaction, or after 15 minutes), day (24 hours) or week (7 days) (`src/wc/lifetime.ts`).
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
| Wallet tools and chain writes, 10 tools (11 with `MOI_ACCOUNT_KEY_TOOLS=on`) | yes | yes | no |
| Agent registry writes, 3 tools | yes | yes | no |
| Launchpad and dapp tools, 11 tools | no | yes | no |

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

`ping` is the health check. The other eight each ask the node several questions and return one answer, built on the node methods above: `moi_get_account` reads `moi.AccountState`, `moi.InteractionCount`, `moi.AccountMetaInfo`, `moi.TDU` and `moi.Deeds`; `moi_get_history` reads `moi.AccountMetaInfo` and then `moi.Tesseract` once for each height; `moi_get_asset` reads `moi.AssetInfoByAssetID`; `moi_get_interaction` reads `moi.InteractionByHash` and `moi.InteractionReceipt`, and for an interaction with no receipt yet `ixpool.ContentFrom` and `ixpool.WaitTime`; `moi_get_logic` and `moi_asset_routines` read `moi.LogicManifest`; the two agent reads call the agent registry logic. All three deployments list them, they need no wallet, and they cannot sign anything. Every combined read is bounded: a list or a long text is cut at a fixed length, and the answer says so, with `truncated`. Use one when it fits, and a node method when you need exactly what the node says, a tesseract other than the latest, or something no combined read covers.

| Tool | Phone approval | What it does |
|---|---|---|
| `ping` | no | Health check: server version, network, config status |
| `moi_get_account` | no | The account's nonce (the count of interactions the account has sent), whether it is registered on chain, a page of its balances (KMOI first, then by asset id; 50 rows by default, at most 100; one row for each asset and token id, 0 for a fungible asset; pass `assetId` for one asset's rows), and the assets it created (deeds, at most 50) |
| `moi_get_history` | no | An account's recent interactions, newest first: the last few heights (default 5, at most 20), one node call each, with each interaction's hash, operation types and explorer link, and how far it went. It reads only recent history; older or bulk history is not available until an indexer exists |
| `moi_get_asset` | no | Asset symbol, standard, supply, decimals, dimension (0 Economic, 1 Possession), owner |
| `moi_asset_routines` | no | What an asset can do, read from its own manifest on the node: each routine's name, whether it reads or changes state, its inputs and outputs, and whether this server can describe it in a preview |
| `moi_get_interaction` | no | Interaction status, sender, operations, and fuel used, by hash; for an interaction with no receipt yet, what the node's pool says about its sender (pending or queued, how many come first, whether the wait has expired); at most 20 operations are listed, long payloads and receipts are cut, and a note links the whole interaction when anything was cut |
| `moi_get_logic` | no | A deployed logic's callable routines with input and output types (cut and flagged when there are very many) |
| `moi_resolve_agent` | no | Look up an AI agent in the on chain registry by handle, name, or address; a not-found marked `truncated` means the search stopped before it covered the registry; `cardNote` says why an agent's card was not read (https cards on public hosts only) |
| `moi_list_agents` | no | Page through the on chain registry: every agent, or those one account registered |

### Wallet tools and writes

The pairing tools and the writes. A write builds an interaction with the SDK, simulates it against the node, and shows you a preview; your phone signs it, and the server broadcasts the signed interaction through `moi.SendInteractions`. The hosted and stdio servers list them; the read gateway does not.

| Tool | Phone approval | What it does |
|---|---|---|
| `moi_connect_wallet` | pairing tap | Asks how long the pairing should last (once, day or week), then prints a QR code as text in the chat, and as an image, to pair MOI Wallet over WalletConnect |
| `moi_wallet_status` | no | Whether a wallet is paired, and which account |
| `moi_disconnect_wallet` | no | Forget the pairing |
| `moi_transfer` | yes | Propose an asset transfer; balance checked first |
| `moi_create_asset` | yes | Propose a new asset in one of four standards: MAS0 (fungible, the default), MAS1 (one unit, identified by token id), MAS2 (fungible units under token ids) or MASX (a custom asset from a compiled manifest); funds its storage; the preview shows the standard in plain words, the funding and the id the asset will get, and the result gives the id when the receipt shows it in time (the hosted server waits up to 30 seconds) and otherwise says how to read it with `moi_get_interaction` (always so on the stdio server) |
| `moi_mint` | yes | Propose minting more of an asset the paired wallet manages |
| `moi_call_logic` | view: no, invoke: yes | Call a logic routine; `view` reads, `invoke` changes state and is sent as the operation the routine's kind in the manifest names: an invoke routine as a logic call, an enlist routine as an enlistment of your account in the logic (the protocol docs list that operation as reserved, so a node may refuse it). A deploy routine is refused with a pointer to `moi_deploy_logic` |
| `moi_deploy_logic` | yes | Deploy a new logic from a compiled manifest you give it and run one of its deploy routines; previewed in the chat first. 10 KMOI moves into the new logic to pay for its storage, nothing here can take that back or remove the logic, and the preview says it cannot show what the code does |
| `moi_asset_invoke` | read routine: no, write routine: yes | Call a routine of an asset by name. A routine that only reads answers at once (on the hosted server it still needs sign-in; `moi_get_account` does not); one that changes state is simulated, previewed in the chat, then sent to the phone with a confirm token |
| `moi_create_account` | yes | Register and fund a brand-new account from the paired wallet |
| `moi_configure_account` | yes | Off by default: listed only when the operator sets `MOI_ACCOUNT_KEY_TOOLS=on`. Add keys to your account or revoke keys on it, from the paired wallet; one call does one or the other. Every key is added at weight 1000, so a key that is added can sign for the account: the account's keys are read first, every public key is shown in full, and a change that would leave nothing able to sign is refused |

### Applications

Products built on the writes, each its own module under `src/applications/`: the agent registry, the MOI Agent Launchpad, and the generic dapp tools. The registry writes are on the hosted and stdio servers; the Launchpad and dapp tools are on the hosted server only.

| Tool | Phone approval | What it does |
|---|---|---|
| `moi_register_agent` | yes | Register an agent you host yourself in the on chain registry, owned by the paired wallet (for a Launchpad agent use `moi_launchpad_register_agent`) |
| `moi_set_agent_status` | yes | Mark an agent in the registry ACTIVE or DEPRECATED; only its owner can |
| `moi_transfer_agent` | yes | Hand an agent in the registry to another account; only its owner can |
| `moi_launchpad_templates` | no | The MOI Agent Launchpad's templates and the config each needs (hosted server) |
| `moi_launchpad_status` | no | Launchpad session, Telegram link state, and the wallet's agents there |
| `moi_launchpad_create_agent` | no | Create an agent from a template; previewed in the chat first, then created with a confirm token; it runs once registered and its setup script has been run |
| `moi_launchpad_register_agent` | yes | Register the agent in the on chain registry and tell the Launchpad |
| `moi_launchpad_telegram_link` | no | The bot link that connects Telegram to the Launchpad account |
| `moi_launchpad_setup_script` | no | A one-time download link for the agent's setup script, with the ordered steps to run it; the key never enters the chat |
| `moi_dapp_sign_in` | message tap | Sign in to any MOI dapp that follows the dapp conventions, as the paired wallet. This is also how you sign in to the Launchpad: pass its URL |
| `moi_dapp_api` | no | The operations a dapp publishes in its OpenAPI document |
| `moi_dapp_call` | no | Call one published operation as the signed-in person; a GET runs at once, anything else is previewed in the chat first and sent with a confirm token |
| `moi_dapp_sessions` | no | The dapps signed in to |
| `moi_dapp_sign_out` | no | Forget a dapp session, the Launchpad's included |

The Launchpad has no sign-in or sign-out tool of its own. It is a dapp that follows the conventions, so you sign in with `moi_dapp_sign_in` and the Launchpad's URL (`https://launchpad.moi.technology`, or whatever `MOI_LAUNCHPAD_URL` is on that server), approving one message on the phone, and sign out with `moi_dapp_sign_out` and the same URL. That stores the session the `moi_launchpad_*` tools read, and each of them that needs one says how to get it, with the URL, when it is missing. The cost: `moi_dapp_sign_in` accepts only public https hosts, so a Launchpad running locally or over plain http can no longer be signed in to from the chat, and with no session only `moi_launchpad_templates` works against it.

What a dapp offers for the generic `moi_dapp_*` tools to work is in [docs/dapp-conventions.md](docs/dapp-conventions.md).

Two MCP resources are also exposed: `moi://networks` and `moi://docs/quickstart` (`src/resources/`).

On `moi_create_asset`: a new MOI asset must hold KMOI to pay for its own storage, so the tool bundles the creation with a KMOI transfer to the asset's own account. The `storageFund` argument is optional; omitted, the server sizes it from your balance. See `docs/upstream-issues.md` on where that deposit sits.

What each standard takes: MAS0 and MAS2 take `symbol`, `supply` and `decimals`. MAS1 takes `symbol` only, because it is single-unit (a fixed maximum supply of 1, every unit whole and moved by its token id) and has no decimals, and a call that gives a supply or decimals is refused with the reason. MASX takes `symbol`, `supply`, `manifest` (the JSON `coco compile` writes for a `coco asset` module), `routine` (the deploy routine to run, needed when the manifest has more than one and not allowed when it has none) and `args` (that routine's inputs by label); it takes no decimals and no `storageFund`, and is always funded with exactly the SDK's default, as `moi_deploy_logic` is, so a caller cannot choose how much KMOI goes into an account that runs a manifest it supplied. MAS0 keeps its fund rule: 10 KMOI, or 7 KMOI when the balance cannot carry 10. A dry run on the devnet on 7 October 2026 refused a MAS1 and a MAS2 create funded with 7 KMOI and accepted both with 8 KMOI, so those two are funded with the `storageFund` you pass or, when you pass none, exactly 10 KMOI, and an account that cannot carry that plus the whole fuel limit is told so before anything reaches the phone. Each payload was compared with the SDK's own builder byte for byte (`MAS0AssetLogic`, `MAS1AssetLogic`, `MAS2AssetLogic` and `AssetFactory`), as this server holds it, as the phone is asked to sign it, and through the signed-interaction check. Each standard was also dry-run on the devnet on 7 October 2026 through this server's own prepare path, and the node accepted the predicted asset id for each; nothing was signed or broadcast, and no asset of MAS1, MAS2 or MASX has been created for real by this server yet, so one real creation per standard is still owed. A MASX create is read the way a logic deploy is: the manifest is encoded and decoded again, and the preview shows the routine count, the encoded size, the SHA-256, the deploy routine and its inputs. It cannot show what the code does, and says so. The dry run refused a compiled TaxToken whose deploy routine wrote state without `payer Logic` and accepted the same source with it, so a MASX deploy routine should pay for its writes as a logic's does. The dry run refused a MASX deploy routine that minted to an account other than yours ("unable to fetch state object"), because a create declares no participants, as the SDK's does, so pass your own address wherever the routine takes an account. The result gives the new asset's id from the receipt on the hosted server (`created` yes and `assetId`), after waiting up to 30 seconds for it; on the stdio server it does not look and says how to read the id (`moi_get_interaction` with the hash, then the first operation's `data.asset_id`). The tokens of a MAS1 or MAS2 asset, and the routines of a MASX asset, are used through `moi_asset_invoke`.

On `moi_call_logic`: `view` reads. `invoke` changes state, and the operation it sends is the one the SDK's own logic driver builds for the routine, which it chooses from the kind the logic's manifest declares: an invoke routine is a LOGIC_INVOKE, an enlist routine is a LOGIC_ENLIST, and a deploy routine is refused with a pointer to `moi_deploy_logic`, because it runs once, when a logic is deployed. `moi_get_logic` lists each routine with its kind. There is no tool of its own and no new input; the payload and the participants are the ones the SDK builds for the routine, and a test compares them key for key. The protocol docs describe enlisting as subscribing an account to a logic: it allocates a storage area for that logic inside the account's state and runs a setup routine the logic defines. Storage in your own account is paid for by you as collateral, KMOI that stays in the account but cannot be spent while the storage exists, and the docs list no operation that removes an enlistment. The preview says this, and that this server cannot show what the routine does. Limits, as of October 2026: the protocol docs list LogicEnlist as Reserved, not yet active, with a design that may change before activation; the Cocolang 0.9.2 release notes say MOI has no enlist interaction, that the compiler no longer accepts `endpoint enlist`, and that an account that was never written reads every field as zero, and they tell authors to call such a routine with invoke; the JSON-RPC docs still list `moi.LogicEnlisted`, which this server does not call, so it cannot say whether your account is already enlisted. The SDK this server uses (js-moi-sdk 0.9.0-rc2) still builds the operation, so it can be sent, but nothing here has run against a node, the mock node accepts any simulation, and a node may refuse it. Every write is simulated first, so a refusal shows before your phone is asked, and it says the operation itself may be the reason. Before this change an enlist routine was sent as a LOGIC_INVOKE; `moi_call_logic` has no input to choose that now, so if a node refuses the enlistment there is no way to send the routine through this tool. The agent registry's tools send invoke routines only and refuse an enlist routine. `LOGIC_UPGRADE` and `LOGIC_INTERACT` cannot be built: the installed SDK has no serialiser for them (it throws "Unsupported Ix type"), and a server that holds no key can send only what the SDK can encode.

On `moi_deploy_logic`: it takes the manifest `coco compile` writes, as the JSON object, and builds one LOGIC_DEPLOY operation with the KMOI transfer that funds the new logic's own account, which the chain needs the moment a logic is created (the SDK's `LogicFactory` bundles the same transfer, and a test compares the two byte for byte). The funding is always the SDK's default, 10 KMOI, and there is no argument to change it, so a caller cannot move more of your KMOI into code it wrote. The manifest is encoded with the SDK's `ManifestCoder`, decoded again, and the preview is read from the decoded copy: the routine count and names, the deploy routine and its inputs, the size and a SHA-256 of the encoded bytes. The preview does not show what the code does, because this server cannot, and says so: the deploy routine runs at once with your account as the sender, anyone can call the logic afterwards, and the KMOI that funds it moves into an account the logic's own code controls. The preview also names the address the funding goes to, which is the address in the interaction the phone signs, and the most the fuel can cost in KMOI. A manifest has no name and the chain stores none, so none is shown. A manifest with no `kind` (the current compiler, Coco 0.9.0, writes none for a logic) is taken as a logic and encoded with kind logic; any other kind is refused. A manifest with one deploy routine runs it, one with several needs `routine` to name one, and one with none is refused, because only the SDK's own comments say the chain accepts a deploy with nothing to run and that was not run. A manifest with two routines of one name, a routine whose name is not a plain identifier, or two elements with one `ptr` is refused, and so is one that encodes to more than 32 KiB (or is more than 128 KiB of JSON; real compiled manifests are under 5 KB). The inputs are validated by the same code as an asset routine's, so a type that code cannot encode (a class) is refused. The balance is checked after the fuel is known, against the fund plus the whole fuel limit, which the chain holds back; if the node cannot estimate the fuel, a deploy gets a limit of 2,000,000 (the SDK's own deploy example) and the preview says what that can cost. The result says whether a logic exists in `deployed` (`yes` with its id, `no`, or `unknown`) and tells the model not to deploy again until the receipt has been read, because a second call creates a second logic. The hosted server watches for the receipt for up to 30 seconds after the broadcast; the stdio server does not look, because a receipt right after a broadcast is rarely there and the tap has used most of the client's budget, and says how to read the id with `moi_get_interaction`. A receipt is read strictly: an id is reported only from a receipt that is a clean success with one deploy operation whose id is the address that was funded. Limits: one deploy has run on the devnet (7 October 2026) and succeeded, but the mock node answers any simulation, so no unit test shows what the devnet simulates for a deploy, and the receipt layout and the address derivation are read from the SDK; a deploy routine that writes state without `payer Logic` fails, as the SDK's own comments say and a devnet deploy showed on 7 October 2026, and the preview cannot tell whether a manifest's does; whether the WalletConnect relay and the wallet take a manifest of tens of KB, and what the wallet shows for a LOGIC_DEPLOY, are not known; the protocol docs say a logic that is not sealed can be updated in place, and nothing here shows whether a deployed one is sealed; a deploy routine with a class-typed input cannot be called.

`moi_configure_account` is not registered unless the operator sets `MOI_ACCOUNT_KEY_TOOLS=on` (the default is `off`), on the hosted and the stdio server alike. A key added at weight 1000 signs for the account alone, for good, and MOI Wallet shows it as a hex string nobody can check by eye, so a wrong paste, or a prompt injected into something the model read, is enough to give the account away, and neither the preview nor the tap guards against it. With the setting off the tool is absent from the tool list and a call to it is unknown. The rest of this paragraph describes the tool as it works with the setting on.

On `moi_configure_account`: it sends one ACCOUNT_CONFIGURE operation (type 2) for the paired wallet's own account, which is the only account it can act on. A key that is added can sign for the account and a key that is revoked can no longer sign, so the summary says that in plain words, the preview shows every public key in full, and the account's keys are read first (`moi.AccountKeys`) and shown beside the change. One call adds keys or revokes keys, never both: the protocol docs say an AccountConfigure operation does either an add or a revoke, never both, and their multi-sig tutorial revokes in a second interaction, while the SDK builds both in one operation and would accept it. A request that names both is refused with the way to do it in two calls, which is also the safe way to rotate a key: add the new one, check that it signs, then revoke the old one. A key is given as a compressed public key (0x and 66 hex characters). Every key is added at weight 1000 and there is no input for another: the installed SDK (js-moi-sdk 0.9.0-rc2) accepts any positive weight, the protocol docs give 0 to 1000 and show multi-sig setups of 500 and of 400, 350 and 250, and the newer SDK (0.9.0-rc3) refuses a weight under 1000 and says the chain does too, so 1000 is the one weight every source accepts, and it makes the summary true of every key that is added. The multi-sig setups of the docs cannot be made from this tool until a supervised run on devnet shows what the chain does with a lighter key. The signature algorithm is always 0, the only value the SDK accepts; the docs do not say which scheme that is, so nothing here names it. The protocol docs give the default account threshold as 1000 and as the least combined weight any interaction needs: the preview shows the weight of the keys that are not revoked before and after, and says that this server cannot read the account's own threshold. At most 5 keys go in one call. Before anything is simulated or sent to the phone it refuses an account whose key 0 is missing, revoked or under 1000 (this server signs every interaction as key 0 alone, so nothing it sends could be valid), a key id the account does not have or has already revoked, a key the account already has, revoked or not (two keys are the same key when their x coordinates are: the node lists 32 bytes and the wallet and the SDK give 33; a revoked key is not added again, because the docs describe a revoke as for compromised and obsolete keys and say nothing of adding one back), the same key or id twice, a request that revokes every key that is not revoked, a request that leaves the keys that remain under 1000, and a request made while an interaction of the account is still pending (the keys are read at the latest tesseract, so a revoke that has not landed would not show, and two quick revokes could together leave nothing able to sign). The key 0, weight, pending and revoked-key checks go beyond what was asked. Key 0 is the key this server signs with, and so the key the paired wallet signs with here; revoking it ends what this server can do for the account, so the summary says so, and it is allowed. A request that names no key is refused with the account's keys, because the signing servers list no tool that shows them (`moi_rpc_account_keys` is on the read gateway only). The tool description tells the model to compare the key on the phone, if it shows one, with the preview, and not the amount and address that the other writes ask for. Limits, as of October 2026: nothing here has run against a node, the mock node accepts any simulation, and what MOI Wallet shows for an ACCOUNT_CONFIGURE is not known, so the summary in the chat is where it is described and the phone may show nothing to compare. The journal records that a `configure_account` was proposed, signed and broadcast, with the interaction's hash; which keys were added or revoked is in the interaction on chain and in nothing else the server keeps. Nothing checks that a new key is a point on the curve (about half of random values are, so a pass would prove nothing) or that anyone holds its private key, so compare the key in the preview with the one you were given, and see it sign before you revoke the old one. Mainnet and custom networks have no published chain id here (`src/moi/provider.ts`), so only voyage devnet can pair today, and that is where the first run should be. `ACCOUNT_INHERIT` (type 3) has no tool, because what it does on chain is not written anywhere this server can read, and a value-moving tool with a guessed preview is worse than none. Its payload is a target account, an asset action and a sub-account index, and the SDK builds it. The docs say the asset action "funds the new sub-account", but the payload names a beneficiary inside the transfer, the SDK lets the caller choose it, and the docs' own example sends it to an account that is neither the sender nor the sub-account its receipt reports. Three documents give three directions of inheritance: the protocol docs have the sub-account inherit the context of a target application, the August 2026 release notes have it inherit from its parent, and the account tutorial says "from one participant (or target account) to another". How the sub-account index gives the sub-account's id, what the sub-account can then do, whether it can be removed and what funding it needs are not stated anywhere, and the docs say a document on inherited accounts is "coming soon". What would settle it is that document, or a supervised run on devnet.

On `moi_asset_routines` and `moi_asset_invoke`: they work from the asset's own manifest, which the node returns; a node that returns none gets a refusal and there is no fallback. Integer inputs are whole numbers in base units (the preview shows whole tokens too), and a zero amount is refused. This server has a description (a preview sentence, input checks, and the accounts a routine locks) for the routines of MAS0, MAS1, MAS2 and the native asset, one file per standard in `src/capabilities/assets/standards/`; a routine without one still runs if you pass `participants`, and its preview says there is no description. `moi_transfer` and `moi_mint` stay as shortcuts and a test checks that they write the same bytes as the generic path for MAS0. Limits: MAS0 and the native asset were checked against real devnet manifests; MAS1, MAS2 and custom (MASX) assets were not seen on any node, and the MAS1 and MAS2 descriptions are written from the SDK (`moi_create_asset` can now create all three, dry-run on the devnet on 7 October 2026 and not yet created for real); a routine that only reads was tested against a mock node only; the unit of `expires_at` and what Lockup and Release do on chain are not confirmed, so the preview shows the raw value and claims nothing more; integer inputs are limited to 64 bits by the wire encoding; the shortcuts allow a zero amount and the generic path does not; the native asset cannot be minted or burned.

## Security model

- The server never generates, stores, or accepts a private key or mnemonic; the only `Signer` class in the codebase throws when asked to sign.
- Your phone approves every write. The wallet signs (`moi.signInteraction`) and the server broadcasts the signed interaction to the node, because the wallet's combined sign and send call crashes the wallet (`docs/upstream-issues.md`).
- OAuth access tokens are stored as SHA-256 hashes, never in plain text (`src/auth/index.ts:71`).
- The confirm token binds the preview you read to the write that is sent: same user, same tool, same arguments, ten minutes, one use (`src/tools/preview.ts`).
- Wallet pairings expire at the lifetime the person chose when connecting: once (after one approved transaction or 15 minutes), day (24 hours) or week (7 days) (`src/wc/lifetime.ts`).
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