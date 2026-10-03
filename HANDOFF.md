# Handoff

State as of 2026-09-01. Two repos: `~/moi-mcp` (TypeScript, stdio + read-only
HTTP, wallet writes) and `~/moi-mcp-go` (Go, read-only, stdio + stateless
HTTP). Nothing is published to npm. Everything from this session is committed;
the working tree is clean at 484e114.

**Tomorrow morning: follow `READY-TO-TEST.md` top to bottom.** It is the
ordered checklist with exact commands.

## What is verified

| Area | Status | Evidence |
|---|---|---|
| Unit tests | 169 pass, 5 skipped (the `MOI_E2E`-gated live tests) | `npm test`, 1.5 s |
| Typecheck, build, pack | clean; tarball 30 files, 183 kB | fresh-install run from the packed tarball |
| stdio server | 13 tools, 2 resources, stdout 100 % JSON, stderr empty at `LOG_LEVEL=error` | JSON-RPC sweep, unpaired and paired |
| Reads on devnet | nonce 5, 95699 KMOI, KMOI/MAS0/supply 90000000100000, interaction `0x3c5682…` success/299 fuel | `npm run test:e2e`, `npm run cross-check` |
| Go vs TS | all 10 compared fields identical, raw output byte-identical | `npm run cross-check` exit 0 |
| Go repo | build/vet/gofmt/test clean; stdio + `-http` + `/health` + error paths | driven by script; `MOI_E2E=1 go test -run TestLive ./internal/moirpc/` |
| Wallet guards | unpaired → `wallet_disconnected`; other network → `network_mismatch`; expired → `wallet_disconnected`; insufficient balance refused before fuel/simulate/relay; simulation failure refused with hint | hermetic tool-handler tests + paired sweep against the real session |
| Write mechanism | sign on phone (`moi.signInteraction`, `params: [ixObject]`) then broadcast from here (`moi.SendInteractions`) — proven on chain at `0x3c5682…` | `docs/upstream-issues.md` §1 |
| `moi_create_asset` | bundles `ASSET_CREATE` + KMOI funding transfer to the derived asset id; `storageFund` param, in base units; with none the fund is sized (10 KMOI, or 7 KMOI on a smaller balance, refused under 7.001 KMOI) and one below about 6.1 KMOI is refused by simulation with the hint | hermetic tests; the paired sweep of 2026-09-01 predates the KMOI rescale and ran against the old 1,000,000 default |

## What needs a phone

No automation can tap Approve. Unverified through the tools with a real tap:

- `moi_transfer` → Approve → `{status:"sent", hash}`
- `moi_create_asset` with no `storageFund` (the server funds 10 KMOI, or 7 KMOI on a smaller balance) → Approve → `sent`
- `moi_transfer` → ignore 5 min → `timeout`
- switch wallet network → `network_mismatch`
- `moi_disconnect_wallet` then write → `wallet_disconnected`

`READY-TO-TEST.md` §5 walks them in order with expected output. The paired
session in `~/.moi-mcp/session.json` expires **2026-09-02 05:03 UTC**; re-pair
first if `npm run status` says not connected.

## Bugs found and fixed (commit 10f2ce1)

Five streams of automated checking found these; all are fixed and verified
against live devnet.

1. **`moi_get_logic` returned `routines: []` for every logic.** The manifest
   names routines `"callable"` (`js-moi-utils` `ElementType.ROUTINE`), not
   `"routine"`. Now returns the registry logic's 14 callables with kinds.
2. **`moi-mcp-http` never started via the npm bin symlink.** npm installs bins
   as symlinks, so a basename main-module guard never matched: exit 0, no
   output, nothing listening — i.e. broken exactly as `npx` would run it. Now
   compares realpaths.
3. **`GET /health` returned 503 without `WC_PROJECT_ID`.** The read-only
   server does not need one; it now satisfies the shared config schema itself.
4. **The MOI string error code never reached the client.** SDK 1.30's
   `tools/call` wrapper collapses a thrown `McpError` to
   `{isError, text: message}` and drops `data`. The code is now a `[CODE]`
   token in the message: `[INSUFFICIENT_BALANCE] Account … holds 95699 …`.
   Agents branch on that token, not on `data.code`.
5. Minor: `moi_call_logic` calls `wc.currentSession()` before the `view`
   branch (`src/tools/writes.ts:307`), so an unpaired view initialises the real
   SignClient for nothing. `src/wc/client.ts:246,319` write debug lines with
   `process.stderr.write`, bypassing `LOG_LEVEL`. `src/schema.ts:38` `CAIP2`
   default still says `moi:voyage` (unused; `provider.ts` has the verified
   `moi:14`). Simulation failure reasons are surfaced as raw POLO hex.

## Design notes worth a second opinion

- **`ReadOnlySigner`** (`src/moi/provider.ts`) — the SDK routes read-only
  logic calls through a `Signer`; this one carries a provider and throws on
  both signing methods. Deliberate misuse of an abstract class, and how the
  zero-key invariant is enforced.
- **Write tools advertise a permissive output shape.** MCP SDK 1.30 cannot
  convert a Zod 3 discriminated union to JSON Schema, so they publish the
  superset of `WriteResult`'s variants and validate the strict union before
  returning. A regression test checks `hash`/`explorerUrl` are not required.
- **`MOI_WC_PARAM_STYLE` is nearly dead.** It only changes the payload of
  `sendInteraction()`, which no tool calls. `schema.WcSendInteractionsParams`
  models the unused path. Worth removing both once the wallet bug is fixed or
  declared permanent.
- **`toInteractionArgs` mutates.** `withMeasuredFuel`/`assertWillSucceed` hand
  the unsigned interaction to js-moi-sdk, which rewrites `ix.participants` in
  place; the wallet therefore sees the SDK-normalised participant list. Tests
  cover the resulting wire payload as-is.
- **`moi_resolve_agent` scans** up to 200 profiles and fetches agent cards
  over HTTP. Fine while the registry is small.

## Open questions

- npm scope: `@moi-protocol` (current) vs `@sarvalabs`. Both unclaimed.
- Ship a shared `WC_PROJECT_ID` or make users bring their own (current).
- Mainnet CAIP-2 id and RPC URL — none published anywhere.
- Canonical read-only caller for logic simulation (`PLAN.md` §7 Q7).
- Delegation: MOI has account keys (`ACCOUNT_CONFIGURE`), access policies
  (`ACCESS_CREATE/UPDATE/DELETE`, storage-only today) and MAS0 mandates
  (`Approve`/`TransferFrom`/`Revoke`, amount + expiry). Only mandates carry a
  budget. `docs/findings.md` §6 has the full picture and what a
  `moi_transfer_from` tool would need.
- `~/moi-mcp-go/go.mod` lists direct deps as `// indirect` — `go mod tidy` when
  convenient.

## Commands

```bash
cd ~/moi-mcp && npm test && npm run typecheck && npm run build   # 169 tests
npm run test:e2e                # live devnet reads
npm run cross-check             # TS vs Go, 10 fields
npm run status                  # wallet session; npm run pair if not connected
npm run inspect                 # MCP Inspector against source
cd ~/moi-mcp-go && export PATH="/opt/homebrew/bin:$PATH" && go build -o bin/moi-mcp ./cmd/moi-mcp && go test ./...
```
