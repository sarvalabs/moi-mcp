/**
 * Which dapp a person may sign in to from the chat: a public https origin.
 * Anything else, a bare IP, a machine-local name, a plain-http site, is
 * refused before any request is made. Tests may allow http for a local fake.
 */

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".home", ".lan"];

export function dappOrigin(url: string, opts: { allowInsecure?: boolean } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MoiError(ErrorCode.INVALID_ARGS, `"${url}" is not a URL.`);
  }
  const host = parsed.hostname.toLowerCase();
  const insecure = opts.allowInsecure === true;
  if (parsed.protocol !== "https:" && !(insecure && parsed.protocol === "http:")) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Dapps are reached over https; "${url}" is not.`);
  }
  if (!insecure) {
    const ipLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":");
    if (ipLiteral || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
      throw new MoiError(ErrorCode.INVALID_ARGS, `"${host}" is not a public dapp host.`);
    }
  }
  return `${parsed.protocol}//${parsed.host}`;
}
