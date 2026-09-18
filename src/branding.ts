/**
 * The server's own icon and landing page.
 *
 * Clients that list connectors show an icon for the server's host. With
 * nothing served here that icon is whatever the hosting domain's favicon
 * happens to be, which on a tunnel is the tunnel provider's. So the server
 * answers the usual icon paths itself, and also advertises the icon in its
 * MCP serverInfo for clients that read that instead of guessing from the
 * hostname.
 */

import { BRAND_ASSETS_BASE64 } from "./brand-assets.js";

/**
 * The images ship inside the bundle, not beside it. Reading them from
 * ../assets/ at runtime meant any deployment that copied dist/ without the
 * assets directory answered 500 on every icon path, which is exactly what
 * the first VM deployment did. Decoded once, on first use.
 */
const cache = new Map<string, Buffer>();
function asset(name: string): Buffer | undefined {
  let buf = cache.get(name);
  if (!buf) {
    const b64 = BRAND_ASSETS_BASE64[name];
    if (!b64) return undefined;
    buf = Buffer.from(b64, "base64");
    cache.set(name, buf);
  }
  return buf;
}

export const WEBSITE_URL = "https://moi.technology";

/** Paths answered with an image, and what each returns. */
const BRAND_PATHS: Record<string, { file: string; type: string }> = {
  "/favicon.ico": { file: "moi-logo-64.png", type: "image/png" },
  "/favicon.png": { file: "moi-logo-64.png", type: "image/png" },
  "/favicon.svg": { file: "moi-logo.svg", type: "image/svg+xml" },
  "/logo.png": { file: "moi-logo-512.png", type: "image/png" },
  "/logo.svg": { file: "moi-logo.svg", type: "image/svg+xml" },
  "/apple-touch-icon.png": { file: "moi-logo-512.png", type: "image/png" },
};

/** The bytes and content type for a brand path, or undefined if it is not one. */
export function brandAsset(pathname: string): { body: Buffer; type: string } | undefined {
  const hit = BRAND_PATHS[pathname];
  if (!hit) return undefined;
  const body = asset(hit.file);
  // A missing image is a 404, never a thrown error: an icon nobody can fetch
  // should not take the response down with it.
  if (!body) return undefined;
  return { body, type: hit.type };
}

/**
 * MCP Implementation fields that name the icon. Absolute URLs only, so the
 * caller must know its public origin; with none known there is nothing a
 * remote client could fetch, and the field is left out rather than pointing
 * at localhost.
 */
export function brandServerInfo(publicUrl: string | undefined): {
  websiteUrl: string;
  icons?: Array<{ src: string; mimeType: string; sizes: string[] }>;
} {
  if (!publicUrl) return { websiteUrl: WEBSITE_URL };
  const base = publicUrl.replace(/\/$/, "");
  return {
    websiteUrl: WEBSITE_URL,
    icons: [
      { src: `${base}/logo.png`, mimeType: "image/png", sizes: ["512x512"] },
      { src: `${base}/favicon.png`, mimeType: "image/png", sizes: ["64x64"] },
      { src: `${base}/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  };
}

/** A minimal root page so icon discovery via <link rel="icon"> works too. */
export function landingHtml(title: string, mcpPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1117; color: #c3c8d4; font: 15px/1.5 system-ui, sans-serif; }
  main { text-align: center; padding: 32px; }
  img { width: 96px; height: 96px; }
  code { color: #e6e9f0; }
  p { margin: 8px 0 0; color: #9aa1b1; }
</style>
</head>
<body>
<main>
  <img src="/logo.png" alt="MOI" />
  <h1 style="margin:16px 0 0;font-size:20px;color:#e6e9f0">${title}</h1>
  <p>MCP endpoint: <code>${mcpPath}</code></p>
  <p>Add this URL as a connector in your AI assistant.</p>
</main>
</body>
</html>`;
}
