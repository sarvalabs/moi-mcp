# Running the MOI MCP gateway on Voyage

Voyage exposes a JSON-RPC gateway today. This is the same idea for MCP, the
protocol Claude and similar assistants use to call external tools. A developer
pastes one URL into their assistant and can then ask questions about MOI and
get real chain data back.

It is a protocol adapter, not a new data path: every tool call ends up as a
JSON-RPC request to the endpoint Voyage already serves.

## What it is operationally

A small Node process serving two paths, `/mcp` and `/health`. It is stateless:
a fresh handler per request, no database, no keys, no user state, nothing
written to disk. Scale it horizontally like any other stateless service.

It cannot write to the chain. The write code is not disabled by a flag, it is
not compiled into this binary, which is why it needs no secrets.

Five read tools: `moi_get_account`, `moi_get_asset`, `moi_get_interaction`,
`moi_get_logic`, `moi_resolve_agent`, plus `ping`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | Rejects a non-numeric value at startup rather than binding something random. |
| `MOI_NETWORK` | `voyage` | Selects the built-in RPC endpoint. |
| `MOI_RPC_URL` | unset | Overrides the endpoint. Point this at the internal RPC address. |

No other configuration exists.

## Storage, for the write phase

The read gateway stores nothing. The write phase keeps a wallet pairing per
user, and it can hold that either on disk or in Redis.

On disk is the default and needs nothing but a directory that survives a
restart. That suits a VM: one box, one folder.

Set `REDIS_URL` instead and both the wallet session records and the
WalletConnect SDK's own state (its keychain, pairings and subscriptions) go to
Redis. The process then keeps nothing locally, so it can be replaced freely,
which is what containers need. Two conditions apply. Redis must have
persistence enabled, because one run as a pure cache comes back empty and
silently un-pairs everyone. And it must be treated as a secret store with auth
and TLS: a session record carries the key that lets its holder raise a signing
prompt on somebody's phone, so it should not share tenancy with cache
workloads.

## Docker

    docker build -t moi-mcp-gateway .
    docker run -p 8787:8787 -e MOI_NETWORK=voyage moi-mcp-gateway

The image runs as a non-root user and carries a `HEALTHCHECK` that polls
`/health`. Without Docker it is `node dist/http.js` after `npm ci && npm run
build`, on Node 20 or newer.

## Reverse proxy

Three settings matter, and MCP breaks quietly without them.

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;  # required: the app rate-limits per client address

        proxy_buffering off;      # responses stream; buffering breaks them silently
        proxy_read_timeout 300s;  # matches the assistant's tool-call budget
        proxy_send_timeout 300s;
        gzip off;
    }

Serve it on one exact hostname, and do not put a redirect in front of it that
strips the `Authorization` header. Nothing sends that header today, but the
authenticated version will, and a redirect that eats it produces a login loop
nobody can debug from the client side.

## Verifying a deployment

    curl https://HOST/health
    # {"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}

    curl -X POST https://HOST/mcp \
      -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

The second should list six tools. Then paste `https://HOST/mcp` into an
assistant's connector settings and ask it something about a MOI asset.

## Two things to decide

The endpoint has no authentication, so the URL is public. It can only read
public chain state, but put a rate limit on it so nobody hammers the RPC node
through it. In nginx that is a `limit_req` zone keyed on `$binary_remote_addr`.

Transactions are a later phase and a separate conversation. That version needs
per-user authentication and holds live wallet sessions, so it does not scale
the same way. It is built and tested but should not be bundled into this
deployment.
