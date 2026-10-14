# 60-second demo — prompt sequence

For recording the pitch demo. Not run yet.

**Setup before you hit record**

- Real `WC_PROJECT_ID`, server running in Claude Desktop, wallet **not** yet paired
  (`node dist/cli.js clear-session`) — the pairing moment is worth showing.
- A devnet account with a non-zero balance, and its asset id to hand.
- Phone on screen or in frame, screen-recording too.
- **Do a full dry run first.** Every fallback below exists because the live
  version can fail, but a rehearsal removes most of them.

Record the chat and the phone side by side. No voiceover — the phone buzzing
carries it.

---

## The sequence

### 0:00–0:08 — Frame it

Nothing typed. Tools panel open, 22 `moi_*` tools visible.

> "My agent has a MOI wallet. It does not have my keys."

### 0:08–0:18 — Pair

```
connect my MOI wallet
```

QR appears in chat. Scan it. Approve on the phone.

- **Expected:** `status: "awaiting_scan"`, then a QR image block.
- **If the QR doesn't render:** the URI is in the text block right under it —
  say "or paste the URI" and paste it into the wallet. Keep moving.
- **If the relay refuses:** stop recording. That is a `WC_PROJECT_ID` problem,
  not a demo problem. See `docs/local-testing.md`.

```
what's my wallet status?
```

- **Expected:** `connected: true`, your account, `network: "voyage"`.

### 0:18–0:26 — Read, with no wallet involved

```
what's in my MOI account?
```

- **Expected:** balances, instantly. **Say the point out loud:** this needed no
  approval, because reading never needs a key.
- **If balances come back empty:** the account holds nothing on devnet. Fall
  back to `look up MOI account <a funded address>` — the tool works the same and
  the point survives.

### 0:26–0:36 — Resolve an agent

```
find the agent called <handle> in the MOI registry
```

**Read this before recording.** On devnet the registry logic has no state
object, so `moi_resolve_agent` currently returns `{"found": false}` — every
time, for every query. That is honest behaviour (an unwritten registry is an
empty registry), but it is not a good demo beat.

Three options, best first:

1. **Register an agent first** so there is something to find. Takes a few
   minutes with `js-moi-agent-registry` and makes this the strongest moment in
   the demo — agent discovers agent, then pays it.
2. **Show the miss deliberately.** Keep it and say: *"nothing registered on
   devnet yet — it tells you that instead of guessing."* Honest, and it
   demonstrates the tool degrades cleanly. Costs ~4 seconds.
3. **Cut the step.** Go straight from balance to transfer. Loses the
   agent-to-agent story, which is most of why this is interesting. Last resort.

Decide which before you record; do not improvise this one live.

### 0:36–0:50 — Propose the payment, then stop talking

```
send 1 <SYMBOL> to <address>
```

- Agent resolves the asset, checks the balance, builds the interaction.
- **The phone buzzes. Hold it up. Say nothing.** Let the approval screen sit on
  camera for a beat before you tap Send.

This is the whole demo. Do not cut it short, do not speed it up, do not talk
over it.

- **If it returns `wallet_disconnected`:** the session dropped between pairing
  and here. Re-pair and re-record; do not patch it in the edit.
- **If it returns `network_mismatch`:** your wallet moved networks. Worth a
  sentence if you're feeling confident — *"it refused to sign for the wrong
  chain"* — but cleaner to fix and re-record.
- **If it says "holds X … but the transfer needs Y":** you used the wrong
  asset id or too large an amount. Lower the amount; the balance you just read
  is on screen.
- **If it says "The node says this interaction would fail":** the simulation
  refused it before the phone was involved. Read the reason, fix the input,
  re-record.
- **If nothing arrives on the phone within ~10s:** stop. Check
  `moi_wallet_status` (session may have expired) and the relay; the payload
  shape itself is confirmed against the real wallet, so do not go looking for
  an encoding switch.
- **If the phone approves but the tool says "broadcasting it failed":** the
  signature is fine and the node rejected it — usually a stale sequence
  number. Re-run once; do not patch it in the edit.

### 0:50–0:58 — Confirm

```
did that land?
```

- **Expected:** `status: "success"` and the explorer link.
- **If still `pending`:** say "still settling" and show the explorer link
  instead. Do not sit in silence waiting for a tesseract.

### 0:58–1:00 — End card

> `@moi-protocol/mcp-server` — the agent never holds the key.

---

## What to say if asked "so it can't run unattended?"

Answer it straight, don't dodge: **correct, and that's the trade.** Every write
waits for a human. The next step is capability, not custody: MOI's MAS0 assets
already have mandates — the owner `Approve`s an agent wallet for an amount
until an expiry, the agent signs `TransferFrom` with its own key, the owner can
`Revoke` at any time. This server does not build `TransferFrom` yet, and a
mandate is a single cap per asset with no per-transaction limit or rate, so
richer policy needs a Logic. Either way, a hot key on the server is not the
answer. (MOI also has weighted account keys and storage access policies;
neither carries a budget. `docs/findings.md` §6.)

## Recording notes

- Devnet only. Do not imply mainnet works — it has no published RPC or chain id.
- Blur or crop the account address if it is one you reuse.
- The `WC_PROJECT_ID` is a public identifier, but crop the config anyway; it
  invites questions that aren't the point.
