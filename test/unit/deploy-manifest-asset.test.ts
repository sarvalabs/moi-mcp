/**
 * readDeployManifest and the planning pieces it shares with a MASX create: the kind it is asked to expect, the words that
 * differ between a logic and an asset, and the defaults that keep moi_deploy_logic as it was. Pure: no node, no wallet.
 */

import { describe, expect, it } from "vitest";

import { isMoiError } from "../../src/moi-error.js";
import { manifestLine, pickRoutine, readDeployManifest } from "../../src/capabilities/logics/deploy-manifest.js";
import { LOCK_LEDGER, LOGIC_KIND, NO_KIND, PLAIN_ASSET, TAXTOKEN, TWO_DEPLOYS_ASSET } from "../helpers/asset-create-fixtures.js";

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (isMoiError(err)) return err.message;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("readDeployManifest with the kind it expects", () => {
  it("reads a compiled asset manifest when it expects an asset, and lists its deploy routine and its inputs", () => {
    const m = readDeployManifest(TAXTOKEN as never, "asset");
    expect(m.counts).toEqual({ total: 2, deploy: 1, invoke: 1, enlist: 0, internal: 0, other: 0 });
    expect(m.names).toEqual(["Init", "Transfer"]);
    expect([...m.deploys.keys()]).toEqual(["Init"]);
    expect(m.deploys.get("Init")!.accepts!.map((f) => f.label)).toEqual(["treasury_addr", "bps", "initial_supply"]);
    expect(readDeployManifest(PLAIN_ASSET as never, "asset").deploys.size).toBe(0);
  });

  it("still defaults to a logic: an asset manifest is sent to moi_create_asset, and no longer told that assets are MAS0 only", () => {
    const message = refusal(() => readDeployManifest(TAXTOKEN as never));
    expect(message).toMatch(/for an asset.*moi_create_asset/);
    expect(message).toMatch(/standard MASX takes a compiled asset manifest/);
    expect(message).not.toMatch(/MAS0 assets only|only for now/);
    expect(message).toMatch(/Nothing was sent to your wallet\.$/);
    expect(readDeployManifest(LOCK_LEDGER as never).deploys.size).toBe(1);
  });

  it("refuses a logic manifest when it expects an asset, and sends it to moi_deploy_logic (R7)", () => {
    for (const logic of [LOCK_LEDGER, LOGIC_KIND]) {
      expect(refusal(() => readDeployManifest(logic as never, "asset"))).toBe(
        'This manifest is for a logic (its kind is "logic"), not an asset. A MASX asset is created from the manifest of a `coco asset` module (kind "asset"). ' +
          "To deploy a logic use moi_deploy_logic. Nothing was sent to your wallet.",
      );
    }
  });

  it("names the kind it expects when the manifest has none or another, for a logic as it always did and for an asset", () => {
    expect(refusal(() => readDeployManifest(NO_KIND as never, "asset"))).toBe(`The manifest's kind must be "asset", as a compiled asset manifest says; it has no kind. Nothing was sent to your wallet.`);
    expect(refusal(() => readDeployManifest({ ...TAXTOKEN, kind: "Asset" } as never, "asset"))).toMatch(/got "Asset"/);
    expect(refusal(() => readDeployManifest({ ...LOCK_LEDGER, kind: "Logic" } as never))).toBe(
      `The manifest's kind must be "logic", as a compiled logic manifest says; got "Logic". Nothing was sent to your wallet.`,
    );
    expect(refusal(() => readDeployManifest({ ...TAXTOKEN, elements: [] } as never, "asset"))).toMatch(/a compiled asset manifest has syntax, engine, kind and elements\./);
  });
});

describe("the pieces a deploy and a MASX create share", () => {
  it("pickRoutine asks for a name with the closing words it is given, and 'at deployment' by default", () => {
    const m = readDeployManifest(TWO_DEPLOYS_ASSET as never, "asset");
    expect(refusal(() => pickRoutine(m, undefined))).toBe("The manifest has 2 deploy routines: Init, Reinit. Pass routine to say which one runs at deployment. Nothing was sent to your wallet.");
    expect(refusal(() => pickRoutine(m, undefined, "when the asset is created"))).toMatch(/Pass routine to say which one runs when the asset is created\./);
    expect(pickRoutine(m, "Reinit").routine.name).toBe("Reinit");
  });

  it("manifestLine ends with the logic's words by default and with the words it is given", () => {
    const m = readDeployManifest(TAXTOKEN as never, "asset");
    expect(manifestLine(m)).toMatch(/; no name, because a compiled manifest carries none and the chain stores none$/);
    expect(manifestLine(m, "the symbol above is the asset's only name")).toMatch(/; the symbol above is the asset's only name$/);
    expect(manifestLine(m)).toContain(`${m.bytes} bytes encoded; SHA-256 of those bytes ${m.digest};`);
  });
});
