# Ready to test — morning checklist

In order. Every step is safe until §5; §5 pushes real approvals to your phone.
All commands assume `cd ~/moi-mcp` unless stated.

## 0. Pair (the previous session expired 2026-09-02 05:03 UTC — it is gone)

```bash
cd ~/moi-mcp && npm run build   # dist/ is gitignored; the CLI below runs from it
cd ~/moi-mcp && npm run pair    # scan the terminal QR with MOI Wallet on voyage, approve
cd ~/moi-mcp && npm run status
```

Expected: a JSON object with `"connected": true`, account
`0x000000001a46…0000`, network `voyage`, and an `expiresAt` in the future.
`moi-mcp status` never prints a `Paired with …` line — it only ever prints this
JSON, and it exits 1 whenever `"connected"` is false; that exit code is the
signal, not a crash.

## 1. Hermetic checks (no network, no phone)

```bash
npm test                # expect: 13 files, 169 passed | 5 skipped
npm run typecheck       # expect: no output
npm run build           # expect: dist/{index,cli,http,schema}.js rebuilt
```

## 2. Live reads against devnet

```bash
npm run test:e2e        # expect: `Tests  7 passed (7)` — the 5 MOI_E2E-gated
                        # devnet tests plus 2 that always run. Needs network, no phone.
```

## 3. TypeScript vs Go cross-check

```bash
npm run cross-check     # expect: 10-row table, every row "yes", "cross-check: all 10 fields match", exit 0
```

Needs network (devnet RPC); no phone. A few seconds once the Go binary exists,
~40 s the first time — it builds `~/moi-mcp-go/bin/moi-mcp` if missing (`bin/`
is gitignored, so that is normal) and finds `go` at `/opt/homebrew/bin` itself,
so no `PATH` export is needed here.

Nonce 5 / 95699 KMOI are live values — after §5 lands a transfer they change,
and both columns must change together.

## 4. Claude Desktop

Add an `mcpServers` key to the object already in
`~/Library/Application Support/Claude/claude_desktop_config.json` — it
currently holds `coworkUserFilesPath` and `preferences`; keep both. This is the
value to merge in, not the whole file:

```json
{
  "mcpServers": {
    "moi": {
      "command": "node",
      "args": ["/Users/adithyaganesh/moi-mcp/dist/index.js"],
      "env": {
        "MOI_NETWORK": "voyage",
        "WC_PROJECT_ID": "<copy the value from ~/moi-mcp/.env — do not paste it anywhere else>",
        "LOG_LEVEL": "error"
      }
    }
  }
}
```

Quit Claude completely (Cmd-Q, not close window) and reopen. The tool picker
should list 13 `moi` tools.

13 tools show up even with a missing or wrong `WC_PROJECT_ID` — config loads
lazily. The real gate is §5 check 1: `moi_wallet_status` must return
`configOk: true`; if it returns false, its `configError` field names the cause.
To diagnose, read `~/Library/Logs/Claude/mcp-server-moi.log` rather than running
`node dist/index.js` by hand — run from `~/moi-mcp` it picks `WC_PROJECT_ID` out
of `.env` and so cannot reproduce a bad `env` block.

## 5. Wallet checks (phone in hand; each prompt is one chat message)

Call the transfer prompt **T**:

> `send 1 of asset 0x1080fffe4cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000 to 0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000`

| # | Prompt | Phone | Expected |
|---|---|---|---|
| 1 | `what's my MOI wallet status?` | — | `connected: true`, account `0x…1a46…`, `network: voyage`, `chainId: moi:14`, `configOk: true` |
| 2 | **T** | **Approve** | `{"status":"sent","hash":"0x…","explorerUrl":…}`. Then `did that land?` → `status: success` |
| 3 | `create an asset called MCPTEST with supply 1000` | **Approve** | `status: sent` + hash — the new asset id is **not** in the write result (only `{status, hash, explorerUrl}`). Get it from `did <hash> land?` and read the ASSET_CREATE operation's payload/receipt, or from the explorerUrl page. Then `look up asset <that id>` → symbol MCPTEST, MAS0 |
| 3b | `mint 1000 of asset <the new id>` | **Approve** | `status: sent`; then `what's in my account?` shows the new asset, and it appears in MOI Wallet. Creating sets a max supply and mints nothing — until you mint, you hold none and the wallet shows nothing |
| 4 | **T** | **Reject** | `{"status":"rejected","reason":"user_rejected"}` |
| 5 | **T** | ignore it | After ~60 s the chat shows `MCP error -32001: Request timed out`. The server gives up first at `REQUEST_TIMEOUT_MS` (55000), just under the MCP client's own 60s `DEFAULT_REQUEST_TIMEOUT_MSEC`, so the approval dies with it. Pass = the request ends cleanly, a later tap does nothing, and `npm run status` still shows `connected: true` |
| 6 | quit Claude Desktop, set `MOI_NETWORK` to `mainnet` in `claude_desktop_config.json`, reopen, then **T** | — | `reason: network_mismatch`; `what's in my account?` still answers. Set `MOI_NETWORK` back to `voyage` and reopen afterwards |
| 7 | `create an asset called MCPTEST2 with supply 1000` (no storageFund) | nothing arrives | Tool error: "The node says this interaction would fail … Pass a smaller `storageFund`". Already verified; a regression if the phone buzzes |
| 8 | `disconnect my MOI wallet`, then **T** | — | `No wallet was paired`-style text, then `reason: wallet_disconnected`. To re-pair: quit Claude Desktop (Cmd-Q) first, then `npm run pair`, then reopen Claude Desktop. The running server holds its own in-memory WalletConnect client over `~/.moi-mcp/wc.db`; re-pairing from the terminal while it is up leaves it holding a session topic it cannot sign with |

`KMOI = 0x1080fffe4cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000`.
`moi_transfer` requires an explicit `assetId` and the server has no symbol→id
lookup, so the prompt must carry the id.

The disconnect check is last on purpose: `moi_create_asset` calls
`requireSession` before it builds anything, so running check 7 after a
disconnect would return `wallet_disconnected` rather than the storageFund
refusal it is there to prove.

Between 2 and 3 the sequence number advances; if 3 says "broadcasting it
failed", run it once more.

## 6. Go service

```bash
cd ~/moi-mcp-go && export PATH="/opt/homebrew/bin:$PATH"
go build -o bin/moi-mcp ./cmd/moi-mcp && go test ./... && go vet ./...
./bin/moi-mcp -http :8798 &
# expect exactly: {"endpoint":"https://dev.voyage-rpc.moi.technology/devnet/","network":"voyage","ok":true,"readOnly":true,"version":"0.1.0"}
curl -s localhost:8798/health
curl -s -X POST localhost:8798/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'   # expect 4 tools
kill %1
```

`-http :PORT` is stateless and needs `Content-Type: application/json` **and** an
`Accept` header containing **both** `application/json` and `text/event-stream`.
With only `application/json` the server replies with the plain-text line
`Accept must contain both 'application/json' and 'text/event-stream'` and no
JSON-RPC envelope — which reads like a broken server but is not.

(The TS HTTP server: `PORT=8787 node dist/http.js`. It needs no
`WC_PROJECT_ID` — `/health` returns
`{"ok":true,"version":"0.1.0","network":"voyage","readOnly":true}` with nothing
configured.)

## 7. If something fails, send me

1. The step number and the exact prompt or command.
2. The tool's full output block from the chat (the JSON or the "MCP error …"
   text), or the terminal output for §1–3/§6.
3. Any `[moi-mcp] …` line from stderr: Claude Desktop → Settings → Developer →
   Open Logs (`~/Library/Logs/Claude/mcp-server-moi.log` — that directory exists
   on this Mac and is where Claude Desktop writes per-server logs, so it can be
   tailed without the menu); for the terminal, it is already on screen.
   The line starting `[moi-mcp] debug: raw wallet error` is the one that
   matters for §5.
4. For §5 failures: what the phone showed (approval screen appeared? error
   toast?) and `npm run status` output afterwards.
5. Do not send the `WC_PROJECT_ID`, `.env`, or `session.json`.
