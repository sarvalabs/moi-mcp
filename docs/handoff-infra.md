# Deploying and operating the hosted MOI MCP server

This document supersedes docs/deploy-vm.md. Follow this one.

## What you are deploying

MCP (Model Context Protocol) is the protocol an AI client such as claude.ai uses to list and call tools on a server. You are deploying two Node.js processes built from one repository, github.com/sarvalabs-adithya/moi-mcp. The process definitions live in ecosystem.config.cjs at the repository root. The first process is `moi-mcp-read`, entry file dist/http.js, listening on port 8787. It answers read-only questions about the MOI blockchain over HTTP. It holds no keys, no sessions, and no user state, so you can run several copies of it. The second process is `moi-mcp-write`, entry file dist/server.js, listening on port 8788. It serves OAuth sign-in, wallet pairing, and the transaction tools. OAuth is the sign-in protocol the server runs itself; users need no account and no password.

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

A domain with a DNS A record pointing at the VM. The examples below use mcp.moi.technology. Use a hostname dedicated to this service. Do not put an HTTP to HTTPS redirect in front of the MCP path on this hostname: a redirect drops the Authorization header, and the client does not retry with it restored (docs/deploy-vm.md documented this failure; it presents as a connector that looks signed in and fails every call).

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
| `PUBLIC_URL` | required in production | `https://mcp.moi.technology` | The public origin of the write gateway. It is the OAuth issuer, meaning the identity the sign-in endpoints claim in the discovery document. It also decides whether the moi_uid cookie is marked Secure (src/auth/index.ts line 60: Secure only when the value starts with https://). | A mismatch with the real hostname makes sign-in fail in a way that looks like a client bug. Default is http://localhost:8788, which is wrong for any real deployment. |
| `MOI_DATA_DIR` | recommended | `/var/lib/moi-mcp` | Directory for the write gateway's state: OAuth clients and tokens, the cookie secret, wallet sessions, the write journal. Created 0700 (src/config.ts, loadHostedConfig). Default `~/.moi-mcp-hosted`. | Losing the directory signs everyone out and un-pairs every wallet. See the data directory section. |
| `MOI_NETWORK` | optional | `voyage` | Which MOI network to talk to: voyage, mainnet, or custom (src/schema.ts line 466). Default voyage. | An invalid value fails config load; /health returns 503 with `ok:false`. `custom` without MOI_RPC_URL throws at load (src/config.ts). |
| `MOI_RPC_URL` | required when MOI_NETWORK=custom | `https://node.example/jsonrpc` | JSON-RPC endpoint of the MOI node, the HTTP API the server sends read queries and signed transactions to. | Missing while network is custom throws at config load. A wrong URL makes every read tool return an RPC error. |
| `MOI_EXPLORER_URL` | optional | `https://voyage.moi.technology` | Base URL used to build the explorer link included in write results (src/schema.ts line 470). Default https://voyage.moi.technology. | A wrong value produces dead links in tool output. Nothing else breaks. |
| `WC_PROJECT_ID` | required on the write gateway | `2f5a8c1de94b47f0a3c6e8b90d1a7c42` | The Reown project id, 32 hex characters, that authenticates this server to the WalletConnect relay (src/config.ts, projectIdIssue). | Missing or placeholder: the write gateway exits at boot with a message pointing to cloud.reown.com. The read gateway supplies itself a dummy and does not need it (src/http.ts line 204). |
| `REDIS_URL` | optional | `redis://:password@127.0.0.1:6379` | When set, wallet pairings and WalletConnect internal state move from files to Redis (src/server.ts main, src/wc/redis-store.ts). | An unreachable Redis makes the write gateway refuse to start and log a connection error at boot (connectRedis in src/wc/redis-store.ts is deliberately eager). Unset means file storage under MOI_DATA_DIR. |
| `LOG_LEVEL` | optional | `info` | Log verbosity: silent, error, info, or debug (src/schema.ts line 482). All logs go to stderr. Default error. | An invalid value fails config load. ecosystem.config.cjs sets info for both apps. |
| `HOSTED_TIMEOUT_MS` | optional | `240000` | Wall-clock budget in milliseconds for one hosted tool call, which includes waiting for a phone tap. Default 240000. claude.ai allows 300 seconds per call; stay under it (src/config.ts, HostedConfigSchema). | A value above 300000 makes claude.ai abandon calls the server is still serving. |
| `MOI_MCP_HOME` | optional | `~/.moi-mcp` | State directory for the local stdio server, created 0700 (src/schema.ts line 469). The hosted gateways create it but keep their state in MOI_DATA_DIR. | Irrelevant to the hosted deployment beyond directory creation. |
| `REQUEST_TIMEOUT_MS` | optional | `55000` | Phone-wait budget for the stdio server, default 55000 (src/schema.ts). The write gateway uses HOSTED_TIMEOUT_MS instead (src/server.ts passes hosted.HOSTED_TIMEOUT_MS to the hub). | No effect on the hosted deployment. |
| `MOI_AGENT_REGISTRY_LOGIC_ID` | optional | `0x20000000c684...` | Overrides the agent registry logic id used by moi_resolve_agent (src/moi/registry.ts line 24). Default is the canonical registry id shipped inside js-moi-agent-registry@0.3.0-rc1 (src/moi/registry.ts line 20). | A wrong id makes moi_resolve_agent return not found for every agent. |
| `MOI_READ_CALLER` | optional | `0x...` | Participant id used as the caller for read-only logic simulation (src/moi/provider.ts line 215). Needed on networks where the placeholder identity is rejected. | An unparseable value is ignored and the placeholder is used. |
| `MOI_WC_PARAM_STYLE` | optional | `positional` | Payload shape for the wallet's sendInteractions call (src/wc/client.ts line 40). The live write path uses signInteraction and ignores this. | No effect today; leave unset. |
| `NODE_ENV` | optional | `production` | Standard Node convention. ecosystem.config.cjs sets it to production for both apps. The server's own config does not branch on it. | None. |

Put `WC_PROJECT_ID` in a `.env` file next to ecosystem.config.cjs. The server loads `.env` from its working directory (src/config.ts loads dotenv). ecosystem.config.cjs is committed to git; `.env` is not, and secrets must never go in the committed file (comment at the top of ecosystem.config.cjs).

## Install

1. Create the directory and clone.

```bash
sudo mkdir -p /opt/moi-mcp && sudo chown "$USER" /opt/moi-mcp
```

```bash
git clone https://github.com/sarvalabs-adithya/moi-mcp.git /opt/moi-mcp
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

6. Edit ecosystem.config.cjs and set `PUBLIC_URL` in the moi-mcp-write env block to your real hostname. The committed value is https://mcp.moi.technology.

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
    server_name mcp.moi.technology;

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
sudo certbot --nginx -d mcp.moi.technology
```

When certbot adds an HTTP to HTTPS redirect, that is fine for browsers hitting the landing page; the connector URL you hand out must be the https one, so the Authorization header never crosses a redirect.

## Redis

Redis is optional. When `REDIS_URL` is unset, the write gateway stores wallet pairings as files under `MOI_DATA_DIR/sessions/` and WalletConnect's internal key material under the same data directory (src/server.ts main: "wallet sessions on disk under ..."). On a VM with a stable disk that is enough.

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
curl -s https://mcp.moi.technology/.well-known/oauth-authorization-server
```

```
{"issuer":"https://mcp.moi.technology","authorization_endpoint":"https://mcp.moi.technology/authorize","token_endpoint":"https://mcp.moi.technology/token","registration_endpoint":"https://mcp.moi.technology/register","scopes_supported":["moi:read","moi:write"],"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_post"]}
```

The issuer must equal your `PUBLIC_URL` exactly. If it shows http://localhost:8788, the env block did not reach the process; check `pm2 env` or restart after fixing ecosystem.config.cjs.

List the tools. tools/list is public, and so are calls to ping and the read tools. Only calls to the wallet and write tools require a token (src/server.ts lines 375 to 380, the lazy-auth gate; the gated tool list is at src/server.ts lines 70 to 76).

```bash
curl -s -X POST https://mcp.moi.technology/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists 13 tools: ping, moi_get_account, moi_get_asset, moi_get_interaction, moi_get_logic, moi_resolve_agent (registered in src/http.ts and src/tools/reads.ts), moi_connect_wallet, moi_wallet_status, moi_disconnect_wallet (src/server.ts), moi_transfer, moi_create_asset, moi_mint, moi_call_logic (src/tools/hosted-writes.ts). The read gateway on 8787 lists the first 6 only.

Finally, in claude.ai: Settings, Connectors, Add custom connector, paste https://mcp.moi.technology/mcp, and choose OAuth as the auth mode. Choosing None on the write gateway makes sign-in impossible.

## The data directory

Everything the write gateway persists lives under `MOI_DATA_DIR` (the ecosystem file sets /var/lib/moi-mcp). The directory is created mode 0700 and every file inside is written mode 0600.

| Path | What it is | Source |
|---|---|---|
| `auth/clients/<clientId>.json` | OAuth client registrations created by claude.ai's dynamic registration. | src/auth/store.ts, ClientStore |
| `auth/tokens/<sha256>.json` | Access and refresh token records, filed by token hash. | src/auth/store.ts, TokenStore |
| `auth/cookie-secret` | 32 random bytes that sign the moi_uid browser cookie. | src/auth/crypto.ts, loadOrCreateCookieSecret; path set in src/auth/index.ts line 46 |
| `sessions/<sha256(userId)>.json` | One wallet pairing per user. | src/wc/store.ts, FileWalletSessionStore |
| `journal.jsonl` | Append-only write journal recording proposed, signed, broadcast, confirmed, failed, and orphaned states for every transaction (src/journal.ts line 16). | src/journal.ts line 41 |
| `wc-relay-scratch/` | The shared WalletConnect client's own internal session file. It is never per-user data (comment in src/config.ts, loadHostedConfig). | src/config.ts |

Back up the whole directory (skip the backup entirely if `REDIS_URL` is set, and back up Redis instead; journal.jsonl stays on disk either way).

What losing each piece costs:

Losing `auth/cookie-secret` regenerates a new secret on next boot. Every existing moi_uid cookie then fails HMAC verification (an HMAC is a keyed hash; the server signs each cookie with the secret and rejects any cookie whose signature does not match), so every browser is silently assigned a fresh identity. Their tokens and pairings still exist but belong to the old identity, so users must sign in and pair again.

Losing `auth/tokens/` invalidates every issued token. claude.ai gets 401 and shows the Connect card; users re-run OAuth consent.

Losing `sessions/` un-pairs every wallet. Users scan a new QR code with the phone app.

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

The code never prints a bearer token, a cookie, or a pairing URL (comment at src/server.ts lines 653 to 654), and it never prints the Redis URL, which carries the password (src/wc/redis-store.ts line 53). If you ever see one of these values in a log line, that is a bug: report it to the repository immediately and rotate the leaked value.

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