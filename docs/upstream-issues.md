# Issues in the MOI stack

Found while building an MCP server against voyage devnet, 2026-08-26 to
2026-09-01. Each is reproducible and each blocks any third-party integrator, not
just us. Filed here so they can be raised independently of anything else.
Asset creation is **not** on this list: it works once the new asset is funded
with KMOI for its own storage, which the server now does automatically.

Environment: `js-moi-sdk@0.8.0`, `js-moi-agent-registry@0.3.0-rc1`,
MOI Wallet mobile over WalletConnect v2, RPC
`https://dev.voyage-rpc.moi.technology/devnet/`, chain `moi:14`.

---

## 1. `moi.sendInteractions` crashes MOI Wallet's local database

**Severity: blocks the documented write path entirely.**

Sending an interaction over WalletConnect with `moi.sendInteractions` fails
every time with a SQLite error leaking out of the wallet:

```
Failed to create interaction: Calling the 'finalizeAsync' function has failed
→ Caused by: Error code 19: NOT NULL constraint failed:
  interactions_metadata.number_of_operations
```

**This is not a malformed payload.** It reproduces with an interaction built by
the SDK's own builder — the same class `sarvalabs/wallet-connect-dapp` uses in
`src/contexts/JsonRpcContext.tsx`:

```ts
const ix = await new MAS0AssetLogic(KMOI_ASSET_ID, signer)
  .transfer(recipient, 1)
  .ixData({ sender: { id: account, key_id: 0, sequence } });

await client.request({
  topic, chainId: "moi:14",
  request: { method: "moi.sendInteractions", params: [ix] },
});
```

The same interaction simulates cleanly against the node (`moi.Call` →
`receipt.status: 0`, `fuel_used: 0x12b`), and the identical payload signs and
broadcasts successfully via the workaround below. So the interaction is valid;
the wallet fails while writing its own metadata row.

**Workaround, and what the server ships:** call `moi.signInteraction` with
the same positional `params: [ix]`, and broadcast the returned
`{ ix_args, signatures }` yourself via the node's `moi.SendInteractions`. That
path works — confirmed on chain at
`0x3c568254d339090d1e0ec256f9ac46fe288aab7d7739275e2267ddff3fdbc009`
(status 0, 299 fuel). The phone still shows the approval screen and still
holds the only key; the dapp merely relays the signed bytes.

**Note:** a dapp should never see a SQLite constraint error. Even once the
underlying cause is fixed, a validation failure would be more useful than an
internal DB error.

---

## 2. `AccountState.nonce` is declared in the SDK types but never returned

**Severity: silent wrong values, hard to trace.**

`js-moi-providers` declares:

```ts
export interface AccountState {
    nonce: string;
    // ...
}
```

The node does not return that field. `provider.getAccountState(id).nonce` is
`undefined`, which any reasonable numeric coercion turns into `0` — so an
account that has transacted several times reports a nonce of 0, and the wallet
then rejects the interaction with **"invalid nonce"**.

The type is what makes this expensive: it asserts a field exists, so nobody
thinks to check, and the failure surfaces two layers away as a wallet
rejection.

**Correct source**, and what the SDK's own `Signer.getNonce()` uses:

```ts
await provider.getPendingInteractionCount(id, keyId)
```

**Suggested fix:** mark it optional (`nonce?: string`) or remove it. Either
makes the compiler surface the problem at the call site.

---

## 3. `AgentRegistry.init()` requires a private key to perform reads

**Severity: unusable from any keyless process.**

```ts
export interface SDKConfig {
    wallet: Signer;      // required
    uploader?: CardUploader;
}
static init(config: SDKConfig): Promise<AgentRegistry>;
```

`getAgentProfile`, `getAgentsByOwner`, `getAllAgentIds` and `getAgentCount` are
all read-only, but the class cannot be constructed without a `Signer`. Anything
that deliberately holds no keys — an indexer, a public API, an MCP server —
cannot use the package for reads at all.

**Workaround:** bypass the class and call `getLogicDriver(LOGIC_ID, signer)`
with a Signer that carries a provider and throws on both signing methods.

**Suggested fix:** accept a provider, or add a `AgentRegistry.readOnly(provider)`
constructor that exposes only the query methods.

---

## 4. Four undocumented JSON-RPC details

**Severity: hours of debugging each, for anyone not reading the SDK source.**

Found while writing a second client in Go against the same endpoint. None is
in the public JSON-RPC docs; all four are only discoverable by reading
`js-moi-providers`.

| Detail | What happens if you get it wrong |
|---|---|
| Params are wrapped: `params: [{...}]`, not positional | `empty options` |
| The identifier key is `id`, not `identifier` | `invalid identifier` — reads like a bad address, not a wrong field name |
| Most reads need an `options` block; `{"tesseract_number": -1}` means latest | `empty options`, even with a valid id |
| Asset standard is in bytes 2..3 of the asset id | No `standard` field on `AssetInfo`; you assume it is missing data |

The second one is the worst: `invalid identifier` sends you off validating the
address you passed, when the address was fine and the *field name* was wrong.

**Suggested fix:** one worked `curl` example per method in the JSON-RPC docs
would close all four.

## Two smaller notes

**Registry has no state on devnet.** The logic at
`0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000`
loads its manifest and exposes 11 routines, but every routine call fails with
`state object fetch failed: failed to fetch acc meta info: account not found`.
Presumably nothing has been registered yet — worth confirming that is expected
rather than a deployment problem.

**Read-only logic calls need a caller that exists on chain.** `getLogicDriver`
routes reads through a `Signer`, and the node resolves that caller's account
meta info, so a synthetic identity fails. A read failing for reasons unrelated
to what is being read is surprising. Is there a canonical read-only caller, or
should simulation not require a resolvable sender?

---

## 5. Delegation surfaces are half-implemented and half-documented

**Severity: anyone designing agent spend control will pick the wrong primitive.**

MOI has three things that look like delegation (`docs/findings.md` §6 has the
evidence):

- **Access policies** (`ACCESS_CREATE/UPDATE/DELETE`): `ResourceType` declares
  `STORAGE/ASSET/LOGIC/KEY` and `AccessAction` declares `ASSET_ACCESS` and
  `LOGIC_ACCESS`, but the SDK validator throws on anything except `STORAGE`
  and the devnet node answers `only 'storage' resource type is implemented`.
  The policy type has no amount, limit, rate or expiry field. The
  `moi.AccessPolicy` / `moi.AccessPolicies` RPCs and the SDK `Access` class
  are not in the public docs.
- **Account keys** (`ACCOUNT_CONFIGURE`): weights 0–1000 against a fixed
  threshold of 1000. No per-key scope, cap or expiry. Documented.
- **MAS0 mandates** (`Approve`/`TransferFrom`/`Revoke`): amount + `expires_at`
  per (asset, grantee), revocable, and the grantee signs with its own key.
  Documented as "Mandates"; `moi.Mandates` RPC documented; no provider helper
  in `js-moi-providers@0.8.0`. Whether the cap decrements cumulatively across
  `TransferFrom`s is not stated.

**Suggested fix:** document which `ResourceType`/`AccessAction` values are live
per network, publish the access-policy RPCs, and state mandate accounting.

## Also worth knowing

`moi.sendInteractions` (wallet, camelCase) and `moi.SendInteractions` (node,
PascalCase) differ only in casing and do different things on different
transports. That is a genuine trap; naming them distinctly would help.

Manifest elements that are routines carry `kind: "callable"`, not `"routine"`
(`js-moi-utils` `ElementType.ROUTINE = "callable"`). Anyone filtering a raw
manifest by the obvious word gets an empty list — we did.

The node returns `asset_deeds` on `moi.AccountState` where the SDK type says
`asset_approvals`, and returns no `nonce` (issue 2). Two more places the types
and the wire disagree.


## 6. `moi.signInteraction` has no way to show the user what they are signing

**Severity: limits how informed a phone approval can be.**

Every write tool composes a plain sentence ("Transfer 50 KMOI to 0x…") for the
user to approve. There is nowhere to put it. `moi.signInteraction` takes only
the interaction (`params: [address, ix]` in `sarvalabs/wallet-connect-dapp`,
`[ixRequest]` in the extension's SPECIFICATION.md), and the interaction format
has no memo or label field. The wallet therefore renders whatever it can decode
from the raw operations. For a transfer that is legible; for an asset create,
a mint, or a logic call with encoded calldata, it is much less so.

**Workaround, and what the server ships:** every hosted write is two calls.
The first builds and simulates the interaction and returns a preview: the
sentence, the values the wallet will render (amount in base units, asset id,
recipient, storage fund), and a single-use confirm token bound to the user,
the tool and the arguments. The second call, carrying the token, is the only
path to the phone. So the chat shows the phone's own numbers before the phone
does, the model cannot skip the step, and if the numbers move between the two
calls the user gets a fresh preview rather than a send. The stdio server keeps
the single-call flow with a confirm-before-call instruction.

**Wallet-side fix:** accept an optional second param (or a `meta.description`
like the `ix_args` style already models for `sendInteractions`) and render it
above the decoded operations.

---

## 7. No way to read the network's minimum fuel price

**Severity: every client hardcodes a number that the chain can move.**

A transaction priced below the mempool floor is refused at broadcast with
"interaction underpriced", but only at broadcast: simulation via `moi.Call`
accepts it, so a server can preview, collect a signature on the phone, and
then fail. That is what happened here after the September 2026 upgrade moved
the floor: this server sent a fuel price of 1, every simulation and test
passed, and two approved interactions bounced.

Nothing reports the floor. `moi.FuelPrice`, `moi.MinFuelPrice`,
`moi.NetworkInfo` and `moi.ProtocolParams` do not exist, and js-moi-providers
has no method for it. The only source is `DEFAULT_FUEL_PRICE` in
js-moi-constants, a compile-time copy that is right until the next upgrade.

**Workaround, and what the server ships:** take the price from the SDK
constant rather than a local literal, so an SDK upgrade carries it.

**Node-side fix:** expose the current minimum over RPC, and have `moi.Call`
reject an underpriced interaction the way broadcast does, so a preview can
fail before anyone is asked to sign.
