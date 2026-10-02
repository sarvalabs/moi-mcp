/**
 * Account keys for the moi_configure_account tests, and the node's answer to moi.AccountKeys for them.
 *
 * Two forms of a key, because the sources give both. MOI Wallet and the SDK give a compressed key, 33 bytes: 0x, 02 or 03, then the
 * 32-byte x coordinate (compressedKey). The node lists a key as the 32-byte x coordinate alone (listedKey, the form in the protocol
 * docs' moi.AccountKeys answer). The same byte gives the same x coordinate in both, so compressedKey("aa") and listedKey("aa") are
 * one key. These are not real keys: some of them happen to be points on the curve and some are not, the code under test does not
 * check, and nothing here signs.
 *
 * serveKeys makes the mock node answer moi.AccountKeys with the keys given, keeping the two checks the default handler makes (a valid
 * id and a non-empty options block), because the real node makes them. Like every `on()` override, node.reset() drops it. The mock's
 * default answer is one key that is 2 bytes long, which is enough for the tools that do not read keys.
 *
 * Imports mock-node.ts only; it does not import this file.
 */

import { RpcFailure, type MockNode } from "./mock-node.js";

/** 0x, 02 or 03, and `byte` written 32 times: 33 bytes. Different bytes are different keys. */
export const compressedKey = (byte: string, prefix: "02" | "03" = "02"): string => `0x${prefix}${byte.repeat(32)}`;

/** The same key as the node lists it: the 32-byte x coordinate. */
export const listedKey = (byte: string): string => `0x${byte.repeat(32)}`;

export interface ServedKey {
  id: number;
  /** As the node lists it: usually listedKey(...). */
  publicKey: string;
  weight: number;
  revoked?: boolean;
}

const ID_RE = /^0x[0-9a-fA-F]{64}$/;

const hex = (n: number): string => `0x${n.toString(16)}`;

/**
 * Answer moi.AccountKeys with `keys`. "number" sends ids and weights as JSON numbers, as the mock node's own default does; "hex"
 * sends them as hex strings, as the protocol docs' answer does ("0x0", "0x3e8").
 */
export function serveKeys(node: MockNode, keys: ServedKey[], encoding: "number" | "hex" = "number"): void {
  node.on("moi.AccountKeys", (p) => {
    if (typeof p["id"] !== "string" || !ID_RE.test(p["id"])) throw new RpcFailure(`invalid identifier: ${String(p["id"])}`);
    const options = p["options"];
    if (typeof options !== "object" || options === null || Object.keys(options).length === 0) throw new RpcFailure("empty options");
    return keys.map((key) => ({
      id: encoding === "hex" ? hex(key.id) : key.id,
      publicKey: key.publicKey,
      weight: encoding === "hex" ? hex(key.weight) : key.weight,
      signature_algorithm: encoding === "hex" ? "0x0" : 0,
      revoked: key.revoked ?? false,
      sequence_id: encoding === "hex" ? "0x0" : 0,
    }));
  });
}
