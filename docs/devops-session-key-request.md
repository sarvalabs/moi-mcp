# Request to devops: MOI_SESSION_KEY for the MCP write service

## What it is

The next version of the MCP write service (`dist/server.js`, pm2 app `moi-mcp-write`) encrypts what it stores on disk: wallet pairings, WalletConnect state and dapp sessions. It needs one secret for that, `MOI_SESSION_KEY`. Without it the service exits at boot with:

```
Invalid hosted MOI MCP configuration — MOI_SESSION_KEY: is required; generate one with `openssl rand -base64 32` and put it in .env before restarting.
```

The read service (`dist/http.js`) does not use it.

The code that needs the key is not in the current PR. It goes in as a separate PR once the workflows below can supply the key, so nothing breaks in the meantime.

## What to add

Three GitHub Actions secrets in `sarvalabs/voyage-api`, one per environment, each a different random value:

| Secret | Used by | Make it with |
|---|---|---|
| `MCP_DEV_SESSION_KEY` | `moi-mcp.deploy.yml`, dev job | `openssl rand -base64 32` |
| `MCP_PROD_SESSION_KEY` | `moi-mcp.deploy.yml`, production job | `openssl rand -base64 32` |
| `MCP_PREVIEW_SESSION_KEY` | `moi-mcp.preview.yml` | `openssl rand -base64 32` |

Rules for the value: at least 43 characters of base64 or hex. The 44 characters that `openssl rand -base64 32` prints are right. Random, not a passphrase.

## Where to use them

In each workflow, pass the secret into the write service's `pm2 start` environment, next to `WC_PROJECT_ID`, which is already passed the same way:

- `moi-mcp.deploy.yml`: add `MOI_SESSION_KEY: ${{ secrets.MCP_DEV_SESSION_KEY }}` to the dev deploy step's `env` (near line 182, beside `WC_PROJECT_ID`), and `MOI_SESSION_KEY="${MOI_SESSION_KEY}" \` to the `pm2 start` block of the write app (near line 243). Same for the production job with `MCP_PROD_SESSION_KEY` (near lines 472 and 533).
- `moi-mcp.preview.yml`: the same with `MCP_PREVIEW_SESSION_KEY` (near lines 127 and 200). One key for all previews is fine; preview data is throwaway.

The read service's `pm2 start` block does not need it.

## Things to know

1. **Keep a copy of each key apart from any data backup.** If the key is lost or changed, nothing is deleted, but nothing opens: everyone pairs their wallet and signs in to dapps again, and the service refuses to start while old WalletConnect state is still on disk.
2. **The first boot on the new code converts existing records in place.** Before that first deploy, copy `sessions/` and `wc.db/` from the data directory (`/var/lib/moi-mcp`), because older code cannot read the converted records. Rolling back without that copy un-pairs every wallet.
3. **Never log or print the value.** The service logs individual settings, never this one.

## Two other settings worth adding at the same time

Not secrets, and not blocking, but the preview and dev deploys are missing them today:

| Setting | Value | Why |
|---|---|---|
| `MOI_READ_CALLER` | Any participant id that exists on the network, for example the KMOI creator `0x000000005dfd3e93ae09bea907f0d6db965ddfe84d09dfdf868e4e6800000000` on the devnet | Without it, `moi_list_agents` and `moi_resolve_agent` return an error, on both the read and the write service |
| `MOI_SIGNED_CHECK` | `warn` (the default) for now | Leave it; it moves to `enforce` later |
