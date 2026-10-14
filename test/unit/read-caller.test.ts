/**
 * What a person is told when the node cannot find an account while running a read-only call, and which setting
 * the signer actually uses. Pure functions: the environment is passed in, nothing touches a node.
 */
import { describe, expect, it } from "vitest";

import { MoiError } from "../../src/moi-error.js";
import { readCallerFromEnv } from "../../src/moi/provider.js";
import {
  callerRejected,
  isCallerRejected,
  MAX_NODE_TEXT,
  ReadCallerRejected,
  rejectedCallerError,
} from "../../src/moi/read-caller.js";
import { ErrorCode } from "../../src/schema.js";

const NODE = "failed to fetch acc meta info: account not found";
const NESTED = `failed to fetch transition objects: state object fetch failed: ${NODE}`;
const VALID = "0x000000005dfd3e93ae09bea907f0d6db965ddfe84d09dfdf868e4e6800000000";

describe("isCallerRejected", () => {
  it("matches the node's full text, alone and nested in a longer one", () => {
    expect(isCallerRejected(new Error(NODE))).toBe(true);
    expect(isCallerRejected(new Error(NESTED))).toBe(true);
    expect(isCallerRejected(NODE)).toBe(true);
  });

  it("does not match anything else", () => {
    expect(isCallerRejected(new Error("state object fetch failed"))).toBe(false);
    // A bare "account not found" also comes from a missing argument or a missing logic, so it is not relabelled.
    expect(isCallerRejected(new Error("account not found"))).toBe(false);
    expect(isCallerRejected(undefined)).toBe(false);
    expect(isCallerRejected(42)).toBe(false);
  });
});

describe("rejectedCallerError", () => {
  it("returns undefined for a MoiError, even one that carries the node's text", () => {
    expect(rejectedCallerError(new MoiError(ErrorCode.RPC_ERROR, NODE), {})).toBeUndefined();
  });

  it("returns undefined for another failure", () => {
    expect(rejectedCallerError(new Error("node on fire"), {})).toBeUndefined();
    expect(rejectedCallerError(new Error("account not found"), {})).toBeUndefined();
  });

  it("returns an RPC_ERROR MoiError for the rejection", () => {
    const err = rejectedCallerError(new Error(NESTED), {});
    expect(err).toBeInstanceOf(MoiError);
    expect(err).toBeInstanceOf(ReadCallerRejected);
    expect(err?.code).toBe(ErrorCode.RPC_ERROR);
  });

  it("is not itself taken for a rejection again, although it quotes the node's text", () => {
    const once = rejectedCallerError(new Error(NODE), {});
    expect(isCallerRejected(once)).toBe(true);
    expect(rejectedCallerError(once, {})).toBeUndefined();
  });
});

describe("the message", () => {
  it("with the setting unset names the placeholder, says what to set and quotes the node, with no value", () => {
    const message = callerRejected(new Error(NESTED), {}).message;
    expect(message).toContain("The node could not find an account while running this read, so the read did not run.");
    expect(message).toContain("placeholder caller");
    expect(message).toContain("MOI_READ_CALLER must be set");
    expect(message).toContain("a participant that exists on this network");
    expect(message).toContain("an account named in the call's arguments");
    expect(message).toContain(`The node said: "${NESTED}".`);
    expect(message).not.toMatch(/0x[0-9a-f]{8}/);
    expect(message).not.toContain("is ignored");
  });

  it("with a valid value names it and still says what must be set", () => {
    const message = callerRejected(new Error(NODE), { MOI_READ_CALLER: VALID }).message;
    expect(message).toContain(`MOI_READ_CALLER (${VALID})`);
    expect(message).toContain("MOI_READ_CALLER must be set");
    expect(message).toContain("a participant that exists on this network");
    expect(message).toContain("an account named in the call's arguments");
    expect(message).not.toContain("placeholder caller");
  });

  it("with a value that is set but invalid says it is ignored and does not repeat it", () => {
    const message = callerRejected(new Error(NODE), { MOI_READ_CALLER: "not-an-id" }).message;
    expect(message).toContain("MOI_READ_CALLER is set but is not a valid participant id, so it is ignored");
    expect(message).toContain("placeholder caller");
    expect(message).toContain("MOI_READ_CALLER must be set");
    expect(message).not.toContain("not-an-id");
  });

  it("never puts any other part of the environment in the message", () => {
    const env = { MOI_READ_CALLER: VALID, WC_PROJECT_ID: "project-secret-xyz", MOI_SESSION_KEY: "key-secret-abc" };
    const message = callerRejected(new Error(NODE), env).message;
    expect(message).not.toContain("project-secret-xyz");
    expect(message).not.toContain("key-secret-abc");
  });

  it("cuts the node's text at 300 characters and keeps it on one line", () => {
    expect(MAX_NODE_TEXT).toBe(300);
    const long = `${NODE} ${"x".repeat(1000)}\nsecond line`;
    const message = callerRejected(new Error(long), {}).message;
    const quoted = /The node said: "(.*)"\.$/.exec(message)?.[1] ?? "";
    expect(quoted).toHaveLength(MAX_NODE_TEXT);
    expect(quoted.startsWith(NODE)).toBe(true);
    expect(message).not.toContain("second line");
    expect(message).not.toContain("\n");
  });
});

describe("readCallerFromEnv", () => {
  it("returns the value only when it is a valid participant id", () => {
    expect(readCallerFromEnv({ MOI_READ_CALLER: VALID })).toBe(VALID);
    expect(readCallerFromEnv({ MOI_READ_CALLER: "not-an-id" })).toBeUndefined();
    expect(readCallerFromEnv({ MOI_READ_CALLER: "0x1234" })).toBeUndefined();
    expect(readCallerFromEnv({ MOI_READ_CALLER: "" })).toBeUndefined();
    expect(readCallerFromEnv({})).toBeUndefined();
  });
});
