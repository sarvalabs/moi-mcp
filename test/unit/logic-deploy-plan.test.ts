/**
 * What moi_deploy_logic decides before it asks the node or the phone anything: the manifest read and checked, the deploy
 * routine chosen, its inputs validated and encoded, and the words the person reads. Pure: no node, no wallet.
 */

import { createHash } from "node:crypto";

import { DEFAULT_STORAGE_FUND, KMOI_ASSET_ID, ManifestCoder, ManifestCoderFormat } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_CHARS, readDeployManifest } from "../../src/capabilities/logics/deploy-manifest.js";
import { describeDeploy, planLogicDeploy, type LogicDeployInput } from "../../src/capabilities/logics/deploy.js";
import { MoiError } from "../../src/moi-error.js";
import { callable, COUNTER, FLIPPER, FLIPPER_PAYER, LOCK_LEDGER, logicManifest, NO_DEPLOY } from "../helpers/logic-fixtures.js";
import { OTHER } from "../helpers/mock-node.js";

const LEDGER_ARGS = { name: "MOI Ledger", symbol: "MOI", supply: "1000" };
const FUND_KEY = "KMOI moved into the new logic, base units";
const MANIFEST_KEY = "Manifest, read by this server (the phone shows only its bytes)";
const NEW_LOGIC = `0x${"20".repeat(32)}`;
const LEDGER_DIGEST = "347f7330ebb6e5804a54a7e2fd8bc58b612a3c6835011fe05679a3ffe64dc03e";

function plan(manifest: unknown, over: Partial<LogicDeployInput> = {}) {
  return planLogicDeploy({ manifest: manifest as Record<string, unknown>, args: {}, ...over });
}

/** The refusal a call gets: its code and message. Fails the test when the call is accepted. */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(MoiError);
    return { code: (err as MoiError).code, message: (err as MoiError).message };
  }
  throw new Error("expected a refusal");
}

describe("a manifest with one deploy routine", () => {
  it("runs it without being told, and encodes its inputs as the SDK's ManifestCoder does", () => {
    const p = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    expect(p.callsite).toBe("Seed");
    expect(p.manifestHex).toBe(ManifestCoder.encodeManifest(LOCK_LEDGER as never));
    expect(p.calldata).toBe(new ManifestCoder(LOCK_LEDGER as never).encodeArguments("Seed", "MOI Ledger", "MOI", 1000));
    expect(p.calldata).toMatch(/^0x[0-9a-f]+$/);
    expect(p.participants).toEqual([]);
  });

  it("gives the same text for the same call in another key order, which the confirm step relies on", () => {
    const a = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    const b = plan(LOCK_LEDGER, { args: { supply: 1000, symbol: "MOI", name: "MOI Ledger" } });
    expect(describeDeploy(b, NEW_LOGIC, 1n)).toEqual(describeDeploy(a, NEW_LOGIC, 1n));
    expect(b.calldata).toBe(a.calldata);
  });

  it("refuses an input the routine does not take, a missing one, and a value of the wrong type", () => {
    expect(refusal(() => plan(LOCK_LEDGER, { args: { ...LEDGER_ARGS, extra: 1 } })).message).toMatch(/Seed has no input "extra"\. It takes: name \(string\), symbol \(string\), supply \(u256\)/);
    expect(refusal(() => plan(LOCK_LEDGER, { args: { name: "x", symbol: "y" } })).message).toMatch(/Missing input "supply" \(u256\) for Seed/);
    const wrong = refusal(() => plan(LOCK_LEDGER, { args: { ...LEDGER_ARGS, supply: "1.5" } }));
    expect(wrong.code).toBe("INVALID_ARGS");
    expect(wrong.message).toMatch(/Input "supply" must be a whole number/);
    expect(wrong.message).not.toMatch(/decimals/); // a logic has none, so nothing talks about whole tokens
    expect(wrong.message).toMatch(/Nothing was sent to your wallet\.$/);
  });

  it("refuses a name that is not the manifest's one, and offers the near miss without applying it", () => {
    const wrong = refusal(() => plan(LOCK_LEDGER, { routine: "seed", args: LEDGER_ARGS }));
    expect(wrong.code).toBe("LOGIC_ROUTINE_NOT_FOUND");
    expect(wrong.message).toMatch(/no deploy routine "seed" \(did you mean "Seed"\?\)\. Its deploy routines are: Seed\./);
    // An invoke routine is not a deploy routine.
    expect(refusal(() => plan(LOCK_LEDGER, { routine: "Mint" })).code).toBe("LOGIC_ROUTINE_NOT_FOUND");
    // A name that is an Object.prototype key is just a name that is not there.
    expect(refusal(() => plan(LOCK_LEDGER, { routine: "constructor" })).code).toBe("LOGIC_ROUTINE_NOT_FOUND");
  });

  it("refuses an input of a type this server cannot encode, rather than guess", () => {
    const manifest = logicManifest([callable(0, "Seed", "dynamic", [["cfg", "class.Config"]], [], "deploy")]);
    expect(refusal(() => plan(manifest, { args: { cfg: {} } })).message).toMatch(/Input "cfg" has type class\.Config, which this server cannot encode yet/);
  });

  it("refuses a deploy routine whose inputs this server cannot read at all", () => {
    const many = Array.from({ length: 17 }, (_, i) => [`a${i}`, "u64"] as [string, string]);
    const r = refusal(() => plan(logicManifest([callable(0, "Wide", "dynamic", many, [], "deploy")])));
    expect(r.code).toBe("INVALID_ARGS");
    expect(r.message).toMatch(/The deploy routine Wide has inputs this server cannot read \(more than 16/);
  });
});

describe("a manifest with several deploy routines", () => {
  it("must be told which one, and names them", () => {
    const r = refusal(() => plan(FLIPPER));
    expect(r.code).toBe("INVALID_ARGS");
    expect(r.message).toMatch(/has 2 deploy routines: Init, Seed\. Pass routine to say which one runs at deployment\./);
  });

  it("runs the one it is told, with or without inputs, and counts routines of every kind", () => {
    const init = plan(FLIPPER, { routine: "Init" });
    expect(init.callsite).toBe("Init");
    expect(init.calldata).toBeUndefined();
    expect(init.deployLine).toBe("Init");
    expect(init.argsLine).toBe("none");
    expect(init.manifestLine).toMatch(/^6 routines \(2 deploy, 3 invoke, 1 internal\): Init, Seed, Get, Set, Toggle; 548 bytes encoded; SHA-256 of those bytes [0-9a-f]{64}; no name, because /);

    const seed = plan(FLIPPER, { routine: "Seed", args: { initial: true } });
    expect(seed.calldata).toBe(new ManifestCoder(FLIPPER as never).encodeArguments("Seed", true));
    expect(seed.argsLine).toBe('{"initial":true}');
    expect(refusal(() => plan(FLIPPER, { routine: "Seed", args: { initial: "yes" } })).message).toMatch(/Input "initial" must be true or false/);
  });

  it("refuses inputs for a routine that takes none", () => {
    expect(refusal(() => plan(FLIPPER, { routine: "Init", args: { initial: true } })).message).toMatch(/Init has no input "initial"\. It takes: no inputs\./);
  });
});

describe("a manifest with no deploy routine", () => {
  it("is refused, with or without a routine named, and the refusal says what is not known", () => {
    for (const over of [{}, { routine: "Init" }, { args: { x: 1 } }]) {
      const r = refusal(() => plan(NO_DEPLOY, over));
      expect(r.code).toBe("INVALID_ARGS");
      expect(r.message).toMatch(/^The manifest has no deploy routine\. This tool deploys a logic by running one of its deploy routines: whether the chain accepts a deploy with nothing to run is documented only in the SDK's own comments, and has not been run, so it is not offered\. Nothing was sent to your wallet\.$/);
    }
  });
});

describe("the manifest", () => {
  it("must be a logic: an asset manifest is sent to moi_create_asset, and anything else is named", () => {
    expect(refusal(() => plan({ ...LOCK_LEDGER, kind: "asset" })).message).toMatch(/for an asset.*moi_create_asset/);
    expect(refusal(() => plan({ ...LOCK_LEDGER, kind: "Logic" })).message).toMatch(/kind must be "logic".*got "Logic"/);
  });

  // Coco 0.9.0 writes no kind into a logic manifest, so a manifest with none is a logic and is encoded as one.
  it("a logic manifest with no kind is taken as a logic", () => {
    const { kind: _kind, ...noKind } = LOCK_LEDGER;
    const withKind = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    const without = plan(noKind, { args: LEDGER_ARGS });

    // The bytes sent are those of the manifest with its kind, not the shorter encoding of one that has none.
    expect(without.manifestHex).toBe(ManifestCoder.encodeManifest(LOCK_LEDGER as never));
    expect(without.manifestHex).not.toBe(ManifestCoder.encodeManifest(noKind as never));
    expect(without.manifestHex).toBe(withKind.manifestHex);
    expect(without.manifestLine).toBe(withKind.manifestLine);
    expect(without.manifestLine).toContain(LEDGER_DIGEST);
    expect(ManifestCoder.decodeManifest(without.manifestHex, ManifestCoderFormat.JSON)).toMatchObject({ kind: "logic" });
    // The caller's object is not changed.
    expect("kind" in noKind).toBe(false);
  });

  it("the compiler's own output is accepted as written", () => {
    const { kind: _kind, ...asCompiled } = FLIPPER_PAYER;
    expect("kind" in asCompiled).toBe(false);

    const p = plan(asCompiled, { routine: "Seed", args: { initial: true } });

    expect(p.callsite).toBe("Seed");
    expect(p.argsLine).toBe('{"initial":true}');
    // Equal to the manifest the fixture holds with the kind added by hand, byte for byte.
    expect(p.manifestHex).toBe(ManifestCoder.encodeManifest(FLIPPER_PAYER as never));
    expect(p.manifestHex).toBe(plan(FLIPPER_PAYER, { routine: "Seed", args: { initial: true } }).manifestHex);
  });

  it("any other kind is still refused", () => {
    for (const kind of ["asset", "Logic", "", null, 1]) {
      const r = refusal(() => plan({ ...LOCK_LEDGER, kind }));
      expect(r.code).toBe("INVALID_ARGS");
      expect(r.message).toMatch(kind === "asset" ? /for an asset.*moi_create_asset/ : /kind must be "logic"/);
      expect(r.message).toMatch(/Nothing was sent to your wallet\.$/);
    }
  });

  it("a MASX manifest with no kind is still refused: the compiler writes kind asset for those", () => {
    const { kind: _kind, ...noKind } = LOCK_LEDGER;
    const r = refusal(() => readDeployManifest(noKind, "asset"));
    expect(r.message).toMatch(/kind must be "asset".*it has no kind/);
  });

  it("needs a syntax number, an engine with a kind, and some elements", () => {
    const { syntax: _s, ...noSyntax } = LOCK_LEDGER;
    const { engine: _e, ...noEngine } = LOCK_LEDGER;
    for (const m of [noSyntax, noEngine, { ...LOCK_LEDGER, syntax: "1" }, { ...LOCK_LEDGER, engine: { flags: [] } }]) {
      expect(refusal(() => plan(m)).message).toMatch(/needs a whole-number `syntax` and an `engine` object with a `kind`/);
    }
    for (const m of [{ ...LOCK_LEDGER, elements: [] }, { ...LOCK_LEDGER, elements: {} }]) {
      expect(refusal(() => plan(m)).message).toMatch(/no `elements` list, or an empty one/);
    }
  });

  it("is refused when the encoder cannot take it", () => {
    const r = refusal(() => plan({ ...LOCK_LEDGER, elements: [{ ptr: 0, kind: "nope", data: {} }] }));
    expect(r.code).toBe("INVALID_ARGS");
    expect(r.message).toMatch(/could not be encoded: Unknown element kind: nope\. Pass the JSON object coco compile writes, unchanged\./);
  });

  it("is refused above the JSON cap before it is encoded, and above the byte cap after", () => {
    // One routine whose `executes.hex` is a string of this many characters: the JSON and the POLO are each a little over that long.
    const huge = (chars: number) =>
      logicManifest([{ ...callable(0, "Big", "dynamic", []), data: { ...(callable(0, "Big", "dynamic", [])["data"] as object), executes: { hex: "a".repeat(chars), asm: [] } } }]);
    expect(MAX_MANIFEST_BYTES).toBe(32_768);
    const json = refusal(() => plan(huge(MAX_MANIFEST_JSON_CHARS)));
    expect(json.message).toMatch(new RegExp(`too large: \\d+ characters of JSON, and this tool takes at most ${MAX_MANIFEST_JSON_CHARS}`));
    const bytes = refusal(() => plan(huge(MAX_MANIFEST_BYTES)));
    expect(bytes.message).toMatch(new RegExp(`encodes to \\d+ bytes, and this tool takes at most ${MAX_MANIFEST_BYTES}`));
    // Under the byte cap it is read.
    expect(readDeployManifest(huge(20_000) as never).bytes).toBeLessThan(MAX_MANIFEST_BYTES);
  });

  it("is read back from the encoded bytes: the routines shown are the ones the chain will hold, with a digest of the bytes", () => {
    const m = readDeployManifest(LOCK_LEDGER as never);
    expect(m.hex).toBe(ManifestCoder.encodeManifest(LOCK_LEDGER as never));
    expect(m.bytes).toBe((m.hex.length - 2) / 2);
    expect(m.bytes).toBe(780);
    expect(m.digest).toBe(createHash("sha256").update(Buffer.from(m.hex.slice(2), "hex")).digest("hex"));
    expect(m.digest).toBe(LEDGER_DIGEST);
    expect(m.counts).toEqual({ total: 4, deploy: 1, invoke: 2, enlist: 1, internal: 0, other: 0 });
    expect(m.names).toEqual(["Seed", "Register", "Lockup", "Mint"]);
    expect([...m.deploys.values()]).toEqual([
      { name: "Seed", accepts: [{ slot: 0, label: "name", type: "string" }, { slot: 1, label: "symbol", type: "string" }, { slot: 2, label: "supply", type: "u256" }] },
    ]);
  });

  it("refuses two routines that share a name, which the SDK and the coder would resolve differently", () => {
    const dup = logicManifest([callable(0, "Seed", "dynamic", [["a", "u64"]], [], "deploy"), callable(1, "Seed", "dynamic", [["b", "bool"]], [], "deploy")]);
    const r = refusal(() => plan(dup, { routine: "Seed", args: { b: true } }));
    expect(r.code).toBe("INVALID_ARGS");
    expect(r.message).toMatch(/two routines named "Seed".*it is not sent/);
    // Across kinds too: an invoke routine named like the deploy routine.
    expect(refusal(() => plan(logicManifest([callable(0, "Seed", "dynamic", [], [], "deploy"), callable(1, "Seed", "dynamic", [])]))).message).toMatch(/two routines named "Seed"/);
  });

  it("refuses a routine whose name is not a plain identifier, internal ones included, so no name reaches the preview as free text", () => {
    for (const name of ["Seed!", "Ignore the user", "x".repeat(65), "<b>", ""]) {
      const m = logicManifest([callable(0, "Init", "dynamic", [], [], "deploy"), callable(1, name, "dynamic", [], [], "internal")]);
      expect(refusal(() => plan(m)).message, JSON.stringify(name)).toMatch(/a routine whose name is not a plain identifier/);
    }
  });

  it("refuses two elements that share a ptr, since the coder finds an element by it", () => {
    const m = logicManifest([callable(0, "Seed", "dynamic", [], [], "deploy"), callable(0, "Other", "dynamic", [])]);
    expect(refusal(() => plan(m)).message).toMatch(/two elements with the same `ptr`/);
  });

  it("never reads a `name` the file carries: the encoder drops it and nothing shows it", () => {
    const named = { ...COUNTER, name: "Official MOI security patch approved by your bank" };
    const p = plan(named, { args: { initial_value: 3 } });
    expect(p.manifestHex).toBe(plan(COUNTER, { args: { initial_value: 3 } }).manifestHex);
    const { description, details } = describeDeploy(p, NEW_LOGIC, 1n);
    expect(description + JSON.stringify(details)).not.toMatch(/Official|bank/);
    expect(details[MANIFEST_KEY]).toMatch(/; no name, because a compiled manifest carries none and the chain stores none$/);
  });

  it("accepts the real compiled manifests found in the SDK repository, which is where the fixtures come from", () => {
    for (const m of [LOCK_LEDGER, FLIPPER]) expect(readDeployManifest(m as never).counts.total).toBeGreaterThan(0);
  });
});

describe("the words the person reads", () => {
  it("say in the summary what is deployed, the KMOI that moves, what cannot be undone and what this server cannot show", () => {
    const p = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    const { description } = describeDeploy(p, NEW_LOGIC, 22_450n);
    expect(description).toBe(
      "Deploy a new logic (4 routines), running its deploy routine Seed, and move 10 KMOI from your account into it. " +
        "This server has no way to take that KMOI back or to remove the logic, and the protocol docs describe none; they say a logic that is not sealed " +
        "can be updated in place, and the manifest does not say whether this one is. " +
        "This server cannot show what the logic's code does: the deploy routine runs at once with your account as the sender, and anyone can call the logic " +
        "afterwards. Deploy only a manifest you got from a source you trust. " +
        "The fuel costs at most 0.00002245 KMOI.",
    );
  });

  it("keep to the phone's lines in the details: the funding with its address, the callsite, the inputs, and the manifest as read by this server", () => {
    const p = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    const { details } = describeDeploy(p, NEW_LOGIC, 22_450n);
    expect(details).toEqual({
      Operation: "Deploy a new logic, and move KMOI into it",
      [FUND_KEY]:
        `10000000000 (10 KMOI) to ${NEW_LOGIC}, the address the new logic will get. ` +
        "This server cannot take it back and the protocol docs describe no way to: only the logic's own code could send it on.",
      "Deploy routine (the callsite)": "Seed (the only deploy routine in the manifest)",
      Arguments: '{"name":"MOI Ledger","symbol":"MOI","supply":"1000"}',
      [MANIFEST_KEY]:
        `4 routines (1 deploy, 2 invoke, 1 enlist): Seed, Register, Lockup, Mint; 780 bytes encoded; SHA-256 of those bytes ${LEDGER_DIGEST}; ` +
        "no name, because a compiled manifest carries none and the chain stores none",
    });
  });

  it("always fund the SDK's default, whatever the caller passes: there is no input for another amount", () => {
    const p = planLogicDeploy({ manifest: COUNTER, args: { initial_value: 1 }, storageFund: "18000000000000000000" } as never);
    expect(describeDeploy(p, NEW_LOGIC, 1n).details[FUND_KEY]).toMatch(/^10000000000 \(10 KMOI\) to /);
    expect(String(DEFAULT_STORAGE_FUND)).toBe("10000000000");
  });

  it("name the participants as accounts the new code may move, and say so only when there are some", () => {
    const withOther = describeDeploy(plan(COUNTER, { args: { initial_value: 1 }, participants: [{ id: OTHER, lock: "mutate" }] }), NEW_LOGIC, 1n);
    expect(withOther.details["Other participants (the new code may move these)"]).toBe(`${OTHER} (mutate)`);
    const without = describeDeploy(plan(COUNTER, { args: { initial_value: 1 } }), NEW_LOGIC, 1n);
    expect(Object.keys(without.details).some((k) => k.startsWith("Other participants"))).toBe(false);
  });

  it("show a deploy routine that takes no inputs as having none, and list at most twelve routine names", () => {
    expect(describeDeploy(plan(FLIPPER, { routine: "Init" }), NEW_LOGIC, 1n).details["Arguments"]).toBe("none");
    const many = logicManifest([
      callable(0, "Seed", "dynamic", [], [], "deploy"),
      ...Array.from({ length: 14 }, (_, i) => callable(i + 1, `Routine${i}`, "dynamic", [])),
    ]);
    expect(plan(many).manifestLine).toMatch(/^15 routines \(1 deploy, 14 invoke\): Seed, Routine0, .*, Routine10, and 3 more; /);
  });

  it("put the fee, a figure that moves, in the summary and not in the lines the confirm step compares", () => {
    const p = plan(LOCK_LEDGER, { args: LEDGER_ARGS });
    const cheap = describeDeploy(p, NEW_LOGIC, 22_450n);
    const dear = describeDeploy(p, NEW_LOGIC, 100_000_000n);
    expect(dear.description).toContain("at most 0.1 KMOI");
    expect(dear.details).toEqual(cheap.details);
  });
});

describe("participants", () => {
  it("are passed on as given, and KMOI is refused in any spelling because the funding transfer declares it", () => {
    const p = plan(COUNTER, { args: { initial_value: 1 }, participants: [{ id: OTHER, lock: "mutate" }] });
    expect(p.participants).toEqual([{ id: OTHER, lock: "mutate" }]);
    const kmoi = String(KMOI_ASSET_ID).toUpperCase().replace("0X", "0x");
    expect(refusal(() => plan(COUNTER, { args: { initial_value: 1 }, participants: [{ id: kmoi, lock: "none" }] })).message).toMatch(/KMOI is declared by the funding transfer/);
  });
});
