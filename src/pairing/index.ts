/**
 * One-time QR pairing link + page.
 *
 * `moi_connect_wallet` cannot hand the agent a raw `wc:` URI: the URI embeds
 * a live symmetric relay key, and anything the model sees becomes part of a
 * transcript that outlives the 5-minute pairing window. So it hands out an
 * HTTPS link instead, and this module is the only place the URI is ever
 * resolved and rendered — never logged, never written to disk.
 */

import { randomBytes } from "node:crypto";
import express, { Express, Request, Response } from "express";
import QRCode from "qrcode";

import { DEFAULT_MODE, isPairingMode, type PairingMode } from "../wc/lifetime.js";

/** Matches the WalletConnect proposal's own lifetime. */
const TTL_MS = 5 * 60 * 1000;

interface PairingRecord {
  userId: string;
  /** Lifetime the user picked on the page. Read when the phone's approval lands. */
  mode: PairingMode;
  createdAt: number; // ms, per the injected clock
  uri?: string; // resolved once, then cached — see mountPairing
  resolving?: Promise<string>; // in-flight resolveUri call; see mountPairing
  used: boolean;
}

/**
 * What the chat tool already knows when it hands out a link: the lifetime the
 * person asked for, and the wc: URI of the proposal it just started, so the
 * page shows the same code the chat did instead of starting a second one.
 */
export interface PairingSeed {
  mode?: PairingMode;
  uri?: string;
}

export interface PairingModule {
  createPairingLink(userId: string, publicUrl: string, seed?: PairingSeed): { url: string; expiresAt: number };
  consumeForUser(userId: string): void;
  /** The lifetime chosen on the user's live pairing page, or the default. */
  modeForUser(userId: string): PairingMode;
  mountPairing(app: Express, opts: { resolveUri: (userId: string) => Promise<string> }): void;
}

// Named so req.params.token is `string`, not ParamsDictionary's default
// `string | string[]` (which exists for wildcard routes we don't use here).
type PairRequest = Request<{ token: string }>;

/**
 * Build an isolated pairing module. Production uses the singleton exported
 * below; tests build their own instance with an injected `now()` so TTL
 * expiry is deterministic instead of racing the real clock.
 */
export function createPairingModule(now: () => number = Date.now): PairingModule {
  // token -> record, plus a userId -> token index so the idempotency check
  // in createPairingLink doesn't scan every outstanding token.
  const tokens = new Map<string, PairingRecord>();
  const byUser = new Map<string, string>();

  function isLive(rec: PairingRecord): boolean {
    return !rec.used && now() - rec.createdAt < TTL_MS;
  }

  function expirySeconds(rec: PairingRecord): number {
    return Math.floor((rec.createdAt + TTL_MS) / 1000);
  }

  function linkUrl(publicUrl: string, token: string): string {
    return `${publicUrl.replace(/\/+$/, "")}/pair/${token}`;
  }

  /** Drop expired entries so a long-running process doesn't grow this map forever. */
  function sweep(): void {
    for (const [token, rec] of tokens) {
      if (now() - rec.createdAt >= TTL_MS) {
        tokens.delete(token);
        if (byUser.get(rec.userId) === token) byUser.delete(rec.userId);
      }
    }
  }

  function createPairingLink(userId: string, publicUrl: string, seed?: PairingSeed): { url: string; expiresAt: number } {
    sweep();

    const existingToken = byUser.get(userId);
    const existing = existingToken ? tokens.get(existingToken) : undefined;
    if (existing && isLive(existing)) {
      applySeed(existing, seed);
      return { url: linkUrl(publicUrl, existingToken as string), expiresAt: expirySeconds(existing) };
    }

    const token = randomBytes(32).toString("base64url");
    const record: PairingRecord = { userId, mode: DEFAULT_MODE, createdAt: now(), used: false };
    applySeed(record, seed);
    tokens.set(token, record);
    byUser.set(userId, token);
    return { url: linkUrl(publicUrl, token), expiresAt: expirySeconds(record) };
  }

  /**
   * A mode from the chat is the newest word on the lifetime, so it wins. A
   * URI only fills an empty slot: once the page has resolved (or is resolving)
   * its own proposal, that one stays, and the chat's proposal simply expires
   * unused.
   */
  function applySeed(rec: PairingRecord, seed?: PairingSeed): void {
    if (!seed) return;
    if (seed.mode) rec.mode = seed.mode;
    if (seed.uri && rec.uri === undefined && rec.resolving === undefined) rec.uri = seed.uri;
  }

  function consumeForUser(userId: string): void {
    const token = byUser.get(userId);
    const rec = token ? tokens.get(token) : undefined;
    if (rec) rec.used = true;
  }

  function modeForUser(userId: string): PairingMode {
    const token = byUser.get(userId);
    const rec = token ? tokens.get(token) : undefined;
    return rec ? rec.mode : DEFAULT_MODE;
  }

  /**
   * The page posts the user's choice here before they scan. Only a live,
   * unused token can be changed, and only to a known mode; anything else is
   * ignored with a 4xx rather than reasoned about.
   */
  function handleSetMode(req: PairRequest, res: Response): void {
    const rec = tokens.get(req.params.token);
    if (!rec || !isLive(rec)) {
      res.status(410).json({ error: "link expired" });
      return;
    }
    const body = req.body as { mode?: unknown } | undefined;
    const mode = body?.mode;
    if (!isPairingMode(mode)) {
      res.status(400).json({ error: "mode must be persistent or once" });
      return;
    }
    rec.mode = mode;
    res.status(200).json({ mode });
  }

  async function handleGet(
    req: PairRequest,
    res: Response,
    resolveUri: (userId: string) => Promise<string>,
  ): Promise<void> {
    const token = req.params.token;
    // The page can carry a live wc: URI once resolved — an intermediary or
    // browser cache holding that would be as bad as logging it.
    res.set("Cache-Control", "no-store");

    const rec = tokens.get(token);
    if (!rec || !isLive(rec)) {
      res.status(410).type("html").send(goneHtml());
      return;
    }

    let uri = rec.uri;
    if (uri === undefined) {
      // Cache the in-flight promise, not just the eventual result: two GETs
      // of the same token arriving before the first resolveUri() settles
      // must share one resolution, or a page refresh mid-load would burn a
      // second WalletConnect pairing for the same link.
      rec.resolving ??= resolveUri(rec.userId).catch((err: unknown) => {
        rec.resolving = undefined; // let a later GET retry instead of wedging on one failure
        throw err;
      });
      try {
        uri = await rec.resolving;
      } catch {
        // Never surface the error's message/stack here — it can carry relay
        // or wallet internals. The caller supplying resolveUri is where any
        // server-side logging of the failure belongs.
        res.status(500).type("html").send(errorHtml());
        return;
      }
      rec.uri = uri;
    }

    let svg: string;
    try {
      svg = await QRCode.toString(uri, { type: "svg", margin: 1, width: 240 });
    } catch {
      // Same rule as the resolveUri failure above: never surface the raw
      // error here either.
      res.status(500).type("html").send(errorHtml());
      return;
    }
    res.status(200).type("html").send(pairingHtml(uri, svg, expirySeconds(rec), rec.mode));
  }

  function mountPairing(app: Express, opts: { resolveUri: (userId: string) => Promise<string> }): void {
    app.get("/pair/:token", (req: PairRequest, res: Response) => {
      void handleGet(req, res, opts.resolveUri);
    });
    app.post("/pair/:token/mode", express.json({ limit: "1kb" }), handleSetMode);
  }

  return { createPairingLink, consumeForUser, modeForUser, mountPairing };
}

const shared = createPairingModule();

export const createPairingLink = shared.createPairingLink;
export const consumeForUser = shared.consumeForUser;
export const modeForUser = shared.modeForUser;
export const mountPairing = shared.mountPairing;

// ---------------------------------------------------------------------------
// Rendering. Inline CSS/JS only, no external resources — this page is the
// one place a live pairing secret is ever displayed.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0b0d12;
    color: #e7e9ee;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
    box-sizing: border-box;
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: #14171f;
    border: 1px solid #262b38;
    border-radius: 16px;
    padding: 28px 24px;
    text-align: center;
    box-sizing: border-box;
  }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #9aa1b1; font-size: 13px; }
  .qr { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; }
  .qr svg { display: block; width: 220px; height: 220px; }
  .steps { text-align: left; margin: 20px 0 0; padding-left: 20px; color: #c3c8d4; font-size: 13px; }
  .uri-row { display: flex; gap: 8px; margin-top: 20px; }
  .mode { text-align: left; margin: 20px 0 0; padding: 12px 14px; border: 1px solid #2a2f3b; border-radius: 10px; }
  .mode legend { padding: 0 6px; color: #c3c8d4; font-size: 13px; }
  .mode label { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; color: #c3c8d4; font-size: 13px; cursor: pointer; }
  .mode input { margin-top: 3px; }
  .mode-note { margin: 8px 0 0; color: #9aa1b1; font-size: 12px; }
  .uri-row input {
    flex: 1;
    min-width: 0;
    background: #0b0d12;
    border: 1px solid #262b38;
    color: #e7e9ee;
    border-radius: 8px;
    padding: 8px 10px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .uri-row button {
    background: #4c6ef5;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .uri-row button:active { opacity: 0.85; }
  .expiry { margin-top: 16px; color: #6b7280; font-size: 12px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function pairingHtml(uri: string, svg: string, expiresAtSeconds: number, mode: PairingMode): string {
  const expiresLabel = new Date(expiresAtSeconds * 1000).toUTCString();
  const persistentChecked = mode === "persistent" ? " checked" : "";
  const onceChecked = mode === "once" ? " checked" : "";
  return shell(
    "Pair MOI Wallet",
    `
    <h1>Pair MOI Wallet</h1>
    <p class="sub">One-time link — don't share this page.</p>
    <div class="qr">${svg}</div>
    <ol class="steps">
      <li>Open MOI Wallet on your phone</li>
      <li>Tap Scan (or WalletConnect &rarr; Scan)</li>
      <li>Point it at this QR code</li>
    </ol>
    <div class="uri-row">
      <input id="uri" type="text" readonly value="${escapeHtml(uri)}" onclick="this.select()" />
      <button id="copy" type="button">Copy</button>
    </div>
    <fieldset class="mode">
      <legend>Stay connected?</legend>
      <label><input type="radio" name="mode" value="persistent"${persistentChecked} />
        <span><b>Keep me connected</b> for a week. Scan once, then just talk. You can disconnect any time.</span></label>
      <label><input type="radio" name="mode" value="once"${onceChecked} />
        <span><b>Just this once.</b> Forgotten after the next approved transaction, or in 15 minutes.</span></label>
      <p class="mode-note" id="mode-note">Either way, every transaction still needs your approval on this phone.</p>
    </fieldset>
    <p class="expiry">Expires ${escapeHtml(expiresLabel)}. Reloading this page keeps the same QR.</p>
    <script>
      (function () {
        var note = document.getElementById("mode-note");
        var radios = document.querySelectorAll('input[name="mode"]');
        for (var i = 0; i < radios.length; i++) {
          radios[i].addEventListener("change", function (e) {
            fetch(location.pathname + "/mode", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode: e.target.value })
            }).then(function (r) {
              note.textContent = r.ok ? "Saved. Scan whenever you're ready." : "Couldn't save that choice; reload and try again.";
            }).catch(function () {
              note.textContent = "Couldn't save that choice; reload and try again.";
            });
          });
        }
      })();
      document.getElementById("copy").addEventListener("click", function () {
        var input = document.getElementById("uri");
        input.select();
        if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(function () {});
        var btn = document.getElementById("copy");
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    </script>`,
  );
}

function goneHtml(): string {
  return shell(
    "Link expired",
    `
    <h1>This link is no longer valid</h1>
    <p class="sub">Pairing links are one-time and expire after 5 minutes. Ask your agent to connect the wallet again for a fresh link.</p>`,
  );
}

function errorHtml(): string {
  return shell(
    "Something went wrong",
    `
    <h1>Could not generate this pairing link</h1>
    <p class="sub">Something went wrong on our end. Ask your agent to connect the wallet again.</p>`,
  );
}
