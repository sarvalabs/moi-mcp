# Code review guide

For Gokul. Every claim here comes from the repo at commit c7076f4 ("Preview every hosted write before it reaches the phone"). Paths are relative to the repo root.

## What this code does

This is an MCP server (Model Context Protocol, the tool-calling protocol Claude clients speak) for the MOI blockchain. A person adds it to claude.ai as a custom connector and signs in through OAuth 2.1, a standard web sign-in protocol, which this server itself serves. Then the person pairs the MOI Wallet app on their phone once by scanning a QR code returned inline in the chat. The QR code carries a WalletConnect v2 pairing URI. WalletConnect is a protocol that connects the server to the phone through a relay, a message-forwarding service run by a third party. After pairing, Claude can read chain state directly and can propose transactions, and every state change is signed by the phone: the server builds and simulates the transaction, shows a preview with a single-use confirm token, and only a second call carrying that token reaches the phone. The server holds zero private keys, which package.json's description states and src/moi/provider.ts enforces in code. The signed bytes come back from the phone and the server broadcasts them to the MOI node itself, because the wallet's combined sign-and-send call crashes the wallet (docs/upstream-issues.md, issue 1).

## Stack

Versions are the semver ranges declared in package.json. Read them with:

```bash
node -p "require('/Users/adithyaganesh/moi-mcp/package.json').dependencies"
```

```
{
  '@modelcontextprotocol/sdk': '^1.0.0',
  '@walletconnect/sign-client': '^2.17.0',
  dotenv: '^16.4.5',
  express: '^5.2.1',
  'js-moi-sdk': '^0.8.0',
  'js-polo': '^0.1.4',
  qrcode: '^1.5.4',
  'qrcode-terminal': '^0.12.0',
  redis: '^6.2.1',
  zod: '^3.23.8'
}
```

| Package | Version | Used for |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.0.0` | The MCP server framework: tool registration, stdio and streamable HTTP transports. |
| `@walletconnect/sign-client` | `^2.17.0` | WalletConnect v2, the relay protocol that connects the server to MOI Wallet on the phone. |
| `js-moi-sdk` | `^0.8.0` | The MOI protocol SDK: JSON-RPC provider, interaction builder, identifier types. |
| `express` | `^5.2.1` | HTTP routing for the hosted server, the OAuth endpoints, and the pairing page. |
| `zod` | `^3.23.8` | Every tool input and output schema, config validation, and on-disk record shapes (src/schema.ts). |
| `dotenv` | `^16.4.5` | Loads `.env` into process.env at startup (src/config.ts). |
| `js-polo` | `^0.1.4` | POLO serialization, MOI's binary wire encoding, used by the interaction builder. |
| `qrcode` | `^1.5.4` | Renders the WalletConnect pairing URI as a PNG for the chat and the pairing page. |
| `qrcode-terminal` | `^0.12.0` | ASCII QR for the `moi-mcp pair` CLI command. |
| `redis` | `^6.2.1` | Optional session backend so a replaced container keeps its pairings (src/wc/redis-store.ts). |
| `typescript` | `^5.6.0` | Language. Dev dependency; tsup compiles to dist/. |
| `vitest` | `^2.1.0` | Test runner. Dev dependency. |
| `tsup` | `^8.3.0` | Build tool producing dist/. Dev dependency. |
| `tsx` | `^4.19.0` | Runs TypeScript directly for `npm run dev`. Dev dependency. |

## Three entry points

The `bin` field in package.json maps four names to three servers and one CLI:

| Bin name | File | What it is |
|---|---|---|
| `mcp-server` | dist/index.js (src/index.ts) | MCP server that talks over stdio (the process's standard input and output streams) for desktop clients such as Claude Desktop. The client starts it as a child process. stdout is the MCP transport; all diagnostics go to stderr (invariant in the src/index.ts header). Registers reads, wallet tools, and single-user writes. |
| `moi-mcp-http` | dist/http.js (src/http.ts) | Read-only HTTP gateway. Stateless, no wallet, no auth, no keys. Exposes the read tools and resources at `/mcp` on `PORT`, default 8787 (src/http.ts:180). |
| `moi-mcp-hosted` | dist/server.js (src/server.ts) | The hosted multi-user gateway: OAuth, per-user wallet pairings, and the write tools. Listens on `HOSTED_PORT`, default 8788 (src/config.ts:149). This is what claude.ai connects to. |
| `moi-mcp` | dist/cli.js (src/cli.ts) | Terminal companion: `pair`, `status`, `disconnect`, `config`. It does not start a server. |

ecosystem.config.cjs defines two pm2 apps for a VM deployment: `moi-mcp-read` runs dist/http.js on port 8787, and `moi-mcp-write` runs dist/server.js on port 8788. The write app is pinned to one fork-mode instance, with comments explaining why: in cluster mode a request can land on a copy that does not hold the user's pairing, and an overlapping reload runs two processes that both try to use the same WalletConnect relay identity.

## File tour

Generate the list yourself with:

```bash
find /Users/adithyaganesh/moi-mcp/src -type f -name "*.ts" | sort
```

The command prints 40 paths, matching the 40 entries below. Grouped by directory, based on each file's header comment.

Top level:

- `src/index.ts` (119 lines): stdio entry point. Registers resources, read tools, wallet tools, write tools.
- `src/http.ts` (240): read-only HTTP transport. The header explains the split: a WalletConnect session is a persistent relay socket and a pending approval waits minutes for a phone tap, so writes stayed local in the pre-hosted design and reads run behind a URL.
- `src/server.ts` (681): hosted multi-user entry point. Builds a new McpServer per request, mounts OAuth, pairing, security headers, rate limits, and the journal reconciliation on boot. The header documents claude.ai's lazy auth: only a real 401 with `WWW-Authenticate` triggers the Connect card, never a tool error.
- `src/cli.ts` (143): the `moi-mcp` pairing CLI.
- `src/config.ts` (239): environment loading and validation with zod. Lazy so the server can start and report why it is misconfigured. Also maps an injected `PORT` onto `HOSTED_PORT` for platforms that assign ports.
- `src/schema.ts` (521): the one place tool input and output shapes, WalletConnect payloads, the on-disk session store, and error codes are defined.
- `src/errors.ts` (72): maps the string error codes onto JSON-RPC errors MCP clients understand, keeping the string code at `data.code`.
- `src/moi-error.ts` (32): framework-free error type so src/moi/ and src/wc/ never import the MCP SDK.
- `src/journal.ts` (186): append-only write journal at `<dataDir>/journal.jsonl`, one JSON object per line (JSONL). States: proposed, signed, broadcast, confirmed, failed, orphaned (line 16).
- `src/json-schema-dialect.ts` (150): rewrites the SDK's draft-07 `$schema` stamp to JSON Schema 2020-12 on the way out, because strict clients reject draft-07 tools before they run.
- `src/security-headers.ts` (28): the response headers, aimed at clickjacking on the consent and pairing pages.
- `src/clean-errors.ts` (23): replaces Express's stack-printing error handler with plain 400 and 500 JSON bodies.
- `src/branding.ts` (97): serves the server's own icon and landing page so connector lists do not show a tunnel provider's favicon.

`src/auth/` (the OAuth 2.1 authorization server):

- `src/auth/index.ts` (89): mounts everything and explains why it is written in this repo: the SDK's OAuthServerProvider has no room for a cookie-identified consent screen, and its AuthInfo shape does not match this repo's contract.
- `src/auth/routes.ts` (414): the endpoints. RFC 8414 and RFC 9728 metadata, RFC 7591 dynamic client registration, `/authorize` with PKCE required, `/token` with authorization_code and refresh_token grants.
- `src/auth/crypto.ts` (70): node:crypto only. Cookie secret generation (0600 file), HMAC signing of the uid cookie, sha256 helpers, timing-safe compare.
- `src/auth/store.ts` (137): clients and tokens as 0600 files under `<dataDir>/auth/`; authorization codes are 60-second, single-use, in memory only.
- `src/auth/types.ts` (49): the AuthInfo contract ({userId, clientId, scopes, expiresAt in unix seconds}).
- `src/auth/pages.ts` (61): dependency-free HTML for the consent and error pages.
- `src/auth/rate-limit.ts` (68): sliding-window limiter, a Map of timestamps, no dependency.
- `src/auth/util.ts` (39): cookie parsing and redirect-URI and path-segment checks.

`src/wc/` (WalletConnect):

- `src/wc/client.ts` (561): the single-user WalletConnect transport. The only place that talks to the relay. The header notes the named-import trap: the package's default export is a constants object whose `.init` is undefined.
- `src/wc/hub.ts` (366): the multi-user hub. One SignClient per process, signing only via `signInteractionFor(topic, ...)`, topic never accepted from tool parameters.
- `src/wc/lifetime.ts` (47): pairing lifetimes. Persistent is 7 days, "once" is 15 minutes, and records written before lifetimes existed are aged from createdAt, so no record is exempt from expiry.
- `src/wc/store.ts` (152): file-backed per-user session store, filenames are sha256(userId) to block path traversal.
- `src/wc/redis-store.ts` (176): Redis versions of both the session store and WalletConnect's own key-value storage, so a replacement process holds both the topic and the key material behind it.
- `src/wc/session.ts` (100): the single-user on-disk session at `$MOI_MCP_HOME/session.json`, 0600.
- `src/wc/qr.ts` (17): pairing URI to PNG or terminal ASCII.

`src/moi/` (chain library, no MCP imports by rule):

- `src/moi/provider.ts` (224): network registry, provider factory, and the ReadOnlySigner (see custody below).
- `src/moi/ix-builder.ts` (565): builds unsigned interactions, documents the two encodings that are often confused (plain InteractionObject to the wallet, POLO hex to the node), fuel estimation (fuel is the compute cost a transaction may consume), and `quoteChainText`.
- `src/moi/reads.ts` (324): account, asset, interaction, and logic reads returning exactly the schema shapes, plus `clampChainText`.

`src/tools/` (what every tool shares):

- `src/tools/register.ts`: the one place a tool that can change something is put on a server, for the stdio and hosted servers. `registerTools(server, { mode })` is the whole list of each mode.
- `src/tools/register-gateway.ts`: the read gateway's list (its ping, the read tools, the resources). Imports no wallet, write or application code; the hosted server reuses it for its read half.
- `src/tools/define.ts`: `defineTool`, which builds a tool as data so only register.ts can put it on a server.
- `src/tools/ping.ts`: the stdio and HTTP health-check tools.
- `src/tools/wallet.ts` (stdio) and `src/tools/wallet-hosted.ts` (hosted): the pairing tools `moi_connect_wallet`, `moi_wallet_status`, `moi_disconnect_wallet`.
- `src/tools/local-writes.ts`: what the stdio server supplies to the write path: a constant local user, a store over `session.json`, a hub over the WalletConnect client, and a journal in `MOI_MCP_HOME`.
- `src/tools/write-core.ts`: the helpers every write shares: simulation, fuel measurement, the result envelope and the broadcast. Handles no signing and no session routing.
- `src/tools/hosted-writes.ts`: `runWrite`, the one write path.
- `src/tools/preview.ts`: the confirm-token registry for hosted writes.

`src/capabilities/` (what the node can do, by capability; imports nothing from `src/applications`):

- `src/capabilities/accounts/create-participant.ts`: `moi_create_account`.
- `src/capabilities/assets/`: `create.ts` (`moi_create_asset`), `shortcuts.ts` (`moi_transfer`, `moi_mint` and the standard guard), `execute.ts` (the half of `moi_asset_invoke` that needs the node and the write path), and the manifest reading, argument coding and one file per asset standard, which import nothing from `src/tools/`.
- `src/capabilities/logics/`: `invoke.ts` and `view.ts` (`moi_call_logic`).
- `src/capabilities/reads/`: `tools.ts` (the read tools) and `registry.ts` (agent-registry reads through getLogicDriver, deliberately avoiding `AgentRegistry.init()` because it demands a Signer with keys; it is here because the read gateway serves it).

`src/applications/` (products built on the write path; the core has none):

- `src/applications/registry/`: the agent registry's write tools (`tools.ts`) and what they prepare (`core.ts`).
- `src/applications/launchpad/`: the Agent Launchpad client, one-time download links, setup-script handling and tools.
- `src/applications/dapp/`: the generic dapp client, origin guard, encrypted session store and tools.

Other directories:

- `src/pairing/index.ts` (353): one-time HTTPS pairing link and page. A raw `wc:` URI embeds a live symmetric relay key, so this module is the only place a link-based URI is resolved and rendered, never logged, never written to disk.
- `src/resources/index.ts` (97): MCP resources, reference text an agent can read without a tool call: networks (which includes the registry logic id) and quickstart (registered at src/resources/index.ts:48 and 85).

## The five flows worth the most review time

### a. OAuth

The authorization server is implemented in this repo in src/auth/, and src/auth/index.ts's header carries the argument for why. Discovery metadata (RFC 8414), protected-resource metadata (RFC 9728), and dynamic client registration (RFC 7591, `/register`, rate limited to 10 per minute at src/auth/routes.ts:122) let claude.ai onboard with zero manual configuration. PKCE is the code-interception defense where the client sends a hash of a secret and later the secret itself; only the S256 method is accepted, enforced at src/auth/routes.ts:229 and advertised at line 101. Identity is the `moi_uid` browser cookie (name at src/auth/routes.ts:22): a random uid signed with an HMAC, a keyed hash that proves the server issued the value, using a persisted 0600 secret (src/auth/crypto.ts), so there are no accounts and no passwords. Tokens are opaque random strings stored only as sha256 hashes (src/auth/routes.ts:61 and 69; src/auth/store.ts), so a stolen data directory yields no usable bearer tokens. Access tokens live 3600 seconds, refresh tokens 30 days and rotate on use (src/auth/routes.ts:19, 20, 388). Places to check: redirect-URI validation in src/auth/util.ts, the wrong-client refresh path at routes.ts:370 (a wrong client_id must not become a way to invalidate someone else's token), and the consent decision limiter at routes.ts:259.

### b. Pairing

One WalletConnect SignClient exists per hosted process, owned by `WalletConnectHub` (src/wc/hub.ts, invariants in the header, lines 8 to 13). Sessions are keyed by topic, the relay's identifier for one wallet connection, and the topic is only ever resolved from the stored session record, never from tool input. Pairing and signing must run on the same SignClient: the comment at src/wc/hub.ts:149 records that a session paired on any other client is invisible to `signInteractionFor`, and PLAN-HOSTED.md's STATUS section records that manual verification caught exactly this bug before it shipped. The hosted `moi_connect_wallet` (src/server.ts:198) returns the QR image inline in the chat plus the raw URI as fallback text, with a comment at src/server.ts:231 defending the transcript exposure: the proposal expires after about five minutes or first use, and a hijacked pairing can raise prompts on a phone and cannot sign for it. Lifetimes live in src/wc/lifetime.ts: 7 days for a persistent pairing, 15 minutes for "just this once". The mode is picked in two ways. On the pairing page the user picks it directly (src/pairing/index.ts:178). In the hosted `moi_connect_wallet` call the model passes a `remember` argument that maps to the mode (src/server.ts:208 and 222), and the tool description instructs the model to ask the user before calling.

### c. The two-call write

The wallet app has nowhere to render a description (docs/upstream-issues.md, issue 6), so the phone shows raw decoded operation fields. The server's answer is that every hosted write is two tool calls, implemented in `runWrite` (src/tools/hosted-writes.ts:224) and `PreviewRegistry` (src/tools/preview.ts). Call one, without `confirm`, builds and simulates the full interaction, so a balance shortfall or a reverting call surfaces before the user is asked for a yes, and returns a one-sentence summary, the exact values the wallet will display, the fuel, and a confirm token. The token is bound to the user, the tool, and a canonical fingerprint of the arguments (src/tools/preview.ts:101 sorts keys so argument order does not matter), lives 10 minutes (`PREVIEW_TTL_MS`, line 28), and works once: `redeem` (line 59) deletes on match and refuses a token from another user or other arguments without invalidating the owner's token. If the freshly rebuilt numbers differ from what was previewed, hosted-writes.ts:247 discards the token and returns a fresh preview with a note. Any call without a redeemed token ends at line 250 with a preview, so nothing reaches the phone unconfirmed.

### d. Sign split from broadcast

The documented wallet call `moi.sendInteractions` crashes MOI Wallet with a SQLite NOT NULL error on every valid payload (docs/upstream-issues.md, issue 1, with the reproduction). So the server sends `moi.signInteraction` over WalletConnect (src/wc/hub.ts:274), the phone signs and returns `{ix_args, signatures}`, and the server broadcasts those bytes to the MOI node itself via `broadcastSigned` (src/tools/write-core.ts:220). The phone still shows the approval screen and still holds the only key. Every step lands in the write journal (src/journal.ts): proposed before the phone is contacted, signed after the tap, broadcast with the hash, then confirmed, since nothing later confirms from the server side and leaving broadcast non-terminal made every restart report a landed transaction as stranded (comment at src/tools/hosted-writes.ts:267). On boot, `reconcileJournalOnBoot` (src/server.ts:573) finalizes any broadcast entry that has a hash as confirmed and marks everything else orphaned, because the signed payload is never persisted and an orphaned entry cannot be safely re-broadcast.

### e. Custody

A private key would have to appear in one of three places: the signer used to build and simulate, the WalletConnect layer, or the broadcast path. It appears in none. `getReadOnlySigner` (src/moi/provider.ts:213) returns a `ReadOnlySigner` (line 150) whose `sign` (line 190) and `signInteraction` both throw `WALLET_NOT_CONNECTED` with the message "This MCP server holds no private keys." The interaction builder stops at the unsigned InteractionObject by construction (src/moi/ix-builder.ts header), src/wc/client.ts's header states the module never sees a private key, and `broadcastSigned` only forwards bytes the phone produced. A search confirms it:

```bash
grep -rni "privatekey\|mnemonic\|keypair" /Users/adithyaganesh/moi-mcp/src/
```

No matches.

## Security model in one page

What a stolen access token can do: call the read tools, see the paired wallet's address via `moi_wallet_status`, propose transactions, and push approval prompts to the victim's phone. What it cannot do: sign. The key is on the phone, and every send requires a tap there. The same bound holds for a stale pairing record: src/wc/lifetime.ts's header states that a pairing does not protect funds, it only lets its holder raise prompts and see which wallet is attached, and the lifetime limits how long that exposure lasts.

What a compromised server can do: a session record carries the symmetric relay key that lets its holder raise a signing prompt on somebody's phone (src/wc/redis-store.ts header), so a full server compromise means prompt-spamming and surveillance of paired accounts, and still no signing. A compromised server could also lie in previews; the mitigation is that the phone renders the raw operations itself, so the tap is on the wallet's own decode.

Rate limits: `/register` 10 per minute (src/auth/routes.ts:122), the consent decision 20 (line 259), `/token` 30 (line 393), and `/mcp` 240 (src/server.ts:436), all per-client sliding windows from src/auth/rate-limit.ts.

Headers (src/security-headers.ts): nosniff, `X-Frame-Options: DENY`, no-referrer, a Content-Security-Policy header (CSP) with `frame-ancestors 'none'`, and a Strict-Transport-Security header (HSTS) when the public URL is https. The stated target is clickjacking on the consent and pairing pages, the two places a browser click has consequences.

Chain text is treated as untrusted input to the model. `clampChainText` (src/moi/reads.ts:85) strips control characters and caps symbols and names at 64 characters, because asset symbols are chosen by whoever creates the asset. `quoteChainText` (src/moi/ix-builder.ts:426) does the same at 240 characters for revert reasons and wraps the result in quotes so it reads as something said, and never as an instruction. `cleanErrors` (src/clean-errors.ts) keeps stack traces and filesystem paths out of HTTP responses.

One recorded oddity worth knowing while reviewing writes: the storage fund deposited when creating an asset goes into the asset's own account and is not spent (src/capabilities/assets/create.ts labels it exactly that way in the preview).

## Tests

28 files under test/unit plus three helpers under test/helpers and one env-gated e2e file. The suite lists 419 cases:

```bash
npm test
```

The command runs vitest. A passing run ends with 419 passed. A failing run names each failed test and its file; read the file it names before anything else.

```bash
npx vitest list | wc -l
```

```
419
```

The mock MOI node (test/helpers/mock-node.ts) is an in-process HTTP server speaking exactly the JSON-RPC dialect js-moi-sdk sends, recording every request so tests can assert call order. test/helpers/harness.ts boots the real McpServer handlers over the SDK's own in-memory transport, so those tests exercise input validation, the handler, and output-schema validation on both sides. Real code runs for the tool layer, the builders, auth routes, the journal, and the preview registry; the store, hub, journal, and wallet are faked where the real thing needs a phone or a relay.

A coverage audit found weak spots, and a full test plan carrying that audit exists as separate work (docs/testing-plan.md). The known pattern is tests that assert against fakes that mirror the code instead of exercising it. Two concrete examples from test/unit/hosted-writes.test.ts:

- "single user can transfer, signing on their topic" (line 113) registers the tools and then never calls one. It asserts that `store.get(USER_A)` returns the record the test itself inserted and that the fake's spy was called, by calling the fake directly. A comment in the test admits it is "a simplified version".
- "network mismatch is caught before hub.signInteractionFor" (line 163) performs the network comparison inside the test body with its own `if`, then asserts the fake hub was never called. The production guard in `loadSession` never runs.

The later files fixed the pattern: test/helpers/hosted.ts's header states "A test that pokes the store directly would pass no matter what the handler did", and hosted-writes-crossuser.test.ts and hosted-writes-lifetime.test.ts drive the real handlers through it.

## Not merged on purpose

The branch `feat/mandates-v2` holds the delegated-authority work: MAS0 mandates, where the user approves a spending cap once on the phone and the agent then acts within it using a per-user agent key held by the server. It is complete end to end with 532 tests, and it is the one place the server would hold a key. PLAN-HOSTED.md's STATUS section (dated 2026-09-03) records the decision: "Left unmerged deliberately", because giving up the zero-key property should be a decision someone makes on purpose. Review master on the assumption that zero keys is an invariant; review the branch separately if that decision comes up.

## Suggested review order

Roughly two and a half hours of reading time.

1. PLAN-HOSTED.md STATUS section and docs/upstream-issues.md, 15 min. Context for every workaround you will meet.
2. src/schema.ts, 15 min. Every shape in the system.
3. src/server.ts, 25 min. The hosted entry point: lazy auth, GATED tools (line 69), per-tool scopes (line 87), boot reconciliation (line 573).
4. src/auth/routes.ts, 20 min, with src/auth/crypto.ts and src/auth/store.ts, 10 min.
5. src/tools/preview.ts, 5 min, then src/tools/hosted-writes.ts, 20 min. The two-call write.
6. src/tools/write-core.ts, 15 min. Build, simulate, broadcast.
7. src/wc/hub.ts, 15 min, and src/wc/lifetime.ts plus src/wc/store.ts plus src/wc/redis-store.ts, 10 min.
8. src/moi/ix-builder.ts, 15 min, and src/moi/provider.ts for the ReadOnlySigner, 5 min.
9. src/pairing/index.ts, 10 min. The URI-handling rules.
10. src/journal.ts, 5 min.
11. src/moi/reads.ts and src/capabilities/reads/registry.ts, 10 min.
12. src/index.ts, src/http.ts, src/tools/register.ts, src/tools/register-gateway.ts, src/capabilities/reads/tools.ts, src/tools/wallet.ts, src/tools/local-writes.ts, 10 min. The stdio and read-only paths reuse everything above.
13. test/helpers/ and the hosted-writes test trio, 15 min, reading hosted-writes.test.ts with the weak-test note above in hand.