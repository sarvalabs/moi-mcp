/**
 * Which dapp a person may sign in to from the chat: a public https origin.
 * Anything else, a bare IP, a machine-local name, a plain-http site, is
 * refused before any request is made. Tests may allow http for a local fake.
 * The host is also resolved, on every connection, by publicFetch below: a name
 * with any loopback, private, link-local, unique-local or unspecified answer is
 * refused, and the socket connects to the address that was checked.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

import { MoiError } from "../../moi-error.js";
import { ErrorCode } from "../../schema.js";
import type { FetchLike } from "./client.js";

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".home", ".lan"];

export function dappOrigin(url: string, opts: { allowInsecure?: boolean } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MoiError(ErrorCode.INVALID_ARGS, `"${url}" is not a URL.`);
  }
  // URL keeps a trailing dot ("localhost." is still localhost), so it is dropped before any rule reads the name.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) throw new MoiError(ErrorCode.INVALID_ARGS, `"${url}" is not a public dapp host.`);
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
  // Built from the cleaned host, never parsed.host, which would bring the trailing dot back.
  return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
/** What the connection itself would use: getaddrinfo, every answer, in the order given. */
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true });

// Destinations a public dapp is never at. The first rows are the ones named in the fix (loopback, private, link-local,
// unique-local, unspecified); the rest are non-routable or internal and cannot hold a legitimate public dapp: 0/8, shared
// address space 100.64/10 (carrier NAT, some cloud metadata), multicast, reserved, site-local fec0::/10 and 6to4 2002::/16.
// IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) needs no row: BlockList.check maps it onto the IPv4 rules.
// 64:ff9b::/96 (DNS64) is deliberately NOT here, or every dapp on an IPv6-only network would be refused.
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2002::", 16],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** Fails closed: anything that is not an IP address is not public. BlockList.check on junk returns false, so isIP comes first. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !BLOCKED.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// One message for every refusal, a name that does not resolve included, so the answer is no oracle for which internal
// names exist. The address is never put in it.
const refusal = (host: string) => new MoiError(ErrorCode.INVALID_ARGS, `"${host}" does not resolve to a public address.`);

async function resolvePublic(host: string, resolve: Resolver) {
  let found: Array<{ address: string; family: number }> = [];
  try {
    found = await resolve(host);
  } catch {
    /* refused below, in the same words as a private answer */
  }
  if (found.length === 0 || !found.every((a) => isPublicAddress(a.address))) throw refusal(host);
  return found;
}

/**
 * The lookup the dapp Agent connects with. It is the only resolution the socket uses and it hands back only the checked
 * addresses, so there is no second lookup for the answer to change in. Node calls it with {all:true} by default and with
 * no `all` when autoSelectFamily is off; both shapes are answered.
 */
export function guardedLookup(resolve: Resolver): LookupFunction {
  return (host, opts, cb) => {
    resolvePublic(host, resolve).then(
      (addrs) => {
        if (opts.all) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: MoiError) => cb(err, ""),
    );
  };
}

function build(resolve: Resolver): FetchLike {
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(resolve) } });
  return async (input, init) => {
    // net skips lookup for an IP literal, so a literal is checked here. dappOrigin already refuses every literal; this keeps
    // publicFetch safe on its own.
    const host = new URL(input).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && !isPublicAddress(host)) throw refusal(host);
    // undici's own fetch with undici's own Agent. Node bundles a different undici in each release (24.18 has 7.28), so a
    // userland Agent must never be handed to the global fetch.
    return await undiciFetch(input, { ...init, dispatcher });
  };
}

// One Agent per resolver, built on first use: the hosted server registers the dapp tools on every request, and an Agent
// holds a connection pool. Pooled sockets stay on the address they were checked against.
const guards = new WeakMap<Resolver, FetchLike>();
export function publicFetch(resolve: Resolver = systemResolver): FetchLike {
  let guarded = guards.get(resolve);
  if (!guarded) {
    guarded = build(resolve);
    guards.set(resolve, guarded);
  }
  return guarded;
}
