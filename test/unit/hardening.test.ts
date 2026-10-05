/**
 * The audit fixes, each pinned by a test that fails without it.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { rateLimit } from "../../src/auth/rate-limit.js";
import { securityHeaders } from "../../src/security-headers.js";
import { renderConsentPage } from "../../src/auth/pages.js";
import { TokenStore } from "../../src/auth/store.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function listen(app: express.Express): Promise<string> {
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("rate limiting on the auth surface", () => {
  it("refuses the request after the window's quota, then recovers", async () => {
    let t = 1_000_000;
    const app = express();
    app.post("/x", rateLimit({ windowMs: 60_000, max: 3, now: () => t }), (_req, res) => res.json({ ok: true }));
    const base = await listen(app);

    const hit = () => fetch(`${base}/x`, { method: "POST" });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);

    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // A minute later the window has slid past every earlier hit.
    t += 60_001;
    expect((await hit()).status).toBe(200);
  });

  it("counts clients separately, keyed on the proxy-appended address", async () => {
    const app = express();
    app.post("/x", rateLimit({ windowMs: 60_000, max: 1 }), (_req, res) => res.json({ ok: true }));
    const base = await listen(app);

    const as = (ip: string) => fetch(`${base}/x`, { method: "POST", headers: { "x-forwarded-for": ip } });
    expect((await as("10.0.0.1")).status).toBe(200);
    expect((await as("10.0.0.1")).status).toBe(429);
    expect((await as("10.0.0.2")).status).toBe(200);
    // The front of the header is client-written; rewriting it neither
    // dodges an exhausted bucket nor mints a fresh one.
    expect((await as("9.9.9.1, 10.0.0.1")).status).toBe(429);
    expect((await as("9.9.9.2, 10.0.0.2")).status).toBe(429);
  });
});

describe("security headers", () => {
  it("forbids framing and sniffing on every response", async () => {
    const app = express();
    app.use(securityHeaders("http://localhost"));
    app.get("/p", (_req, res) => res.type("html").send("<html></html>"));
    const base = await listen(app);

    const res = await fetch(`${base}/p`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // Not https, so no HSTS: sending it over plain http would be a lie the
    // browser remembers for a year.
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("adds HSTS only when the public origin is https", async () => {
    const app = express();
    app.use(securityHeaders("https://mcp.example.test"));
    app.get("/p", (_req, res) => res.send("ok"));
    const base = await listen(app);
    expect((await fetch(`${base}/p`)).headers.get("strict-transport-security")).toContain("max-age=");
  });
});

describe("the consent page tells the user where a grant goes and what it allows", () => {
  const html = renderConsentPage({
    clientName: "Some App",
    scopes: ["moi:read", "moi:write"],
    redirectOrigin: "https://claude.ai",
    formAction: "/authorize/decision",
    hidden: {},
  });

  it("names the redirect destination so a phishing clone is distinguishable", () => {
    expect(html).toContain("https://claude.ai");
  });

  it("explains scopes in words rather than showing bare codes", () => {
    expect(html).toMatch(/propose transactions/i);
    expect(html).toMatch(/approve on your phone/i);
    expect(html).not.toMatch(/<code>moi:write<\/code>/);
  });

  it("says there is no account, so a missing login reads as designed rather than broken", () => {
    expect(html).toMatch(/no account to sign in to/i);
    expect(html).toMatch(/wallet is your identity/i);
  });

  it("escapes a hostile client name", () => {
    const evil = renderConsentPage({
      clientName: "<script>alert(1)</script>",
      scopes: ["moi:read"],
      redirectOrigin: "https://x.test",
      formAction: "/authorize/decision",
      hidden: {},
    });
    expect(evil).not.toContain("<script>alert");
  });
});

describe("expired tokens are swept from disk", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("removes what has expired and keeps what has not", () => {
    const dir = mkdtempSync(join(tmpdir(), "moi-tokens-"));
    dirs.push(dir);
    const store = new TokenStore(dir);
    const now = 1_700_000_000;

    store.save("a".repeat(64), { clientId: "c", userId: "u", scopes: ["moi:read"], kind: "access", expiresAt: now - 1 } as never);
    store.save("b".repeat(64), { clientId: "c", userId: "u", scopes: ["moi:read"], kind: "access", expiresAt: now + 100 } as never);
    // Junk that is not ours must not break the sweep.
    writeFileSync(join(dir, "auth", "tokens", "garbage.json"), "{not json");

    const removed = store.sweepExpired(now);

    expect(removed).toBe(1);
    expect(existsSync(join(dir, "auth", "tokens", "a".repeat(64) + ".json"))).toBe(false);
    expect(existsSync(join(dir, "auth", "tokens", "b".repeat(64) + ".json"))).toBe(true);
  });
});
