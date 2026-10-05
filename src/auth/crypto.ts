/**
 * Secrets, signing, and token generation. node:crypto only.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const COOKIE_SECRET_BYTES = 32;

/** Read the persisted cookie-signing secret, generating and 0600-persisting one on first use. */
export function loadOrCreateCookieSecret(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const secret = randomBytes(COOKIE_SECRET_BYTES);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

/** `<uid>.<hmac>` — the value stored in the moi_uid cookie. */
export function signUid(uid: string, secret: Buffer): string {
  return `${uid}.${createHmac("sha256", secret).update(uid).digest("base64url")}`;
}

/**
 * Verify a signed cookie value and return the uid, or undefined for anything
 * missing, malformed, or with a bad signature — including a forged one.
 */
export function verifySignedUid(cookieValue: string | undefined, secret: Buffer): string | undefined {
  if (!cookieValue) return undefined;
  const sep = cookieValue.lastIndexOf(".");
  if (sep <= 0) return undefined;
  const uid = cookieValue.slice(0, sep);
  const mac = cookieValue.slice(sep + 1);
  const expected = createHmac("sha256", secret).update(uid).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  return timingSafeEqual(a, b) ? uid : undefined;
}

/** A fresh 16-byte-hex user id, minted when no valid identity cookie is present. */
export function newUid(): string {
  return randomBytes(16).toString("hex");
}

/** A random base64url token (authorization codes, access/refresh tokens, client ids/secrets). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)), compared against code_challenge. */
export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/** Constant-time string equality, for comparing secrets/hashes of possibly differing length. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
