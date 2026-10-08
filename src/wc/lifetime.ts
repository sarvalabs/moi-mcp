/**
 * How long a wallet pairing is allowed to live.
 *
 * A pairing does not protect funds; every transaction still needs the phone.
 * What a stale one can do is let whoever holds the server-side record raise
 * prompts on that phone and see which wallet is attached. The lifetime is the
 * knob on that exposure. The person picks it in the chat when the wallet is
 * connected, and it reaches the server through the model. That means a model
 * could pick a longer lifetime than it was told to, so the bound that matters
 * is the top one: a week, which is also WalletConnect's own session limit.
 */

import type { StoredWalletSession } from "./store.js";

/**
 * The words a pairing record stores. "persistent" is the stored word for a
 * week, kept so every record written before lifetimes had three values still
 * reads as it did.
 */
export const PAIRING_MODES = ["persistent", "day", "once"] as const;
export type PairingMode = (typeof PAIRING_MODES)[number];

/** The words the connect tool offers the person: once, day and week. */
export const LIFETIMES = ["once", "day", "week"] as const;
export type PairingLifetime = (typeof LIFETIMES)[number];

/** Matches WalletConnect's own default session lifetime; we can be shorter, never longer. */
export const PERSISTENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export const DAY_TTL_SECONDS = 24 * 60 * 60;

/** A "just this once" pairing that is never used still goes away on its own. */
export const ONCE_TTL_SECONDS = 15 * 60;

/** The stored mode for a lifetime the person chose: a week is stored as persistent. */
export function modeOfLifetime(lifetime: PairingLifetime): PairingMode {
  return lifetime === "week" ? "persistent" : lifetime;
}

/** The lifetime word for a stored mode. A record with no mode predates lifetimes and was a week. */
export function lifetimeOfMode(mode: PairingMode | undefined): PairingLifetime {
  return mode === undefined || mode === "persistent" ? "week" : mode;
}

export function expiryFor(mode: PairingMode, nowSeconds: number): number {
  if (mode === "once") return nowSeconds + ONCE_TTL_SECONDS;
  if (mode === "day") return nowSeconds + DAY_TTL_SECONDS;
  return nowSeconds + PERSISTENT_TTL_SECONDS;
}

/**
 * Records written before lifetimes existed carry no expiresAt. They are
 * treated as persistent and aged from their createdAt, so an old pairing
 * still expires rather than living forever by omission.
 */
export function expiresAtOf(record: Pick<StoredWalletSession, "expiresAt" | "createdAt">): number {
  if (typeof record.expiresAt === "number") return record.expiresAt;
  const created = Math.floor(new Date(record.createdAt).getTime() / 1000);
  return Number.isFinite(created) ? created + PERSISTENT_TTL_SECONDS : 0;
}

export function isExpired(
  record: Pick<StoredWalletSession, "expiresAt" | "createdAt">,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return expiresAtOf(record) <= nowSeconds;
}
