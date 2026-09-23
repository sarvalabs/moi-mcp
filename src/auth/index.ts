/**
 * OAuth 2.1 authorization server + resource-server verification for the
 * hosted MCP endpoint, built for what claude.ai's custom-connector flow
 * requires: RFC 8414 + RFC 9728 metadata, RFC 7591 dynamic client
 * registration, PKCE-required authorization codes (RFC 9700), and bearer
 * token verification.
 *
 * Hand-rolled rather than built on the SDK's server/auth/* helpers: their
 * OAuthServerProvider abstraction assumes redirect-based authorize() with no
 * room for the cookie-identified consent screen this spec requires, and its
 * AuthInfo shape ({token, clientId, scopes, expiresAt?, resource?}) doesn't
 * match the {userId, clientId, scopes, expiresAt} contract other modules in
 * this repo compile against. Reimplementing the provider to bridge that gap
 * would be more code than routing Express directly. The dependency budget
 * here (express + node:crypto/node:fs only) rules out importing them anyway.
 */

import type { Express } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { loadOrCreateCookieSecret, sha256Hex } from "./crypto.js";
import { mountAuthRoutes } from "./routes.js";
import { ClientStore, CodeStore, TokenStore } from "./store.js";
import type { AuthInfo } from "./types.js";

export type { AuthInfo } from "./types.js";

export interface MountAuthOptions {
  publicUrl: string;
  dataDir: string;
  /**
   * Path of the MCP endpoint under publicUrl, "/mcp" by default. The
   * protected-resource metadata's `resource` must be the URL a person types
   * into claude.ai, path included, and the metadata is also served at the
   * path-suffixed well-known location (RFC 9728 §3.1).
   */
  mcpPath?: string;
}

export interface AuthHandle {
  authenticate(req: { headers: IncomingHttpHeaders }): AuthInfo | undefined;
  /**
   * Default (no args): a token is missing/invalid — `error="invalid_token"`.
   * Pass `{ error: "insufficient_scope", scope }` when a token was presented
   * and verified but does not cover the tool being called (RFC 6750 §3.1).
   */
  challengeHeader(opts?: { error?: string; scope?: string }): string;
}

export function mountAuth(app: Express, opts: MountAuthOptions): AuthHandle {
  const publicUrl = opts.publicUrl.replace(/\/+$/, "");
  const mcpPath = opts.mcpPath ?? "/mcp";
  const cookieSecret = loadOrCreateCookieSecret(join(opts.dataDir, "auth", "cookie-secret"));
  const clientStore = new ClientStore(opts.dataDir);
  const tokenStore = new TokenStore(opts.dataDir);
  // Expired tokens are deleted lazily on presentation; sweep the rest so an
  // abandoned sign-in does not leave a file behind for good.
  const sweep = setInterval(() => {
    try {
      tokenStore.sweepExpired();
    } catch {
      // A failed sweep is not worth surfacing; the next one will try again.
    }
  }, 15 * 60_000);
  sweep.unref();
  const codeStore = new CodeStore();
  const cookieSecure = publicUrl.startsWith("https://");

  mountAuthRoutes(app, { publicUrl, mcpPath, clientStore, tokenStore, codeStore, cookieSecret, cookieSecure });

  function authenticate(req: { headers: IncomingHttpHeaders }): AuthInfo | undefined {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith("Bearer ")) return undefined;
    const token = value.slice("Bearer ".length).trim();
    if (!token) return undefined;

    const hash = sha256Hex(token);
    const record = tokenStore.get(hash);
    if (!record || record.kind !== "access") return undefined;
    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      tokenStore.delete(hash);
      return undefined;
    }
    return { userId: record.userId, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt };
  }

  function challengeHeader(opts?: { error?: string; scope?: string }): string {
    const error = opts?.error ?? "invalid_token";
    const description = error === "insufficient_scope" ? "This action requires additional scope" : "Authorization required";
    const scopePart = opts?.scope ? `, scope="${opts.scope}"` : "";
    // The path-suffixed document, which is the one RFC 9728 names for a
    // resource that has a path, and the one Anthropic's reference server points at.
    return `Bearer error="${error}", error_description="${description}", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource${mcpPath}"${scopePart}`;
  }

  return { authenticate, challengeHeader };
}
