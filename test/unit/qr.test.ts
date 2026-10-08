import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { toBlockText, toPng, toTerminal } from "../../src/wc/qr.js";

const URI = "wc:7f2a@2?relay-protocol=irn&symKey=deadbeef";

describe("QR rendering", () => {
  it("produces a real PNG, base64 with no data: prefix", async () => {
    const b64 = await toPng(URI);
    expect(b64.startsWith("data:")).toBe(false);
    const bytes = Buffer.from(b64, "base64");
    // PNG magic number: 89 50 4E 47 -> \x89PNG
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("renders ASCII art for the terminal", async () => {
    const art = await toTerminal(URI);
    expect(art.length).toBeGreaterThan(100);
    expect(art).toMatch(/[█▀▄ ]/);
  });

  it("encodes distinct URIs differently", async () => {
    expect(await toPng(URI)).not.toBe(await toPng(`${URI}&x=1`));
  });

  /** A URI of the real shape: 64 hex topic, 64 hex key, a ten digit expiry. */
  const realUri = (): string =>
    `wc:${randomBytes(32).toString("hex")}@2?relay-protocol=irn&symKey=${randomBytes(32).toString("hex")}&expiryTimestamp=1790000000`;
  const MARGIN = 4;
  const GLYPHS = new Set([" ", "\u2580", "\u2584", "\u2588", "\n"]);

  it("renders the block text as equal-width rows of four glyphs", async () => {
    for (const uri of [URI, realUri(), realUri(), realUri()]) {
      const text = await toBlockText(uri);
      const rows = text.split("\n");
      // Nothing but the four glyphs and newlines, and no newline at the end.
      expect([...text].every((ch) => GLYPHS.has(ch))).toBe(true);
      expect(text.endsWith("\n")).toBe(false);
      // A model checks its copy by eye against equal widths, and the quiet zone is four spaces each side of every row.
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      for (const row of rows) {
        expect(row.startsWith(" ".repeat(MARGIN))).toBe(true);
        expect(row.endsWith(" ".repeat(MARGIN))).toBe(true);
      }
    }
  });

  it("spells the same module matrix as the code the PNG is made from", async () => {
    for (const uri of [URI, realUri(), realUri()]) {
      const { modules } = QRCode.create(uri, { errorCorrectionLevel: "M" });
      const rows = (await toBlockText(uri)).split("\n");
      // Two modules per line, with the margin as two lines above and two below. A space is both modules light, the upper
      // half block the top one dark, the lower half block the bottom one dark, the full block both.
      const dark = (line: number, col: number, bottom: boolean): boolean => {
        const ch = rows[MARGIN / 2 + line]![MARGIN + col]!;
        if (ch === "\u2588") return true;
        return ch === (bottom ? "\u2584" : "\u2580");
      };
      expect(rows.length).toBeGreaterThanOrEqual(Math.ceil(modules.size / 2) + MARGIN);
      for (let row = 0; row < modules.size; row++) {
        for (let col = 0; col < modules.size; col++) {
          expect(dark(Math.floor(row / 2), col, row % 2 === 1), `module ${row},${col}`).toBe(Boolean(modules.get(row, col)));
        }
      }
    }
  });

  it("gives two different block texts for two different URIs", async () => {
    expect(await toBlockText(URI)).not.toBe(await toBlockText(`${URI}&x=1`));
  });
});
