# Give your agent a MOI wallet in 5 minutes

**Before you start:** [Node.js 20 or later](https://nodejs.org) (`node -v` to
check) and the [MOI Wallet](https://docs.wallet.moi.technology/getting-started/download)
app on your phone (Android, iOS, or the Chrome extension).

> [!IMPORTANT]
> This guide runs on `voyage`, MOI's **devnet**. The KMOI you'll use below is
> test currency with no real value — claim some free from the
> [Voyage faucet](https://voyage.moi.technology/faucet/), or ask in the
> [MOI Discord](https://discord.gg/5gG6efFN4s) if the faucet is empty.

## 1. Get a WalletConnect project id (1 min)

Sign in at [cloud.reown.com](https://cloud.reown.com), create a project, copy
the project id. This is what lets your machine and your phone find each other
through the WalletConnect relay. It is not a secret key.

## 2. Add the server to your client (1 min)

**Claude Desktop** — edit `claude_desktop_config.json`. It lives at:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, open Claude Desktop once (then quit it) — it
creates the file on first launch. If it already has an `mcpServers` block,
**merge** into it — add `"moi"` as a new key, don't overwrite the file:

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

Restart Claude completely (quit the app, not just the window). `moi` should
appear in the tools list with 23 tools.

**Cursor** — same block in `.cursor/mcp.json`. See `examples/cursor.mcp.json`.

<!-- TODO screenshot: the MOI tools listed in the client's tool picker -->

## 3. Read something (30 sec)

No pairing needed yet. Ask:

> what MOI networks can you reach?

The agent reads `moi://networks`. Then try a real account:

> look up MOI account 0x…

## 4. Pair your phone (2 min)

Don't have MOI Wallet yet? [Download it](https://docs.wallet.moi.technology/getting-started/download)
for Android, iOS, or the Chrome extension.

> connect my MOI wallet

A QR code appears in the chat. Open MOI Wallet on your phone, scan it, approve.

<!-- TODO screenshot: QR in chat, MOI Wallet approval screen -->

Prefer the terminal? `npx -y -p @moi-protocol/mcp-server moi-mcp pair` prints the same QR.

Confirm it landed:

> what's my MOI wallet status?

## 5. Send something (30 sec)

No KMOI yet? Claim free devnet tokens from the
[Voyage faucet](https://voyage.moi.technology/faucet/).

> send 1 KMOI to 0x…

The agent resolves the asset, checks your balance, builds the interaction,
simulates it against the node, and shows you a preview in the chat: one sentence
and the exact values your phone will show. Say yes, and it asks your phone.
**Nothing is signed until you tap Approve.** The phone returns the signature;
the server broadcasts it and hands you the hash. Reject it and you get back
`{"status":"rejected","reason":"user_rejected"}`. Ignore it for five minutes and
you get `"timeout"`.

Creating a token works the same way — `create an asset called MCPTEST with
supply 1000`. A new asset must hold some KMOI to pay for its own storage, and
the server sizes that for you: 10 KMOI when your balance can carry it, 7 KMOI
when it cannot, and it refuses before your phone is asked if you hold less than
7.001 KMOI (claim more from the faucet). The deposit goes into the new asset's
own account and is not spent. You do not need to pass `storageFund`; if you do,
it is in base units, so `10000000000` is 10 KMOI.

<!-- TODO screenshot: approval screen, then the interaction hash in chat -->

Then:

> did that interaction land?

## What just happened

Your agent never saw a private key. It read the chain over JSON-RPC, built an
unsigned interaction locally, sent it over the WalletConnect relay to the only
thing that can sign — your phone — and then submitted the signed bytes to the
node itself. The server relays a signature; it never produces one.

## Next

- `moi_resolve_agent` finds other agents in the on-chain registry, so your agent
  can discover and pay them.
- `moi_call_logic` with `kind:"view"` reads any deployed logic with no wallet at
  all.
- `moi_get_logic` lists a logic's routines so the agent knows what to call.
- `moi_asset_routines` lists what an asset can do, read from its manifest, and
  `moi_asset_invoke` calls one of those routines: a read answers at once, a
  write is previewed in the chat and approved on your phone like a transfer.
