/**
 * Sealing what the hosted server stored before it was sealed: the wallet
 * pairing records and the WalletConnect client's own state.
 *
 * Unlike the dapp sessions, nothing is dropped. A dropped pairing makes a
 * person scan a QR code again, so a plain value is sealed from its own text
 * and put back where it was, once, at boot, before the server listens and
 * before the WalletConnect client starts. A sealed value that does not open
 * (a rotated or mistyped MOI_SESSION_KEY) is kept and counted, never deleted.
 * Running it twice changes nothing. Nothing here logs a value, an id or a key.
 */

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";

import { isSealedEnvelope, seal, unseal } from "../auth/crypto.js";
import { log } from "../config.js";

export interface SealCounts {
  /** Plain values sealed and put back in place. */
  sealed: number;
  /** Values already sealed that open with this key; left alone, byte for byte. */
  alreadySealed: number;
  /** Values that are neither: sealed under another key, altered, or not in a form this code knows. Kept, never deleted. */
  unreadable: number;
  /** Plain values whose sealed copy could not be put in place. The plain value is left exactly as it was. */
  failed: number;
}

export interface SealPlainStore {
  sealPlain(): Promise<SealCounts>;
}

/** One stored value as the migration sees it. */
export interface StoredValue {
  /** What it is, or will be, sealed under as additional data: its own slot or storage key. */
  aad: string;
  /** The stored text. */
  raw: string;
  /** Put `sealed` where `raw` was. The old value must stay until the new one is complete. */
  replace(sealed: string): void | Promise<void>;
}

/**
 * Write `text` to `file` through `<file>.tmp` in the same directory and rename
 * it over, so at every moment the path holds the old content or the new one,
 * never a half-written file. Mode 0600. Synchronous on purpose: no other write
 * to the same path can interleave between the write and the rename.
 *
 * `durable` flushes the temporary file to disk before the rename. The
 * migration asks for it, because it is the one write that destroys the only
 * other copy of a pairing; without it a power loss could leave an empty file
 * under the real name. Ordinary writes skip it: it costs a few milliseconds
 * each, and the files they replace were never flushed either.
 */
export function replaceFile(file: string, text: string, durable = false): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${text}\n`);
    if (durable) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** `raw` when it is JSON text, otherwise undefined. */
export function jsonText(raw: string): string | undefined {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * The text to seal for a plain WalletConnect value: JSON text as it is, and
 * anything else as a JSON string. The SDK's own file storage writes a string
 * value unquoted (the client id, `did:key:...`), so a bare string is a value,
 * not damage, and reading it back gives the same string the SDK read.
 */
export function walletConnectText(raw: string): string {
  return jsonText(raw) ?? JSON.stringify(raw);
}

/** JSON of the sealed shape, whether or not it opens. */
function looksSealed(raw: string): boolean {
  try {
    return isSealedEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * Classify every value and seal the plain ones. `plaintextOf` returns the text
 * to seal for a plain value, or undefined when `raw` is not a plain value this
 * store recognises (so it is counted unreadable and left alone).
 */
export async function sealValues(
  values: AsyncIterable<StoredValue>,
  key: Buffer,
  plaintextOf: (raw: string) => string | undefined,
): Promise<SealCounts> {
  const counts: SealCounts = { sealed: 0, alreadySealed: 0, unreadable: 0, failed: 0 };
  for await (const value of values) {
    if (unseal(value.raw, key, value.aad) !== undefined) {
      counts.alreadySealed++;
      continue;
    }
    // Sealed under another key, or altered: not ours to judge, never deleted.
    if (looksSealed(value.raw)) {
      counts.unreadable++;
      continue;
    }
    const plaintext = plaintextOf(value.raw);
    if (plaintext === undefined) {
      counts.unreadable++;
      continue;
    }
    try {
      const copy = seal(plaintext, key, value.aad);
      // Never put down a copy that does not open to the same text: it would replace the only readable one.
      if (unseal(copy, key, value.aad) !== plaintext) throw new Error("the sealed copy does not open");
      await value.replace(copy);
      counts.sealed++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}

export interface WalletSealReport {
  sessions: SealCounts;
  wcStorage: SealCounts;
}

/**
 * What the operator reads when the boot stops. Words only: the counts are in
 * the log line above it, and nothing in it is a value, an id, a path or a key.
 */
const WALLETCONNECT_STATE_STOP =
  "The stored WalletConnect state does not open with MOI_SESSION_KEY, or could not be sealed, so the server did not start. " +
  "Nothing was deleted. If the key was changed or mistyped, put the original value back in .env and start again. " +
  "If you changed it on purpose, move sessions/ and wc.db/ out of the data directory (in Redis, delete the moi:session:*, " +
  "moi:topic:* and moi:wc:* keys) and start again; everyone pairs again. If the state could not be sealed, free the disk " +
  "or fix its permissions and start again.";

/**
 * Seal the pairing records and the WalletConnect state in place, once, before
 * the server listens. One log line with the counts and nothing else: at info
 * when every value is sealed or was sealed now, at error when any value was
 * kept unreadable or could not be sealed.
 *
 * Then, one stop. If any WalletConnect value is unreadable or could not be
 * sealed, this throws, and main() has not started the WalletConnect client.
 * That is the point: started over a key chain it cannot read, the SDK takes
 * the chain for missing, mints a new relay identity and writes a new chain over
 * the old one, which un-pairs everyone and cannot be undone by putting the
 * right key back. A pairing record that does not open costs one person a
 * re-pair and is only counted.
 */
export async function sealWalletStateOnBoot(stores: {
  sessions: SealPlainStore;
  wcStorage: SealPlainStore;
}): Promise<WalletSealReport> {
  const sessions = await stores.sessions.sealPlain();
  const wcStorage = await stores.wcStorage.sealPlain();
  const part = (c: SealCounts) =>
    `sealed ${c.sealed}, already sealed ${c.alreadySealed}, unreadable ${c.unreadable}, failed ${c.failed}`;
  const attention = sessions.unreadable + sessions.failed + wcStorage.unreadable + wcStorage.failed > 0;
  log(attention ? "error" : "info", `wallet state: pairings ${part(sessions)}; walletconnect ${part(wcStorage)}`);
  if (wcStorage.unreadable + wcStorage.failed > 0) throw new Error(WALLETCONNECT_STATE_STOP);
  return { sessions, wcStorage };
}
