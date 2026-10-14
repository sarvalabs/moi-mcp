# Deploying and operating the hosted MOI MCP server

This document supersedes docs/deploy-vm.md. Follow this one.

## What you are deploying

MCP (Model Context Protocol) is the protocol an AI client such as claude.ai uses to list and call tools on a server. You are deploying two Node.js processes built from one repository, github.com/sarvalabs/moi-mcp. The process definitions live in ecosystem.config.cjs at the repository root. The first process is `moi-mcp-read`, entry file dist/http.js, listening on port 8787. It answers read-only questions about the MOI blockchain over HTTP. It holds no keys, no sessions, and no user state, so you can run several copies of it. The second process is `moi-mcp-write`, entry file dist/server.js, listening on port 8788. It serves OAuth sign-in, wallet pairing, and the transaction tools. OAuth is the sign-in protocol the server runs itself; users need no account and no password.

The write gateway must stay one pm2 fork instance. ecosystem.config.cjs sets `instances: 1` and `exec_mode: "fork"` for it, with a comment explaining why. Two facts force this shape. First, OAuth authorization codes live only in process memory (src/auth/store.ts, top comment: codes are short-lived and single-use, so they are never written to disk). In pm2 cluster mode, requests spread across copies, and a code issued by one copy is unknown to the next. Second, the process holds one WalletConnect client, created once in main() in src/server.ts. WalletConnect is the protocol that connects the server to the user's phone through a relay, which is a message-passing service run by the relay provider. A request that lands on a copy without the user's pairing cannot reach that user's phone.

## Prerequisites

You need the following before starting.

A Linux VM with Node.js 20 or later. package.json declares `"engines": { "node": ">=20" }`, README.md requires Node.js 20 or later, and the Dockerfile builds on node:20-alpine (Dockerfile line 6). Treat 20 as the floor and the tested line.

git, to clone the repository.

nginx, to terminate TLS and proxy to the two processes. TLS is the encryption layer behind https; nginx decrypts incoming traffic and forwards plain HTTP to the two processes.

pm2, the process manager. Install it globally:

```bash
sudo npm install -g pm2
```

A domain with a DNS A record pointing at the VM. The examples below use mcp.voyage.moi.technology, the production write gateway. Use a hostname dedicated to this service. Do not put an HTTP to HTTPS redirect in front of the MCP path on this hostname: a redirect drops the Authorization header, and the client does not retry with it restored (docs/deploy-vm.md documented this failure; it presents as a connector that looks signed in and fails every call).

Redis is optional. See the Redis section.

A WalletConnect project id. This is a public identifier that lets the server and the phone find each other through the WalletConnect relay. It is free. Get one like this:

1. Sign in at https://cloud.reown.com (Reown is the company that runs the WalletConnect relay).
2. Create a project. Any name works.
3. Copy the Project ID from the project page.

The id is 32 hexadecimal characters. src/config.ts checks it against the pattern `/^[0-9a-f]{32}$/i` (function projectIdIssue) and test/unit/project-id.test.ts pins that behavior. A missing or placeholder value (REPLACE_ME, TODO, and similar) makes the write gateway refuse to start with a message naming cloud.reown.com.

## Every environment variable

The shared Config schema is defined in src/schema.ts lines 465 to 483 and loaded by src/config.ts (loadConfig). HostedConfigSchema is defined in src/config.ts (line 148) and read only by the write gateway. src/http.ts reads PORT. Empty strings count as unset and fall back to the default.

| Name | Required | Example | What it does | When missing or wrong |
|---|---|---|---|---|
| `PORT` | optional | `8787` | Port the read gateway listens on (src/http.ts, resolvePort, line 189). Default 8787. | A non-numeric value makes the process exit with "Invalid PORT". Blank falls back to 8787. |
| `HOSTED_PORT` | optional | `8788` | Port the write gateway listens on. Default 8788. When unset, the server falls back to `PORT` because hosting platforms inject that name (src/config.ts, loadHostedConfig). | Wrong value means nginx proxies to a port nobody listens on; you see 502. |
| `PUBLIC_URL` | required in production | `https://mcp.voyage.moi.technology` | The public origin of the write gateway. It is the OAuth issuer, meaning the identity the sign-in endpoints claim in the discovery document. It also decides whether the moi_uid cookie is marked Secure (src/auth/index.ts line 60: Secure only when the value starts with https://). | A mismatch with the real hostname makes sign-in fail in a way that looks like a client bug. Default is http://localhost:8788, which is wrong for any real deployment. |
| `MOI_DATA_DIR` | recommended | `/var/lib/moi-mcp` | Directory for the write gateway's state: OAuth clients and tokens, the cookie secret, wallet sessions, dapp sessions, the write journal. Created 0700 (src/config.ts, loadHostedConfig). Default `~/.moi-mcp-hosted`. | Losing the directory signs everyone out and un-pairs every wallet. See the data directory section. |
| `MOI_NETWORK` | optional | `voyage` | Which MOI network to talk to: voyage, mainnet, or custom (src/schema.ts line 466). Default voyage. | An invalid value fails config load; /health returns 503 with `ok:false`. `custom` without MOI_RPC_URL throws at load (src/config.ts). |
| `MOI_RPC_URL` | required when MOI_NETWORK=custom | `https://node.example/jsonrpc` | JSON-RPC endpoint of the MOI node, the HTTP API the server sends read queries and signed transactions to. | Missing while network is custom throws at config load. A wrong URL makes every read tool return an RPC error. |
| `MOI_EXPLORER_URL` | optional | `https://voyage.moi.technology` | Base URL used to build the explorer link included in write results (src/schema.ts line 470). Default https://voyage.moi.technology. | A wrong value produces dead links in tool output. Nothing else breaks. |
| `WC_PROJECT_ID` | required on the write gateway | `2f5a8c1de94b47f0a3c6e8b90d1a7c42` | The Reown project id, 32 hex characters, that authenticates this server to the WalletConnect relay (src/config.ts, projectIdIssue). | Missing or placeholder: the write gateway exits at boot with a message pointing to cloud.reown.com. The read gateway supplies itself a dummy and does not need it (src/http.ts line 204). |
| `REDIS_URL` | optional | `redis://:password@127.0.0.1:6379` | When set, wallet pairings and WalletConnect internal state move from files to Redis (src/server.ts main, src/wc/redis-store.ts). | An unreachable Redis makes the write gateway refuse to start and log a connection error at boot (connectRedis in src/wc/redis-store.ts is deliberately eager). Unset means file storage under MOI_DATA_DIR. |
| `LOG_LEVEL` | optional | `info` | Log verbosity: silent, error, info, or debug (src/schema.ts line 482). All logs go to stderr. Default error. | An invalid value fails config load. ecosystem.config.cjs sets info for both apps. |
| `MOI_SIGNED_CHECK` | optional | `enforce` | What the server does when the interaction MOI Wallet signed is not, byte for byte, one of the two encodings of the interaction it previewed (src/schema.ts, Config; src/moi/signed-check.ts; src/tools/write-core.ts, broadcastSigned). `warn`, the default, writes one error-level log line that gives lengths and never the bytes, and broadcasts as it always did. `enforce` refuses: nothing is broadcast, the write journal entry ends as `orphaned` with the reason, and the person is told that the wallet returned a different interaction than the one previewed and that nothing was sent. A match writes one info-level line in both modes. The write gateway and the stdio server share this path, so both read the setting. Leave it on `warn` until one real write has logged a match; the steps are in "Checking what the phone signed". | Unset or blank means `warn`. Any other value fails config load, as a bad `MOI_NETWORK` does: /health returns 503 with `ok:false` and the log names the variable. |
| `MOI_ACCOUNT_KEY_TOOLS` | optional | `on` | Whether the write gateway and the stdio server register moi_configure_account, the tool that adds keys to the person's account or revokes keys on it (src/schema.ts, Config; src/config.ts, accountKeyToolsOn; src/tools/register.ts). `off`, the default, leaves the tool out of tools/list, and a call to it is answered as an unknown tool with no sign-in prompt. A key added at full weight signs for the account alone, for good, and the phone shows only a hex string nobody can check by eye, so leave it off unless you have decided that chats may offer it. `on` registers it and everything works as it did. Changing it needs a pm2 restart. | Unset or blank means `off`. Any other value fails config load, as a bad `MOI_NETWORK` does: the write gateway exits at boot with a message naming the variable, and the stdio server starts, lists no such tool and reports the bad config from `ping`. |
| `HOSTED_TIMEOUT_MS` | optional | `240000` | Wall-clock budget in milliseconds for one hosted tool call, which includes waiting for a phone tap. Default 240000. claude.ai allows 300 seconds per call; stay under it (src/config.ts, HostedConfigSchema). | A value above 300000 makes claude.ai abandon calls the server is still serving. |
| `MOI_MCP_HOME` | optional | `~/.moi-mcp` | State directory for the local stdio server, created 0700 (src/schema.ts line 469). The hosted gateways create it but keep their state in MOI_DATA_DIR. | Irrelevant to the hosted deployment beyond directory creation. |
| `REQUEST_TIMEOUT_MS` | optional | `55000` | Phone-wait budget for the stdio server, default 55000 (src/schema.ts). The write gateway uses HOSTED_TIMEOUT_MS instead (src/server.ts passes hosted.HOSTED_TIMEOUT_MS to the hub). | No effect on the hosted deployment. |
| `MOI_AGENT_REGISTRY_LOGIC_ID` | optional | `0x200000002f3e9469...` | Overrides the agent registry logic id used by moi_resolve_agent (`registryLogicId` in src/capabilities/reads/registry.ts). Default is the registry redeployed after the September 2026 chain reset, pinned in src/capabilities/reads/registry.ts; the id shipped inside js-moi-agent-registry@0.3.0-rc1 is the pre-reset one and no longer exists. | A wrong id makes moi_resolve_agent return not found for every agent. |
| `MOI_READ_CALLER` | required on devnet | `0x00000000a27d9a3e...` | Participant id used as the caller for read-only logic simulation (`readCallerFromEnv` and `getReadOnlySigner` in src/moi/provider.ts). The current devnet rejects the placeholder identity, so every registry read (moi_resolve_agent, moi_list_agents, the registry lookup after moi_launchpad_register_agent) needs this set to any account that exists on the network. | Unset on devnet: registry reads, asset routine reads and logic view calls (moi_call_logic with kind view) fail with an error that says MOI_READ_CALLER must be set to a participant that exists on the network (src/moi/read-caller.ts). The error names the value when one is set and valid. An unparseable value is ignored and the placeholder is used; the error then says so, without repeating the value. |
| `MOI_LAUNCHPAD_URL` | optional | `https://launchpad.moi.technology` | The MOI Agent Launchpad the moi_launchpad_* tools act on (src/config.ts, HostedConfigSchema). The Launchpad has no sign-in tool of its own: a person signs in with moi_dapp_sign_in and this URL, which stores the session the Launchpad tools read, per user, under MOI_DATA_DIR/dapps, or in Redis next to the wallet sessions, for a day at most. It must be the Launchpad's own public https origin, the same value as its NEXT_PUBLIC_APP_URL, and be written as a bare origin: a path, query or fragment stops the server at boot, while upper case, a default port and a trailing dot or slash are normalised away. Sign-in is refused when the Launchpad's sign-in message names a different origin. moi_dapp_sign_in accepts only public https hosts, and the host must resolve to a public address from this server, so a Launchpad on localhost or plain http cannot be signed in to from the chat; its templates tool still works, and every other Launchpad tool needs a session. | A wrong value makes every Launchpad tool fail to reach the Launchpad, or, when it reaches the Launchpad under an address other than the one the Launchpad writes in its messages, makes moi_dapp_sign_in refuse with `Not signing` when given this URL; nothing else is affected. |
| `MOI_FAUCET_URL` | optional | `https://dev.voyage-rpc.moi.technology/devnet/v2/faucet` | The base address of the Voyage devnet faucet API, which the moi_faucet tool claims test KMOI from (src/config.ts, HostedConfigSchema; src/applications/faucet/). https only, with no query, fragment or credentials, and no default on purpose: a default that pointed at the wrong host would send the key there. The tool is listed only when this and `MOI_FAUCET_KEY` are both set and `MOI_NETWORK` is `voyage`. It claims for the address the person's wallet reported when it paired, never for one typed into the chat, and nothing asks the person before a claim. Each signed-in person gets 3 claims an hour from this server (in memory, so a restart clears it); that only stops a looping model. There is no cap on the shared key here: the faucet's own cooldown per account and the key's quota on the Voyage side are what limit the rest. Put it in `.env` next to the key. | Unset, set without the key, or on any network but voyage: the tool is not listed, and a half-set pair or a wrong network writes one `faucet:` error line at boot that never holds either value. A value the client refuses (not https, not a URL, a query, fragment or credentials, localhost, an IP address, a name with no dot) leaves the tool off with one fixed `faucet:` error line; it does not stop the server. A name that later resolves to a private address makes every claim answer that this server will not send anything to the faucet's address. |
| `MOI_FAUCET_KEY` | optional | a key from your Voyage dashboard (the Getting Started guide, "Creating an API key") | The API key the faucet requires. The faucet takes it as part of the address, `<MOI_FAUCET_URL>/<key>/claim`, so the key and the address built from it are both secrets. The server never logs either, never puts either in a tool result or an error, and never follows a redirect with it. If the faucet's own reply repeats the key (in any letter case, or with spaces or invisible characters between its letters), the whole reply is withheld; a faucet that echoes only part of the key, masked, is not caught. Keep it in `.env` with `WC_PROJECT_ID`, never in ecosystem.config.cjs (committed, and pm2 saves its env block in its dump file). | Unset: the tool is not listed. A key that is empty, over 256 characters or only dots leaves the tool off with a `faucet:` error line. A key the faucet refuses: moi_faucet answers that the server's key was not accepted, which only you can fix. To rotate it, edit `.env` and run `pm2 restart moi-mcp-write`. |
| `MOI_WC_PARAM_STYLE` | optional | `positional` | Payload shape for the wallet's sendInteractions call (src/wc/client.ts line 40). The live write path uses signInteraction and ignores this. | No effect today; leave unset. |
| `NODE_ENV` | optional | `production` | Standard Node convention. ecosystem.config.cjs sets it to production for both apps. The server's own config does not branch on it. | None. |

Put `WC_PROJECT_ID` in a `.env` file next to ecosystem.config.cjs. The server loads `.env` from its working directory (src/config.ts loads dotenv). ecosystem.config.cjs is committed to git; `.env` is not, and secrets must never go in the committed file (comment at the top of ecosystem.config.cjs).

## Install

1. Create the directory and clone.

```bash
sudo mkdir -p /opt/moi-mcp && sudo chown "$USER" /opt/moi-mcp
```

```bash
git clone https://github.com/sarvalabs/moi-mcp.git /opt/moi-mcp
```

2. Install exact locked dependencies. `npm ci` installs from package-lock.json and fails on any mismatch.

```bash
cd /opt/moi-mcp && npm ci
```

3. Build. package.json defines `"build": "tsup"`, which compiles src/ to dist/.

```bash
cd /opt/moi-mcp && npm run build
```

4. Confirm the entry files exist.

```bash
ls /opt/moi-mcp/dist/http.js /opt/moi-mcp/dist/server.js
```

```
/opt/moi-mcp/dist/http.js  /opt/moi-mcp/dist/server.js
```

If either file is missing, the build failed; read the tsup output above.

5. Create the config file and data directory.

```bash
printf 'WC_PROJECT_ID=your_32_character_id_here\n' > /opt/moi-mcp/.env && chmod 600 /opt/moi-mcp/.env
```

```bash
sudo mkdir -p /var/lib/moi-mcp && sudo chown "$USER" /var/lib/moi-mcp && chmod 700 /var/lib/moi-mcp
```

6. Edit ecosystem.config.cjs and set `PUBLIC_URL` in the moi-mcp-write env block to your real hostname. The committed value is https://mcp.voyage.moi.technology.

## Run

Start both apps from the repository root, so the write gateway finds `.env`.

```bash
cd /opt/moi-mcp && pm2 start ecosystem.config.cjs
```

Persist the process list so pm2 restores it after a reboot.

```bash
pm2 save
```

Install the boot hook. This prints one sudo command; run that printed command.

```bash
pm2 startup
```

Check status.

```bash
pm2 status
```

The table must show `moi-mcp-read` and `moi-mcp-write`, both `online`, moi-mcp-write in mode `fork` with 1 instance. A status of `errored` with rising restarts on moi-mcp-write usually means a bad `WC_PROJECT_ID`; read the error log (see Logs).

## nginx

One server block fronts both processes. The MCP path of the write gateway needs three things beyond a plain proxy. `proxy_read_timeout` must be 300 seconds, the value the repository's own nginx block sets (docs/deploy-vm.md line 116). A signing request holds the HTTP connection open while a person finds their phone, and claude.ai allows 300 seconds per tool call (src/config.ts line 156); a shorter timeout makes nginx cut the held connection before the client's own deadline. `proxy_buffering off` is required because the MCP endpoint streams responses as server-sent events, a format where the server sends the response in pieces over a held connection; with buffering on, nginx waits for the whole response and the service looks healthy while never answering. `proxy_set_header X-Forwarded-For $remote_addr` is required because the rate limiter keys on the client address. The app trusts only the last entry of that header, and only when the connection comes from this machine (src/auth/rate-limit.ts, function clientAddress); overwriting the header with `$remote_addr` discards anything the sender wrote. Leaving the line out passes the sender's own header through, and the limiter would key on text the sender controls.

Paste this block, replacing the hostname:

```nginx
server {
    listen 80;
    server_name mcp.voyage.moi.technology;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;  # required: the app rate-limits per client address
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        gzip off;
    }
}
```

This proxies everything to the write gateway on 8788, which serves the landing page, OAuth, pairing, and /mcp. Keep the `X-Forwarded-For $remote_addr` line exactly as written; the reason is in the nginx section above. One more constraint: nginx must connect to the gateways from this same machine (127.0.0.1, as the block does). A proxy connecting from any other address, for example from a separate container over a Docker bridge, makes the limiter ignore the header and key every client on the proxy address, which collapses all users into one shared rate bucket. If you also expose the read gateway publicly, give it its own hostname with the same block pointed at 8787.

Test and load the config.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Get a certificate. certbot edits the block in place, adds the TLS listener, and installs a renewal timer.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d mcp.voyage.moi.technology
```

When certbot adds an HTTP to HTTPS redirect, that is fine for browsers hitting the landing page; the connector URL you hand out must be the https one, so the Authorization header never crosses a redirect.

## Redis

Redis is optional. When `REDIS_URL` is unset, the write gateway stores wallet pairings as files under `MOI_DATA_DIR/sessions/` and WalletConnect's internal key material as `MOI_DATA_DIR/wc.db` (src/server.ts main: "wallet sessions on disk under ..."). On a VM with a stable disk that is enough.

When `REDIS_URL` is set, two stores move to Redis together: the server's own record of which wallet belongs to which user (RedisWalletSessionStore) and the WalletConnect SDK's internal state (RedisKeyValueStorage), both in src/wc/redis-store.ts. They move together on purpose: the session record holds the topic and the SDK state holds the key material, and a replacement process needs both halves to sign for a user (comment in src/server.ts main).

Requirements when you use it: set a password (the records carry the symmetric key that lets the holder raise a signing prompt on somebody's phone, per the file comment in src/wc/redis-store.ts) and enable appendonly persistence. A Redis running as a plain cache comes back empty after a restart and silently un-pairs every user.

Failure behavior: connectRedis is called at boot and is deliberately eager, so an unreachable Redis makes the write gateway refuse to start with a logged connection error (the URL itself is never logged because it carries the password). Redis going down while the process runs makes wallet tool calls fail until it returns. There is no automatic fallback to files; the fallback exists only as the default when `REDIS_URL` is unset.

## Verify the deployment

Read gateway health (shape from src/http.ts, the /health handler):

```bash
curl -s http://localhost:8787/health
```

```
{"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}
```

Write gateway health (shape from src/server.ts, buildHostedApp, line 349):

```bash
curl -s http://localhost:8788/health
```

```
{"ok":true,"network":"voyage","readOnly":false,"pairingMounted":true}
```

`ok:false` with status 503 means the config failed to load; check the error log. `pairingMounted:false` means main() did not wire the pairing page, which does not happen in the shipped entry point.

OAuth discovery document (shape from src/auth/routes.ts, mountMetadata):

```bash
curl -s https://mcp.voyage.moi.technology/.well-known/oauth-authorization-server
```

```
{"issuer":"https://mcp.voyage.moi.technology","authorization_endpoint":"https://mcp.voyage.moi.technology/authorize","token_endpoint":"https://mcp.voyage.moi.technology/token","registration_endpoint":"https://mcp.voyage.moi.technology/register","scopes_supported":["moi:read","moi:write"],"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_post"]}
```

The issuer must equal your `PUBLIC_URL` exactly. If it shows http://localhost:8788, the env block did not reach the process; check `pm2 env` or restart after fixing ecosystem.config.cjs.

List the tools. tools/list is public, and so are calls to ping and the read tools. Only calls to the wallet and write tools require a token (src/server.ts lines 375 to 380, the lazy-auth gate; the gated tool list is at src/server.ts lines 70 to 76).

```bash
curl -s -X POST https://mcp.voyage.moi.technology/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists 33 tools, or 34 when the devnet faucet is configured (`MOI_FAUCET_URL` and `MOI_FAUCET_KEY` set, network voyage): ping, the eight reads, the three wallet tools, the ten write tools, the Launchpad tools, the dapp tools and, with the faucet configured, moi_faucet. With `MOI_ACCOUNT_KEY_TOOLS=on` there is one more write tool, moi_configure_account, after moi_create_account. The list is src/tools/register.ts, README.md under Tools has the table, and test/unit/__snapshots__/tools-hosted.json pins it. The read gateway on 8787 lists 43: ping, the eight reads and the 34 `moi_rpc_*` node method tools.

Finally, in claude.ai: Settings, Connectors, Add custom connector, paste https://mcp.voyage.moi.technology/mcp, and choose OAuth as the auth mode. Choosing None on the write gateway makes sign-in impossible.

## The data directory

Everything the write gateway persists lives under `MOI_DATA_DIR` (the ecosystem file sets /var/lib/moi-mcp). The directory is created mode 0700 and every file inside is written mode 0600.

| Path | What it is | Source |
|---|---|---|
| `auth/clients/<clientId>.json` | OAuth client registrations created by claude.ai's dynamic registration. | src/auth/store.ts, ClientStore |
| `auth/tokens/<sha256>.json` | Access and refresh token records, filed by token hash. | src/auth/store.ts, TokenStore |
| `auth/cookie-secret` | 32 random bytes that sign the moi_uid browser cookie. | src/auth/crypto.ts, loadOrCreateCookieSecret; path set in src/auth/index.ts line 46 |
| `sessions/<sha256(userId)>.json` | One wallet pairing per user. | src/wc/store.ts, FileWalletSessionStore |
| `dapps/<sha256>.json` | One dapp session per user and dapp (Launchpad included), kept for a day at most. The file name is a hash of the user and the dapp. | src/applications/dapp/store.ts, FileDappSessionStore |
| `journal.jsonl` | Append-only write journal recording proposed, signed, broadcast, confirmed, failed, and orphaned states for every transaction (src/journal.ts line 16). | src/journal.ts line 41 |
| `wc.db` | The WalletConnect client's own state: the key chain with the symmetric key of every pairing and the relay identity, the subscriptions, the pending requests and the request history. It is never per-user data. Not used when `REDIS_URL` is set. | src/wc/hub.ts |

Back up the whole directory (skip the backup entirely if `REDIS_URL` is set, and back up Redis instead; journal.jsonl stays on disk either way).

What losing each piece costs:

Losing `auth/cookie-secret` regenerates a new secret on next boot. Every existing moi_uid cookie then fails HMAC verification (an HMAC is a keyed hash; the server signs each cookie with the secret and rejects any cookie whose signature does not match), so every browser is silently assigned a fresh identity. Their tokens and pairings still exist but belong to the old identity, so users must sign in and pair again.

Losing `auth/tokens/` invalidates every issued token. claude.ai gets 401 and shows the Connect card; users re-run OAuth consent.

Losing `sessions/` or `wc.db` un-pairs every wallet. They are two halves of one pairing (the record names the topic, `wc.db` holds the key behind it), so losing either ends every pairing. Users scan a new QR code with the phone app.

Losing `dapps/` signs everyone out of every dapp, one phone tap each to sign in again.

Losing `journal.jsonl` loses the audit history of past writes. No funds are at risk; the chain itself is the record.

## Restarts and upgrades

Across a restart, everything in the data directory survives: sign-ins, tokens, pairings, and the journal. Two things do not survive: OAuth authorization codes mid-consent (in memory only, src/auth/store.ts) and any tool call in flight.

At boot the server reconciles the journal (src/server.ts, reconcileJournalOnBoot). Two log lines are normal after a crash:

An entry that had reached `broadcast` with a hash is marked confirmed, with the line "had broadcast before exit; recording it confirmed". The node accepted it before the crash.

An entry left in `proposed` or `signed` is marked orphaned, with an error line saying it "cannot be safely re-broadcast; marking orphaned". The server never persists the signed payload, so replaying it is impossible by design. This line after a crash mid-approval is expected and needs no action; the user retries the action in chat.

To upgrade:

```bash
cd /opt/moi-mcp && git pull
```

```bash
cd /opt/moi-mcp && npm ci && npm run build
```

```bash
pm2 reload moi-mcp-read
```

```bash
pm2 restart moi-mcp-write
```

Use restart, never reload, for the write gateway. Reload overlaps the old and new process on purpose. Two write gateways at once both connect to the relay with the same WalletConnect identity, and the relay delivers each message to only one of them (comment in ecosystem.config.cjs). The two-second gap is the cheaper failure.

## Logs

pm2 writes each app's stdout to `~/.pm2/logs/<app>-out.log` and stderr to `~/.pm2/logs/<app>-error.log` for the user that started pm2. The server logs to stderr only, one line per event, prefixed `[moi-mcp]` (src/config.ts, function log), so the error log is the one that matters.

```bash
pm2 logs moi-mcp-write --lines 100
```

The code never prints a bearer token, a cookie, or a pairing URL (comment at src/server.ts lines 653 to 654), and it never prints the Redis URL, which carries the password (src/wc/redis-store.ts line 53), or the faucet's key or the address built from it (src/applications/faucet/client.ts). Each faucet claim writes one `faucet: user <id> -> <outcome>` line at info level, so it is recorded only when `LOG_LEVEL` is `info` or `debug` (ecosystem.config.cjs sets `info` for both apps; the default is `error`, which records nothing about a claim). If you ever see one of these values in a log line, that is a bug: report it to the repository immediately and rotate the leaked value.

## Checking what the phone signed

The server builds an interaction, simulates it, shows it to the person, sends it to the phone, and broadcasts the bytes the phone returns. Before it broadcasts, it compares those bytes with the interaction it previewed (src/tools/write-core.ts, checkSigned; src/moi/signed-check.ts). It accepts exactly two encodings of that interaction: the one a wallet makes from the JSON it receives, and the one it makes if it turns every integer into a bigint first. They are the same bytes unless the interaction carries a bigint, as a create does. No real MOI Wallet answer has been compared with either, so the check ships in `warn`: a mismatch is logged and the broadcast goes ahead as before. A false refusal after the person has already approved on the phone is the worst outcome this check can cause, and `enforce` is only switched on once a real write has shown a match.

| `MOI_SIGNED_CHECK` | A match | A mismatch |
|---|---|---|
| `warn` (default) | One info-level line: `signed check (warn): the interaction MOI Wallet signed matches the preview as the ...`. Broadcast. | One error-level line: `signed check (warn): ... not byte for byte the one that was previewed (the answer is N hex characters, the wire form is M and the full-width form is K); broadcasting it anyway ...`. Broadcast. |
| `enforce` | The same info-level line, with `(enforce)`. Broadcast. | One error-level line ending `refusing to broadcast it`. Nothing is broadcast. The journal entry goes proposed, signed, orphaned, with the reason. The person is told: `[RPC_ERROR] MOI Wallet returned a different interaction than the one that was previewed. Nothing was sent to the network ...`. |

The lines hold lengths and form names, never the bytes, so they are safe to paste into a message. A mismatch is logged at error level, which shows at the default `LOG_LEVEL`. The match line is info level, so it is recorded only when `LOG_LEVEL` is `info` or `debug`: ecosystem.config.cjs sets `info` for both apps, and a stdio server needs `LOG_LEVEL=info` in the `env` block of the MCP client's config for the capture below.

To move from `warn` to `enforce`:

1. Make sure the write gateway is logging at info level, and that it runs the release that carries this check.
2. Make one real write on devnet with a real phone. A transfer of 1 base unit of KMOI to an account you own is enough. A `moi_create_asset` is worth doing once as well: its interaction carries a bigint, so its line says which integer width the wallet signs, where a transfer reports both because the two encodings are the same bytes for it.
3. Read the log for that write:

```bash
pm2 logs moi-mcp-write --lines 300 --nostream | grep 'signed check'
```

4. If the line says `matches the preview`, go on. If it says `not byte for byte the one that was previewed`, do not enforce: leave `warn`, and send the whole line, and which tool you used, to whoever maintains the wallet. Equal lengths with a mismatch mean a value differs and the shape does not (a fee, a sequence number, a recipient). Different lengths mean a field was added or dropped, or an integer was written at another width. The line cannot say whether the difference is harmless (the wallet encodes the same interaction another way, which is the reason this ships in `warn`) or a real change to what the person approved, so a mismatch is something to understand before enforcing, not to switch past.
5. Set `MOI_SIGNED_CHECK=enforce` in `/opt/moi-mcp/.env` (edit the line if there is one), then `pm2 restart moi-mcp-write`. Use restart, never reload, for the reason given under "Restarts and upgrades".
6. Make one more write and confirm it still succeeds, and that its line now says `signed check (enforce)`.

What a refusal leaves behind. The phone had signed, so the journal entry ends `orphaned`, with the message the person saw as its detail: `grep orphaned <MOI_DATA_DIR>/journal.jsonl`. An `orphaned` entry is final, and the boot-time reconcile does not touch it. Nothing was broadcast, so nothing is on chain and nothing needs undoing. The person has to start again from a fresh preview, because the confirm token was spent, and should look at what the phone shows before approving. A pairing made "just this once" is not forgotten by a refused write; it stays usable until its 15-minute expiry. Nothing alerts on an `orphaned` entry: the error-level log line is the only trace besides the journal.

To back out, set the value to `warn` or delete the line, and `pm2 restart moi-mcp-write`. The stdio server reads the same setting from its own environment and journals to `MOI_MCP_HOME/journal.jsonl`.

## Watching upstream releases

Three MOI projects change what this server does without changing its code: js-moi-sdk (a dependency), go-moi (the chain) and cocolang (the logic language). The go-moi v0.13.0 upgrade broke asset creation here in September 2026 and went unnoticed for about a week. Three automations cover this.

Dependabot (`.github/dependabot.yml`) opens a pull request when an npm dependency publishes a new version. The js-moi-sdk packages move together in one pull request. CI runs the full suite against it. Nothing merges automatically, because an SDK change can change what a user signs.

The upstream watch (`.github/workflows/upstream-watch.yml`) runs daily and files an issue labelled `upstream-release` for each new release of the three projects. go-moi and cocolang are private repositories, and a workflow's built-in token can read only its own repository, so those two need a repository secret named `UPSTREAM_READ_TOKEN`: a fine-grained personal access token with read-only "Contents" access to `sarvalabs/go-moi` and `sarvalabs/cocolang`. Without the secret, the watch skips those two with a warning and still covers js-moi-sdk.

The chain canary (`.github/workflows/chain-canary.yml`) runs nightly against the live voyage devnet. It reads KMOI and simulates the asset-create and transfer interactions this server builds. It also watches the storage floor (`MEASURED_STORAGE_FLOOR` in src/moi/ix-builder.ts): a create funded 5 percent above it must simulate, one funded 10 percent below it must fail, and the node's storage pricing must still be the three strings it was on 2 October 2026. Any of those failing means the floor has to be measured again, and the comment above the constant says how. Simulation signs nothing and spends no fuel. When the chain rejects something, the canary opens an issue labelled `chain-canary`, and the next green run closes it. Run it by hand with `MOI_E2E=1 npx vitest run test/e2e/chain-canary.test.ts`.

## What the CI/CD pipeline should do

On every pull request, run these four commands and require all of them to pass before merge:

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

The suite is 419 tests (PLAN-HOSTED.md line 92) and all must pass.

```bash
npm run build
```

The script names come from package.json: typecheck is `tsc --noEmit`, test is `vitest run`, build is `tsup`.

Deploy only after review approval and merge to main. The deploy job is the upgrade sequence from the previous section: git pull, npm ci, npm run build, `pm2 reload moi-mcp-read`, `pm2 restart moi-mcp-write`. Never deploy an unmerged branch to the box.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| nginx returns 502 | The Node process is down or listening on a different port. | Run `pm2 status`. If moi-mcp-write is errored, read `~/.pm2/logs/moi-mcp-write-error.log`; a fatal line about WC_PROJECT_ID means the .env file is missing or wrong. Confirm `proxy_pass` matches HOSTED_PORT. |
| Tool calls fail during long phone waits | `proxy_read_timeout` is below the 300 second client budget, so nginx cuts the held connection during the phone wait. | Set `proxy_read_timeout 300s;` and `proxy_send_timeout 300s;` on the proxied location (docs/deploy-vm.md line 116), then reload nginx. |
| Sign-in loops: consent completes, then the connector asks again | `PUBLIC_URL` does not match the domain users reach, so the OAuth issuer is wrong; or the site is plain http, so the moi_uid cookie is marked Secure (src/auth/index.ts line 60) and the browser never sends it back. | Set `PUBLIC_URL` to the exact https origin, serve only over TLS, and restart moi-mcp-write. Verify with the discovery curl above. |
| Scanning the QR code does nothing on the phone | `WC_PROJECT_ID` is missing, a placeholder, or misshapen, so the relay rejects the pairing (src/config.ts, projectIdIssue). | Put the real 32 hex character id in /opt/moi-mcp/.env and restart moi-mcp-write. The boot log names the problem when the id is unusable. |
| Wallet pairs, then every write fails with a network mismatch error | The phone approved a session on a different chain than `MOI_NETWORK` (error code NETWORK_MISMATCH, src/schema.ts line 492). | Set `MOI_NETWORK` on the server to the network the wallet app is on, restart moi-mcp-write, and have the user disconnect and pair again. |
| /health returns 503 with `ok:false` | The shared config failed to load, usually a bad `MOI_NETWORK` or `MOI_NETWORK=custom` without `MOI_RPC_URL`. | Read the error log; the message names the variable. Fix it and restart. |
| Users all signed out after a data restore | `auth/cookie-secret` changed, so every cookie fails verification. | Restore the original file from backup. If it is gone, users sign in and pair again; nothing else can recover the old identities. |
| Every write is refused with "MOI Wallet returned a different interaction than the one that was previewed" | `MOI_SIGNED_CHECK=enforce` is set and the wallet's answer is not one of the two encodings the server accepts (src/moi/signed-check.ts). | Set it to `warn`, or delete the line, and `pm2 restart moi-mcp-write`. Then read the `signed check` lines as in "Checking what the phone signed" before enforcing again. |