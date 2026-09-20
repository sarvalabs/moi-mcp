# How the MOI MCP server works

## What this is

You chat with Claude on claude.ai. Claude proposes actions on the MOI blockchain: send tokens, create an asset, mint tokens, call a program. A blockchain is a shared public ledger run by many computers, and MOI is one such ledger. You approve every action Claude proposes, with a tap in the MOI Wallet app on your phone. The server described here connects claude.ai to your phone. It builds the transactions, shows you a preview in the chat, and passes signing requests to the phone. It never holds the key that authorizes spending, so it can never move your money on its own (src/moi/provider.ts:150).

## The five pieces

claude.ai is the chat website where you talk to Claude. It also acts as the MCP client. MCP is the Model Context Protocol, Anthropic's standard that lets a chat assistant call functions on an outside program. claude.ai sends each function call to the server over HTTPS, the encrypted form of ordinary web traffic, and shows you what comes back.

This server is a program written in TypeScript, a typed variant of JavaScript, and run by Node.js, a program that runs JavaScript outside a browser. It uses the Express web framework to answer web requests and Anthropic's Model Context Protocol SDK to speak MCP (package.json lists `express` and `@modelcontextprotocol/sdk`; src/server.ts:28-30). Its TOOLS registry lists 11 tools (src/schema.ts:508-520). The server registers `moi_mint` separately (src/tools/hosted-writes.ts:330; src/tools/writes.ts:145) and a `ping` health check (src/index.ts:40, src/http.ts:60). The server you connect to from claude.ai lists 13 tools.

MOI Wallet is an app on your phone. It holds your private key, a secret number that only your phone knows, and it uses that key to sign transactions. Signing means producing a mathematical proof that the key holder approved exactly this transaction. The signature is worthless for any other transaction. The pairing screen on the phone shows the server as "MOI MCP" (src/wc/hub.ts:107-112).

The WalletConnect relay is a message-forwarding service run by a company called Reown. The server and your phone each open a connection to it, and it forwards messages between them on a shared channel called a topic (src/wc/store.ts:22). The server talks to it through the `@walletconnect/sign-client` library (src/wc/hub.ts:23).

The MOI node is a computer that runs the MOI blockchain and accepts finished transactions. The server talks to it over JSON-RPC, a convention for calling functions on a remote computer by sending JSON, a plain text data format. On the default network the node is at `https://dev.voyage-rpc.moi.technology/devnet/` (src/moi/provider.ts:56).

## The words you need

| Term | Meaning |
|---|---|
| MCP, tool | The Model Context Protocol. A tool is one named function the server offers, such as `moi_transfer` (src/schema.ts:508-520). |
| OAuth | A standard way for one website to prove to another that you approved a connection, without sharing a password. This server implements OAuth 2.1 itself (src/auth/index.ts:1-6). |
| Cookie | A small piece of text a website stores in your browser and gets back on every later visit. This server's cookie is named `moi_uid` and is your whole identity here (src/auth/routes.ts:22). |
| QR code | A square barcode a phone camera can read. Here it carries the WalletConnect pairing text. |
| WalletConnect pairing | The one-time handshake where your phone and the server agree, through the relay, on a shared channel name called a topic (src/wc/store.ts:22). |
| Private key, signing | The private key is the secret that controls an account. Signing with it approves one exact transaction. Only the phone has the key. |
| Interaction | MOI's word for a transaction: a signed instruction that changes the ledger (src/schema.ts:356). |
| Fuel | The fee unit MOI charges for processing an interaction. A transfer takes around 300 fuel (src/moi/ix-builder.ts:47). |
| Sequence (nonce) | A counter on each account. Every interaction carries the next number so the same one cannot run twice (src/tools/write-core.ts:99-114). |
| Asset | A token type on MOI, with a symbol, a supply, and an owner (src/schema.ts:130-139). |
| KMOI | The currency on MOI's test network. It pays fuel there and has no real value (docs/quickstart.md:8-10). |
| Devnet | A development network. The default here is `voyage`, MOI's devnet (src/schema.ts:466). |
| POLO encoding | MOI's binary format for interactions. The phone returns the signed interaction as POLO bytes written out as hex text (each byte written as two characters 0-9 a-f) with no `0x` prefix (src/schema.ts:318-320). |
| Redis | A small database program. When configured, the server keeps pairing records there instead of in files (src/server.ts:610-619). |
| Journal | The server's append-only log of every attempted write and the state it reached (src/journal.ts:1-8). |

## Connecting, step by step

1. You open claude.ai, go to connector settings, choose to add a custom connector, and paste the server's URL. The MCP endpoint is the path `/mcp` on the server's public address (src/http.ts:42, src/server.ts:23-25).
2. claude.ai calls the server with no credentials. Reading tools work without any sign-in. The first time Claude calls a tool that touches your wallet, the server answers with HTTP status 401, which means "you must sign in", plus a header (a labeled line at the top of the web reply) pointing at its OAuth metadata (src/server.ts:14-21, 384-390). claude.ai then shows you a Connect button.
3. claude.ai registers itself with the server as an OAuth client, using dynamic client registration, an automatic form of "hello, I am claude.ai, here is where to send the user back" (src/auth/routes.ts:1-3). OAuth's job in this step is to tell the server who claude.ai is and where to send the browser back.
4. claude.ai sends your browser to the server's `/authorize` page. OAuth's job in this step is to move the approval question from claude.ai to the server, where you answer it directly.
5. The server reads its `moi_uid` cookie from your browser, or creates one if this is your first visit (src/auth/routes.ts:33-48). There is no username and no password. The cookie is the account.
6. The browser shows a consent page titled "claude.ai wants to connect" (with the client's registered name). It tells you where the server will send the browser back after you approve, and lists what is being asked: to see which wallet is paired and its address, and to pair or unpair a wallet and propose transactions for you to approve on your phone (src/auth/pages.ts:25-28). It then says, word for word: "There is no account to sign in to. Your wallet is your identity: approving links this browser to the phone you pair next, and nothing more." (src/auth/pages.ts:51). It also says every transaction still needs your approval in MOI Wallet (src/auth/pages.ts:52). You click Approve or Deny.
7. On Approve, the server sends the browser back to claude.ai with a one-time code. OAuth's job in this step is to hand claude.ai proof of your approval without handing it your cookie. The code is valid for 60 seconds and works once (src/auth/store.ts:14, 130-136).
8. claude.ai trades the code at the server's `/token` endpoint for an access token, a random string that stands for "this user approved". OAuth's job in this step is the exchange: claude.ai sends the code, the server returns the token. The access token lasts one hour. A refresh token, which claude.ai uses to get new access tokens without asking you again, lasts 30 days (src/auth/routes.ts:19-20).
9. From then on claude.ai includes the token in every tool call, in an `Authorization: Bearer` header. The server hashes the presented token and looks the hash up in its store to find your user id (src/auth/index.ts:66-79).

If you click Deny, or the sign-in stalls, Claude will report that the connector is not authorized. Retry from the Connect button. The server saves nothing partial except the cookie.

## Pairing the phone, step by step

1. In the chat, ask to connect your wallet. Claude calls the tool `moi_connect_wallet` (src/server.ts:198).
2. The server asks the WalletConnect relay to open a pairing proposal and gets back a `wc:` URI, a line of text that encodes the proposal and the key to join it (src/wc/hub.ts:154-181).
3. The server renders that URI as a QR code image, 320 pixels wide, and returns it inline in the chat, together with the raw text to paste if the image does not render (src/server.ts:237-247).
4. You open MOI Wallet on your phone and scan the QR code. Scanning gives the phone the proposal and the key to join it. The phone and the server then open a shared channel through the relay, identified by a string called a topic (src/wc/store.ts:22). From then on they exchange messages through the relay on that topic (src/wc/hub.ts:271-275).
5. The phone shows the pairing request, labeled "MOI MCP", and you approve it there. The server stores a record linking your user id to the topic and your wallet address (src/server.ts:490-540).
6. The QR proposal expires after about 5 minutes if nobody scans it (src/server.ts:246, 536-537). If it expires, ask Claude to connect again, and the server issues a fresh QR.

A pairing has one of two lifetimes, and you choose it. The default, persistent, lasts 7 days (src/wc/lifetime.ts:16). The other, once, lasts 15 minutes or one approved transaction, whichever comes first (src/wc/lifetime.ts:19; src/tools/hosted-writes.ts:133-146). The chat tool takes a `remember` argument; the browser pairing page has the same choice as two radio buttons (src/pairing/index.ts:300-303).

Pairing again while a wallet is already paired replaces it. The tool warns you first: the reply names the currently paired address and says that approving the new scan replaces it, and that if you did not ask to change wallets you should not scan (src/server.ts:224-252). When a pairing expires, the server deletes its record the next time it is touched, and the server answers any write attempt with a message that the pairing has expired and you should pair again (src/tools/hosted-writes.ts:121-126).

## Sending a transaction, step by step

Suppose you type: "send 5 KMOI to 0xabc...". Every state-changing tool works as two calls (src/tools/hosted-writes.ts:180-186).

Call one: Claude calls `moi_transfer` with the recipient, the asset, and the amount, and no `confirm` argument. The server looks up your pairing. It reads the asset's details from the node. It checks that your balance covers 5 KMOI. It builds the unsigned interaction. It asks the node to estimate the fuel. It simulates the transaction, and refuses one that would fail, before it asks you anything (src/tools/write-core.ts:258-297, 69-82). Nothing reaches the phone. The reply is a preview. Rendered in the chat, it begins like this (src/tools/write-core.ts:169-185):

```
PREVIEW. Nothing has been sent to the phone.
Transfer 5 KMOI to 0xabc...

What the phone will show:
  Operation: Transfer
  Asset: KMOI 0x...
  Amount: 5
  Amount in base units: 5
  To: 0xabc...
  Fuel: up to 450 at price 1
  Network: voyage
```

The block above shows the first part of the rendering. The full reply ends with an instruction that carries the confirm token, tells Claude to get an explicit yes from you, and tells you to check that the amount and address on the phone match (src/tools/write-core.ts:180-182).

The field labels Operation, Asset, Amount, "Amount in base units", and To come from src/tools/write-core.ts:289-294. Base units are the asset's smallest unit. Decimals is the asset's number of decimal places. For an asset with 6 decimals, an amount of 1.5 is 1500000 base units (src/moi/ix-builder.ts:83-100). Dimension is a separate field naming the asset's kind: 0 Economic, 1 Possession. The fuel line is built as "up to (limit) at price (price)" (src/tools/hosted-writes.ts:207). The preview also carries a confirm token: a short random string bound to your user id, this tool, and these exact arguments, valid for 10 minutes and usable once (src/tools/preview.ts:5-9, 28).

The preview exists because the wallet lacks a feature: `moi.signInteraction` has no field for a description, so the phone shows only the raw operation fields it can decode (docs/upstream-issues.md, issue 6). The chat shows you the same numbers first, in the same units the phone will use. The confirm token is the proof you saw them. Without a matching token, the server refuses to contact the phone at all.

Call two: you say yes in the chat. Claude calls `moi_transfer` again with the same arguments plus the token. The server rebuilds and re-simulates, redeems the token, and checks that the rebuilt numbers still match the ones you saw (src/tools/hosted-writes.ts:244-251). Then, in order:

1. It writes a journal entry in state `proposed` (src/tools/hosted-writes.ts:254).
2. It sends the unsigned interaction to your phone through the relay as a `moi.signInteraction` request (src/wc/hub.ts:271-274). Your phone shows the approval screen.
3. You check that the amount and address on the phone match the preview, then tap Approve. The phone signs with your private key and returns the signed bytes: `ix_args` and `signatures`, both POLO hex (src/schema.ts:439-442). The journal entry moves to `signed`.
4. The server broadcasts the signed interaction to the MOI node itself (src/tools/write-core.ts:220-238). The server does the broadcasting because the wallet's own combined sign-and-send call, `moi.sendInteractions`, crashes the wallet's local database (docs/upstream-issues.md, issue 1). The journal entry moves to `broadcast`, then `confirmed` (src/tools/hosted-writes.ts:263-269).
5. The reply in the chat carries the interaction hash and an explorer link of the form `https://voyage.moi.technology/interaction/?0x...`, where you can watch the transaction on the public ledger (src/moi/provider.ts:128-130).

If your pairing was the "once" kind, the server forgets it at this point, before it returns the result (src/tools/hosted-writes.ts:133-146).

## What can go wrong

Each row shows the reply Claude receives, from `WriteResult` in src/schema.ts:190-225 and `asWriteResult` in src/tools/write-core.ts:121-140.

| What happened | What Claude tells you | What to do |
|---|---|---|
| You tapped Reject on the phone | `status: "rejected"`, `reason: "user_rejected"` | Nothing was sent. Ask again if you change your mind. |
| You ignored the phone past the time limit | `status: "rejected"`, `reason: "timeout"`, with the message "No answer from MOI Wallet within N seconds. Nothing was sent. Check the phone and try again." (src/wc/hub.ts:87). The hosted wait is 240 seconds by default (src/config.ts:157). | A tap after the timeout broadcasts nothing (src/wc/hub.ts:277-281). Retry from a fresh preview. |
| The pairing expired | `status: "rejected"`, `reason: "wallet_disconnected"`, message "The wallet pairing has expired. Call moi_connect_wallet to pair again." (src/tools/hosted-writes.ts:121-126) | Ask Claude to connect your wallet and scan a new QR. |
| The wallet is on the wrong network | `status: "rejected"`, `reason: "network_mismatch"`, message "Wallet is on (chain), expected (chain)" (src/tools/hosted-writes.ts:103-106) | Re-pair on the network the server is configured for. |
| Your balance is too small | `status: "error"`, `code: "INSUFFICIENT_BALANCE"`, with a message naming what you hold and what the transfer needs, in base units (src/tools/write-core.ts:270-277) | Get more of the asset, or send less. On devnet, use the Voyage faucet, a web page that hands out free test tokens (docs/quickstart.md:81-82). |
| The numbers changed between preview and confirm | A fresh preview with the note "The numbers changed since the preview, for example because a balance moved. Nothing was sent to the phone." (src/tools/hosted-writes.ts:192-194) | Read the new preview and say yes again. |
| The token was missing, expired, used, or the arguments changed | A fresh preview with the note beginning "That confirm token did not match this call" (src/tools/hosted-writes.ts:188-190) | Read the new preview and say yes again. |

One failure is not in the table. If the phone signs but the broadcast to the node then fails, the reply says "You approved the interaction but broadcasting it failed" (src/tools/write-core.ts:233-237), and the journal records the attempt as `orphaned` so the server never retries it on its own (src/tools/hosted-writes.ts:74-98). Check the explorer before retrying, so you do not send twice.

## What the server keeps and what it never has

The server keeps three kinds of records, all under its data directory with owner-only file permissions.

The server stores sign-in tokens hashed. When a token is issued, the server saves it under its SHA-256 hash, a one-way fingerprint, and when a request arrives it hashes the presented token and looks the hash up (src/auth/routes.ts:63-79; src/auth/index.ts:71-73). A copy of the token files does not contain the tokens themselves.

The pairing record for each user holds the WalletConnect topic, the chain id, the wallet address, the chosen lifetime, and the expiry time. The server names the file with the SHA-256 hash of the user id (src/wc/store.ts:19-33, 148-151). With Redis configured, the same record lives there instead (src/server.ts:610-619).

The journal is an append-only file of every write attempt and the states it passed through: proposed, signed, broadcast, confirmed, failed, orphaned (src/journal.ts:16).

The server never stores a private key and never sees one. The only signer class in the codebase throws on both of its signing methods. Its sign method throws with the message "This MCP server holds no private keys. Signing happens in MOI Wallet on your phone." (src/moi/provider.ts:190-195). Its signInteraction method throws a similar message that points to the tools that route signing to the phone over WalletConnect (src/moi/provider.ts:197-202). Keys stay on the phone; the server only relays the signed bytes to the node (src/tools/write-core.ts:213-219).

So a fully stolen server, records and all, could see which wallet address is paired to which browser cookie and could push approval requests to your phone. It could do nothing else. It could not sign, and it could not spend. The pairing lifetime limits that exposure, and you choose it (src/wc/lifetime.ts:1-9). Money moves only when you read the screen on your phone and tap Approve.