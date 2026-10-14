/**
 * What a logic routine is sent as, decided by the SDK from the kind its manifest declares: buildLogicEnlist, the builder behind
 * an enlist routine of moi_call_logic, and the two functions in src/moi/ix-builder.ts that act on the SDK's answer
 * (logicCallKind and assertNotDeployRoutine). In its own file because ix-builder.test.ts is at the 500 line limit.
 *
 * The SDK's LogicDriver is the reference: it turns a routine's kind into an operation type (js-moi-logic, logic-base.ts,
 * getTxType), and the builders must write what it writes. LogicDriver is run here with an empty object for a signer, which is
 * enough for ixData when the sender is given.
 */

import { createParticipantId, LockType, LogicDriver, ManifestCoder, OpType, ParticipantTagV0, toInteractionArgs } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { buildLogicEnlist } from "../../src/capabilities/logics/enlist.js";
import { assertNotDeployRoutine, buildLogicInvoke, logicCallKind, toPoloHex, type SenderInfo } from "../../src/moi/ix-builder.js";
import { isMoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { callable, FLIPPER, LOCK_LEDGER, logicManifest, MEMBERS } from "../helpers/logic-fixtures.js";
import { LOGIC, OTHER } from "../helpers/mock-node.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };
const SDK_SENDER = { id: SENDER.id, sequence: 3, key_id: 0 };
const FEES = { fuelLimit: 449, fuelPrice: 50 };

const driverFor = (manifest: unknown) => new LogicDriver(LOGIC, manifest as never, {} as never);

describe("buildLogicEnlist", () => {
  it("emits one LOGIC_ENLIST operation with the logic, the callsite and the calldata as given", () => {
    const ix = buildLogicEnlist(SENDER, { logicId: LOGIC, callsite: "Join", calldata: "0x0d2f06" });
    expect(ix.ix_operations).toEqual([{ type: OpType.LOGIC_ENLIST, payload: { logic_id: LOGIC, callsite: "Join", calldata: "0x0d2f06" } }]);
    expect(OpType.LOGIC_ENLIST).toBe(13);
    expect(ix.sender).toEqual({ id: SENDER.id, sequence: 3, key_id: 0 });
  });

  it("leaves calldata out for a routine that takes no inputs, and declares no participants unless asked", () => {
    const ix = buildLogicEnlist(SENDER, { logicId: LOGIC, callsite: "Register", calldata: "", participants: [] });
    expect(ix.ix_operations[0]!.payload).toEqual({ logic_id: LOGIC, callsite: "Register" });
    expect(ix).not.toHaveProperty("participants");
  });

  it("is buildLogicInvoke with the other operation type, so payload, participants and fees cannot drift apart", () => {
    const params = {
      logicId: LOGIC,
      callsite: "Join",
      calldata: "0x0d2f06",
      participants: [
        { id: OTHER, lock: "none" as const },
        { id: OTHER.toUpperCase().replace("0X", "0x"), lock: "mutate" as const },
      ],
    };
    const enlist = buildLogicEnlist(SENDER, params, FEES);
    const invoke = buildLogicInvoke(SENDER, params, FEES);
    expect(enlist.ix_operations).toEqual([{ type: OpType.LOGIC_ENLIST, payload: invoke.ix_operations[0]!.payload }]);
    expect({ ...enlist, ix_operations: [] }).toEqual({ ...invoke, ix_operations: [] });
    // The strongest lock wins, ids are lower-cased, and the logic is added as mutate, exactly as for an invoke.
    expect(enlist.participants).toEqual([
      { id: OTHER, lock_type: LockType.MUTATE_LOCK },
      { id: LOGIC, lock_type: LockType.MUTATE_LOCK },
    ]);
  });

  it("changes the bytes the wallet signs: the operation type is in them", () => {
    const params = { logicId: LOGIC, callsite: "Register" };
    expect(toPoloHex(buildLogicEnlist(SENDER, params))).toBe(toPoloHex(buildLogicEnlist(SENDER, params)));
    expect(toPoloHex(buildLogicEnlist(SENDER, params))).not.toBe(toPoloHex(buildLogicInvoke(SENDER, params)));
  });
});

describe("what the builders write, against the SDK's LogicDriver", () => {
  /** What the SDK builds for the same routine: its ixData, with the sender fixed and no signer. */
  async function sdkIx(manifest: unknown, routine: string, args: unknown[], participants: Array<{ id: string; lock_type: number }> = []) {
    const request = (driverFor(manifest).routines as unknown as Record<string, (...a: unknown[]) => { ixData: (o: unknown) => Promise<Record<string, unknown>> }>)[routine]!(...args);
    return request.ixData({ sender: SDK_SENDER, fuel_limit: 449, fuel_price: 50, participants });
  }

  const CASES = [
    { name: "LOCK_LEDGER Register(), an enlist routine that takes nothing", manifest: LOCK_LEDGER, routine: "Register", args: [], op: OpType.LOGIC_ENLIST },
    { name: "MEMBERS Join(nickname), an enlist routine with an input", manifest: MEMBERS, routine: "Join", args: ["ana"], op: OpType.LOGIC_ENLIST },
    // A safe integer goes to the SDK as a number: POLO writes a number compactly and a bigint full-width, and the tool passes the number.
    { name: "LOCK_LEDGER Lockup(amount), an invoke routine, which must not change", manifest: LOCK_LEDGER, routine: "Lockup", args: [5], op: OpType.LOGIC_INVOKE },
    { name: "MEMBERS Post(text), an invoke routine", manifest: MEMBERS, routine: "Post", args: ["hi"], op: OpType.LOGIC_INVOKE },
  ] as const;

  for (const row of CASES) {
    it(`writes the same interaction as the SDK for ${row.name}`, async () => {
      const sdk = await sdkIx(row.manifest, row.routine, [...row.args]);
      const calldata = row.args.length > 0 ? new ManifestCoder(row.manifest as never).encodeArguments(row.routine, ...row.args) : undefined;
      const params = { logicId: LOGIC, callsite: row.routine, ...(calldata ? { calldata } : {}) };
      const ours = row.op === OpType.LOGIC_ENLIST ? buildLogicEnlist(SENDER, params, FEES) : buildLogicInvoke(SENDER, params, FEES);

      // The operation is the SDK's, key for key, with the type the routine's kind gives it.
      expect(sdk["ix_operations"]).toHaveLength(1);
      expect(ours.ix_operations[0]).toEqual((sdk["ix_operations"] as unknown[])[0]);
      expect(ours.ix_operations[0]!.type).toBe(row.op);
      // What the node is sent is identical: the processed operation and the participants it derives, which are the logic, locked to mutate.
      expect(toInteractionArgs(ours as never)).toEqual(toInteractionArgs(sdk as never));
      expect((toInteractionArgs(ours as never).participants ?? []).map((p) => [p.id, p.lock_type])).toEqual([[LOGIC, LockType.MUTATE_LOCK]]);
      // And so are the bytes the wallet signs.
      expect(toPoloHex(ours)).toBe(toPoloHex(sdk as never));
    });
  }

  it("declares participants the way the SDK does for an enlist: the one named, then the logic", async () => {
    const sdk = await sdkIx(LOCK_LEDGER, "Register", [], [{ id: OTHER, lock_type: LockType.MUTATE_LOCK }]);
    const ours = buildLogicEnlist(SENDER, { logicId: LOGIC, callsite: "Register", participants: [{ id: OTHER, lock: "mutate" }] }, FEES);
    expect(toInteractionArgs(ours as never)).toEqual(toInteractionArgs(sdk as never));
    expect(toPoloHex(ours)).toBe(toPoloHex(sdk as never));
  });

  it("is a driver that offers only the invoke and enlist routines of a manifest: no deploy routine and no internal one", () => {
    const ledger = driverFor(LOCK_LEDGER);
    expect(Object.keys(ledger.routines)).toEqual(["Register", "Lockup", "Mint"]);
    expect(Object.keys(driverFor(FLIPPER).routines)).toEqual(["Get", "Set", "Toggle"]);
  });
});

/** A manifest that declares one name twice, as a hostile or careless logic can: the kinds in the order given. */
const declaredTwice = (...kinds: string[]) => logicManifest(kinds.map((kind, ptr) => callable(ptr, "Dup", "dynamic", [], [], kind)));

describe("logicCallKind: what the SDK built is what is sent", () => {
  type Request = { type: () => number; ctx: { opType?: number } };
  const requestFor = (manifest: unknown, routine: string, ...args: unknown[]) =>
    (driverFor(manifest).routines as unknown as Record<string, (...a: unknown[]) => Request>)[routine]!(...args);

  it("is invoke for LOGIC_INVOKE and enlist for LOGIC_ENLIST, which is what a manifest's invoke and enlist routines are", () => {
    expect(logicCallKind(OpType.LOGIC_INVOKE, "Lockup")).toBe("invoke");
    expect(logicCallKind(OpType.LOGIC_ENLIST, "Register")).toBe("enlist");
    expect(logicCallKind(requestFor(LOCK_LEDGER, "Register").ctx.opType, "Register")).toBe("enlist");
    expect(logicCallKind(requestFor(LOCK_LEDGER, "Lockup", 5).ctx.opType, "Lockup")).toBe("invoke");
  });

  it("reads ctx.opType, which is what the request's public type() says", () => {
    for (const [manifest, routine, args] of [[LOCK_LEDGER, "Register", []], [LOCK_LEDGER, "Lockup", [5]], [MEMBERS, "Join", ["ana"]]] as const) {
      const request = requestFor(manifest, routine, ...args);
      expect(request.ctx.opType).toBe(request.type());
    }
  });

  it("follows the SDK when a manifest declares one name twice, where the callsite map and the driver's callable disagree", () => {
    // The driver offers the last invoke or enlist routine of a name and skips the others; the callsite map keeps the last of any kind.
    // The SDK's callable decides the operation, so that is what is sent: enlist then deploy, and enlist then internal, are enlistments.
    const cases = [
      { kinds: ["enlist", "deploy"], sdk: "enlist", map: "deploy" },
      { kinds: ["enlist", "internal"], sdk: "enlist", map: "internal" },
      { kinds: ["invoke", "deploy"], sdk: "invoke", map: "deploy" },
      { kinds: ["invoke", "enlist"], sdk: "enlist", map: "enlist" },
      { kinds: ["enlist", "invoke"], sdk: "invoke", map: "invoke" },
    ] as const;
    for (const row of cases) {
      const manifest = declaredTwice(...row.kinds);
      expect(driverFor(manifest).getCallsites().get("Dup")?.kind, row.kinds.join(",")).toBe(row.map);
      expect(logicCallKind(requestFor(manifest, "Dup").ctx.opType, "Dup"), row.kinds.join(",")).toBe(row.sdk);
    }
  });

  it("refuses any other operation type, or none, so an SDK that stops saying fails closed", () => {
    for (const opType of [OpType.LOGIC_DEPLOY, OpType.ASSET_INVOKE, 0, undefined]) {
      let thrown: unknown;
      try {
        logicCallKind(opType, "Odd");
      } catch (err) {
        thrown = err;
      }
      expect(isMoiError(thrown), String(opType)).toBe(true);
      expect(thrown).toMatchObject({ code: ErrorCode.INVALID_ARGS, data: { callsite: "Odd", opType: opType ?? null } });
      expect((thrown as Error).message).toBe('Could not tell which operation a call to "Odd" is sent as. Nothing was sent to your wallet.');
    }
  });
});

describe("assertNotDeployRoutine", () => {
  it("refuses a deploy routine with a pointer to moi_deploy_logic, and the code of a bad argument", () => {
    let thrown: unknown;
    try {
      assertNotDeployRoutine(driverFor(LOCK_LEDGER), LOGIC, "Seed");
    } catch (err) {
      thrown = err;
    }
    expect(isMoiError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: ErrorCode.INVALID_ARGS, data: { logicId: LOGIC, callsite: "Seed", kind: "deploy" } });
    expect((thrown as Error).message).toBe(
      `"Seed" is a deploy routine of logic ${LOGIC}. A deploy routine runs once, when a logic is deployed, and cannot be called on a logic that already exists. ` +
        "To deploy a new logic from its compiled manifest use moi_deploy_logic. Nothing was sent to your wallet.",
    );
  });

  it("lets everything else through: enlist, invoke, internal, an unknown name, and a driver that cannot say", () => {
    for (const [driver, name] of [
      [driverFor(LOCK_LEDGER), "Register"],
      [driverFor(LOCK_LEDGER), "Lockup"],
      [driverFor(FLIPPER), "set"],
      [driverFor(FLIPPER), "Nope"],
      [{}, "Seed"],
    ] as const) {
      expect(() => assertNotDeployRoutine(driver, LOGIC, name)).not.toThrow();
    }
  });
});
