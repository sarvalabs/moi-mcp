# MOI dapp conventions

What a dapp offers so the MOI MCP connector can act on it from a chat without code written for that dapp. The MOI Agent Launchpad is the reference; its hand-written tools (`moi_launchpad_*`) do what the generic tools (`moi_dapp_*`) do for any dapp that follows this.

## 1. Sign-In With MOI

There is no account. The wallet is the identity, and the dapp proves it holds the key by having the wallet sign a message.

| Route | Body | Answer |
|---|---|---|
| `POST /api/auth/nonce` | `{ "walletAddress": "0x…" }` | `{ "nonce": "…", "message": "…" }` |
| `POST /api/auth/verify` | `{ "address": "0x…", "message": "…", "signature": "…" }` | `200 { "ok": true, … }` and a `Set-Cookie: moi_session=…; HttpOnly; Max-Age=…` |
| `POST /api/auth/logout` | none | `{ "ok": true }` |

The message is plain text. The Launchpad's form, which other dapps are encouraged to reuse, is:

```
<Dapp name> wants you to sign in with your MOI account.

Wallet: <address>
Nonce: <nonce>
Issued At: <ISO time>
Origin: <dapp origin>
```

The signature is what MOI Wallet returns for `moi.sign`: the MOI signature envelope as hex (type byte, DER length, DER body, parity byte), with or without `0x`. The dapp verifies it by recovering the public key from the signature over `blake2b256(message)` and checking it derives the address; no public key is sent. Nonces are single-use and short-lived. The cookie is the session; `Max-Age` tells the connector how long to keep it.

Every route that acts for the person answers `401` when the cookie is missing or dead. The connector forgets the session on a 401 and asks the person to sign in again.

## 2. Published operations

A dapp that wants the connector to call it publishes an OpenAPI 3 document at one of:

```
/.well-known/openapi.json
/openapi.json
/api/openapi.json
```

The connector reads it, lists the operations to the model (`moi_dapp_api`), and calls only operations listed there (`moi_dapp_call`), with the session cookie, path and query parameters filled from the document, and a JSON body where the operation declares one. Redirects are never followed. Responses are handed to the model as JSON, cut at 64 KB.

Give each operation an `operationId` and a one-line `summary`; that is what the model reads. Mark reads and writes clearly in the summary, since the connector asks the person before anything that is not a plain read.

## 3. What the connector never does

- It never sends a dapp's cookie anywhere but that dapp's origin, and only over https to a public host.
- It never calls a path the dapp did not publish.
- It never returns a secret the dapp hands out (a private key, an API key) as a tool result. The Launchpad's setup script, which embeds an agent key, is served to a browser through a one-time link instead.
