/**
 * Per-client sliding-window rate limiting for the auth surface.
 *
 * /register is unauthenticated and writes a file per call; /token and the
 * consent decision are where a stolen code or cookie would be replayed. None
 * of them need more than a handful of requests a minute from one address.
 * Kept dependency-free: a Map of timestamps, swept as it goes.
 */

import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * The address a request came from, spoof-resistant.
 *
 * The sender writes the FRONT of X-Forwarded-For and can rotate it per
 * request, so keying on it turns the limiter off. Two cases are safe:
 * a connection from a remote address keys on the socket address and ignores
 * the header entirely, and a connection from this machine (the local nginx
 * or tunnel the runbook deploys) keys on the LAST header entry, the one
 * that local proxy appended and the sender cannot write.
 */
export function clientAddress(remote: string | undefined, fwd: string | string[] | undefined): string {
  const socket = (remote ?? "").trim() || "unknown";
  const local = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
  if (!local) return socket;
  const flat = Array.isArray(fwd) ? fwd.join(",") : (fwd ?? "");
  const parts = flat.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : socket;
}

function clientKey(req: Request): string {
  return clientAddress(req.socket.remoteAddress ?? undefined, req.headers["x-forwarded-for"]);
}

/** The counting half, usable from plain node:http as well as Express. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  allow(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const floor = t - this.opts.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > floor);
    if (recent.length >= this.opts.max) {
      const oldest = recent[0] ?? t;
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + this.opts.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    // Opportunistic sweep so an attacker rotating addresses cannot grow the
    // map without bound. Cheap enough to run on every request.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((ts) => ts <= floor)) this.hits.delete(k);
      }
    }
    return { ok: true };
  }
}

export function rateLimit(opts: RateLimitOptions) {
  const window = new SlidingWindow(opts);
  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const verdict = window.allow(clientKey(req));
    if (!verdict.ok) {
      res.setHeader("Retry-After", String(verdict.retryAfterS));
      res.status(429).json({ error: "rate_limited", error_description: "Too many requests. Try again shortly." });
      return;
    }
    next();
  };
}
