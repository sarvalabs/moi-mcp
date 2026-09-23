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
  /** Path of the MCP endpoint under publicUrl, e.g. "/mcp". */
  mcpPath: string;
  clientStore: ClientStore;
  tokenStore: TokenStore;
  codeStore: CodeStore;
  cookieSecret: Buffer;
  cookieSecure: boolean;
  /** See MountAuthOptions.pairedWallet. Absent means the consent page never mentions pairings. */
  pairedWallet?: (userId: string) => Promise<{ address: string } | undefined>;
}

/** Read the signed identity cookie, or mint and set a fresh one. Shared by GET /authorize and the decision POST. */
function resolveIdentity(req: Request, res: Response, deps: RouteDeps): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = verifySignedUid(cookies[COOKIE_NAME], deps.cookieSecret);
  if (existing) return existing;
  return mintIdentity(res, deps);
}

/**
 * Mint a new identity and make this browser carry it from now on. Used for a
 * browser with no cookie, and for a person who says on the consent page that
 * the wallet already paired to this browser is not theirs.
 */
function mintIdentity(res: Response, deps: RouteDeps): string {
  const uid = newUid();
  res.cookie(COOKIE_NAME, signUid(uid, deps.cookieSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: deps.cookieSecure,
    maxAge: COOKIE_MAX_AGE_MS,
  });
  return uid;
}

/** How long the consent page waits for the wallet store before showing no notice. */
const PAIRED_LOOKUP_TIMEOUT_MS = 750;

/**
 * The wallet paired to this identity, for the consent page to show. Neither a
 * failure nor a stall may block sign-in: this route did no I/O before the
 * notice existed, and a wallet store that stops answering (a Redis blip is
 * enough) must not turn every sign-in into a hung request. Both read as
 * "no pairing" and the page simply omits the notice.
 */
async function pairedWalletFor(deps: RouteDeps, userId: string): Promise<{ address: string } | undefined> {
  if (!deps.pairedWallet) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps.pairedWallet(userId),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PAIRED_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Which identity a consent page was rendered for, carried in the form as a
 * hash so the page cannot be used to approve as someone else. The browser has
 * one cookie: if a second person replaced it ("I am someone else") while the
 * first person's tab was still open, the first person's later Approve would
 * otherwise mint a grant for the second person's identity.
 */
function identityTag(userId: string): string {
  return sha256Hex(userId);
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

  // `resource` is the MCP endpoint itself, path included. claude.ai compares
  // it against the URL the person entered for the connector, and that URL
  // ends in /mcp; a bare origin here does not match. Served at both the root
  // location and the path-suffixed one (RFC 9728 §3.1), because clients try
  // the suffixed form first when the resource has a path.
  const protectedResource = (_req: Request, res: Response): void => {
    res.json({
      resource: `${deps.publicUrl}${deps.mcpPath}`,
      authorization_servers: [deps.publicUrl],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get(`/.well-known/oauth-protected-resource${deps.mcpPath}`, protectedResource);
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

function mountRegister(app: Express, deps: RouteDeps): void {
  // Unauthenticated and writes a file per call: the cheapest thing to spam,
  // so it is limited per client address. The limit has to allow for how
  // claude.ai behaves, though: it registers a fresh client on every new
  // connection, and every claude.ai user arrives from Anthropic's shared
  // egress range (160.79.104.0/21), so one address stands for many people.
  // 10 a minute was enough to lock the whole of claude.ai out after a
  // handful of Connect clicks. 120 still bounds the disk cost of a spammer.
  const limiter = rateLimit({ windowMs: 60_000, max: 120 });
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
    void handleAuthorize(req, res, deps).catch(() => {
      if (!res.headersSent) res.status(500).send(renderErrorPage("Something went wrong", "Try again."));
    });
  });

  async function handleAuthorize(req: Request, res: Response, deps: RouteDeps): Promise<void> {
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

    const userId = resolveIdentity(req, res, deps);
    const paired = await pairedWalletFor(deps, userId);

    const html = renderConsentPage({
      clientName: client.clientName,
      scopes: requestedScopes,
      redirectOrigin: new URL(redirectUri).origin,
      formAction: "/authorize/decision",
      ...(paired ? { pairedAddress: paired.address } : {}),
      hidden: {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: requestedScopes.join(" "),
        state: q["state"] ?? "",
        shown_for: identityTag(userId),
      },
    });
    res.status(200).type("html").send(html);
  }

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

    // "approve" keeps whatever identity this browser carries. "approve_fresh"
    // is the person saying the wallet paired to this browser is not theirs:
    // they get a new identity, the browser's cookie is replaced, and the
    // previous person's pairing stays untouched under the old one. Anything
    // else is a denial.
    const decision = body["decision"];
    if (decision !== "approve" && decision !== "approve_fresh") {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
      return;
    }

    const userId = decision === "approve_fresh" ? mintIdentity(res, deps) : resolveIdentity(req, res, deps);
    // A page rendered for one identity may only approve as that identity.
    // If the cookie changed underneath an open tab, send the person back
    // through /authorize so they see who this browser is now, then decide.
    const shownFor = body["shown_for"];
    if (decision === "approve" && shownFor && shownFor !== identityTag(userId)) {
      const again = new URL("/authorize", "http://placeholder");
      for (const key of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state"]) {
        const value = body[key];
        if (value) again.searchParams.set(key, value);
      }
      again.searchParams.set("response_type", "code");
      res.redirect(302, again.pathname + again.search);
      return;
    }
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
