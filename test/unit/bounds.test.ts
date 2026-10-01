/**
 * The limits on what comes back from a dapp (src/bounds.ts): the byte-capped readers and the serialisation guard.
 * Hand-built Response objects, no server and no network.
 */
import { describe, expect, it } from "vitest";

import {
  boundedResult,
  clip,
  limitDepth,
  MAX_BODY_BYTES,
  MAX_DEPTH,
  MAX_TEXT_CHARS,
  readCapped,
  readWhole,
} from "../../src/bounds.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";

/** A half of a surrogate pair with no partner. isWellFormed is ES2024; the tsconfig lib is ES2023. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A response whose body never ends: `chunk` bytes at a time, counting how often it was pulled and whether it was cancelled. */
function endless(chunk = 1024, headers: Record<string, string> = {}) {
  const seen = { pulls: 0, cancelled: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls++;
        controller.enqueue(new Uint8Array(chunk).fill(97));
      },
      cancel() {
        seen.cancelled++;
      },
    },
    // Nothing is pulled before the first read, so the counts below are the reader's own.
    { highWaterMark: 0 },
  );
  return { res: new Response(body, { headers }), seen };
}

/** The depth of a value made of arrays and plain objects. */
function depthOf(v: unknown): number {
  let depth = 0;
  let cur: unknown = v;
  while (Array.isArray(cur) || (cur !== null && typeof cur === "object")) {
    depth++;
    cur = Array.isArray(cur) ? cur[0] : Object.values(cur as object)[0];
  }
  return depth;
}

const nestedObject = (levels: number) => JSON.parse('{"a":'.repeat(levels) + "1" + "}".repeat(levels)) as unknown;
const nestedArray = (levels: number) => JSON.parse("[".repeat(levels) + "]".repeat(levels)) as unknown;

describe("readCapped", () => {
  it("cancels a stream that never ends once the cap is reached", async () => {
    const { res, seen } = endless();
    const out = await readCapped(res, 4096, "https://dapp.example");
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(4096);
    expect(seen.cancelled).toBe(1);
    // Four chunks fill the cap and the fifth proves there is more; nothing is read past that.
    expect(seen.pulls).toBeLessThanOrEqual(6);
  });

  it("counts bytes beyond the cap only: exactly the cap is whole, one more is cut", async () => {
    const whole = await readCapped(new Response("a".repeat(100)), 100, "x");
    expect(whole).toEqual({ text: "a".repeat(100), truncated: false });
    const cut = await readCapped(new Response("a".repeat(101)), 100, "x");
    expect(cut).toEqual({ text: "a".repeat(100), truncated: true });
  });

  it("does not trust a declared Content-Length", async () => {
    const stream = () => new Blob(["a".repeat(10_000)]).stream();
    const lying = await readCapped(new Response(stream(), { headers: { "content-length": "10" } }), 100, "x");
    expect(lying).toEqual({ text: "a".repeat(100), truncated: true });
    // A huge declared length still returns a prefix: a prefix is what the caller wants.
    const { res } = endless(1024, { "content-length": "999999999" });
    expect((await readCapped(res, 2048, "x")).truncated).toBe(true);
  });

  it("reads an empty answer (204, 304) as no text", async () => {
    expect(await readCapped(new Response(null, { status: 204 }), 100, "x")).toEqual({ text: "", truncated: false });
  });

  it("never splits a character it cuts through", async () => {
    // "a" is one byte, the euro sign three: a cap of 3 falls inside the euro sign.
    expect(await readCapped(new Response("a€"), 3, "x")).toEqual({ text: "a", truncated: true });

    const euros = await readCapped(new Response("€".repeat(40_000)), MAX_BODY_BYTES, "x");
    expect(euros.truncated).toBe(true);
    expect(euros.text).toHaveLength(21_845);
    expect(euros.text).not.toContain("�");

    const emoji = await readCapped(new Response("\u{1F600}".repeat(20_000)), MAX_BODY_BYTES, "x");
    expect(emoji.truncated).toBe(true);
    expect(emoji.text).toHaveLength(32_768);
    expect(emoji.text).not.toMatch(LONE_SURROGATE);
    expect(emoji.text).not.toContain("�");
  });

  it("counts the cap in bytes, not characters", async () => {
    const out = await readCapped(new Response("€".repeat(MAX_BODY_BYTES)), MAX_BODY_BYTES, "x");
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("says which origin a failed read came from", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("terminated"));
      },
    });
    const err = await readCapped(new Response(broken), 100, "https://dapp.example").then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MoiError);
    expect((err as MoiError).code).toBe(ErrorCode.LAUNCHPAD_ERROR);
    expect((err as MoiError).message).toBe("Could not read the answer from https://dapp.example: terminated");
  });
});

describe("readWhole", () => {
  const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as MoiError);

  it("returns a body that fits", async () => {
    expect(await readWhole(new Response('{"ok":true}'), 1024, "x")).toBe('{"ok":true}');
  });

  it("refuses a body over the cap, names the size and cancels the stream", async () => {
    const { res, seen } = endless();
    const err = await rejection(readWhole(res, 4096, "https://dapp.example/api/me"));
    expect(err).toBeInstanceOf(MoiError);
    expect(err!.code).toBe(ErrorCode.LAUNCHPAD_ERROR);
    expect(err!.message).toBe("https://dapp.example/api/me is too large: it is over 4 KB, the most this connector reads.");
    expect(err!.data).toEqual({ limitBytes: 4096 });
    expect(seen.cancelled).toBe(1);
  });

  it("labels megabytes, and adds the advice when given", async () => {
    const err = await rejection(readWhole(new Response("a".repeat(3000)), 2048, "The document", "Publish a smaller one."));
    expect(err!.message).toBe("The document is too large: it is over 2 KB, the most this connector reads. Publish a smaller one.");
    const big = await rejection(
      readWhole(new Response("a", { headers: { "content-length": String(3 * 1024 * 1024) } }), 2 * 1024 * 1024, "The document"),
    );
    expect(big!.message).toContain("over 2 MB");
  });

  it("refuses on a declared length over the cap without reading a byte", async () => {
    const { res, seen } = endless(1024, { "content-length": "5000000" });
    const err = await rejection(readWhole(res, 1024 * 1024, "x"));
    expect(err!.code).toBe(ErrorCode.LAUNCHPAD_ERROR);
    expect(seen.pulls).toBe(0);
    expect(seen.cancelled).toBe(1);
  });

  it("falls back on the streamed count when the declared length is missing, wrong or not a number", async () => {
    for (const header of [undefined, "10", "abc", ""]) {
      const res = new Response(new Blob(["a".repeat(500)]).stream(), header === undefined ? {} : { headers: { "content-length": header } });
      expect((await rejection(readWhole(res, 100, "x")))!.message, String(header)).toMatch(/too large/);
    }
  });

  it("never puts any of the body in the message", async () => {
    const err = await rejection(readWhole(new Response("AGENT_KEY=very-secret".padEnd(5000, "x")), 100, "The setup script"));
    expect(err!.message).not.toContain("very-secret");
  });
});

describe("clip", () => {
  it("cuts to the length and never leaves half a surrogate pair", () => {
    expect(clip("abcdef", 10)).toBe("abcdef");
    expect(clip("abcdef", 3)).toBe("abc");
    // Index 1 is the high half of the pair.
    expect(clip("a\u{1F600}b", 2)).toBe("a");
    expect(clip("a\u{1F600}b", 3)).toBe("a\u{1F600}");
  });
});

describe("limitDepth", () => {
  it("returns a shallow value as the same reference", () => {
    const v = { a: [1, { b: "x" }], c: null, d: new Date(0), e: new Uint8Array(2) };
    const out = limitDepth(v);
    expect(out.value).toBe(v);
    expect(out.truncated).toBe(false);
  });

  it("replaces what nests too deep and says so", () => {
    const out = limitDepth({ a: [1, { b: 2 }] }, 2);
    expect(out.value).toEqual({ a: [1, "[omitted: nested more than 2 levels deep]"] });
    expect(out.truncated).toBe(true);
  });

  it("keeps exactly maxDepth levels", () => {
    const out = limitDepth(nestedObject(MAX_DEPTH + 5));
    expect(depthOf(out.value)).toBe(MAX_DEPTH);
    expect(out.truncated).toBe(true);
    expect(limitDepth(nestedObject(MAX_DEPTH)).truncated).toBe(false);
  });

  it("reduces a body nested thousands of levels deep without overflowing the stack", () => {
    for (const deep of [nestedObject(7000), nestedArray(30_000)]) {
      const out = limitDepth(deep);
      expect(out.truncated).toBe(true);
      expect(depthOf(out.value)).toBe(MAX_DEPTH);
      expect(JSON.stringify(out.value).length).toBeLessThan(1000);
    }
  });

  it("cuts a cycle rather than throwing", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop["self"] = loop;
    const out = limitDepth(loop);
    expect(out.truncated).toBe(true);
    expect(() => JSON.stringify(out.value)).not.toThrow();
  });

  it("keeps an own __proto__ key from a parsed body instead of setting the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":{"b":{"c":1}}}') as object;
    const out = limitDepth(parsed, 2).value as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ x: 1 });
  });
});

describe("boundedResult", () => {
  it("gives a small value as pretty JSON and the same object, as before", () => {
    const v = { a: 1, list: [1, 2] };
    const out = boundedResult(v);
    expect(out.content).toEqual([{ type: "text", text: JSON.stringify(v, null, 2) }]);
    expect(out.structuredContent).toBe(v);
  });

  it("uses the text it is given, untouched when it fits", () => {
    const out = boundedResult({ a: 1 }, "Signed in.");
    expect(out.content[0]!.text).toBe("Signed in.");
  });

  it("makes a body nested seven thousand deep small, in the text and the structured copy", () => {
    const body = nestedObject(7000);
    // Before the guard the pretty text of this is about 98 million characters.
    const out = boundedResult({ dapp: "x", body });
    expect(out.content[0]!.text.length).toBeLessThan(5000);
    expect(depthOf((out.structuredContent as { body: unknown }).body)).toBeLessThanOrEqual(MAX_DEPTH);
    expect(out.content[0]!.text).toContain("[omitted: nested more than 20 levels deep]");
  });

  it("handles nesting too deep for JSON.stringify itself", () => {
    expect(() => boundedResult({ body: nestedArray(30_000) })).not.toThrow();
  });

  it("falls back to compact JSON when only that fits", () => {
    const v = { items: Array.from({ length: 200 }, (_, i) => ({ v: [i] })) };
    const compact = JSON.stringify(v);
    const pretty = JSON.stringify(v, null, 2);
    expect(pretty.length).toBeGreaterThan(compact.length + 1000);
    const out = boundedResult(v, undefined, compact.length + 10);
    expect(out.content[0]!.text).toBe(compact);
    expect(JSON.parse(out.content[0]!.text)).toEqual(v);
  });

  it("cuts a text that fits no form, with a marker, and leaves the structured copy whole", () => {
    const v = { numbers: Array.from({ length: 100_000 }, (_, i) => i) };
    const out = boundedResult(v);
    const text = out.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 200);
    expect(text.startsWith('{"numbers":[0,1,2')).toBe(true);
    expect(text).toMatch(/\n\[Output cut: \d+ of \d+ characters shown\. Ask for less/);
    expect(out.structuredContent).toBe(v);
  });

  it("does not end a cut on half a surrogate pair", () => {
    // The text starts with {"s":" (6 characters), so the pairs begin on even indexes and index 1000 is a high half.
    const out = boundedResult({ s: "\u{1F600}".repeat(50_000) }, undefined, 1001);
    const [shown] = out.content[0]!.text.split("\n[Output cut");
    expect(shown).toHaveLength(1000);
    expect(shown).not.toMatch(LONE_SURROGATE);
    expect(boundedResult({}, "\u{1F600}".repeat(500), 101).content[0]!.text.split("\n[Output cut")[0]).not.toMatch(LONE_SURROGATE);
  });

  it("does not cut a full 64 KB text body even when escaping makes it six times longer", () => {
    // A control byte is one byte and six characters once JSON-escaped: 65,536 of them stringify to 393,218 characters.
    const body = "\u0001".repeat(MAX_BODY_BYTES);
    const out = boundedResult({ dapp: "https://dapp.example", operationId: "get", status: 200, ok: true, body, truncated: true });
    expect(out.content[0]!.text).not.toContain("[Output cut");
    expect(out.content[0]!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ body });
  });
});
