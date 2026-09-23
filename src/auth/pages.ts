/** Minimal, dependency-free HTML for the two auth-server pages a browser sees. */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE =
  "font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;" +
  "padding:0 1.5rem;color:#1a1a1a;line-height:1.5";

export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="${STYLE}">
<h1 style="font-size:1.25rem">${esc(title)}</h1>
<p>${esc(detail)}</p>
</body></html>`;
}

/** What each scope lets the app do, in the user's terms. */
const SCOPE_MEANING: Record<string, string> = {
  "moi:read": "See which MOI wallet is paired here and its address.",
  "moi:write": "Pair or unpair a wallet, and propose transactions for you to approve on your phone. It cannot move anything without your tap.",
};

export function renderConsentPage(opts: {
  clientName: string;
  scopes: string[];
  /** Origin the browser is sent back to on approval; the one thing a phishing clone cannot fake. */
  redirectOrigin: string;
  formAction: string;
  hidden: Record<string, string>;
  /**
   * Address of the wallet already paired to this browser's identity, if any.
   * Shown so a second person on a shared browser can choose to start as
   * themselves instead of inheriting the first person's phone.
   */
  pairedAddress?: string;
}): string {
  const hiddenInputs = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n");
  const scopeList = opts.scopes
    .map((s) => `<li>${esc(SCOPE_MEANING[s] ?? s)}</li>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize ${esc(opts.clientName)}</title></head>
<body style="${STYLE}">
<h1 style="font-size:1.25rem">${esc(opts.clientName)} wants to connect</h1>
<p>After you approve, you will be sent back to <strong>${esc(opts.redirectOrigin)}</strong>. If that is not the app you are using, deny this.</p>
<p>It is asking to:</p>
<ul>${scopeList}</ul>
<p>There is no account to sign in to. Your wallet is your identity: approving links this browser to the phone you pair next, and nothing more.</p>
<p style="color:#555;font-size:0.9rem">Nothing here gives it your keys. Every transaction still needs your approval in MOI Wallet on your phone.</p>
${opts.pairedAddress ? renderPairedNotice(opts.pairedAddress) : ""}
<form method="post" action="${esc(opts.formAction)}" style="display:flex;gap:0.75rem;margin-top:1.5rem;${opts.pairedAddress ? "flex-direction:column" : ""}">
${hiddenInputs}
${opts.pairedAddress ? PAIRED_BUTTONS : PLAIN_BUTTONS}
</form>
</body></html>`;
}

const BUTTON = "flex:1;padding:0.6rem;border:none;border-radius:6px;cursor:pointer";

const PLAIN_BUTTONS = `<button type="submit" name="decision" value="approve"
  style="${BUTTON};background:#111;color:#fff">Approve</button>
<button type="submit" name="decision" value="deny"
  style="${BUTTON};background:#eee;color:#111">Deny</button>`;

/**
 * Three choices once a pairing exists, stacked so they read at phone width.
 * "Continue" keeps the identity and the phone. "Someone else" mints a new
 * identity for this browser, so the person pairs their own phone next and
 * never touches the previous person's.
 */
const PAIRED_BUTTONS = `<button type="submit" name="decision" value="approve"
  style="${BUTTON};background:#111;color:#fff">Continue with this wallet</button>
<button type="submit" name="decision" value="approve_fresh"
  style="${BUTTON};background:#fff;color:#111;border:1px solid #bbb">I am someone else</button>
<button type="submit" name="decision" value="deny"
  style="${BUTTON};background:#eee;color:#111">Deny</button>`;

/**
 * Enough of a MOI address (66 hex characters) for its owner to recognise it,
 * and no more. The page is shown to whoever is at this browser, before they
 * have proved anything, so the full address stays off it.
 */
function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

function renderPairedNotice(address: string): string {
  return `<div style="margin-top:1.25rem;padding:0.9rem 1rem;background:#f4f2ff;border:1px solid #d9ccff;border-radius:8px">
<p style="margin:0 0 0.4rem"><strong>This browser is already paired to a MOI Wallet.</strong></p>
<p style="margin:0 0 0.6rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9rem">${esc(shortAddress(address))}</p>
<p style="margin:0 0 0.5rem;font-size:0.9rem">If that is your wallet, choose <em>Continue with this wallet</em>.</p>
<p style="margin:0;font-size:0.9rem">If you are someone else, choose <em>I am someone else</em>. This browser then stops using that wallet, and you pair your own phone next. The other person's Claude keeps working with their wallet as before; only a later sign-in from this browser would no longer find it.</p>
</div>`;
}
