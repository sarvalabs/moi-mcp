/**
 * The brand images must survive a deployment that ships dist/ and nothing
 * else. They did not: the first VM deployment answered 500 on every icon
 * path because assets/ was not beside the bundle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { brandAsset } from "../../src/branding.js";
import { BRAND_ASSETS_BASE64 } from "../../src/brand-assets.js";

const ASSETS = new URL("../../assets/", import.meta.url).pathname;

describe("brand assets", () => {
  it("answers every icon path with real image bytes", () => {
    for (const path of ["/favicon.ico", "/favicon.png", "/logo.png", "/apple-touch-icon.png"]) {
      const hit = brandAsset(path);
      expect(hit, path).toBeDefined();
      expect(hit!.type).toBe("image/png");
      // PNG magic number: a truncated or mis-decoded blob fails here.
      expect(hit!.body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    for (const path of ["/favicon.svg", "/logo.svg"]) {
      const hit = brandAsset(path);
      expect(hit, path).toBeDefined();
      expect(hit!.type).toBe("image/svg+xml");
      expect(hit!.body.toString("utf8")).toContain("<svg");
    }
  });

  it("is undefined for a path that is not ours, rather than throwing", () => {
    expect(brandAsset("/nope.png")).toBeUndefined();
    expect(brandAsset("/")).toBeUndefined();
  });

  it("reads nothing from the filesystem at runtime", () => {
    const source = readFileSync(new URL("../../src/branding.ts", import.meta.url).pathname, "utf8");
    // Checked on the import, not on prose: the comments here explain the very
    // filesystem read this module must no longer perform.
    expect(source).not.toMatch(/^import .*"node:fs"/m);
    expect(source).not.toMatch(/^import .*"node:url"/m);
  });

  it("matches the files on disk, so a changed logo cannot be forgotten", () => {
    // Regenerate with: node scripts/inline-brand.mjs
    const onDisk = readdirSync(ASSETS).filter((f) => /\.(png|svg)$/.test(f)).sort();
    expect(Object.keys(BRAND_ASSETS_BASE64).sort()).toEqual(onDisk);
    for (const f of onDisk) {
      expect(Buffer.from(BRAND_ASSETS_BASE64[f]!, "base64"), f).toEqual(readFileSync(join(ASSETS, f)));
    }
  });
});
