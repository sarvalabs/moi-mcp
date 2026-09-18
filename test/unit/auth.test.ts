import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Base64Url } from "../../src/auth/crypto.js";
import { mountAuth } from "../../src/auth/index.js";

/** Mount on a real listening server so requests exercise HTTP end to end. */
async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** RFC 7636 requires 43-128 chars from the unreserved set — this easily qualifies. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = `test-verifier-${"a".repeat(50)}`;
  return { verifier, challenge: sha256Base64Url(verifier) };
}

function extractCookie(setCookieHeader: string | null): string {
  const match = setCookieHeader ? /moi_uid=([^;]+)/.exec(setCookieHeader) : null;
  if (!match) throw new Error(`expected a moi_uid cookie, got: ${setCookieHeader}`);
  return `moi_uid=${match[1]}`;
}

interface RegisteredClient {
  client_id: string;
  client_name: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

describe("auth", () => {
  let dataDir: string;
  let server: Server;
  let base: string;
  let auth: ReturnType<typeof mountAuth>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "moi-mcp-auth-test-"));
    const app = express();
    ({ server, base } = await listen(app));
    auth = mountAuth(app, { publicUrl: base, dataDir });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function register(redirectUri: string): Promise<RegisteredClient> {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test Client" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as RegisteredClient;
  }

  /** GET /authorize -> consent screen; returns the identity cookie the server issued. */
  async function getConsentScreen(params: URLSearchParams, cookie?: string): Promise<Response> {
    return fetch(`${base}/authorize?${params.toString()}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
  }

  /** POST the approve decision; returns the 302 response carrying ?code=...&state=... */
  async function approve(params: URLSearchParams, cookie: string): Promise<Response> {
    return fetch(`${base}/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...Object.fromEntries(params), decision: "approve" }),
    });
  }

  /** Full register -> consent -> approve flow. Returns the code and the client used. */
  async function authorizeFlow(redirectUri = `${base}/cb`): Promise<{
    code: string;
    client: RegisteredClient;
    verifier: string;
    redirectUri: string;
  }> {
    const client = await register(redirectUri);
    const { verifier, challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "moi:read moi:write",
      state: "xyz",
    });

    const consentRes = await getConsentScreen(params);
    expect(consentRes.status).toBe(200);
    const cookie = extractCookie(consentRes.headers.get("set-cookie"));

    const decisionRes = await approve(params, cookie);
    expect(decisionRes.status).toBe(302);
    const location = new URL(decisionRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    if (!code) throw new Error(`expected a code in redirect: ${location.toString()}`);

    return { code, client, verifier, redirectUri };
  }

  async function exchangeCode(opts: {
    code: string;
    client: RegisteredClient;
    verifier: string;
    redirectUri: string;
  }): Promise<Response> {
    return fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: opts.redirectUri,
        client_id: opts.client.client_id,
        code_verifier: opts.verifier,
      }),
    });
  }

  it("runs the full happy path: register -> authorize with cookie -> code -> PKCE token -> authenticate", async () => {
    const flow = await authorizeFlow();

    const tokenRes = await exchangeCode(flow);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as TokenResponse;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("moi:read moi:write");
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const info = auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(info).toBeDefined();
    expect(info?.clientId).toBe(flow.client.client_id);
    expect(info?.scopes).toEqual(["moi:read", "moi:write"]);
    expect(typeof info?.userId).toBe("string");
    expect(info?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Bogus and missing tokens are both rejected.
    expect(auth.authenticate({ headers: { authorization: "Bearer not-a-real-token" } })).toBeUndefined();
    expect(auth.authenticate({ headers: {} })).toBeUndefined();
  });

  it("supports refresh_token rotation: the old refresh token stops working after use", async () => {
    const flow = await authorizeFlow();
    const first = (await (await exchangeCode(flow)).json()) as TokenResponse;

    const refreshRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: flow.client.client_id,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const rotated = (await refreshRes.json()) as TokenResponse;
    expect(rotated.access_token).not.toBe(first.access_token);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);

    const reuseRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: flow.client.client_id,
      }),
    });
    expect(reuseRes.status).toBe(400);
  });

  it("rejects a token exchange with the wrong code_verifier", async () => {
    const flow = await authorizeFlow();
    const res = await exchangeCode({ ...flow, verifier: "wrong-verifier-that-does-not-match-the-challenge" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects a reused authorization code", async () => {
    const flow = await authorizeFlow();
    const first = await exchangeCode(flow);
    expect(first.status).toBe(200);

    const second = await exchangeCode(flow);
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    const client = await register(`${base}/cb`);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://attacker.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const res = await getConsentScreen(params);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body.toLowerCase()).toContain("redirect");
  });

  it("rejects plain PKCE (and a missing code_challenge_method) without showing consent", async () => {
    const redirectUri = `${base}/cb`;
    const client = await register(redirectUri);
    const { verifier } = pkcePair();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: verifier,
      code_challenge_method: "plain",
      state: "s1",
    });
    const res = await getConsentScreen(params);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("error")).toBe("invalid_request");

    params.delete("code_challenge_method");
    const res2 = await getConsentScreen(params);
    expect(res2.status).toBe(302);
    expect(new URL(res2.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses a tampered scope at the decision, the same way /authorize does", async () => {
    const client = await register(`${base}/cb`);
    const { challenge } = pkcePair();
    const decide = (scope: string) =>
      fetch(`${base}/authorize/decision`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: `${base}/cb`,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope,
          state: "s",
          decision: "approve",
        }),
      });

    for (const scope of ["moi:read moi:admin", ""]) {
      const res = await decide(scope);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("code")).toBeNull();
    }

    // A legitimate narrowing still mints a code.
    const ok = await decide("moi:read");
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("rejects an expired access token", async () => {
    const flow = await authorizeFlow();
    const tokens = (await (await exchangeCode(flow)).json()) as TokenResponse;
    expect(auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } })).toBeDefined();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (tokens.expires_in + 1) * 1000);

    expect(auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } })).toBeUndefined();
  });

  it("treats a forged cookie signature as no identity and mints a fresh one", async () => {
    const client = await register(`${base}/cb`);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: `${base}/cb`,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const forged = "moi_uid=deadbeefdeadbeefdeadbeefdeadbeef.not-a-real-signature";
    const res = await getConsentScreen(params, forged);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const issued = extractCookie(setCookie);
    // A fresh signed cookie was minted rather than trusting the forged uid.
    expect(issued).not.toBe(forged);
    expect(issued).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("exposes RFC 8414 and RFC 9728 metadata", async () => {
    const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const asMeta = await asRes.json();
    expect(asMeta).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ["moi:read", "moi:write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });

    const rsRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const rsMeta = await rsRes.json();
    expect(rsMeta).toMatchObject({
      resource: base,
      authorization_servers: [base],
      scopes_supported: ["moi:read", "moi:write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("builds challengeHeader() exactly as WWW-Authenticate expects", () => {
    expect(auth.challengeHeader()).toBe(
      `Bearer error="invalid_token", error_description="Authorization required", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
  });

  it("includes client_secret_expires_at (RFC 7591 §3.2.1) whenever client_secret_post issues a secret", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [`${base}/cb`],
        client_name: "Confidential Test Client",
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_secret?: string; client_secret_expires_at?: number };
    expect(typeof body.client_secret).toBe("string");
    // 0 = never expires, per RFC 7591 — matches ClientStore, which never checks a TTL.
    expect(body.client_secret_expires_at).toBe(0);
  });

  it("omits client_secret_expires_at for a public (token_endpoint_auth_method=none) client", async () => {
    const registered = await register(`${base}/cb`);
    expect("client_secret" in registered).toBe(false);
    expect("client_secret_expires_at" in registered).toBe(false);
  });

  it("builds challengeHeader({error, scope}) for an insufficient_scope challenge", () => {
    expect(auth.challengeHeader({ error: "insufficient_scope", scope: "moi:write" })).toBe(
      `Bearer error="insufficient_scope", error_description="This action requires additional scope", ` +
        `resource_metadata="${base}/.well-known/oauth-protected-resource", scope="moi:write"`,
    );
  });

  it("rejects a registration whose redirect_uri is neither https nor loopback http", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(res.status).toBe(400);
  });
});
