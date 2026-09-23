/**
 * One-time download links for an agent's setup script.
 *
 * The Launchpad's setup script embeds the agent's private key in plain text.
 * A tool result lands in the chat transcript, so the script must never be a
 * tool result. Instead a tool hands out a link to this page; opening it
 * fetches the script from the Launchpad with the person's own session, at
 * that moment, and serves it once. Modelled on the pairing page
 * (src/pairing/index.ts): random tokens, a short TTL, no caching, and a
 * record that is spent the instant it is used.
 */

import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { rateLimit } from "../auth/rate-limit.js";

const TTL_MS = 10 * 60 * 1000;

interface DownloadRecord {
  userId: string;
  agentId: string;
  createdAt: number;
  used: boolean;
}

export interface DownloadModule {
  createDownloadLink(userId: string, agentId: string, publicUrl: string): { url: string; expiresAt: number };
  mountDownloads(
    app: Express,
    opts: { fetchScript: (userId: string, agentId: string) => Promise<{ filename: string; body: string }> },
  ): void;
}

type DownloadRequest = Request<{ token: string }>;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;background:#fff;line-height:1.5">
<img src="/logo.svg" alt="MOI" width="52" height="40" style="display:block;margin-bottom:1.25rem">
<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
</body></html>`;
}

export function createDownloadModule(now: () => number = Date.now): DownloadModule {
  const tokens = new Map<string, DownloadRecord>();

  function isLive(rec: DownloadRecord): boolean {
    return !rec.used && now() - rec.createdAt < TTL_MS;
  }

  function sweep(): void {
    for (const [token, rec] of tokens) {
      if (rec.used || now() - rec.createdAt >= TTL_MS) tokens.delete(token);
    }
  }

  function createDownloadLink(userId: string, agentId: string, publicUrl: string): { url: string; expiresAt: number } {
    sweep();
    const token = randomBytes(32).toString("base64url");
    const record: DownloadRecord = { userId, agentId, createdAt: now(), used: false };
    tokens.set(token, record);
    return {
      url: `${publicUrl.replace(/\/+$/, "")}/launchpad/download/${token}`,
      expiresAt: Math.floor((record.createdAt + TTL_MS) / 1000),
    };
  }

  function mountDownloads(
    app: Express,
    opts: { fetchScript: (userId: string, agentId: string) => Promise<{ filename: string; body: string }> },
  ): void {
    // The token has 256 bits of entropy, so this is not about guessing; it
    // keeps a misbehaving client from turning the Launchpad into a load test.
    const limiter = rateLimit({ windowMs: 60_000, max: 20 });
    app.get("/launchpad/download/:token", limiter, (req: DownloadRequest, res: Response) => {
      void handle(req, res, opts.fetchScript);
    });
  }

  async function handle(
    req: DownloadRequest,
    res: Response,
    fetchScript: (userId: string, agentId: string) => Promise<{ filename: string; body: string }>,
  ): Promise<void> {
    res.set("Cache-Control", "no-store");
    const rec = tokens.get(req.params.token);
    if (!rec || !isLive(rec)) {
      res
        .status(410)
        .type("html")
        .send(page("This link has been used or has expired", "Ask Claude for a fresh download link; each one works once and for ten minutes."));
      return;
    }
    // Spend the token before the fetch so two concurrent opens cannot both
    // receive the key. If the fetch fails, the token is handed back so the
    // person can simply reload rather than ask for a new link.
    rec.used = true;
    let script: { filename: string; body: string };
    try {
      script = await fetchScript(rec.userId, rec.agentId);
    } catch {
      rec.used = false;
      res
        .status(502)
        .type("html")
        .send(page("Could not fetch the setup script", "The Launchpad did not hand it over. Reload to try again, or sign in to the Launchpad again from the chat."));
      return;
    }
    tokens.delete(req.params.token);
    const safeName = script.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "setup.sh";
    res
      .status(200)
      .set("Content-Type", "text/x-shellscript; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${safeName}"`)
      .set("X-Content-Type-Options", "nosniff")
      .send(script.body);
  }

  return { createDownloadLink, mountDownloads };
}
