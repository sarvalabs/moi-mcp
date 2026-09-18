/**
 * Express routes: RFC 8414 + RFC 9728 metadata, RFC 7591 dynamic client
 * registration, the /authorize consent flow (RFC 9700 PKCE-required), and
 * /token. No dependency beyond express (its bundled json/urlencoded body
 * parsers) and node:crypto/node:fs (via crypto.ts and store.ts).
 */

import type { Express, Request, Response } from "express";
import express from "express";

import { newUid, randomToken, safeEqual, sha256Base64Url, sha256Hex, signUid, verifySignedUid } from "./crypto.js";
import { renderConsentPage, renderErrorPage } from "./pages.js";
import { rateLimit } from "./rate-limit.js";
import type { ClientStore, CodeStore, TokenStore } from "./store.js";
import type { StoredClientRecord } from "./types.js";
import { isAllowedRedirectUri, parseCookies } from "./util.js";

export const SCOPES_SUPPORTED = ["moi:read", "moi:write"];
const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // browsers cap Max-Age at ~400 days
const COOKIE_NAME = "moi_uid";

export interface RouteDeps {
  publicUrl: string;
  clientStore: ClientStore;
  tokenStore: TokenStore;
  codeStore: CodeStore;
  cookieSecret: Buffer;
  cookieSecure: boolean;
}

/** Read the signed identity cookie, or mint and set a fresh one. Shared by GET /authorize and the decision POST. */
function resolveIdentity(req: Request, res: Response, deps: RouteDeps): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = verifySignedUid(cookies[COOKIE_NAME], deps.cookieSecret);
  if (existing) return existing;

  const uid = newUid();
  res.cookie(COOKIE_NAME, signUid(uid, deps.cookieSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: deps.cookieSecure,
    maxAge: COOKIE_MAX_AGE_MS,
  });
  return uid;
}

function authenticateClient(client: StoredClientRecord, presentedSecret: string | undefined): boolean {
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (!presentedSecret || !client.clientSecretHash) return false;
  return safeEqual(sha256Hex(presentedSecret), client.clientSecretHash);
}

function issueTokenPair(deps: RouteDeps, clientId: string, userId: string, scopes: string[]) {
  const pairId = randomToken(8);
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const nowS = Math.floor(Date.now() / 1000);

  deps.tokenStore.save(sha256Hex(accessToken), {
    kind: "access",
    clientId,
    userId,
    scopes,
    expiresAt: nowS + ACCESS_TOKEN_TTL_S,
    pairId,
  });
  deps.tokenStore.save(sha256Hex(refreshToken), {
    kind: "refresh",
    clientId,
    userId,
    scopes,
    expiresAt: nowS + REFRESH_TOKEN_TTL_S,
    pairId,
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Metadata (RFC 8414, RFC 9728)
// ---------------------------------------------------------------------------

function mountMetadata(app: Express, deps: RouteDeps): void {
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: deps.publicUrl,
      authorization_endpoint: `${deps.publicUrl}/authorize`,
      token_endpoint: `${deps.publicUrl}/token`,
      registration_endpoint: `${deps.publicUrl}/register`,
      scopes_supported: SCOPES_SUPPORTED,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: deps.publicUrl,
      authorization_servers: [deps.publicUrl],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
    });
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

function mountRegister(app: Express, deps: RouteDeps): void {
  // Unauthenticated and writes a file per call: the cheapest thing to spam.
  const limiter = rateLimit({ windowMs: 60_000, max: 10 });
  app.post("/register", limiter, express.json(), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = body["redirect_uris"];

    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array of strings" });
      return;
    }
    for (const uri of redirectUris as string[]) {
      if (!isAllowedRedirectUri(uri)) {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `redirect_uri must be https, or http on localhost/127.0.0.1: ${uri}`,
        });
        return;
      }
    }

    const authMethod = body["token_endpoint_auth_method"];
    if (authMethod !== undefined && authMethod !== "none" && authMethod !== "client_secret_post") {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "unsupported token_endpoint_auth_method" });
      return;
    }
    const tokenEndpointAuthMethod: "none" | "client_secret_post" = authMethod === "client_secret_post" ? "client_secret_post" : "none";

    const clientName = typeof body["client_name"] === "string" ? (body["client_name"] as string) : "Unnamed client";
    const clientId = randomToken(16);

    let clientSecret: string | undefined;
    let clientSecretHash: string | undefined;
    if (tokenEndpointAuthMethod === "client_secret_post") {
      clientSecret = randomToken(32);
      clientSecretHash = sha256Hex(clientSecret);
    }

    const record: StoredClientRecord = {
      clientId,
      clientName,
      redirectUris: redirectUris as string[],
      tokenEndpointAuthMethod,
      clientSecretHash,
      createdAt: new Date().toISOString(),
    };
    deps.clientStore.save(record);

    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: record.redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPES_SUPPORTED.join(" "),
    };
    // RFC 7591 §3.2.1: REQUIRED whenever client_secret is present. ClientStore
    // never expires a secret (authenticateClient only compares the hash), so
    // 0 ("does not expire") is the value that actually matches the behavior.
    if (clientSecret) {
      response["client_secret"] = clientSecret;
      response["client_secret_expires_at"] = 0;
    }

    res.status(201).json(response);
  });
}

// ---------------------------------------------------------------------------
// /authorize (GET: consent screen) + /authorize/decision (POST: approve/deny)
// ---------------------------------------------------------------------------

function mountAuthorize(app: Express, deps: RouteDeps): void {
  app.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const clientId = q["client_id"];
    const redirectUri = q["redirect_uri"];

    if (!clientId || !redirectUri) {
      res.status(400).send(renderErrorPage("Invalid request", "client_id and redirect_uri are required."));
      return;
    }
    const client = deps.clientStore.get(clientId);
    if (!client) {
      res.status(400).send(renderErrorPage("Unknown client", "This application is not registered."));
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      // Never redirect to a redirect_uri we have not validated against the registration.
      res.status(400).send(renderErrorPage("Redirect URI mismatch", "redirect_uri does not match any URI registered for this client."));
      return;
    }

    // redirect_uri is trusted from here on, so remaining errors go back to the client.
    const redirectErr = (error: string, description: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (q["state"]) url.searchParams.set("state", q["state"]);
      res.redirect(302, url.toString());
    };

    if (q["response_type"] !== "code") {
      redirectErr("unsupported_response_type", "Only response_type=code is supported.");
      return;
    }
    const codeChallenge = q["code_challenge"];
    if (!codeChallenge || q["code_challenge_method"] !== "S256") {
      // RFC 9700: PKCE is required and "plain" is not accepted.
      redirectErr("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      return;
    }
    const requestedScopes = (q["scope"] ?? SCOPES_SUPPORTED.join(" ")).split(/\s+/).filter(Boolean);
    if (requestedScopes.length === 0 || !requestedScopes.every((s) => SCOPES_SUPPORTED.includes(s))) {
      redirectErr("invalid_scope", "Unknown scope requested.");
      return;
    }

    resolveIdentity(req, res, deps);

    const html = renderConsentPage({
      clientName: client.clientName,
      scopes: requestedScopes,
      redirectOrigin: new URL(redirectUri).origin,
      formAction: "/authorize/decision",
      hidden: {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: requestedScopes.join(" "),
        state: q["state"] ?? "",
      },
    });
    res.status(200).type("html").send(html);
  });

  const decisionLimiter = rateLimit({ windowMs: 60_000, max: 20 });
  app.post("/authorize/decision", decisionLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const clientId = body["client_id"];
    const redirectUri = body["redirect_uri"];
    const codeChallenge = body["code_challenge"];
    const state = body["state"] ?? "";

    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).send(renderErrorPage("Invalid request", "Missing required fields."));
      return;
    }
    const client = deps.clientStore.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) {
      // Re-validated defense-in-depth: never redirect on a client/redirect_uri we cannot trust.
      res.status(400).send(renderErrorPage("Invalid request", "Unknown client or redirect_uri."));
      return;
    }

    if (body["decision"] !== "approve") {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
      return;
    }

    const userId = resolveIdentity(req, res, deps);
    const scopes = (body["scope"] ?? "").split(/\s+/).filter(Boolean);
    // Same check /authorize already ran. The form echoes what that page was
    // given, but the POST is reachable directly, so an unchecked value here
    // would be the one path minting a grant with a scope nothing vetted.
    if (scopes.length === 0 || !scopes.every((s) => SCOPES_SUPPORTED.includes(s))) {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "invalid_scope");
      url.searchParams.set("error_description", "Unknown scope requested.");
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
      return;
    }
    const code = randomToken(32);
    deps.codeStore.create(code, { clientId, redirectUri, codeChallenge, userId, scopes });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------

function handleAuthorizationCodeGrant(res: Response, body: Record<string, string | undefined>, deps: RouteDeps): void {
  const code = body["code"];
  const redirectUri = body["redirect_uri"];
  const clientId = body["client_id"];
  const codeVerifier = body["code_verifier"];

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const client = deps.clientStore.get(clientId);
  if (!client) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }
  if (!authenticateClient(client, body["client_secret"])) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  const entry = deps.codeStore.consume(code);
  if (!entry) {
    res.status(400).json({ error: "invalid_grant", error_description: "code is invalid, expired, or already used" });
    return;
  }
  if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id or redirect_uri does not match the authorization request" });
    return;
  }
  if (sha256Base64Url(codeVerifier) !== entry.codeChallenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "code_verifier does not match code_challenge" });
    return;
  }

  res.status(200).json(issueTokenPair(deps, clientId, entry.userId, entry.scopes));
}

function handleRefreshTokenGrant(res: Response, body: Record<string, string | undefined>, deps: RouteDeps): void {
  const refreshToken = body["refresh_token"];
  const clientId = body["client_id"];

  if (!refreshToken || !clientId) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const client = deps.clientStore.get(clientId);
  if (!client) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }
  if (!authenticateClient(client, body["client_secret"])) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  const hash = sha256Hex(refreshToken);
  const record = deps.tokenStore.get(hash);
  const nowS = Math.floor(Date.now() / 1000);

  if (!record || record.kind !== "refresh") {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (record.expiresAt < nowS) {
    deps.tokenStore.delete(hash); // safe to garbage-collect regardless of who's asking
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (record.clientId !== clientId) {
    // Do not delete: a wrong client_id paired with someone else's valid token
    // should not become a way to invalidate that token.
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  let scopes = record.scopes;
  const requestedScope = body["scope"];
  if (requestedScope) {
    const narrowed = requestedScope.split(/\s+/).filter(Boolean);
    if (!narrowed.every((s) => record.scopes.includes(s))) {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }
    scopes = narrowed;
  }

  deps.tokenStore.delete(hash); // rotation: the presented refresh token is single-use
  res.status(200).json(issueTokenPair(deps, clientId, record.userId, scopes));
}

function mountToken(app: Express, deps: RouteDeps): void {
  const tokenLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  app.post("/token", tokenLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    switch (body["grant_type"]) {
      case "authorization_code":
        handleAuthorizationCodeGrant(res, body, deps);
        return;
      case "refresh_token":
        handleRefreshTokenGrant(res, body, deps);
        return;
      default:
        res.status(400).json({ error: "unsupported_grant_type" });
    }
  });
}

export function mountAuthRoutes(app: Express, deps: RouteDeps): void {
  mountMetadata(app, deps);
  mountRegister(app, deps);
  mountAuthorize(app, deps);
  mountToken(app, deps);
}
