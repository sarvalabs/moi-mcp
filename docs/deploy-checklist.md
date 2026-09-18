# MOI MCP gateway — deployment guide

## What this is

This service lets AI assistants (Claude and anything else that speaks MCP)
work with the MOI chain. A user adds one URL as a connector in their
assistant, and can then ask questions about accounts, assets, logics and
interactions in plain language — and, after pairing MOI Wallet once by
scanning a QR code, ask the assistant to make transactions: create an asset,
mint, transfer, call a logic.

**The server never holds a private key.** Every transaction is signed on the
user's own phone: the server builds the interaction, sends a signing request
to MOI Wallet over WalletConnect, the user approves on the phone, and the
server broadcasts the signed result and records the receipt. Reads are a
protocol translation only — each tool call becomes a JSON-RPC request to the
voyage endpoint MOI already serves.

## Technical components

Two independent Node.js services, both in this repo, built by `npm run build`:

| | Read gateway | Write gateway |
|---|---|---|
| Entry point | `dist/http.js` | `dist/server.js` |
| Port | 8787 | 8788 |
| Tools | 6 (reads + ping) | 13 (reads + wallet + transactions) |
| State | None — stateless, no secrets | Wallet pairing per user + write journal |
| Sign-in | None — public endpoint | OAuth (the service itself is the issuer; `PUBLIC_URL` must equal the public hostname) |
| Secrets | None | `WC_PROJECT_ID` (WalletConnect project id) in `.env` |
| Storage | None | `MOI_DATA_DIR` (`/var/lib/moi-mcp`) on disk |
| Scaling | Any number of copies | Exactly one process — the live WalletConnect client is per-process |

Around them:

- **nginx** terminates TLS and proxies each hostname to its port. MCP
  responses stream, so `proxy_buffering off` is required, not tuning.
- **pm2** supervises both processes and restarts them on boot
  (`ecosystem.config.cjs` in the repo root defines both).
- **WalletConnect** relays signing requests between the write gateway and
  MOI Wallet on the phone. Needs the free project id from
  https://cloud.reown.com.

## Sign-in and wallet identity

The write gateway contains its own OAuth 2.1 authorization server. There is
no external identity provider, user database, or password system to set up —
nothing extra to deploy. Claude registers itself against it automatically
(dynamic client registration with PKCE). This is why `PUBLIC_URL` must equal
the public hostname exactly: it is the issuer URL the auth server advertises.

There are no user accounts. Sign-in sets a signed browser cookie, and that
cookie is the user id — the consent page says as much: the wallet you pair
is the identity. Signing in from a different browser means a new id and a
fresh pairing.

How different users' wallets stay separate: each wallet pairing is stored
server-side keyed by that user id — one wallet per user, under
`MOI_DATA_DIR/sessions/` — and every transaction resolves which phone to
prompt from that stored record alone. No tool call can name a wallet,
account, or session, so one user's request can only ever reach that user's
own phone.

Pairings expire: a week when the user chooses to stay connected, 15 minutes
for a one-shot pairing. After expiry the user simply pairs again — expected
behavior, not a fault.

Everything the auth server needs (cookie secret, token store, wallet
pairings, write journal) lives under `MOI_DATA_DIR`. That is why the
directory must survive restarts and is worth backing up.

## What you need

This deploys on the Voyage infrastructure, next to the JSON-RPC gateway
Voyage already serves.

1. A host with Node.js 20+ and a TLS-terminating reverse proxy.
2. **Two dedicated hostnames** with DNS and certificates:
   - `mcp.voyage.moi.technology` — write gateway, the URL users add
   - `mcp-read.voyage.moi.technology` — read gateway
   No redirects may sit in front of either hostname, including HTTP→HTTPS:
   a redirect drops the `Authorization` header and sign-in breaks silently.
3. A WalletConnect project id (free, https://cloud.reown.com).
4. Outbound access from the host: HTTPS to the voyage RPC endpoint
   (`dev.voyage-rpc.moi.technology`, or the internal one — see `MOI_RPC_URL`
   below) for both gateways, plus WebSocket (wss) to the WalletConnect/Reown
   relay for the write gateway.
5. A phone with MOI Wallet, for the final verification — its account must
   hold at least ~20,000 KMOI on voyage (the asset-create test needs 10,000
   storage fund + 10,000 fuel reserve).

The steps below assume one Ubuntu VM with nginx and pm2. That layout is a
suggestion — any equivalent (different distro, proxy, or supervisor) is fine
as long as the proxy rules in step 4 and the one-process rule for the write
gateway are kept.

## 1. Install

```bash
sudo mkdir -p /opt/moi-mcp && sudo chown "$USER" /opt/moi-mcp
git clone https://github.com/sarvalabs-adithya/moi-mcp.git /opt/moi-mcp
cd /opt/moi-mcp
npm ci
npm run build
sudo npm install -g pm2
```

## 2. Configure

```bash
cd /opt/moi-mcp
printf 'WC_PROJECT_ID=REPLACE_ME\n' > .env
chmod 600 .env
# now edit .env and put the real project id in place of REPLACE_ME —
# left unedited, the server refuses to start with a message saying exactly this

sudo mkdir -p /var/lib/moi-mcp && sudo chown "$USER" /var/lib/moi-mcp
chmod 700 /var/lib/moi-mcp
```

Optional: add `MOI_RPC_URL=<internal voyage RPC endpoint>` to `.env` to route
chain reads through Voyage's internal RPC instead of the public URL. Both
gateways honor it.

`PUBLIC_URL` in `ecosystem.config.cjs` is already set to
`https://mcp.voyage.moi.technology`. It is the OAuth issuer and must match
the public write hostname exactly — a mismatch makes sign-in fail. Change it
only if the hostname changes.

## 3. Start

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # prints a sudo command — run it

curl localhost:8787/health
# {"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}
curl localhost:8788/health
# {"ok":true,"network":"voyage","readOnly":false,"pairingMounted":true}
```

## 4. nginx

One server block per hostname; only `server_name` and the port differ.
`mcp.voyage.moi.technology` → 8788, `mcp-read.voyage.moi.technology` → 8787.

```nginx
limit_req_zone $binary_remote_addr zone=moimcp:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name mcp.voyage.moi.technology;

    # your certificate directives

    location / {
        limit_req zone=moimcp burst=20 nodelay;

        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # required — the app rate-limits per client IP
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;      # required — responses stream
        proxy_read_timeout 300s;  # the app caps tool calls at 240s; keep this above it
        proxy_send_timeout 300s;
        gzip off;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The Node services listen on all interfaces, so block inbound 8787 and 8788
from outside (`sudo ufw deny 8787 && sudo ufw deny 8788`, or the cloud
security group). nginx reaches them over loopback, which is unaffected.
Without this, the gateways are reachable directly, skipping TLS and the rate
limit.

## 5. Verify from outside

```bash
curl https://mcp.voyage.moi.technology/health
curl https://mcp-read.voyage.moi.technology/health

curl -X POST https://mcp.voyage.moi.technology/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 13 tools; the same call on mcp-read lists 6
```

## 6. Connect in Claude

claude.ai → Settings → Connectors → Add custom connector:

- `https://mcp.voyage.moi.technology/mcp` — authentication **OAuth**
- `https://mcp-read.voyage.moi.technology/mcp` — authentication **None**

Getting the write gateway's setting wrong (None instead of OAuth) means
sign-in never happens and every wallet tool returns an unsatisfiable
sign-in prompt.

## 7. Verify end to end

In a Claude chat, in order:

1. Ask: *"what's the supply of asset
   0x1080fffe4cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000 on
   voyage"* (that is KMOI, the voyage native asset) — a read returns real
   chain data.
2. Ask: *"connect my MOI wallet, stay connected for a week"* — sign in when
   prompted, then a QR code appears in the chat. Scan it with MOI Wallet
   within 5 minutes and approve the pairing on the phone.
3. Ask: *"create a test asset called DEPLOYTEST with supply 100"* — Claude
   first shows a preview with the storage fund and fuel cost; confirm it,
   and then the approval prompt appears on the phone. Approve it there.
   (Needs the ~20,000 KMOI from the prerequisites; an underfunded wallet
   fails at the preview with a clear error.)
4. Ask: *"what's my wallet status"* — shows the paired account.

Deployment is done when step 3 lands on chain.

## Testing before DNS is ready (cloudflared tunnel)

To try the whole flow before the real hostnames exist, expose the write
gateway through a Cloudflare quick tunnel. No Cloudflare account needed.

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/

cloudflared tunnel --url http://localhost:8788
# prints a URL like https://random-words.trycloudflare.com — leave it running
```

In a second terminal, stop the pm2 copy first — two write gateways conflict
on port 8788 and on the WalletConnect relay — then start the gateway directly
with the tunnel URL as its public address (substitute the URL cloudflared
actually printed):

```bash
pm2 stop moi-mcp-write
cd /opt/moi-mcp
PUBLIC_URL=https://random-words.trycloudflare.com node dist/server.js
```

When done testing, Ctrl-C the direct process and `pm2 start moi-mcp-write`.

Add `https://random-words.trycloudflare.com/mcp` in Claude with **OAuth** and
run the step 7 checks against it.

Notes:

- Every quick-tunnel start gets a new random URL. Restart the server with
  the new `PUBLIC_URL` and re-add the connector in Claude each time.
- Read gateway: `cloudflared tunnel --url http://localhost:8787`, add with
  authentication **None**. No `PUBLIC_URL` involved.
- The MOI icon does not display on a trycloudflare hostname; it will on the
  real one. Expected, not a bug.
- Tunnels are for testing only — anything user-facing runs on the real
  hostnames.

## Updating

```bash
cd /opt/moi-mcp && git pull && npm ci && npm run build
pm2 restart moi-mcp-read moi-mcp-write   # restart, NOT reload
```

Reload overlaps old and new processes, and two write gateways fight over the
same WalletConnect relay identity. Restart's two-second gap is the cheaper
failure.

If a release changes the stored pairing format (release notes will say so),
existing users have to pair again — old session records are dropped, the
write journal is kept.
