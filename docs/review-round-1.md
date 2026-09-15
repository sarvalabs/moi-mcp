# Review round 1: findings and fixes

The whole-codebase review (pull request #4) produced four findings, all confirmed against the code. Fixing them produced a fifth: an adversarial pass over the fix itself found a gap in the deployment documents that would have reopened the first finding. All five are fixed on the `fix/review-round-1` branch (commits `0a1bf79` and `52f0ad2`, pull request #6), each pinned by a test that fails without the fix. The suite after the fixes: 428 tests passing across 30 files.

| # | Severity | Area | One line |
|---|---|---|---|
| 1 | High, once on a public domain | Rate limiting | Any sender could switch the rate limiter off by rotating a request header. |
| 2a | Medium, operational | Write journal | A signed transaction could be recorded as if it never happened. |
| 2b | Medium, user-facing | Write path | A landed transaction could be reported to the user as a failure. |
| 3 | Low | Rate limiting | DELETE requests to the MCP endpoint had no rate limit. |
| 4 | Low, hardening | OAuth | The consent form stored a permission string nothing had checked. |
| 5 | High, would have undone fix 1 | Deployment docs | Two nginx examples left out the one line fix 1 depends on. |

None of the five touched the core guarantee. The server holds no private keys, and no finding produced a path where funds move without a tap on the phone.

## 1. The rate limiter trusted a header the sender writes

A rate limiter stops one sender from hammering the server, for example trying thousands of sign-in codes per minute. To count requests per sender it has to know who each request came from. The server read that identity from the front of the `X-Forwarded-For` header. The sender writes the front of that header. An attacker could stamp a different invented address on every request, and the server would treat each request as a brand-new sender. Every limit, on `/register`, `/token`, `/authorize/decision`, and the MCP endpoint, could be dodged this way.

What the limiter protects: brute force against the token endpoint, disk-filling registration spam, and request floods. It does not protect funds; the custody model does not depend on it.

The fix is one function, `clientAddress()` in `src/auth/rate-limit.ts`, shared by the Express middleware and the read gateway (`src/http.ts`). A connection from a remote address is keyed on the socket address, and the header is ignored entirely, because the socket address cannot be faked. A connection from this machine, which is how requests arrive through the local nginx, is keyed on the last header entry, the one nginx itself appends and the sender cannot write.

Tests: the `clientAddress` cases and the rotating-header case in `test/unit/review-fixes.test.ts`, which sends the actual attack and expects a 429, and the strengthened bucket test in `test/unit/hardening.test.ts`.

## 2a. A journal failure could mislabel a live signature

The server keeps a journal of every write attempt through the states proposed, signed, broadcast, confirmed, with `failed` and `orphaned` for the unhappy paths. `orphaned` means a human should look. The code only remembered "the phone signed this" after the journal write recording it succeeded. If that write failed, for example on a full disk, the error handler consulted its memory, concluded nothing had been signed, and recorded `failed`, meaning nothing happened. A real signature existed.

The fix is ordering: the in-memory flag is set the instant the phone returns a signature, before the journal is touched (`src/tools/hosted-writes.ts`). A journal failure after signing now lands as `orphaned`.

Test: "a journal failure AFTER the phone signed lands as orphaned, never failed" in `test/unit/review-fixes.test.ts`.

## 2b. A cleanup failure could report a landed transaction as failed

After a broadcast succeeds, the transaction is on the chain and the money has moved. The server then does housekeeping: a once-only pairing gets deleted, and the final journal entries get written. The pairing deletion was not wrapped in its own error handling. If it threw, the error reached the outer handler, which marked the write `orphaned` and told the user it failed. The user, told their transfer failed, might send again and pay twice.

The fix: once the broadcast succeeds, nothing after it may change the answer. The cleanup and the journal writes are wrapped; a failure there is logged for the operator and the user still gets the truthful "sent" with the transaction hash. The cost is bounded: a once-pairing whose deletion failed stays usable until its existing 15-minute expiry, on the user's own phone, and the boot reconciler finalizes any journal line the swallowed error left missing.

Tests: the store-failure and journal-failure-after-broadcast cases in `test/unit/review-fixes.test.ts`, both asserting the result is `sent` with the hash.

## 3. DELETE had no rate limit

The MCP endpoint applied the limiter to GET and POST and forgot DELETE, which still runs the full request-handling code. The fix adds the same limiter to the DELETE route in `src/server.ts`.

Test: the 241st DELETE in a minute answers 429, in `test/unit/review-fixes.test.ts`.

## 4. The consent decision stored an unchecked scope

Permissions arrive as scopes: `moi:read` and `moi:write`. The page that shows the consent screen (`GET /authorize`) validates the requested scopes against the supported list. The form submission that mints the grant (`POST /authorize/decision`) did not re-check; it stored whatever string the form carried. Harmless today, because everything downstream matches the two known scope strings exactly, and dangerous the day someone changes that downstream code. The fix runs the identical check at the decision and answers `invalid_scope` (`src/auth/routes.ts`).

Test: "refuses a tampered scope at the decision" in `test/unit/auth.test.ts`, including the check that a legitimate narrowing to `moi:read` still works.

## 5. Two deployment documents would have reopened finding 1

Fix 1 trusts the last header entry only because the local nginx appends the real client address there. That is a property of nginx configuration, and two of the three nginx examples in this repository (`docs/deploy-vm.md` and `docs/deploy-voyage.md`) never set the header at all. nginx without that line passes the sender's own header through untouched, and the trusted last entry becomes attacker text again: the original vulnerability, reintroduced by following our own documents.

The fix makes every nginx block set `X-Forwarded-For $remote_addr`, which overwrites the header and discards anything the sender wrote, and `docs/handoff-infra.md` now explains why the line must never be removed. The same section records a related constraint: nginx must connect to the gateways from this machine. A proxy connecting from any other address, for example another container over a Docker bridge, makes the limiter key every client on the proxy's address and collapses all users into one shared bucket. Nothing spoofable, but one busy client would starve the rest; a configurable trusted-proxy list is the code-level answer if that deployment shape ever becomes real.

## The pattern in these five

Findings 1, 3, and 5 are the same lesson three times: a limit is only as real as the identity it counts against, and that identity must come from something the sender cannot write, in every configuration the documents describe. Findings 2a and 2b are one lesson twice: once real money has moved, bookkeeping errors must never rewrite what the user or the journal is told.
