/**
 * What moi_configure_account decides and builds before the phone is asked anything: the input schema, the interaction (against the
 * SDK's own AccountConfigure builder), which keys are the same key, every refusal that comes from the request and the account's
 * keys, and the words the person reads. What is read from the node is in configure-account-reads.test.ts, and the tool end to end,
 * with the node and the phone faked, in configure-account-write.test.ts.
 *
 * The SDK is the reference for the interaction: AccountConfigure builds one ACCOUNT_CONFIGURE operation with both lists present and
 * no participants of its own (js-moi-interactions, account.ts), and buildConfigureAccount must write what it writes. It is run here
 * with an empty object for a signer, which is enough for ixData when the sender is given.
 */

import { AccountConfigure, createParticipantId, OpType, ParticipantTagV0, toInteractionArgs } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  buildConfigureAccount,
  checkKeyChange,
  describeConfigure,
  keyIdentity,
  MAX_LISTED_KEYS,
  MIN_SIGNING_WEIGHT,
  NEW_KEY_WEIGHT,
  SIGNING_KEY_ID,
  type AccountKey,
  type KeyChange,
} from "../../src/capabilities/accounts/configure.js";
import { isMoiError } from "../../src/moi-error.js";
import { SINGLE_KEY_WEIGHT, toPoloHex, type SenderInfo } from "../../src/moi/ix-builder.js";
import { ConfigureAccountInput, MAX_KEY_CHANGES } from "../../src/schema.js";
import { compressedKey, listedKey } from "../helpers/account-keys.js";
import { ACCOUNT } from "../helpers/mock-node.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };
const SDK_SENDER = { id: SENDER.id as `0x${string}`, sequence: 3, key_id: 0 };
const FEES = { fuelLimit: 449, fuelPrice: 50 };

const NOT_SENT = "Nothing was sent to your wallet.";

/** A key as the node lists it: `byte` makes the key, so keyOf(1, "aa") and keyOf(2, "aa") are the same key under two ids. */
const keyOf = (id: number, byte: string, weight = 1000, revoked = false): AccountKey => ({ id, publicKey: listedKey(byte), weight, revoked });
/** A key as a caller gives it to add: 33 bytes. */
const addOf = (byte: string, prefix: "02" | "03" = "02"): string => compressedKey(byte, prefix);

/** The refusal a function throws, as the MoiError it is. */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (err) {
    if (!isMoiError(err)) throw err;
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("the numbers this tool rests on", () => {
  it("takes the weight of a new key and the signing floor from the protocol docs, and the operation type from the SDK", () => {
    expect(NEW_KEY_WEIGHT).toBe(1000);
    expect(NEW_KEY_WEIGHT).toBe(SINGLE_KEY_WEIGHT);
    expect(MIN_SIGNING_WEIGHT).toBe(1000);
    expect(SIGNING_KEY_ID).toBe(0);
    expect(MAX_KEY_CHANGES).toBe(5);
    expect(OpType.ACCOUNT_CONFIGURE).toBe(2);
  });
});

describe("the input schema", () => {
  const parse = (input: unknown) => ConfigureAccountInput.safeParse(input);

  it("takes a list of compressed public keys, as given", () => {
    const parsed = parse({ add: [compressedKey("aa"), compressedKey("bb", "03")] });
    expect(parsed.success && parsed.data.add).toEqual([compressedKey("aa"), compressedKey("bb", "03")]);
  });

  it("accepts a list of key ids to revoke, a key id of 0, and an empty request (code answers that, with the account's keys)", () => {
    expect(parse({ revoke: [0, 2] }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  it.each([
    ["no 0x", compressedKey("aa").slice(2)],
    ["a 32-byte key, which is how the node lists a key and not how a key is given", listedKey("aa")],
    ["an uncompressed prefix", `0x04${"aa".repeat(32)}`],
    ["34 bytes", `${compressedKey("aa")}aa`],
    ["32 bytes and a prefix that is not a key's", `0x05${"aa".repeat(32)}`],
    ["text that is not hex", `0x02${"zz".repeat(32)}`],
    ["nothing", ""],
  ])("refuses a public key that is %s", (_why, publicKey) => {
    expect(parse({ add: [publicKey] }).success).toBe(false);
  });

  it("refuses a key given as an object, which is where a weight used to go: there is no weight to give", () => {
    expect(parse({ add: [{ publicKey: compressedKey("aa"), weight: 500 }] }).success).toBe(false);
  });

  it("refuses more than 5 keys to add, more than 5 to revoke, and a key id that is not a whole number or is negative", () => {
    const six = Array.from({ length: 6 }, (_v, i) => compressedKey(i.toString(16).padStart(2, "0")));
    expect(parse({ add: six.slice(0, 5) }).success).toBe(true);
    expect(parse({ add: six }).success).toBe(false);
    expect(parse({ revoke: [1, 2, 3, 4, 5] }).success).toBe(true);
    expect(parse({ revoke: [1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(parse({ revoke: [-1] }).success).toBe(false);
    expect(parse({ revoke: [1.5] }).success).toBe(false);
  });

  it("has no field for the account, a weight or the signature algorithm: one passed anyway is dropped", () => {
    const parsed = parse({ account: "0x00", weight: 500, signatureAlgorithm: 1, add: [compressedKey("aa")] });
    expect(parsed.success && parsed.data).toEqual({ add: [compressedKey("aa")] });
  });
});

describe("buildConfigureAccount, against the SDK's AccountConfigure", () => {
  /** What the SDK builds for the same change: its ixData, with the sender fixed and no signer. */
  async function sdkIx(build: (configure: AccountConfigure) => AccountConfigure) {
    return build(new AccountConfigure({} as never)).build().ixData({ sender: SDK_SENDER, fuel_limit: 449, fuel_price: 50 });
  }

  const CASES: Array<{ name: string; change: KeyChange; sdk: (c: AccountConfigure) => AccountConfigure }> = [
    {
      name: "one key",
      change: { add: [compressedKey("aa")], revoke: [] },
      sdk: (c) => c.addKey(compressedKey("aa") as never, 1000),
    },
    {
      name: "two keys",
      change: { add: [compressedKey("aa", "03"), compressedKey("bb")], revoke: [] },
      sdk: (c) => c.addKey(compressedKey("aa", "03") as never, 1000).addKey(compressedKey("bb") as never, 1000),
    },
    { name: "one key id", change: { add: [], revoke: [2] }, sdk: (c) => c.revokeKey(2) },
    { name: "two key ids", change: { add: [], revoke: [0, 3] }, sdk: (c) => c.revokeKey(0).revokeKey(3) },
  ];

  for (const row of CASES) {
    it(`writes the same interaction as the SDK for ${row.name}`, async () => {
      const sdk = await sdkIx(row.sdk);
      const ours = buildConfigureAccount(SENDER, row.change, FEES);
      // One ACCOUNT_CONFIGURE operation, key for key: both lists present, weight 1000 and algorithm 0 on every added key, and no participants.
      expect(ours.ix_operations).toEqual(sdk.ix_operations);
      expect(ours.ix_operations[0]!.type).toBe(OpType.ACCOUNT_CONFIGURE);
      expect(ours.participants).toEqual(sdk.participants);
      expect(ours.participants).toEqual([]);
      expect(ours.sender).toEqual(sdk.sender);
      // What the node is sent is identical, and so are the bytes the wallet signs.
      expect(toInteractionArgs(ours as never)).toEqual(toInteractionArgs(sdk as never));
      expect(toPoloHex(ours)).toBe(toPoloHex(sdk as never));
    });
  }

  it("takes the fuel and the sender key from the caller, and falls back to key 0", () => {
    const ix = buildConfigureAccount({ id: SENDER.id, sequence: 9 }, { add: [], revoke: [1] }, { fuelLimit: 777, fuelPrice: 12 });
    expect(ix.sender).toEqual({ id: SENDER.id, sequence: 9, key_id: 0 });
    expect([ix.fuel_limit, ix.fuel_price]).toEqual([777, 12]);
  });
});

describe("keyIdentity: two keys are the same key when their x coordinates are", () => {
  it("is the 32-byte x coordinate, so a 33-byte key and the node's listing of it are one key, and 02 and 03 over one x are one key", () => {
    expect(keyIdentity(compressedKey("aa"))).toBe("aa".repeat(32));
    expect(keyIdentity(compressedKey("aa", "03"))).toBe("aa".repeat(32));
    expect(keyIdentity(listedKey("aa"))).toBe("aa".repeat(32));
    expect(keyIdentity(listedKey("aa"))).toBe(keyIdentity(compressedKey("aa", "03")));
  });

  it("does not care about case or the 0x, and is another key when the x is another", () => {
    expect(keyIdentity(`0x02${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(keyIdentity("AB".repeat(32))).toBe("ab".repeat(32));
    expect(keyIdentity(compressedKey("aa"))).not.toBe(keyIdentity(compressedKey("ab")));
  });

  it("compares a key of any other length whole", () => {
    expect(keyIdentity("0x04aa")).toBe("04aa");
    expect(keyIdentity("0x04aa")).not.toBe(keyIdentity("0xaa"));
  });
});

describe("checkKeyChange", () => {
  const TWO = [keyOf(0, "aa"), keyOf(1, "bb")];
  const listingTwo = `This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 1000).`;
  const FLOOR = `The signatures of an interaction have to weigh at least 1000 together (the protocol docs' floor, which is also their default account threshold)`;

  it("says what the keys not revoked weigh before and after: an add raises it by 1000 a key, a revoke lowers it", () => {
    expect(checkKeyChange(TWO, { add: [addOf("cc")], revoke: [] })).toEqual({ before: 2000, after: 3000 });
    expect(checkKeyChange(TWO, { add: [addOf("cc"), addOf("dd")], revoke: [] })).toEqual({ before: 2000, after: 4000 });
    expect(checkKeyChange(TWO, { add: [], revoke: [1] })).toEqual({ before: 2000, after: 1000 });
    // A key that is revoked weighs nothing now, and adds nothing back.
    expect(checkKeyChange([keyOf(0, "aa"), keyOf(1, "bb", 700, true)], { add: [addOf("cc")], revoke: [] })).toEqual({ before: 1000, after: 2000 });
  });

  it("refuses an empty request, and shows the account's keys in full so a key id can be picked", () => {
    expect(refusal(() => checkKeyChange(TWO, { add: [], revoke: [] }))).toEqual({
      code: "INVALID_ARGS",
      message: `Name at least one key to add or one key id to revoke. ${listingTwo} ${NOT_SENT}`,
    });
    expect(refusal(() => checkKeyChange([], { add: [], revoke: [] })).message).toBe(
      `Name at least one key to add or one key id to revoke. This account has no keys on record. ${NOT_SENT}`,
    );
    // Even for an account this server cannot sign for: the listing is what the model asked for.
    expect(refusal(() => checkKeyChange([keyOf(0, "aa", 1000, true)], { add: [], revoke: [] })).message).toBe(
      `Name at least one key to add or one key id to revoke. This account's keys: key 0 (${listedKey("aa")}, weight 1000, revoked). ${NOT_SENT}`,
    );
  });

  it("refuses when this server cannot sign for the account alone: key 0 missing, revoked, or under 1000", () => {
    const why = (problem: string, listing: string) =>
      `This server signs every interaction as key 0, and ${problem}. ${FLOOR}, so nothing this server sends for this account can be valid. ${listing} ${NOT_SENT}`;
    const add: KeyChange = { add: [addOf("cc")], revoke: [] };
    expect(refusal(() => checkKeyChange([keyOf(1, "bb")], add))).toEqual({
      code: "INVALID_ARGS",
      message: why("this account has no key 0", `This account's keys: key 1 (${listedKey("bb")}, weight 1000).`),
    });
    expect(refusal(() => checkKeyChange([], add)).message).toBe(why("this account has no key 0", "This account has no keys on record."));
    expect(refusal(() => checkKeyChange([keyOf(0, "aa", 1000, true), keyOf(1, "bb")], add)).message).toBe(
      why("key 0 is revoked", `This account's keys: key 0 (${listedKey("aa")}, weight 1000, revoked); key 1 (${listedKey("bb")}, weight 1000).`),
    );
    // A revoke of another key is refused the same way, before its own checks.
    expect(refusal(() => checkKeyChange([keyOf(0, "aa", 500), keyOf(1, "bb", 500)], { add: [], revoke: [1] })).message).toBe(
      why("key 0 weighs 500, under 1000", `This account's keys: key 0 (${listedKey("aa")}, weight 500); key 1 (${listedKey("bb")}, weight 500).`),
    );
    // Exactly 1000 is enough, and so is more.
    expect(checkKeyChange([keyOf(0, "aa", 1000)], add)).toEqual({ before: 1000, after: 2000 });
    expect(checkKeyChange([keyOf(0, "aa", 2000)], add)).toEqual({ before: 2000, after: 3000 });
  });

  it("refuses an add and a revoke in one call, with the two-call way to do it", () => {
    expect(refusal(() => checkKeyChange(TWO, { add: [addOf("cc")], revoke: [1] }))).toEqual({
      code: "INVALID_ARGS",
      message:
        "One call can add keys or revoke keys, not both: the protocol docs say an AccountConfigure operation does either an add or a revoke, never both. " +
        `Add the new key first, check that it works, and then call again to revoke the old one. ${NOT_SENT}`,
    });
  });

  it("refuses the same key twice in add, even as 02 and 03 over one x, and the same id twice in revoke", () => {
    expect(refusal(() => checkKeyChange(TWO, { add: [addOf("cc"), addOf("cc", "03")], revoke: [] })).message).toBe(
      `add lists the same key twice (${compressedKey("cc")} and ${compressedKey("cc", "03")}); a key is added once. ${NOT_SENT}`,
    );
    expect(refusal(() => checkKeyChange(TWO, { add: [], revoke: [1, 1] })).message).toBe(`revoke lists key 1 twice; a key is revoked once. ${NOT_SENT}`);
  });

  it("refuses a key id the account does not have, and one it has already revoked, and lists the keys", () => {
    expect(refusal(() => checkKeyChange(TWO, { add: [], revoke: [7] })).message).toBe(`This account has no key 7. ${listingTwo} ${NOT_SENT}`);
    const withRevoked = [keyOf(0, "aa"), keyOf(1, "bb", 500, true)];
    expect(refusal(() => checkKeyChange(withRevoked, { add: [], revoke: [1] })).message).toBe(
      `Key 1 is already revoked. This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 500, revoked). ${NOT_SENT}`,
    );
  });

  it("refuses a key the account already has, whichever way it is written", () => {
    const same = `That key is already on this account as key 1 (${listedKey("bb")}), and it is not revoked. ${listingTwo} ${NOT_SENT}`;
    expect(refusal(() => checkKeyChange(TWO, { add: [addOf("bb")], revoke: [] })).message).toBe(same);
    expect(refusal(() => checkKeyChange(TWO, { add: [addOf("bb", "03")], revoke: [] })).message).toBe(same);
    expect(refusal(() => checkKeyChange(TWO, { add: [listedKey("bb")], revoke: [] })).message).toBe(same);
  });

  it("refuses a key that is on the account only as a revoked one: a revoked key is not added again", () => {
    const keys = [keyOf(0, "aa"), keyOf(1, "bb", 1000, true)];
    const message =
      `That key is already on this account as key 1 (${listedKey("bb")}), and it is revoked. The protocol docs describe a revoke as for compromised and obsolete keys, ` +
      `so a revoked key is not added again: use a new key. This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 1000, revoked). ${NOT_SENT}`;
    expect(refusal(() => checkKeyChange(keys, { add: [addOf("bb")], revoke: [] }))).toEqual({ code: "INVALID_ARGS", message });
    expect(refusal(() => checkKeyChange(keys, { add: [addOf("bb", "03")], revoke: [] })).message).toBe(message);
  });

  it("refuses a revoke of every key that is not revoked, with a revoked key among them or not", () => {
    const message = `That would revoke every key this account has that is not already revoked (0 and 1), and then nothing could sign for the account again. ${NOT_SENT}`;
    expect(refusal(() => checkKeyChange(TWO, { add: [], revoke: [0, 1] })).message).toBe(message);
    expect(refusal(() => checkKeyChange([...TWO, keyOf(2, "cc", 1000, true)], { add: [], revoke: [1, 0] })).message).toBe(message);
    expect(refusal(() => checkKeyChange([keyOf(0, "aa")], { add: [], revoke: [0] })).message).toContain("(0), and then nothing could sign");
    // One key left is enough, and the rest is the weight rule's.
    expect(checkKeyChange([...TWO, keyOf(2, "cc")], { add: [], revoke: [0, 1] })).toEqual({ before: 3000, after: 1000 });
  });

  it("refuses a revoke that leaves the keys that remain under 1000, and allows one that leaves exactly 1000", () => {
    const lighter = [keyOf(0, "aa"), keyOf(1, "bb", 400), keyOf(2, "cc", 400)];
    expect(refusal(() => checkKeyChange(lighter, { add: [], revoke: [0] })).code).toBe("INVALID_ARGS");
    const exact = [keyOf(0, "aa"), keyOf(1, "bb", 500), keyOf(2, "cc", 500)];
    expect(checkKeyChange(exact, { add: [], revoke: [0] })).toEqual({ before: 2000, after: 1000 });
  });

  it("says what the weights are when the keys that remain would be under 1000", () => {
    const keys = [keyOf(0, "aa"), keyOf(1, "bb", 500)];
    expect(refusal(() => checkKeyChange(keys, { add: [], revoke: [0] })).message).toBe(
      "After this change the keys of this account that are not revoked would weigh 500 in total. " +
        `${FLOOR}, so nothing could sign for the account again. ` +
        `This account's keys: key 0 (${listedKey("aa")}, weight 1000); key 1 (${listedKey("bb")}, weight 500). ${NOT_SENT}`,
    );
  });

  it("lists at most 10 keys and says how many more there are", () => {
    const many = Array.from({ length: MAX_LISTED_KEYS + 3 }, (_v, id) => keyOf(id, id.toString(16).padStart(2, "0")));
    const message = refusal(() => checkKeyChange(many, { add: [], revoke: [99] })).message;
    expect(message).toContain("key 9 (");
    expect(message).not.toContain("key 10 (");
    expect(message).toContain("; and 3 more. ");
  });
});

describe("describeConfigure: the words the person reads", () => {
  const TWO = [keyOf(0, "aa"), keyOf(1, "bb")];
  const describeFor = (change: Partial<KeyChange>, keys: AccountKey[] = TWO) => {
    const full: KeyChange = { add: [], revoke: [], ...change };
    return describeConfigure({ account: ACCOUNT, keys, change: full, ...checkKeyChange(keys, full) });
  };
  const WEIGHT_LINE = (before: number, after: number) =>
    `${before} now, ${after} after this change. An interaction is valid only when the weight of its signatures reaches the account's threshold, which the protocol docs give as 1000 ` +
    "by default and as the least any interaction needs; this server cannot read this account's own threshold.";
  const CURRENT = {
    "Current key 0": `${listedKey("aa")} (weight 1000, not revoked)`,
    "Current key 1": `${listedKey("bb")} (weight 1000, not revoked)`,
  };

  it("says of one key what the brief asks: it can sign for the account", () => {
    const { description, details } = describeFor({ add: [addOf("cc")] });
    expect(description).toBe("Add a key to your account. Anyone who holds this key can sign for this account.");
    expect(details).toEqual({
      Operation: "Add a key to your account (ACCOUNT_CONFIGURE)",
      Account: ACCOUNT,
      "New key 1": `${compressedKey("cc")} (weight 1000, signature algorithm 0)`,
      "Combined weight of keys not revoked": WEIGHT_LINE(2000, 3000),
      ...CURRENT,
    });
    expect(Object.keys(details)).toEqual(["Operation", "Account", "New key 1", "Combined weight of keys not revoked", "Current key 0", "Current key 1"]);
  });

  it("shows every public key in full, never shortened", () => {
    const text = JSON.stringify(describeFor({ add: [addOf("cc")] }).details);
    for (const key of [compressedKey("cc"), listedKey("aa"), listedKey("bb")]) expect(text).toContain(key);
    expect(text).not.toMatch(/…|\.\.\./);
  });

  it("says of several keys that any one of them can sign, and that every one is added at weight 1000", () => {
    const { description, details } = describeFor({ add: [addOf("cc"), addOf("dd")] });
    expect(description).toBe("Add 2 keys to your account. Anyone who holds any one of these keys can sign for this account.");
    expect(details["Operation"]).toBe("Add 2 keys to your account (ACCOUNT_CONFIGURE)");
    expect(details["New key 1"]).toBe(`${compressedKey("cc")} (weight 1000, signature algorithm 0)`);
    expect(details["New key 2"]).toBe(`${compressedKey("dd")} (weight 1000, signature algorithm 0)`);
    expect(details["Combined weight of keys not revoked"]).toBe(WEIGHT_LINE(2000, 4000));
  });

  it("says of a revoked key what the brief asks: it can no longer sign, and shows the key in full with its weight", () => {
    const { description, details } = describeFor({ revoke: [1] });
    expect(description).toBe("Revoke key 1. That key can no longer sign for this account.");
    expect(details).toEqual({
      Operation: "Revoke a key on your account (ACCOUNT_CONFIGURE)",
      Account: ACCOUNT,
      "Revoke key 1": `${listedKey("bb")} (weight 1000)`,
      "Combined weight of keys not revoked": WEIGHT_LINE(2000, 1000),
      ...CURRENT,
    });
  });

  it("names several revoked keys, with 'and'", () => {
    const keys = [keyOf(0, "aa"), keyOf(1, "bb"), keyOf(2, "cc"), keyOf(3, "dd")];
    expect(describeFor({ revoke: [1, 2] }, keys).description).toBe("Revoke keys 1 and 2. Those keys can no longer sign for this account.");
    expect(describeFor({ revoke: [1, 2, 3] }, keys).description).toBe("Revoke keys 1, 2 and 3. Those keys can no longer sign for this account.");
    expect(describeFor({ revoke: [1, 2] }, keys).details["Operation"]).toBe("Revoke 2 keys on your account (ACCOUNT_CONFIGURE)");
  });

  it("says in the summary that key 0 is the key the person's wallet signs with, so revoking it ends what this server can do", () => {
    const { description, details } = describeFor({ revoke: [0] });
    expect(description).toBe(
      "Revoke key 0. That key can no longer sign for this account. " +
        "Key 0 is the key your MOI Wallet signs with here, so after this it can no longer sign for this account, and this server can send nothing more for it.",
    );
    expect(details).not.toHaveProperty("Warning");
    expect(describeFor({ revoke: [1] }).description).not.toContain("MOI Wallet");
    expect(describeFor({ add: [addOf("cc")] }).description).not.toContain("MOI Wallet");
  });

  it("lists the account's keys as they are now, 10 at most, and says how many are left out", () => {
    const many = Array.from({ length: MAX_LISTED_KEYS + 2 }, (_v, id) => keyOf(id, id.toString(16).padStart(2, "0")));
    const { details } = describeFor({ add: [addOf("ff")] }, many);
    expect(Object.keys(details).filter((label) => label.startsWith("Current key"))).toHaveLength(MAX_LISTED_KEYS);
    expect(details["More keys"]).toBe("2 more keys are not listed here.");
    // The keys a request names are shown whatever the cut: a revoke of key 11 still shows key 11.
    expect(describeFor({ revoke: [11] }, many).details["Revoke key 11"]).toBe(`${listedKey("0b")} (weight 1000)`);
  });

  it("says a key id it cannot find is not listed (checkKeyChange has refused that before this is reached)", () => {
    const { details } = describeConfigure({ account: ACCOUNT, keys: TWO, change: { add: [], revoke: [9] }, before: 2000, after: 2000 });
    expect(details["Revoke key 9"]).toBe("(not listed)");
  });
});
