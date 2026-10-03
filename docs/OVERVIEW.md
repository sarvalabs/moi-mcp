# MOI MCP: the whole picture

This is the one document that explains the entire repository. Read it first. Every other document goes deeper on one part, and the last section maps them.

All facts here come from the code at commit c7076f4. Paths are relative to the repository root.

## What this project is

This repository is an MCP server for the MOI blockchain. MCP is the Model Context Protocol, the standard that lets an AI chat client such as claude.ai list and call functions on an outside program. Each function is called a tool. This server's tools let a person read the MOI blockchain and send transactions on it by talking to Claude in plain language.

The design rule behind everything: the server holds zero private keys. A private key is the secret that controls a blockchain account. The key stays inside the MOI Wallet app on the person's phone. The server builds each transaction, shows the person a preview in the chat, sends the signing request to the phone, and the person approves with a tap. A stolen or hacked server can propose transactions and nothing more. Money moves only when a person taps approve on something they were shown first.

## The five pieces

Five separate systems cooperate on every transaction.

```
claude.ai  ──HTTPS/MCP──►  this server  ──JSON-RPC──►  MOI node
                               │
                     WalletConnect relay
                               │
                        MOI Wallet (phone)
```

claude.ai is the chat website. It acts as the MCP client: it lists this server's tools, lets Claude call them, and shows the person what comes back.

This server is a Node.js program written in TypeScript. It uses the Express web framework for HTTP routing, Anthropic's `@modelcontextprotocol/sdk` to speak MCP, and `js-moi-sdk` to speak the MOI protocol. It runs on Node.js 20 or later.

MOI Wallet is the app on the person's phone. It holds the private key and produces signatures. A signature is a mathematical proof that the key holder approved one exact transaction and no other.

The WalletConnect relay is a message-forwarding service run by Reown. The server and the phone each connect to it, and it forwards end-to-end encrypted messages between them on a shared channel called a topic. The server authenticates to the relay with a free project id from cloud.reown.com.

The MOI node is the computer that runs the blockchain. The server sends it read queries and finished signed transactions over JSON-RPC, a convention for calling remote functions with JSON. The default network is voyage, MOI's development network, where the currency is KMOI and has no real value.

## The three servers in this repository

One codebase builds three servers and one command-line helper. The `bin` field in package.json maps the names.

| Name | Entry | What it is |
|---|---|---|
| `mcp-server` | src/index.ts | The local server. A desktop MCP client such as Claude Desktop starts it as a child process and talks to it over stdio, the process's standard input and output. Single user, single wallet. |
| `moi-mcp-http` | src/http.ts | The read-only HTTP gateway on port 8787. Stateless: no wallet, no sign-in, no keys. Safe to run many copies. |
| `moi-mcp-hosted` | src/server.ts | The hosted gateway on port 8788. This is what claude.ai connects to. It serves OAuth sign-in, per-user wallet pairings, and the write tools. It must run as exactly one process, because sign-in codes live in memory and the process holds one WalletConnect client. |
| `moi-mcp` | src/cli.ts | A terminal helper for the local server: pair, status, disconnect, config. It starts no server. |

Both HTTP gateways expose MCP at the path `/mcp`. The hosted gateway lists 36 tools, or 37 when the devnet faucet is configured: a `ping` health check, eight read tools, three wallet tools (connect, status, disconnect), eleven write tools (transfer, create account, configure account, create asset, mint, call a logic, deploy a logic, invoke an asset routine, and three agent registry writes), and the thirteen Launchpad and dapp tools. The read gateway lists 43: `ping`, the eight read tools and 34 node method tools. README.md, under Tools, has the table.

## What using it looks like

1. The person adds the server to claude.ai as a custom connector by pasting its URL.
2. The first wallet-touching tool call returns HTTP 401, and claude.ai shows a Connect button. The person clicks it, lands on the server's consent page, and clicks Approve. There is no account and no password. Identity is a browser cookie named `moi_uid`, and the consent page says so in plain words.
3. The person asks Claude to connect their wallet. The `moi_connect_wallet` tool returns a QR code inline in the chat. The person scans it with MOI Wallet. The pairing lasts 7 days by default, or 15 minutes and one use if they ask for a one-time pairing.
4. The person asks for an action: "send 5 KMOI to 0xabc". Claude calls `moi_transfer` with no confirm argument. The server builds the transaction, simulates it against the node, and returns a preview: a one-sentence summary, the exact values the phone will display in the phone's own units, the fuel, and a confirm token.
5. Claude shows the preview and asks for a yes. On yes, Claude calls the same tool again with the token. The phone buzzes, the person checks that the amount and address match the preview, and taps. The server broadcasts the signed bytes to the node and returns the transaction hash with an explorer link.

## How sign-in works

The server is its own OAuth 2.1 authorization server, implemented by hand in src/auth/. OAuth is the standard that lets claude.ai prove the person approved the connection without ever seeing a password.

claude.ai discovers the endpoints from `/.well-known/oauth-authorization-server` (RFC 8414), registers itself automatically (RFC 7591 dynamic client registration), and sends the browser to the consent page. On Approve, the browser returns to claude.ai with a one-time code, valid 60 seconds. claude.ai trades the code for an access token (valid 1 hour) and a refresh token (valid 30 days, replaced on each use). PKCE with the S256 method is mandatory, which stops a stolen code from being traded by anyone else.

The server stores tokens only as SHA-256 hashes, so a copied disk leaks no usable credentials. Two scopes exist: `moi:read` and `moi:write`. A read-only token calling a write tool gets HTTP 403. The sign-in endpoints carry per-address rate limits, and every response carries security headers that block framing and sniffing.

## How pairing works

`moi_connect_wallet` asks the WalletConnect client for a pairing URI and renders it as a QR code. When the phone scans it, the phone and the server meet at the relay and agree on an encrypted topic. The server stores one pairing record per user: the topic, the wallet address, the chain, the mode (persistent or once), and the expiry (src/wc/store.ts, src/wc/lifetime.ts).

One WalletConnect client exists per process, wrapped by `WalletConnectHub` (src/wc/hub.ts). Every signing request is routed by topic, and the topic comes only from the authenticated user's stored record. Tool inputs carry no topic, no account, and no user id, so one user can never sign on another user's phone. Unpairing from the phone deletes the record on the server; disconnecting in the chat tears down the relay session.

Pairing records live in files under the data directory by default. Setting `REDIS_URL` moves them, together with the WalletConnect client's own state, into Redis, which lets a replaced process keep every pairing.

## How a write works

Every state-changing tool follows one path, `runWrite` in src/tools/hosted-writes.ts.

The first call has no confirm token. The server loads the caller's pairing, checks the network and the expiry, builds the interaction (MOI's word for a transaction), measures the real fuel cost, and simulates it against the node. A transaction that would fail is refused here, before anyone is asked to approve anything. The reply is a preview holding the summary sentence, the values the wallet will render, and a fresh confirm token.

The token (src/tools/preview.ts) is single use, expires in 10 minutes, and is bound to the user, the tool, and a fingerprint of the exact arguments. A replayed token, another user's token, a made-up token, or the same token with changed arguments all produce a fresh preview and never a transaction. If the numbers moved between the two calls, for example the storage fund shrank because the balance dropped, the person gets the new numbers instead of a send.

The second call carries the token. The server pushes the signing request to the phone through the hub and waits, up to the hosted budget of 240 seconds, under claude.ai's 300-second ceiling. The phone signs; the server broadcasts the signed bytes to the node itself. The split exists because the wallet's combined sign-and-send call crashes the wallet (docs/upstream-issues.md, issue 1).

The write journal (src/journal.ts) records every attempt through the states proposed, signed, broadcast, and confirmed, with failed and orphaned for the unhappy paths. On boot, `reconcileJournalOnBoot` in src/server.ts finalizes entries that broadcast before a crash and marks the rest orphaned, so a restart never loses track of an approved transaction.

## What keeps it safe

The server never holds a private key. The read-only signer used for building transactions (src/moi/provider.ts) throws on any attempt to sign.

The preview step means the person approves the server's numbers, shown in the chat, before the phone is ever contacted. The phone then shows the raw operation fields, and the person can check that both match.

Tokens are stored hashed. Sign-in codes are single use and die in 60 seconds. Pairings expire. Rate limits cover the sign-in endpoints and the MCP path. Errors never leak stack traces or file paths. Text that arrives from the chain, such as asset symbols and revert reasons, is quoted, stripped of control characters, and length-capped before Claude sees it, which blocks a hostile asset name from putting words in Claude's mouth (src/moi/reads.ts, src/moi/ix-builder.ts).

## The code, in one map

40 TypeScript files under src/.

| Area | Files | What lives there |
|---|---|---|
| Entry points | index.ts, http.ts, server.ts, cli.ts | The three servers and the CLI described above. |
| Sign-in | auth/ | The OAuth server: routes, token store, cookie identity, consent pages, rate limiting. |
| Wallet link | wc/ | The WalletConnect client and hub, pairing lifetimes, session stores (file and Redis), QR rendering. |
| Tools | tools/ | Read tools, wallet tools, the hosted two-call writes, the preview token registry, shared write logic. |
| Chain | moi/ | Interaction building, fuel estimation, simulation, reads, providers, the agent registry. |
| Shared | schema.ts, config.ts, journal.ts, errors.ts, and friends | Every input and output schema in zod, config loading, the write journal, error mapping, security headers. |

## Tests

419 automated cases across 30 files under test/unit, plus a live devnet suite that runs only with `MOI_E2E=1`. The suite runs a mock MOI node (test/helpers/mock-node.ts) and fake wallets, so it needs no network and finishes in seconds:

```bash
npm test
```

Real phones have signed real transactions through claude.ai against this code; the write journal holds the receipts. A full test plan with a coverage audit exists as separate work in progress.

## Running it

Local development:

```bash
npm ci && npm run build && npm test
```

A VM deployment runs the two gateways under pm2 behind nginx with TLS. The complete runbook, including every environment variable and the nginx timeouts the signing wait requires, is docs/handoff-infra.md. A Dockerfile builds the same thing as a container. The three env vars that matter most: `PUBLIC_URL` (the public origin, also the OAuth issuer), `WC_PROJECT_ID` (the 32-hex Reown id), and `MOI_DATA_DIR` (where all state lives).

## Status and known gaps

Working today: the full path from a claude.ai chat through sign-in, QR pairing, preview, phone approval, and broadcast, proven with real phones on the voyage devnet. Pending: deployment on a permanent domain (the current tunnel URL changes on every restart), the code review, and a two-phone concurrency run.

Three gaps live upstream and are recorded with suggested fixes in docs/upstream-issues.md: the wallet has no field to display a description, so the phone renders raw operation fields (the preview step is the countermeasure); the storage fund paid when creating an asset sits in the asset's own account, which surprises people; and the wallet's combined sign-and-send call crashes it, which is why sign and broadcast are split.

One branch, feat/mandates-v2, holds finished work where the server would hold a delegated key. It stays unmerged on purpose: giving up the zero-key property is a decision someone must make explicitly.

## Where to read more

| Document | Reader | Contents |
|---|---|---|
| docs/how-it-works.md | Anyone, zero background assumed | Every piece, every term, every step, with the failure cases. |
| docs/handoff-infra.md | Infrastructure engineers | The complete deployment and operations runbook. |
| docs/reviewer-guide.md | Code reviewers | Stack, file tour, the five flows worth review time, suggested order. |
| docs/quickstart.md | Local users | Zero to a signed transaction with the stdio server. |
| docs/upstream-issues.md | Wallet and SDK maintainers | The upstream gaps, with evidence and suggested fixes. |
| docs/deploy-voyage.md | The Voyage team | How the gateway slots into Voyage. |
| README.md | Everyone | The front page: what it is and both ways to run it. |
