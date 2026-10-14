/**
 * What moi_configure_account reads from the node before it decides anything: the account's keys (moi.AccountKeys), read strictly,
 * and the count of interactions that landed (moi.InteractionCount), which says whether one is still waiting. A shape the code does
 * not understand is refused as the node's error and never guessed at, and what a node says in an error is quoted and cut before it
 * is passed on. The decisions made from what is read are in configure-account.test.ts, and the tool end to end in
 * configure-account-write.test.ts.
 */

import { createParticipantId, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  assertNothingPending,
  MAX_KEYS_READ,
  MAX_NODE_TEXT,
  parseAccountKeys,
  readAccountKeys,
} from "../../src/capabilities/accounts/configure.js";
import { isMoiError } from "../../src/moi-error.js";
import type { SenderInfo } from "../../src/moi/ix-builder.js";
import { listedKey } from "../helpers/account-keys.js";
import { ACCOUNT } from "../helpers/mock-node.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

const NOT_SENT = "Nothing was sent to your wallet.";

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

/** The same, for a function that returns a promise. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (err) {
    if (!isMoiError(err)) throw err;
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("parseAccountKeys", () => {
  it("reads numbers, as the mock node sends them, and hex quantities, as the protocol docs show them, and sorts by key id", () => {
    const numbers = [
      { id: 1, publicKey: listedKey("BB"), weight: 500, signature_algorithm: 0, revoked: true, sequence_id: 0 },
      { id: 0, publicKey: listedKey("aa"), weight: 1000, signature_algorithm: 0, revoked: false, sequence_id: 7 },
    ];
    const hexes = [
      { id: "0x1", publicKey: listedKey("bb"), weight: "0x1f4", signature_algorithm: "0x0", revoked: true, sequence_id: "0x0" },
      { id: "0x0", publicKey: listedKey("aa"), weight: "0x3e8", signature_algorithm: "0x0", revoked: false, sequence_id: "0x7a" },
    ];
    const expected = [
      { id: 0, publicKey: listedKey("aa"), weight: 1000, revoked: false },
      { id: 1, publicKey: listedKey("bb"), weight: 500, revoked: true },
    ];
    expect(parseAccountKeys(numbers, ACCOUNT)).toEqual(expected);
    expect(parseAccountKeys(hexes, ACCOUNT)).toEqual(expected);
  });

  it("reads a decimal string, a bigint and an empty list", () => {
    expect(parseAccountKeys([{ id: "2", publicKey: "0x04aa", weight: 7n, revoked: false }], ACCOUNT)).toEqual([
      { id: 2, publicKey: "0x04aa", weight: 7, revoked: false },
    ]);
    expect(parseAccountKeys([], ACCOUNT)).toEqual([]);
  });

  const GOOD = { id: 0, publicKey: listedKey("aa"), weight: 1000, revoked: false };
  const BAD: Array<[string, unknown, string]> = [
    ["an answer that is not a list", { id: 0 }, "it is not a list"],
    ["null", null, "it is not a list"],
    ["an entry that is not an object", [null], "entry 0 has no readable key id"],
    ["an entry with no id", [{ ...GOOD, id: undefined }], "entry 0 has no readable key id"],
    ["a fractional id", [{ ...GOOD, id: 1.5 }], "entry 0 has no readable key id"],
    ["a weight that is not a number", [{ ...GOOD, weight: "heavy" }], "key 0 has no readable weight"],
    ["a negative weight", [{ ...GOOD, weight: -1 }], "key 0 has no readable weight"],
    ["a weight past 2^53", [{ ...GOOD, weight: "0xffffffffffffffff" }], "key 0 has no readable weight"],
    ["no weight", [{ ...GOOD, weight: undefined }], "key 0 has no readable weight"],
    ["a public key that is not hex", [{ ...GOOD, publicKey: "0xzz" }], "key 0 has no readable public key"],
    ["a public key of odd length", [{ ...GOOD, publicKey: "0xabc" }], "key 0 has no readable public key"],
    ["an empty public key", [{ ...GOOD, publicKey: "0x" }], "key 0 has no readable public key"],
    ["a public key longer than 65 bytes", [{ ...GOOD, publicKey: `0x${"aa".repeat(66)}` }], "key 0 has no readable public key"],
    ["a public key that is not a string", [{ ...GOOD, publicKey: 5 }], "key 0 has no readable public key"],
    ["no revoked flag", [{ ...GOOD, revoked: undefined }], "key 0 does not say whether it is revoked"],
    ["a revoked flag that is a string", [{ ...GOOD, revoked: "false" }], "key 0 does not say whether it is revoked"],
    ["one id twice", [GOOD, { ...GOOD, publicKey: listedKey("bb") }], "key 0 is listed twice"],
  ];
  it.each(BAD)("refuses %s, as an error of the node and not a guess", (_why, raw, why) => {
    const refused = refusal(() => parseAccountKeys(raw, ACCOUNT));
    expect(refused.code).toBe("RPC_ERROR");
    expect(refused.message).toBe(
      `moi.AccountKeys(${ACCOUNT}): the node's answer is not one this server can read (${why}), and without it nothing can be said about what this would change. ${NOT_SENT}`,
    );
  });

  it(`refuses a list of more than ${MAX_KEYS_READ} keys and reads one of exactly ${MAX_KEYS_READ}`, () => {
    const many = (n: number) => Array.from({ length: n }, (_v, id) => ({ ...GOOD, id }));
    expect(parseAccountKeys(many(MAX_KEYS_READ), ACCOUNT)).toHaveLength(MAX_KEYS_READ);
    expect(refusal(() => parseAccountKeys(many(MAX_KEYS_READ + 1), ACCOUNT)).message).toContain(`it lists ${MAX_KEYS_READ + 1} keys, more than the ${MAX_KEYS_READ} this server reads`);
  });
});

describe("readAccountKeys", () => {
  it("asks the provider for the account's keys and reads the answer", async () => {
    const asked: string[] = [];
    const keys = await readAccountKeys(
      { getAccountKeys: async (id) => (asked.push(id), [{ id: 0, publicKey: listedKey("aa"), weight: 1000, revoked: false }]) },
      ACCOUNT,
    );
    expect(asked).toEqual([ACCOUNT]);
    expect(keys).toEqual([{ id: 0, publicKey: listedKey("aa"), weight: 1000, revoked: false }]);
  });

  it("turns a node that fails into an RPC_ERROR that says which method failed and quotes what the node said", async () => {
    const failing = readAccountKeys({ getAccountKeys: async () => Promise.reject(new Error("account not found")) }, ACCOUNT);
    await expect(failing).rejects.toMatchObject({ code: "RPC_ERROR", message: `moi.AccountKeys(${ACCOUNT}) failed: "account not found". ${NOT_SENT}` });
  });

  it("does not pass on more of a node's error than it has to: control characters become spaces and the text is cut", async () => {
    const said = `line one\nline two\u0007 ${"x".repeat(500)}`;
    const refused = await refusalOf(() => readAccountKeys({ getAccountKeys: async () => Promise.reject(new Error(said)) }, ACCOUNT));
    expect(refused.code).toBe("RPC_ERROR");
    expect(refused.message).toMatch(/^moi\.AccountKeys\(0x[0-9a-f]+\) failed: "line one line two x+…"\. Nothing was sent to your wallet\.$/);
    expect(refused.message.match(/"([^"]*)"/)![1]).toHaveLength(MAX_NODE_TEXT);
  });
});

describe("assertNothingPending: an interaction of this account that has not landed", () => {
  const asking = (answer: unknown, asked: Array<[string, number]> = []) => ({
    getInteractionCount: async (id: string, keyId: number) => {
      asked.push([id, keyId]);
      return answer;
    },
  });

  it("asks for the sender key's count of interactions that landed, and lets a sequence that equals it through", async () => {
    const asked: Array<[string, number]> = [];
    await expect(assertNothingPending(asking(3n, asked), SENDER)).resolves.toBeUndefined();
    expect(asked).toEqual([[SENDER.id, 0]]);
    await expect(assertNothingPending(asking("0x3"), SENDER)).resolves.toBeUndefined();
    await expect(assertNothingPending(asking(9), SENDER)).resolves.toBeUndefined();
  });

  it("refuses when the sequence is ahead of what landed, because one is waiting, and says how to go on", async () => {
    expect(await refusalOf(() => assertNothingPending(asking(2n), SENDER))).toEqual({
      code: "INVALID_ARGS",
      message:
        "An interaction from this account is still waiting to be confirmed: key 0 has 2 confirmed and 3 counting the ones waiting. " +
        `The keys read here do not include it yet, so wait until it has landed and ask again. ${NOT_SENT}`,
    });
  });

  it("refuses a count it cannot read, and a node that fails, as errors of the node", async () => {
    const unreadable = await refusalOf(() => assertNothingPending(asking("many"), SENDER));
    expect(unreadable.code).toBe("RPC_ERROR");
    expect(unreadable.message).toBe(
      `moi.InteractionCount(${SENDER.id}, key 0): the node's answer is not one this server can read (it is not a count), and without it nothing can be said about what this would change. ${NOT_SENT}`,
    );
    const failing = await refusalOf(() =>
      assertNothingPending({ getInteractionCount: async () => Promise.reject(new Error("no such account")) }, SENDER),
    );
    expect(failing).toEqual({ code: "RPC_ERROR", message: `moi.InteractionCount(${SENDER.id}, key 0) failed: "no such account". ${NOT_SENT}` });
  });
});
