import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPairingModule } from "../../src/pairing/index.js";
import QRCode from "qrcode";

vi.mock("qrcode", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof QRCode };
  return { ...actual, default: { ...actual.default, toString: vi.fn(actual.default.toString) } };
});

const PUBLIC_URL = "https://connect.example.test";
const URI = "wc:7f2a@2?relay-protocol=irn&symKey=deadbeef";

/** Mount a pairing module on a real listening server so GETs exercise HTTP end to end. */
async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("pairing", () => {
  let time = 1_000_000; // ms; advanced manually per test
  const now = () => time;

  beforeEach(() => {
    time = 1_000_000;
  });

  describe("createPairingLink / consumeForUser", () => {
    it("is idempotent per user while unexpired", () => {
      const { createPairingLink } = createPairingModule(now);
      const first = createPairingLink("alice", PUBLIC_URL);
      const second = createPairingLink("alice", PUBLIC_URL);
      expect(second.url).toBe(first.url);
      expect(second.expiresAt).toBe(first.expiresAt);
    });

    it("gives different users different links", () => {
      const { createPairingLink } = createPairingModule(now);
      const alice = createPairingLink("alice", PUBLIC_URL);
      const bob = createPairingLink("bob", PUBLIC_URL);
      expect(alice.url).not.toBe(bob.url);
    });

    it("issues a fresh link once the previous one expires", () => {
      const { createPairingLink } = createPairingModule(now);
      const first = createPairingLink("alice", PUBLIC_URL);
      time += 5 * 60 * 1000; // exactly at the TTL boundary — must count as expired
      const second = createPairingLink("alice", PUBLIC_URL);
      expect(second.url).not.toBe(first.url);
    });

    it("expiresAt is unix seconds five minutes out", () => {
      const { createPairingLink } = createPairingModule(now);
      const { expiresAt } = createPairingLink("alice", PUBLIC_URL);
      expect(expiresAt).toBe(Math.floor(time / 1000) + 300);
    });

    it("consumeForUser invalidates the outstanding link, forcing a new one", () => {
      const { createPairingLink, consumeForUser } = createPairingModule(now);
      const first = createPairingLink("alice", PUBLIC_URL);
      consumeForUser("alice");
      const second = createPairingLink("alice", PUBLIC_URL);
      expect(second.url).not.toBe(first.url);
    });

    it("a seeded uri makes the page render that proposal without calling resolveUri", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const resolveUri = vi.fn().mockResolvedValue("wc:other@2?relay-protocol=irn&symKey=ffff");
      const app = express();
      mountPairing(app, { resolveUri });
      const { server, base } = await listen(app);
      try {
        const { url } = createPairingLink("alice", PUBLIC_URL, { uri: URI, mode: "once" });
        const res = await fetch(`${base}${url.slice(PUBLIC_URL.length)}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("wc:7f2a@2"); // the page HTML-escapes the rest
        expect(html).not.toContain("wc:other");
        expect(resolveUri).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    });

    it("a seed updates the lifetime of a live link but never replaces a uri the page already has", async () => {
      const { createPairingLink, modeForUser, mountPairing } = createPairingModule(now);
      const app = express();
      mountPairing(app, { resolveUri: vi.fn() });
      const { server, base } = await listen(app);
      try {
        const first = createPairingLink("alice", PUBLIC_URL, { uri: URI });
        const second = createPairingLink("alice", PUBLIC_URL, { uri: "wc:second@2?relay-protocol=irn", mode: "once" });
        expect(second.url).toBe(first.url);
        expect(modeForUser("alice")).toBe("once");
        const html = await (await fetch(`${base}${first.url.slice(PUBLIC_URL.length)}`)).text();
        // The first proposal stays: the page keeps showing what it already showed.
        expect(html).toContain("wc:7f2a@2");
        expect(html).not.toContain("wc:second");
      } finally {
        server.close();
      }
    });

    it("consumeForUser is a no-op for a user with no outstanding link", () => {
      const { consumeForUser } = createPairingModule(now);
      expect(() => consumeForUser("nobody")).not.toThrow();
    });
  });

  describe("mountPairing", () => {
    let server: Server;
    let base: string;

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("returns 410 for an unknown token", async () => {
      const { mountPairing } = createPairingModule(now);
      const app = express();
      mountPairing(app, { resolveUri: vi.fn() });
      ({ server, base } = await listen(app));

      const res = await fetch(`${base}/pair/does-not-exist`);
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("no longer valid");
    });

    it("resolves the URI, renders the QR page, and calls resolveUri exactly once across two GETs", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const resolveUri = vi.fn().mockResolvedValue(URI);
      const app = express();
      mountPairing(app, { resolveUri });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      // The page HTML-escapes the URI (e.g. "&" -> "&amp;") when embedding it
      // in the readonly input's value attribute, so compare against that form.
      const escapedUri = URI.replace(/&/g, "&amp;");

      const first = await fetch(`${base}${path}`);
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody).toContain(escapedUri);
      expect(firstBody).toContain("<svg");

      const second = await fetch(`${base}${path}`);
      expect(second.status).toBe(200);
      const secondBody = await second.text();
      expect(secondBody).toContain(escapedUri);

      expect(resolveUri).toHaveBeenCalledTimes(1);
      expect(resolveUri).toHaveBeenCalledWith("alice");
    });

    it("shares one in-flight resolveUri call across concurrent GETs of the same token", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      let releaseResolve: (uri: string) => void = () => {};
      const resolveUri = vi.fn(
        () => new Promise<string>((resolve) => { releaseResolve = resolve; }),
      );
      const app = express();
      mountPairing(app, { resolveUri });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      const p1 = fetch(`${base}${path}`);
      const p2 = fetch(`${base}${path}`);
      // give both requests a chance to reach the handler before resolving
      await new Promise((r) => setTimeout(r, 20));
      releaseResolve(URI);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(resolveUri).toHaveBeenCalledTimes(1);
    });

    it("returns 410 once the token has expired", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const app = express();
      mountPairing(app, { resolveUri: vi.fn().mockResolvedValue(URI) });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      time += 5 * 60 * 1000;
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(410);
    });

    it("returns 410 for a token consumeForUser has marked used", async () => {
      const { createPairingLink, consumeForUser, mountPairing } = createPairingModule(now);
      const app = express();
      mountPairing(app, { resolveUri: vi.fn().mockResolvedValue(URI) });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;
      consumeForUser("alice");

      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(410);
    });

    it("renders a clean 500 without leaking the underlying error when resolveUri throws", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const resolveUri = vi.fn().mockRejectedValue(new Error("relay socket exploded: secret=abc123"));
      const app = express();
      mountPairing(app, { resolveUri });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("relay socket exploded");
      expect(body).not.toContain("secret=abc123");
      expect(body).toContain("Could not generate");
    });

    it("renders a clean 500 without leaking the underlying error when QR encoding throws", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const resolveUri = vi.fn().mockResolvedValue(URI);
      vi.mocked(QRCode.toString).mockRejectedValueOnce(new Error("data too big for QR code"));
      const app = express();
      mountPairing(app, { resolveUri });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("data too big for QR code");
      expect(body).toContain("Could not generate");
    });

    it("lets a later GET retry after a failed resolveUri call", async () => {
      const { createPairingLink, mountPairing } = createPairingModule(now);
      const resolveUri = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(URI);
      const app = express();
      mountPairing(app, { resolveUri });
      ({ server, base } = await listen(app));

      const { url } = createPairingLink("alice", base);
      const path = new URL(url).pathname;

      const failed = await fetch(`${base}${path}`);
      expect(failed.status).toBe(500);

      const retried = await fetch(`${base}${path}`);
      expect(retried.status).toBe(200);
      expect(resolveUri).toHaveBeenCalledTimes(2);
    });
  });
});
