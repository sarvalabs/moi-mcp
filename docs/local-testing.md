# Testing locally

v1 is a **stdio** server. Your MCP client spawns it as a local child process and
talks to it over stdin/stdout. There is no URL, no port, and nothing to deploy.

That is deliberate, not a gap:

- **A WalletConnect session is a persistent relay socket.** It has to stay open
  between pairing and every later request.
- **A pending send waits up to five minutes for a phone tap.** `REQUEST_TIMEOUT_MS`
  defaults to 300000.
- **The write path is local-only on purpose.** The interaction is built on your
  machine and signed on your phone. Nothing in between needs to be reachable
  from the internet — that is the security story, not an implementation detail.

A stateless serverless function dies on all three. Hosting is Phase 5 work and
is scoped to a **read-only HTTP transport**, which has none of these problems.

## Which transport

`moi-mcp` (stdio) is the local one your MCP client spawns, with all 22 tools
(`ping`, the eight reads, the three wallet tools and the ten writes; the
setting `MOI_ACCOUNT_KEY_TOOLS=on` adds an eleventh, `moi_configure_account`),
wallet included. `moi-mcp-http` is the read-only service — 43 tools (`ping`, the eight reads and the 34 node method tools), no wallet,
no `WC_PROJECT_ID`, stateless, hostable. This page covers the stdio one; for
the HTTP one, `PORT=8787 node dist/http.js` and point a client at
`http://localhost:8787/mcp`. It needs no `WC_PROJECT_ID` — it registers no
wallet tools, so `/health` and every read work with nothing configured.

## Build it

```bash
cd ~/moi-mcp
npm install
npm run build
```

That produces `dist/index.js`. Rebuild after any source change — your client
runs the built file, not the TypeScript.

## How a write works here

Every write is two tool calls, the same as on the hosted server (`src/tools/hosted-writes.ts`). The first call, without `confirm`, builds the interaction, simulates it against the node and answers `status: "preview"`: one sentence, the values your phone will show, the fuel and a `confirm` token. Nothing has reached the phone, and a preview is not a failure. The second call, with the same arguments and the token, asks the phone and waits for the tap. A token works once, for those arguments, for ten minutes; if the numbers moved in between, the second call answers with a fresh preview instead.

A write tool is marked destructive, so a client that asks before running destructive tools will ask for each of the two calls.

Every confirmed write is recorded in `$MOI_MCP_HOME/journal.jsonl` (mode 0600), one line per step: `proposed`, `signed`, `broadcast`, `confirmed`, or `failed` / `orphaned` when it stopped early. `orphaned` means the phone signed and the node did not take it. Previews, refusals and views write nothing.

## Point Claude Desktop at the local build

```json
{
  "mcpServers": {
    "moi": {
      "command": "node",
      "args": ["/Users/<me>/moi-mcp/dist/index.js"],
      "env": {
        "MOI_NETWORK": "voyage",
        "WC_PROJECT_ID": "REPLACE_WITH_YOUR_PROJECT_ID"
      }
    }
  }
}
```

Use an **absolute path** — the client does not inherit your shell's working
directory. Replace `<me>` with your username; `echo $HOME` if unsure.

### Where the config file lives

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

The file may not exist yet if you've never launched Claude Desktop — open the
app once, quit it, and the file appears. If it already has an `mcpServers`
block, merge into it rather than overwriting the file.

Cursor reads `.cursor/mcp.json` in the project root, same JSON shape.

**Restart the client completely after editing.** Quit it — closing the window is
not enough on macOS.

### After publishing

Once the package is on npm, drop the local path:

```json
{
  "mcpServers": {
    "moi": {
      "command": "npx",
      "args": ["-y", "@moi-protocol/mcp-server"],
      "env": {
        "MOI_NETWORK": "voyage",
        "WC_PROJECT_ID": "REPLACE_WITH_YOUR_PROJECT_ID"
      }
    }
  }
}
```

Keep using the `node` + `dist/index.js` form while developing — `npx` fetches the
published version and will not pick up your local edits.

## Check it works without a client

Two faster loops than restarting Claude:

```bash
npm run inspect        # MCP Inspector against src/, no build step
```

```bash
# Raw protocol — should print a JSON line listing 22 tools
WC_PROJECT_ID=<id> node -e '
const {spawn}=require("child_process");
const c=spawn("node",["dist/index.js"]);
c.stdout.on("data",d=>process.stdout.write(d));
const s=x=>c.stdin.write(JSON.stringify(x)+"\n");
s({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"cli",version:"0"}}});
s({jsonrpc:"2.0",method:"notifications/initialized"});
s({jsonrpc:"2.0",id:2,method:"tools/list",params:{}});
setTimeout(()=>c.kill(),3000);'
```

Pairing is easier from the terminal than from a chat:

```bash
WC_PROJECT_ID=<id> node dist/cli.js pair     # prints a QR in the terminal
WC_PROJECT_ID=<id> node dist/cli.js status
```

The CLI and the server share `$MOI_MCP_HOME`, so a session paired in the
terminal is picked up by the server on its next start.

## Troubleshooting

### The server doesn't start

The client shows it as failed, or the tools never appear.

1. **Run it by hand** — this is the fastest way to see the real error:
   ```bash
   WC_PROJECT_ID=<id> node dist/index.js
   ```
   It should sit there silently waiting for input. Anything printed to stderr is
   the problem, on one line.
2. **`Cannot find module '.../dist/index.js'`** — you didn't `npm run build`, or
   the path in the config is wrong or relative.
3. **`WC_PROJECT_ID is not set`** — the `env` block is missing or the client
   wasn't fully restarted.
4. **Nothing in the client's logs at all** — check the JSON parses.
   `cat <config> | python3 -m json.tool` will point at the bad line. A trailing
   comma is the usual culprit.
5. **Node too old** — needs 20+. `node -v`. If your client launches with a
   different Node than your shell, use an absolute path to the binary as
   `command`.

### The QR doesn't render

- **`moi_connect_wallet` returned text but no image** — you passed `qr: false`,
  or your client doesn't render image content blocks. The `uri` in the text
  block works: paste it into MOI Wallet's "connect via URI" field, or run
  `node dist/cli.js pair` for a terminal QR.
- **"The WalletConnect relay refused the pairing"** — the project id is wrong.
  `node dist/cli.js config` shows whether it's set; `moi_wallet_status` names
  the problem.
- **QR appears but the phone won't scan it** — the terminal QR needs enough
  contrast and a wide window; try `pair` in a light-background terminal, or use
  the in-chat PNG.

### Session expired

`moi_wallet_status` reports `connected:false`, or a write returns
`{"status":"rejected","reason":"wallet_disconnected"}`.

```bash
node dist/cli.js pair       # just pair again
```

Sessions also end when you disconnect from the wallet side; the server notices
via `session_delete` and clears its copy. If the local file is stale:

```bash
node dist/cli.js clear-session
```

### Network mismatch

A write returns `{"status":"rejected","reason":"network_mismatch"}`.

Your wallet and `MOI_NETWORK` disagree. This guard is why the interaction never
left your machine — it would have been built for one chain and signed on
another.

Either switch networks in MOI Wallet, or set `MOI_NETWORK` to match what the
wallet is on and restart the client. `moi_wallet_status` shows both values.
Reads are unaffected either way.

### Writes fail but reads work

Expected before pairing — reads never need a wallet. If you *are* paired, check
in this order: `moi_wallet_status` (connected? config ok?), then the balance
(`moi_get_account`), then whether your phone is showing an approval you haven't
tapped. A write that answers `status: "preview"` has not failed: it is waiting
for a yes, then a second call with its `confirm` token.

### Everything looks right and the first send still fails

Read the tool's message first — it says which stage failed:

- **"The node says this interaction would fail (receipt status N)"** — the
  simulation refused it before anything reached the phone. For
  `moi_create_asset` this is almost always a `storageFund` you passed that is
  below what the chain needs to store a new asset, about 6.1 KMOI. Leave
  `storageFund` out: with none, the server funds 10 KMOI when the balance
  allows and 7 KMOI otherwise, and refuses (`INSUFFICIENT_BALANCE`) when the
  account holds less than 7.001 KMOI. If you do pass it, it is in base units, so
  `storageFund: "7000000000"` is 7 KMOI. The older advice (1,000,000, then
  50000) dates from before KMOI had 9 decimals and is now far below the floor.
- **"holds X of … but the transfer needs Y"** — balance pre-check, local.
- **"You approved the interaction but broadcasting it failed"** — the phone
  signed, the node rejected `moi.SendInteractions`. Usually a stale sequence
  number; retry once. The stderr line `[moi-mcp] debug: raw wallet error …`
  shows the wallet's own error if the phone was the one that failed.

The wallet payload (`moi.signInteraction`, `params: [ixObject]`) is confirmed
against the real wallet, so `MOI_WC_PARAM_STYLE` is not a knob worth turning —
it only affects the unused `moi.sendInteractions` path. See `docs/findings.md` §1.
