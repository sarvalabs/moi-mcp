# Deploying on a VM

Two services live in this repo and you can run either or both.

**The read gateway** (`dist/http.js`) answers questions about the chain. It is
stateless, holds no keys, and needs no secrets. Nothing about it is delicate.

**The write gateway** (`dist/server.js`) also proposes transactions, which the
user approves on their phone. It signs people in, holds a wallet pairing per
user, and needs one secret.

Start with the read gateway even if you want both. It proves the hostname, TLS
and proxy configuration with something that cannot break, and then the write
gateway is the same setup with more environment variables.

## Prerequisites

An Ubuntu VM with Node.js 20 or newer and nginx, and a **dedicated hostname**
for this service. `mcp.moi.technology` is the placeholder below.

Two things that will waste an afternoon if you get them wrong:

Do not reuse a hostname that already serves something else. Terminate TLS
directly on this host.

Do not put a redirect in front of it, including HTTP to HTTPS on this
hostname. A redirect drops the `Authorization` header, and the client will not
retry with it restored. The connector then looks signed in and silently fails
every call, which is close to undebuggable from the outside.

## 1. Get the code onto the box

```bash
sudo mkdir -p /opt/moi-mcp && sudo chown "$USER" /opt/moi-mcp
git clone https://github.com/sarvalabs-adithya/moi-mcp.git /opt/moi-mcp
cd /opt/moi-mcp
npm ci
npm run build
sudo npm install -g pm2
```

## 2a. Read gateway

```bash
pm2 start ecosystem.config.cjs --only moi-mcp-read
pm2 save
pm2 startup   # prints a command to run with sudo, run it
```

```bash
curl localhost:8787/health
# {"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}
```

## 2b. Write gateway

Two extra things it needs.

A WalletConnect project id, free from cloud.reown.com. Put it in a file the
server reads, rather than in the pm2 config, which is committed:

```bash
cd /opt/moi-mcp
printf 'WC_PROJECT_ID=your_32_character_id_here\n' > .env
chmod 600 .env
```

A directory for wallet pairings and the write journal:

```bash
sudo mkdir -p /var/lib/moi-mcp && sudo chown "$USER" /var/lib/moi-mcp
chmod 700 /var/lib/moi-mcp
```

Then set `PUBLIC_URL` in `ecosystem.config.cjs` to the real hostname. It is the
OAuth issuer, so if it does not match what users actually reach, sign-in fails
in a way that looks like a client bug.

```bash
pm2 start ecosystem.config.cjs --only moi-mcp-write
pm2 save
curl localhost:8788/health
# {"ok":true,"network":"voyage","readOnly":false,"pairingMounted":true}
```

Optional: set `REDIS_URL` in the env block and both the wallet pairings and
WalletConnect's own internal state go to Redis instead of `MOI_DATA_DIR`. On a
VM that is unnecessary, since the disk is already stable. It matters if this
ever moves to containers. If you do use it, Redis needs persistence enabled,
because one running as a plain cache comes back empty and quietly un-pairs
everyone, and it needs auth and TLS, because those records carry the key that
lets its holder raise a signing prompt on somebody's phone.

## 3. nginx

Point `proxy_pass` at 8787 for the read gateway or 8788 for the write one.

```nginx
limit_req_zone $binary_remote_addr zone=moimcp:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name mcp.moi.technology;

    # your existing certificate directives

    location / {
        limit_req zone=moimcp burst=20 nodelay;

        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;  # required: the app rate-limits per client address

        proxy_buffering off;      # responses stream; buffering breaks them silently
        proxy_read_timeout 300s;  # matches the assistant's tool-call budget
        proxy_send_timeout 300s;
        gzip off;
    }
}
```

`proxy_buffering off` is the one that catches people. With buffering on, the
service looks healthy and simply never answers.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Check it from outside

```bash
curl https://mcp.moi.technology/health
```

```bash
curl -X POST https://mcp.moi.technology/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Six tools on the read gateway, thirteen on the write one.

## 5. Add it in Claude

Settings, then Connectors, then Add custom connector, and paste
`https://mcp.moi.technology/mcp`.

Choose **None** for the read gateway and **OAuth** for the write one. Getting
that wrong on the write gateway means you never sign in, so the wallet and
transaction tools return a sign-in prompt you cannot satisfy.

Then ask it something: "what's the supply of asset 0x1080... on voyage".

## Updating

```bash
cd /opt/moi-mcp && git pull && npm ci && npm run build
pm2 restart moi-mcp-write
```

Use `restart`, not `reload`. Reload overlaps the old and new process on
purpose, and two write gateways at once fight over the same WalletConnect
relay identity. A two second gap is the cheaper failure. The read gateway does
not care either way.
