# MOI dapp conventions

What a dapp offers so the MOI MCP connector can act on it from a chat without code written for that dapp. The MOI Agent Launchpad is the reference; its hand-written tools (`moi_launchpad_*`) do what the generic tools (`moi_dapp_*`) do for any dapp that follows this.

## 1. Sign-In With MOI

There is no account. The wallet is the identity, and the dapp proves it holds the key by having the wallet sign a message.

| Route | Body | Answer |
|---|---|---|
| `POST /api/auth/nonce` | `{ "walletAddress": "0x…" }` | `{ "nonce": "…", "message": "…" }` |
| `POST /api/auth/verify` | `{ "address": "0x…", "message": "…", "signature": "…" }` | `200 { "ok": true, … }` and a `Set-Cookie: moi_session=…; HttpOnly; Max-Age=…` |
| `POST /api/auth/logout` | none | `{ "ok": true }` |

The message is plain text, and the connector signs this form and no other. It is the form the Launchpad builds:

```
<Dapp name> wants you to sign in with your MOI account.

Wallet: <address>
Nonce: <nonce>
Issued At: <ISO time>
Origin: <dapp origin>
```

Exactly these six lines, in this order, joined with `\n` (never `\r\n`), nothing before or after, at most 1024 characters. The dapp name is 1 to 80 characters with no control, format (zero-width, direction-override) or line-separator characters. Every other value is printable ASCII with no space: `Wallet` and `Nonce` at most 128 characters, `Issued At` at most 40, `Origin` at most 200. The connector checks the message before it asks the phone, and refuses it, sending nothing to the wallet and nothing to `/api/auth/verify`, when:

- `Origin` is not the origin the connector is calling (case is ignored, and one trailing `/` is accepted);
- `Wallet` is not the paired wallet's address (case is ignored);
- `Issued At` is not an ISO 8601 time ending in `Z` or an offset written `+HH:MM` or `-HH:MM`, or is more than five minutes from the connector's clock, earlier or later;
- `Nonce` is missing or empty, or any line is missing, repeated, extra or out of order.

The person then sees `Not signing: the sign-in message from <origin> ...`. A dapp that adds lines to the message (a statement, an expiry) is refused until this form changes.

The connector can only vouch for the `Origin` the dapp itself wrote, so the dapp's own `/api/auth/verify` must reject a message whose `Origin` is not that dapp's own origin. Without that check, a hostile dapp could take a nonce from this one, put it in a message carrying the hostile dapp's own origin, have the wallet sign that, and replay the signature here.

The signature is what MOI Wallet returns for `moi.sign`: the MOI signature envelope as hex (type byte, DER length, DER body, parity byte), with or without `0x`. The dapp verifies it by recovering the public key from the signature over `blake2b256(message)` and checking it derives the address; no public key is sent. Nonces are single-use and short-lived. The cookie is the session; `Max-Age` tells the connector how long to keep it.

Every route that acts for the person answers `401` when the cookie is missing or dead. The connector forgets the session on a 401 and asks the person to sign in again.

## 2. Published operations

A dapp that wants the connector to call it publishes an OpenAPI 3 document at one of:

```
/.well-known/openapi.json
/openapi.json
/api/openapi.json
```

The connector reads it, lists the operations to the model (`moi_dapp_api`), and calls only operations listed there (`moi_dapp_call`), with the session cookie, path and query parameters filled from the document, and a JSON body where the operation declares one. A `GET` runs at once; every other method is a two-step call, described below. A path parameter of `.` or `..` is refused, since the URL would resolve to a path the dapp did not publish. Redirects are never followed. Responses are handed to the model as JSON, cut at 64 KB.

Give each operation an `operationId` and a one-line `summary`; that is what the model reads, and the preview shows the summary beside the request, labelled as the dapp's own description and not checked by the connector.

The connector decides read or write by HTTP method alone, never by the summary. `GET` is a read and runs without asking, so a dapp must not change state on a `GET`. Every other method (`POST`, `PUT`, `PATCH`, `DELETE`) is a write, and a write is two calls. The first `moi_dapp_call` sends nothing: it returns the method, path, parameters and body, as the connector will send them, for the person to read in the chat, with a one-use token. The second call, with the same arguments and that token, sends it. The token is bound to the person, the dapp, the operation as the dapp defines it at that moment (method and path), the wallet signed in as, the parameters and the body. It works once and lives ten minutes. If the dapp redefines the operation, or the person signs in as another wallet, between the two calls, the token fails and a fresh preview comes back instead. If the second call fails or times out the token is spent and the write may or may not have happened, so check the dapp's state before previewing again.

The token proves the call was previewed with exactly these arguments. It is not a signature, and it is not proof that the person read the preview: their yes is asked for in the chat and, for a tool marked destructive, by their MCP client's own approval. Nothing on the phone is involved in a dapp write. Every write therefore costs two tool calls.

## 3. What the connector never does

- It never sends a dapp's cookie anywhere but that dapp's origin, and only over https to a public host. A name is resolved on every new connection, the connection is made to the address that was checked, and a name with any loopback, private, link-local, unique-local or unspecified answer is refused.
- It never calls a path the dapp did not publish.
- It never runs a write on the first call, and never runs one twice on one token, even when the dapp then fails.
- It never returns a secret the dapp hands out (a private key, an API key) as a tool result. The Launchpad's setup script, which embeds an agent key, is served to a browser through a one-time link instead.
- It never asks the wallet to sign anything but a sign-in message of the form in section 1, for that dapp's origin and the paired wallet. No tool takes text to sign.
