/**
 * Confirm tokens for the hosted write tools.
 *
 * A hosted write is two calls. The first builds the interaction and returns
 * what the phone will show plus a token; the second, carrying the token,
 * sends the approval to the phone. The token is what makes the preview
 * mandatory rather than advisory: it is bound to the user, the tool, and the
 * exact arguments, it lives ten minutes, and it works once. Without it a
 * model could go straight to the phone, and the user would be tapping on
 * numbers they never saw in the chat.
 *
 * In memory on purpose. A token that outlives the process is a token nobody
 * is looking at any more; the model previews again and loses a second.
 *
 * Writes to a dapp (src/tools/dapp.ts, and create_agent in
 * src/tools/launchpad.ts) use this same registry through redeemOrIssue below,
 * with no phone behind them. There the token only proves the call was
 * previewed with exactly these arguments; it is not proof that a person read it.
 */

import { createHash, randomBytes } from "node:crypto";

export interface PreviewEntry {
  userId: string;
  kind: string;
  /** fingerprint() of the tool arguments the preview was built from. */
  fingerprint: string;
  /** What the user was shown, so a later change in the numbers is caught. */
  details: Record<string, string>;
  expiresAt: number;
}

export const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Live tokens one user may hold; older ones are dropped first. */
const MAX_PER_USER = 8;

export class PreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxPerUser: number;

  constructor(opts: { ttlMs?: number; now?: () => number; maxPerUser?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? PREVIEW_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxPerUser = opts.maxPerUser ?? MAX_PER_USER;
  }

  issue(entry: Omit<PreviewEntry, "expiresAt">): { token: string; expiresAt: number } {
    this.sweep();
    this.capUser(entry.userId);
    const token = randomBytes(9).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, { ...entry, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Hand back the entry for a token that matches on every axis, and forget
   * it: one preview, one send. A token that belongs to someone else or to
   * different arguments is left alone, so a guess cannot burn the owner's.
   */
  redeem(
    token: string,
    expect: { userId: string; kind: string; fingerprint: string },
  ): PreviewEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return undefined;
    }
    if (
      entry.userId !== expect.userId ||
      entry.kind !== expect.kind ||
      entry.fingerprint !== expect.fingerprint
    ) {
      return undefined;
    }
    this.entries.delete(token);
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(token);
  }

  private capUser(userId: string): void {
    const mine = [...this.entries].filter(([, e]) => e.userId === userId);
    mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    while (mine.length >= this.maxPerUser) this.entries.delete(mine.shift()![0]);
  }
}

/**
 * A stable string for a value: keys sorted, undefined dropped, bigints as
 * decimal strings. Two argument objects that mean the same thing get the
 * same fingerprint however the model happened to order them.
 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(sortKeys(value), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(src)
        .sort()
        .map((k) => [k, sortKeys(src[k])]),
    );
  }
  return value;
}

/** How much of a request body or config a preview shows. The token still binds all of it and all of it is sent. */
export const PREVIEW_BODY_CHARS = 2000;

/** fingerprint() reduced to a fixed-size digest, for arguments that can be large: a dapp body may be up to the 1 MB request cap, and the registry holds the string for ten minutes. */
export function fingerprintDigest(value: unknown): string {
  return createHash("sha256").update(fingerprint(value)).digest("hex");
}

/** `text` cut to `max` characters, saying how much was left out. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

const NO_MATCH_NOTE =
  "That confirm token did not match this call: it was expired, already used, or the call changed since the preview " +
  "(the arguments, the wallet signed in as, or how the dapp defines the operation). Nothing was sent. " +
  "This is a fresh preview; show it and get the user's yes again.";

/**
 * The gate for a call that has no phone behind it. With a confirm token that matches this user, this kind and this
 * fingerprint, the token is spent and undefined comes back: the caller sends. Otherwise a fresh token is issued and
 * returned, with a note when a confirm was given but did not match. Redeem is synchronous, so two concurrent
 * confirms with one token let exactly one through. The binding is the fingerprint alone; `details` is stored empty
 * because nothing compares it here (runWrite compares it because chain numbers drift; an HTTP request does not).
 */
export function redeemOrIssue(
  registry: PreviewRegistry,
  key: { userId: string; kind: string; fingerprint: string },
  confirm: string | undefined,
): { token: string; expiresAt: number; note?: string } | undefined {
  if (confirm && registry.redeem(confirm, key)) return undefined;
  const issued = registry.issue({ ...key, details: {} });
  return confirm ? { ...issued, note: NO_MATCH_NOTE } : issued;
}

/** The preview as a block the model can paste into the chat; modelled on previewText in write-core.ts but for an HTTP call. */
export function previewBlock(p: {
  what: string;
  summary: string;
  details: Record<string, string>;
  token: string;
  expiresAt: number;
  note?: string;
}): string {
  return [
    ...(p.note ? [p.note, ""] : []),
    `PREVIEW. Nothing has been sent to ${p.what}.`,
    p.summary,
    "",
    "What will be sent:",
    ...Object.entries(p.details).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "Show the person this request as written and get an explicit yes. Then call again with the same arguments and " +
      `confirm="${p.token}" (valid until ${new Date(p.expiresAt).toISOString()}); that sends it, once.`,
  ].join("\n");
}
