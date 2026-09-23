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
