/**
 * moi_create_account registers an account that does not exist yet. The one
 * check that must never be wrong is that the public key really produces the
 * address the caller named: funding an address whose key nobody holds burns
 * the KMOI for good.
 */
import { describe, expect, it } from "vitest";

import { accountIdForPublicKey } from "../../src/tools/write-core.js";

// A throwaway devnet key pair: the address is what js-moi-wallet derives for it.
const PUB = "0x03a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f679e9b37c57edb9f";
const ADDRESS = "0x00000000a27d9a3e793f6b548f7553dd4a0ea52846f59bc94d9a0d1f00000000";

describe("accountIdForPublicKey", () => {
  it("derives the same identifier the wallet does for a compressed key", async () => {
    expect((await accountIdForPublicKey(PUB)).toLowerCase()).toBe(ADDRESS);
  });

  it("refuses anything that is not a 33-byte compressed key", async () => {
    await expect(accountIdForPublicKey("0x" + PUB.slice(4))).rejects.toThrow(/33 bytes/);
    await expect(accountIdForPublicKey("0x03abcd")).rejects.toThrow(/33 bytes/);
  });
});

import { documentEncode } from "js-polo";
import { bytesToHex } from "js-moi-sdk";
import { decodeRegistrationHash } from "../../src/tools/write-core.js";

/** A registration hash the way MOI Wallet emits one: a POLO-encoded participant-create operation. */
function fakeRegistrationHash(address: string, publicKey: string): string {
  const schema = {
    kind: "struct",
    fields: {
      opType: { kind: "integer" },
      payload: {
        kind: "struct",
        fields: {
          id: { kind: "string" },
          keys_payload: {
            kind: "array",
            fields: { values: { kind: "struct", fields: { public_key: { kind: "string" }, weight: { kind: "integer" }, signature_algorithm: { kind: "integer" } } } },
          },
          value: { kind: "struct", fields: { asset_id: { kind: "string" }, callsite: { kind: "string" }, calldata: { kind: "string" } } },
        },
      },
    },
  };
  const doc = documentEncode(
    { opType: 1, payload: { id: address, keys_payload: [{ public_key: publicKey, weight: 1000, signature_algorithm: 0 }], value: { asset_id: "0x1080", callsite: "Transfer", calldata: "0x" } } },
    schema as never,
  );
  return "0x" + bytesToHex(doc.bytes());
}

describe("decodeRegistrationHash", () => {
  it("recovers the address and public key from a wallet registration hash", async () => {
    const hash = fakeRegistrationHash(ADDRESS, PUB);
    const out = await decodeRegistrationHash(hash);
    expect(out.address.toLowerCase()).toBe(ADDRESS);
    expect(out.publicKey.toLowerCase()).toBe(PUB.toLowerCase());
    // and the pair really belongs together
    expect((await accountIdForPublicKey(out.publicKey)).toLowerCase()).toBe(out.address.toLowerCase());
  });

  it("rejects something that is not a registration hash", async () => {
    await expect(decodeRegistrationHash("0xdeadbeef")).rejects.toThrow(/registration hash/);
  });
});
