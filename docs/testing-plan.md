# Testing plan

Two implementations, three tiers. The tiers exist because the interesting
failures in this project were not catchable at the tier below.

| Tier | Runs where | Needs | Command |
|---|---|---|---|
| Unit | CI, every push | nothing | `npm test` |
| Live read | on demand | network | `npm run test:e2e`, `npm run cross-check` |
| Wallet | manual | a phone | see below |

---

## Tier 1 — unit (169 tests, hermetic; 5 more skip unless `MOI_E2E=1`)

```bash
npm test          # TypeScript — 13 files, ~1.5 s
go test ./...     # Go — 5 unit tests; 5 TestLive* skip unless MOI_E2E=1
```

No network, no wallet. Everything here must stay deterministic so CI never
flakes on someone else's uptime.

**Module tests** (`config`, `project-id`, `session`, `qr`, `reads`,
`ix-builder`, `wc-client`, `http`). Every group was written after a real
failure, not speculatively:

- **Amount scaling** — bigint/`big.Int` throughout, asserted past 2^53. A
  float64 loses precision silently on MOI supplies.
- **POLO encoding of all three builders** — the original tests only encoded
  transfers, which is exactly why a malformed asset-create shipped.
- **The bigint/JSON boundary** — POLO needs bigint, JSON cannot carry it.
  Asserts the raw interaction throws on `JSON.stringify` and the wire form
  does not.
- **Wire shape** — participants, no `funds` block, unprefixed calldata,
  matched against the SDK's own builder.
- **Chain-keyed namespaces** — uses the verbatim payload MOI Wallet returned.
- **Session validity** — expiry in seconds, network mismatch, fixed clock.
- **WalletConnect client** — against a mocked `SignClient`: both param styles,
  user rejection, timeout, and that a malformed interaction reaches the relay
  **zero** times.
- **Project-id diagnostics** — unset, placeholder, wrong-shaped, valid.
- **HTTP read-only** — asserts `http.ts` imports no wallet module and
  registers no write tool.

**Tool-handler tests** (`test/unit/tools-reads.test.ts`, `tools-wallet.test.ts`,
`tools-writes.test.ts`, `resources.test.ts`; helpers in `test/helpers/`).
These build the server exactly as `src/index.ts` does, connect an MCP `Client`
over `InMemoryTransport`, and call the real handlers against an in-process
JSON-RPC fake node (`mock-node.ts`) and a fake WalletConnect `SignClient`
(`harness.ts`). The harness sets every config key explicitly and uses a
`mkdtemp` home, so a developer `.env` or real session cannot leak in.

- **Reads** — nonce from `moi.InteractionCount`, balances from `moi.TDU`,
  registration from state existence; bad id → tool error with a single node
  call; zod-invalid input → no node call; dimension-18 supply at 2^70;
  interaction success/failed/pending and `ASSET_INVOKE` naming.
  `moi_get_logic` lists the manifest's callable routines (the wire calls them
  `"callable"`, not `"routine"` — filtering on the latter returned zero for
  every real logic).
- **Wallet** — status unpaired/paired/placeholder id/odd id/network mismatch;
  connect already-connected (no `connect()` call), awaiting-scan URI, QR PNG
  block; disconnect passes topic + reason, deletes `session.json`, is
  idempotent, tolerates relay failure.
- **Writes** — guard order (unpaired → `wallet_disconnected` with zero node
  and wallet traffic; other network → `network_mismatch`; expired →
  `wallet_disconnected`; insufficient balance → error before fuel/simulate
  and before any WC request; simulation status 1 → refused with hint, no WC
  call). Success path asserts the WC method is `moi.signInteraction`,
  `params[0]` is JSON-safe, `fuel_limit = ceil(estimate × 1.5)`, calldata is
  unprefixed, and the node's `moi.SendInteractions` receives exactly the
  signed `{ix_args, signatures}`. Fuel fallback 200000; decimals beyond
  dimension refused; `user_rejected`/`timeout` mapping; broadcast failure
  text; a regression test that the advertised output schema does not require
  `hash`/`explorerUrl` and that rejected envelopes validate. `create_asset`:
  ops `[ASSET_CREATE, ASSET_INVOKE]`, `storageFund` changes the funding
  calldata, default fund + simulation failure → refused with the
  `storageFund` hint. `call_logic`: view needs no session and never touches
  the wallet; unknown routine lists the available ones; invoke unpaired →
  rejected; invoke paired → `LOGIC_INVOKE` signed and broadcast.
- **Resources** — list, `moi://networks` (voyage `moi:14`, mainnet null,
  registry default), quickstart names all tools, unknown URI rejects.

**Rule going forward:** every bug fixed gets a test that would have caught it.

## Tier 2 — live reads against devnet

```bash
npm run test:e2e                    # MOI_E2E=1, TypeScript: RPC liveness, typed bad-id, registry loads, empty registry, agentCount 0
npm run cross-check                 # TS (dist/index.js) vs Go (~/moi-mcp-go/bin/moi-mcp), 10 fields, exit 1 on any mismatch
MOI_E2E=1 go test -run TestLive ./internal/moirpc/   # Go, from ~/moi-mcp-go
./bin/moi-mcp -http :8787 &         # Go, then curl /health and POST /mcp
```

Gated so `npm test` and `go test ./...` stay hermetic.

**Cross-implementation check** — `scripts/cross-check.mjs` spawns both stdio
servers through the MCP SDK client, runs the same three reads, normalises the
intersection of fields, and prints a table. Last run: all 10 fields match and
the raw outputs were byte-identical.

| Read | Expected (as of 2026-09-01) |
|---|---|
| `moi_get_account` | nonce 5, registered, 95699 KMOI |
| `moi_get_asset` | KMOI, MAS0, supply 90000000100000, dimension 0 |
| `moi_get_interaction` on `0x3c568254…` | success, 299 fuel, one `ASSET_INVOKE` |

A divergence means one client is parsing the node wrong — which is precisely
the class of bug that produced the phantom nonce. The fixtures are live values;
nonce and balance will move once a real transfer lands, and both servers should
move together.

## Tier 3 — the wallet path (manual, needs a phone)

No automation reaches this. It is also where every serious bug lived.

**Setup:** real `WC_PROJECT_ID` in `.env`, a devnet account with KMOI,
`npm run build`, `npm run status` (then `npm run pair` if not connected).

| # | Check | Pass |
|---|---|---|
| 1 | `npm run pair` → scan | `session.json` written, `npm run status` shows connected |
| 2 | `moi_transfer` 1 KMOI to self → **Approve** | `{"status":"sent"}` + hash; `moi_get_interaction` says success |
| 3 | `moi_create_asset` (no storageFund — it is sized automatically) → **Approve** | `{"status":"sent"}`; the new asset resolves via `moi_get_asset` |
| 4 | `moi_transfer` → **Reject** | `{"status":"rejected","reason":"user_rejected"}` |
| 5 | `moi_transfer` → ignore 5 min | `{"status":"rejected","reason":"timeout"}` |
| 6 | Switch wallet network, then write | `network_mismatch`; reads still work |
| 7 | `moi_disconnect_wallet`, then write | `wallet_disconnected` |
| 8 | `moi_create_asset` with `storageFund: "1000000000"` (1 KMOI, below the floor of about 6.1 KMOI) | Refused by simulation with the storage-fund hint; nothing reaches the phone |

**Status (2026-09-01): 1, 4, 8 verified; 2, 3, 5, 6, 7 not.**
1: a paired session exists and `moi_wallet_status` reports it (expires
2026-09-02 05:03 UTC). 4: a rejection was mapped during the build session.
8: run through the tool against the paired session — refused by simulation
with the hint, nothing sent to the relay (that run was on 2026-09-01 with the old
1,000,000 default, before the KMOI rescale; the row above now uses an explicit
value and has not been run). Check 2's *mechanism* is proven — a
script signed on the phone and broadcast from here, landing at `0x3c568254…` —
but the tool has never returned `sent` after a real tap. The guards for 6 and 7
are covered hermetically; the live tap-through is not.

**Known-failing upstream, do not treat as a regression:** `moi.sendInteractions`
crashes the wallet's database. We use `moi.signInteraction` and broadcast
ourselves. If that ever starts working, revisit — it is the documented path.

## What CI runs

`.github/workflows/ci.yml`, Node 20/22/24: typecheck, unit tests, build, and
`node dist/cli.js help` — the last because a dangling `bin` breaks `npx`
silently. Tier 2 and 3 stay out of CI deliberately.

CI also packs the tarball and starts `moi-mcp-http` through its npm bin
**symlink** with nothing configured, asserting `/health` is `ok:true` and
`tools/list` answers. Running `dist/http.js` directly does not exercise the
main-module guard — which is how a silently-exiting bin shipped once.

## Before any release

```bash
npm run typecheck && npm test && npm run build
npm pack && (cd $(mktemp -d) && npm init -y >/dev/null \
  && npm install <path>/moi-protocol-mcp-server-*.tgz \
  && ./node_modules/.bin/moi-mcp help \
  && (PORT=8799 ./node_modules/.bin/moi-mcp-http & sleep 2; curl -s localhost:8799/health; kill %1))
```

Install from the tarball, not the source tree. That is what caught `js-polo`
being a phantom dependency, and what caught the `moi-mcp-http` bin exiting
silently through the npm bin symlink — fixed in 10f2ce1 by comparing realpaths,
and now asserted in CI against the packed tarball.

Then Tier 3 checks 1–3 by hand. Do not ship a write path nobody has approved.
