/**
 * Secrets, signing, sealing, and token generation. node:crypto only.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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

/**
 * One subkey per purpose, derived from the one operator secret
 * (MOI_SESSION_KEY), so another store can take the same secret later under
 * its own label and never share a key with this one. HKDF is not a password
 * hash: it adds no work for a guesser, so the secret must be random
 * (`openssl rand -base64 32`), not a passphrase.
 *
 * Not derived from auth/cookie-secret on purpose. That file sits in the data
 * directory beside the ciphertext, so it would add no protection there, and
 * rotating it (which logs every browser out) would also lock every sealed
 * record.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), "moi-mcp-hosted", `moi-mcp:${purpose}:v1`, 32));
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Encrypt and authenticate `plaintext` with AES-256-GCM under a fresh random
 * nonce. `aad` is authenticated but not stored: opening the result with a
 * different `aad` fails, which binds a record to the slot it was written for.
 * The envelope's `v` is the storage-envelope version (2 = sealed; a plain
 * record from before sealing was never wrapped), unrelated to any version
 * field inside the plaintext.
 */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 2,
    alg: "A256GCM",
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

/**
 * The plaintext of a sealed value, or undefined for anything that does not
 * open: not JSON, not the envelope, the wrong key, the wrong `aad`, or any
 * altered byte. Never throws. An empty plaintext is valid, so callers compare
 * against `=== undefined` rather than testing truthiness.
 */
export function unseal(sealed: string, key: Buffer, aad: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(sealed);
    // JSON.parse("null") succeeds, and reading a field off it would throw.
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { v, alg, iv, ct, tag } = parsed as Record<string, unknown>;
    if (v !== 2 || alg !== "A256GCM") return undefined;
    if (typeof iv !== "string" || typeof ct !== "string" || typeof tag !== "string") return undefined;
    const ivBytes = Buffer.from(iv, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    if (ivBytes.length !== GCM_IV_BYTES || tagBytes.length !== GCM_TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, ivBytes, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Whether a parsed value has the shape `seal` writes, whether or not it opens
 * under any key. The boot migration uses it to tell a sealed value it cannot
 * open (kept) from a plain one (sealed). It judges the shape only.
 */
export function isSealedEnvelope(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const { v, alg, iv, ct, tag } = parsed as Record<string, unknown>;
  return v === 2 && alg === "A256GCM" && typeof iv === "string" && typeof ct === "string" && typeof tag === "string";
}
