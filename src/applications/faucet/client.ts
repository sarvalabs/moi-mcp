/**
 * The Voyage devnet faucet as a client: one claim, for one account.
 *
 * The documented API (voyage-docs, endpoint-docs/faucet.md) takes the API key as a path segment:
 * POST <base>/<key>/claim with { "address": "<account>" }, answered { "success": true, "message": "..." }, with one claim
 * per account in a fixed cooldown period. THE KEY IS PART OF THE URL, so the URL is a secret, and this file is written
 * around that. The rules, each pinned by test/unit/faucet-secret.test.ts:
 *   - The address and the key live in #private fields, so no log, JSON or inspect of the client holds them.
 *   - No error, log line or result is built from a caught error's own text (undici puts the address in some messages),
 *     from a response's url, or from a header (a redirect's Location carries the key). Every failure is FIXED text, plus at
 *     most the faucet's own message field, which is withheld whole if it repeats the key (see #said).
 *   - A redirect is never followed, so the key cannot be sent to another host.
 *   - The default fetch is the dapp layer's guarded one (publicFetch), which resolves the host on every connection and
 *     refuses private addresses. Only allowInsecure, a switch for tests, swaps it for a plain fetch.
 *
 * What a failure SAYS is limited to what is known. "Nothing was claimed" is said only when the request provably never went
 * out: the host was refused, the connection was refused or timed out, or the name did not resolve. Once the request has gone
 * out, a reset, a timeout, a 5xx or a redirect leave it unknown, and those answers say so and send the person to the balance.
 * No MCP imports.
 */

import { readWhole } from "../../bounds.js";
import { MoiError } from "../../moi-error.js";
import { quoteChainText } from "../../moi/ix-builder.js";
import { ErrorCode, type Network } from "../../schema.js";
import type { FetchLike } from "../dapp/client.js";
import { dappOrigin, publicFetch, type Resolver } from "../dapp/origin.js";

/** The one network the faucet hands out funds on: MOI_NETWORK=voyage is the Voyage devnet. */
export const FAUCET_NETWORK: Network = "voyage";

const TIMEOUT_MS = 20_000;
/**
 * The real answer is one line of JSON. Over this is an error, not a cut: a cut answer cannot be told from a refusal.
 */
export const MAX_FAUCET_ANSWER_BYTES = 8 * 1024;
/** What of the faucet's own words reaches the model. */
export const MAX_FAUCET_MESSAGE_CHARS = 200;
/** The key's real format is not documented, so these are sanity limits and not a pattern. */
const MAX_KEY_CHARS = 256;
const MAX_ADDRESS_CHARS = 2048;
/** An account id: 0x and 32 bytes of hex, which is what the faucet's own example sends. */
const ACCOUNT_ID = /^0x[0-9a-fA-F]{64}$/;

const CHECK_BALANCE = "Check the wallet's balance with moi_get_account in a minute before asking again.";

export type FaucetFailure =
  | "wrong_network"
  | "bad_address"
  | "rate_limited"
  | "refused_host"
  | "unreachable"
  | "timeout"
  | "interrupted"
  | "redirected"
  | "key_refused"
  | "declined"
  | "server_error"
  | "too_large"
  | "unreadable";

/** Every way a claim fails. `data` holds the outcome word and, when there was an answer, its status: nothing from the answer itself. */
export class FaucetError extends MoiError {
  readonly outcome: FaucetFailure;

  constructor(outcome: FaucetFailure, message: string, status?: number) {
    super(ErrorCode.FAUCET_ERROR, message, status === undefined ? { outcome } : { outcome, status });
    this.name = "FaucetError";
    this.outcome = outcome;
  }
}

interface Answer {
  success?: boolean;
  message?: string;
}

/**
 * Read leniently, each field on its own: success only if it is a boolean, message only if it is a string. A null or array
 * message is an ordinary API shape and must not turn a documented success into "unreadable". success is optional on
 * purpose too: a gateway's 429 may carry a message and no success, and its words are still wanted.
 */
function parseAnswer(text: string): Answer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { success, message } = value as { success?: unknown; message?: unknown };
  return {
    ...(typeof success === "boolean" ? { success } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

/**
 * Text folded so that what a person would still read as the key cannot hide in it: compatibility forms folded, lower case,
 * and every control, format (zero-width, bidi), space and separator character taken out.
 */
function fold(text: string): string {
  return text.normalize("NFKC").replace(/[\p{C}\p{Z}\s]+/gu, "").toLowerCase();
}

/**
 * Codes (on the error's cause) of a failure before the request could have been written. Anything else after the request went
 * out leaves what the faucet did unknown. ETIMEDOUT is left out on purpose: it also names a read timeout on an open connection.
 */
const NEVER_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/** The code of a fetch failure's cause, or undefined. Never its message: undici's can hold the address being connected to. */
function causeCode(err: unknown): string | undefined {
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * A failed fetch, as fixed text. The caught error's own message is never used. The guard's refusal arrives either as the
 * MoiError itself (an IP literal) or as the cause of undici's TypeError("fetch failed") (a name), as DappClient.request
 * unwraps it.
 */
function unreached(err: unknown): FaucetError {
  const guard = err instanceof MoiError ? err : err instanceof Error && err.cause instanceof MoiError ? err.cause : undefined;
  if (guard) {
    return new FaucetError(
      "refused_host",
      "This server will not send anything to the faucet's address, because it does not resolve to a public address. " +
        "Nothing was claimed. Whoever runs this server should check MOI_FAUCET_URL.",
    );
  }
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError") {
    return new FaucetError(
      "timeout",
      `The faucet did not answer in time, so it is not known whether the claim went through. ${CHECK_BALANCE}`,
    );
  }
  const code = causeCode(err);
  if (code !== undefined && NEVER_SENT.has(code)) {
    return new FaucetError("unreachable", "The faucet could not be reached. Nothing was claimed; try again in a few minutes.");
  }
  return new FaucetError(
    "interrupted",
    `The connection to the faucet broke before it finished answering, so it is not known whether the claim went through. ${CHECK_BALANCE}`,
  );
}

export interface FaucetClientOptions {
  /** The faucet's base address, without the key: https, no query, no fragment, no credentials. */
  baseUrl: string;
  key: string;
  /** Tests only: let an http origin through, with a plain fetch, so a fake on loopback can be reached. */
  allowInsecure?: boolean;
  /** Tests only: stands in for DNS, so a test never resolves a real name. */
  resolve?: Resolver;
  /** Tests only. */
  timeoutMs?: number;
}

export class FaucetClient {
  readonly #claimUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  /**
   * What must never be shown, folded: the key and its percent-encoded form (the claim address contains the second). A key
   * that folds to nothing would make every message withheld, which is the safe direction.
   */
  readonly #needles: readonly string[];

  constructor(opts: FaucetClientOptions) {
    const { key } = opts;
    if (key.length === 0 || key.length > MAX_KEY_CHARS || /^\.{1,2}$/.test(key)) {
      // A dot segment would be resolved out of the path by the URL parser, and the request would go to another path.
      throw new Error("The faucet key must be 1 to 256 characters and not only dots.");
    }
    let base: URL;
    try {
      if (opts.baseUrl.length > MAX_ADDRESS_CHARS) throw new Error("too long");
      dappOrigin(opts.baseUrl, { allowInsecure: opts.allowInsecure });
      base = new URL(opts.baseUrl);
      if (base.search !== "" || base.hash !== "" || base.username !== "" || base.password !== "") throw new Error("extras");
    } catch {
      // Never the caught error's text: dappOrigin quotes the address it was given.
      throw new Error("The faucet address must be a public https URL with no query, fragment or credentials.");
    }
    const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    const encoded = encodeURIComponent(key);
    this.#claimUrl = `${root}/${encoded}/claim`;
    this.#fetch = opts.allowInsecure === true ? (input, init) => fetch(input, init) : publicFetch(opts.resolve);
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#needles = [...new Set([fold(key), fold(encoded)])];
  }

  /**
   * Ask the faucet for funds for `address`. Resolves with the faucet's own words (cleaned, quoted, or undefined when it
   * said none or they repeated the key) when it says the claim was accepted; throws a FaucetError for everything else.
   */
  async claim(address: string): Promise<{ said: string | undefined }> {
    if (!ACCOUNT_ID.test(address)) {
      throw new FaucetError(
        "bad_address",
        "The paired wallet's address is not an account id the faucet takes (0x and 64 hex characters), so nothing was sent to the faucet.",
      );
    }
    let res: Response;
    try {
      res = await this.#fetch(this.#claimUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ address }),
        // A redirect could carry the key to another host. Never follow one, and never read where it points.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw unreached(err);
    }

    const status = res.status;
    if (status >= 300 && status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new FaucetError(
        "redirected",
        `The faucet answered with a redirect (HTTP ${status}), which this server does not follow, so it is not known what the faucet did with the request. ` +
          `${CHECK_BALANCE} Whoever runs this server should check MOI_FAUCET_URL.`,
        status,
      );
    }

    let text: string;
    try {
      text = await readWhole(res, MAX_FAUCET_ANSWER_BYTES, "The faucet's answer");
    } catch (err) {
      // readWhole's own text is not used: its failed-read message carries the stream error's text. Only whether the size
      // limit was the reason (it sets limitBytes) is taken from it.
      const big = err instanceof MoiError && "limitBytes" in err.data;
      throw new FaucetError(
        big ? "too_large" : "unreadable",
        big
          ? `The faucet's answer was larger than the ${MAX_FAUCET_ANSWER_BYTES / 1024} KB this server reads, so it was not used and it is not known whether funds were sent. ${CHECK_BALANCE}`
          : `The faucet's answer could not be read, so it is not known whether funds were sent. ${CHECK_BALANCE}`,
        status,
      );
    }

    const answer = parseAnswer(text);
    const said = this.#said(answer?.message);
    if (res.ok) {
      if (answer?.success === true) return { said };
      if (answer?.success === undefined) {
        throw new FaucetError(
          "unreadable",
          `The faucet answered (HTTP ${status}) in a form this server does not understand, so it cannot say whether funds were sent. ${CHECK_BALANCE}`,
          status,
        );
      }
    } else if (status === 401 || status === 403) {
      // None of its words: an invalid-key answer is where an API most often echoes the token it was given.
      throw new FaucetError(
        "key_refused",
        `The faucet did not accept this server's key (HTTP ${status}). Only whoever runs this server can fix that, so asking again will not help.`,
        status,
      );
    } else if (status >= 500) {
      // A gateway's 502, 503 or 504 can come after the faucet acted, so this is not "did not hand out funds".
      throw new FaucetError(
        "server_error",
        `The faucet answered with a server error (HTTP ${status})${said ? `. It says: ${said}` : ""}. ` +
          `It is not known whether funds were sent. ${CHECK_BALANCE}`,
        status,
      );
    }
    // From here the faucet said no, in words or only in a status.
    throw new FaucetError(
      "declined",
      `The faucet did not hand out funds (HTTP ${status})${said ? `. It says: ${said}` : ""}. ` +
        "Each account can claim once in a fixed cooldown period, so if this is a cooldown, ask again after it has passed.",
      status,
    );
  }

  /**
   * The faucet's own words, ready for the model, or undefined. WITHHELD WHOLE if a folded copy of them holds the key or its
   * encoded form: that catches the key in any letter case, split by spaces, line breaks or zero-width and bidi characters, and
   * as part of the claim address, wherever it sits and whether or not it would have been cut. It does not catch a deliberate
   * partial echo (a masked key). What survives has control, format and line-separator characters made into spaces and double
   * quotes made single (quoteChainText does not escape them, so the words could otherwise close their own quotes), and is cut
   * and quoted as outside text. Undefined too when nothing is left or the message was not a string.
   */
  #said(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const folded = fold(raw);
    if (this.#needles.some((needle) => folded.includes(needle))) return undefined;
    const text = raw.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ").replace(/"/g, "'").trim();
    return text === "" ? undefined : quoteChainText(text, MAX_FAUCET_MESSAGE_CHARS);
  }
}
