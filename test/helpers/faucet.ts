/**
 * A stand-in for the Voyage devnet faucet: an in-process HTTP server that answers POST /devnet/v2/faucet/<key>/claim as the
 * documented API does ({ success, message }) and in each of the ways it can go wrong. It records every request, and the
 * key it was given, decoded from the path, so a test can say what was sent and, with an echo style set, make the faucet
 * repeat the key back in its words, which is how a leak through the faucet's own words is tried.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FaucetClient, type FaucetClientOptions } from "../../src/applications/faucet/client.js";
import type { FaucetDeps } from "../../src/applications/faucet/tools.js";
import { SlidingWindow } from "../../src/auth/rate-limit.js";
import type { AuthInfo } from "../../src/auth/types.js";
import type { WriteDeps } from "../../src/tools/hosted-writes.js";
import { registerFaucetTools } from "../../src/tools/register.js";
import { authFor, USER } from "./hosted.js";

/** A sentinel, not a key-shaped literal, as needle-body is in the dapp tests. */
export const FAUCET_KEY = "needle-faucet-key-7f3a";
/** Characters that must be percent-encoded in a path. */
export const AWKWARD_KEY = "k/e?y#1%2e+x";
export const FAUCET_PATH = "/devnet/v2/faucet";
export const SAID = "The request to claim the token was successful.";
const COOLDOWN = "This account has already claimed. Try again after the cooldown.";
const CAP = 8 * 1024;

export type FaucetMode =
  | "ok"
  | "null_message"
  | "array_message"
  | "cooldown"
  | "bad_key"
  | "forbidden"
  | "gateway_429"
  | "not_found"
  | "server_error"
  | "bad_gateway"
  | "plain_ok"
  | "empty_204"
  | "no_success_field"
  | "success_false"
  | "redirect"
  | "huge_length"
  | "huge_stream"
  | "exact_cap"
  | "over_cap"
  | "stream_exact"
  | "stream_over"
  | "hang"
  | "hangup";

/** How the fake repeats the key it was given in the words it builds. Every style but "none" is a way an API might echo a token. */
export type EchoStyle = "none" | "raw" | "encoded" | "upper" | "split" | "linebreak" | "bidi";
export const ECHO_STYLES: readonly EchoStyle[] = ["raw", "encoded", "upper", "split", "linebreak", "bidi"];

// Spelled as escapes so the invisible characters cannot be lost in an editor: a zero-width space and a right-to-left override.
const ZERO_WIDTH_SPACE = "​";
const RLO = "‮";

function echoOf(key: string, style: EchoStyle): string {
  switch (style) {
    case "none":
      return "";
    case "raw":
      return ` (token ${key})`;
    case "encoded":
      return ` (path ${encodeURIComponent(key)})`;
    case "upper":
      return ` (token ${key.toUpperCase()})`;
    case "split":
      return ` (token ${key.slice(0, 7)}${ZERO_WIDTH_SPACE}${key.slice(7)})`;
    case "linebreak":
      return ` (token ${key.slice(0, 7)}\n${key.slice(7)})`;
    case "bidi":
      return ` (token ${RLO}${key})`;
  }
}

/** The modes whose words the fake builds from state.message and state.echo (and so can repeat the key). */
export const WORDS_MODES: readonly FaucetMode[] = ["ok", "cooldown", "gateway_429", "no_success_field", "success_false", "bad_gateway"];

/** Every answer a faucet can give that is not a transport failure. bad_key and forbidden echo the key raw unless state.message says otherwise. */
export const ANSWER_MODES: readonly FaucetMode[] = [
  ...WORDS_MODES,
  "bad_key",
  "forbidden",
  "null_message",
  "array_message",
  "not_found",
  "server_error",
  "plain_ok",
  "empty_204",
  "redirect",
  "huge_length",
  "huge_stream",
  "over_cap",
];

export interface SeenClaim {
  method: string;
  /** The raw request target, percent-encoding as sent. */
  url: string;
  /** The key segment of the path, decoded; undefined when the path was not <base>/<key>/claim. */
  keySeen: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeFaucet {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** The base address a client is given: origin plus the documented path. */
  url: string;
  requests: SeenClaim[];
  state: {
    mode: FaucetMode;
    /** Replaces the words of the WORDS_MODES for one test. */
    message: string | undefined;
    /** Appends the key it was given to those words, in this style. */
    echo: EchoStyle;
  };
  close(): Promise<void>;
}

/** A valid success answer of exactly `bytes` bytes (ASCII). */
function answerOfSize(bytes: number): string {
  const head = '{"success":true,"message":"';
  const tail = '"}';
  return head + "m".repeat(bytes - head.length - tail.length) + tail;
}

function reply(res: ServerResponse, status: number, body: string, type = "application/json", extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, ...extra });
  res.end(body);
}

export async function startFakeFaucet(): Promise<FakeFaucet> {
  const requests: SeenClaim[] = [];
  const sockets = new Set<Socket>();
  const state: FakeFaucet["state"] = { mode: "ok", message: undefined, echo: "none" };
  let origin = "";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const match = new RegExp(`^${FAUCET_PATH}/([^/]+)/claim$`).exec(url.split("?")[0] ?? "");
      const keySeen = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text === "" ? undefined : text;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        /* kept as text */
      }
      requests.push({ method: req.method ?? "GET", url, keySeen, headers: req.headers, body });

      const says = (fallback: string): string => `${state.message ?? fallback}${echoOf(keySeen ?? "", state.echo)}`;
      switch (state.mode) {
        case "ok":
          return reply(res, 200, JSON.stringify({ success: true, message: says(SAID) }));
        case "null_message":
          return reply(res, 200, '{"success":true,"message":null}');
        case "array_message":
          return reply(res, 200, '{"success":true,"message":["a","b"]}');
        case "cooldown":
          return reply(res, 429, JSON.stringify({ success: false, message: says(COOLDOWN) }));
        case "bad_key":
          // Echoes the key, as an API that names the bad token does, unless a test sets its own words (a masked echo, say).
          return reply(res, 401, JSON.stringify({ success: false, message: state.message ?? `Invalid faucet token ${keySeen}` }));
        case "forbidden":
          return reply(res, 403, JSON.stringify({ success: false, message: state.message ?? `Token ${keySeen} may not claim` }));
        case "gateway_429":
          return reply(res, 429, JSON.stringify({ message: says("Too many requests") }));
        case "not_found":
          return reply(res, 404, "<html><body>Not found</body></html>", "text/html");
        case "server_error":
          return reply(res, 500, "<html><body>Internal error</body></html>", "text/html");
        case "bad_gateway":
          return reply(res, 502, JSON.stringify({ message: says("Bad gateway") }));
        case "plain_ok":
          return reply(res, 200, "OK", "text/plain");
        case "empty_204":
          res.writeHead(204);
          return void res.end();
        case "no_success_field":
          return reply(res, 200, JSON.stringify({ message: says("hi") }));
        case "success_false":
          return reply(res, 200, JSON.stringify({ success: false, message: says("The faucet is empty") }));
        case "redirect":
          return reply(res, 302, "", "text/plain", { location: `${origin}/moved/${encodeURIComponent(keySeen ?? "")}/claim` });
        case "huge_length":
          return reply(res, 200, "x".repeat(100_000));
        case "huge_stream":
          // No content-length: chunked, so only counting the stream can stop it.
          res.writeHead(200, { "content-type": "application/json" });
          for (let i = 0; i < 8; i++) res.write("x".repeat(16 * 1024));
          return void res.end();
        case "exact_cap":
          return reply(res, 200, answerOfSize(CAP));
        case "over_cap":
          return reply(res, 200, answerOfSize(CAP + 1));
        case "stream_exact":
        case "stream_over": {
          const whole = answerOfSize(state.mode === "stream_exact" ? CAP : CAP + 1);
          res.writeHead(200, { "content-type": "application/json" });
          res.write(whole.slice(0, 4000));
          return void res.end(whole.slice(4000));
        }
        case "hang":
          return; // never answers; close() drops the socket
        case "hangup":
          // After the request was recorded: the request arrived, then the connection is cut.
          req.socket.destroy();
          return;
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}${FAUCET_PATH}`,
    requests,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** An origin on this machine that nothing listens on: a port that was free a moment ago. */
export async function closedPortOrigin(): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** The address a client sends to for `key`: what must never be shown. */
export const claimUrlOf = (fake: { url: string }, key: string): string => `${fake.url}/${encodeURIComponent(key)}/claim`;

/** A client for the fake: a plain fetch to loopback (allowInsecure), `over` replaces any option. */
export function faucetClientFor(fake: { url: string }, over: Partial<FaucetClientOptions> = {}): FaucetClient {
  return new FaucetClient({ baseUrl: fake.url, key: FAUCET_KEY, allowInsecure: true, ...over });
}

/** The tool's deps over the fake. Each call gets its own generous window, so tests do not share one. */
export function faucetDeps(fake: { url: string }, wallets: Pick<WriteDeps, "store">, over: Partial<FaucetDeps> = {}): FaucetDeps {
  return { client: faucetClientFor(fake), wallets, limiter: new SlidingWindow({ windowMs: 60_000, max: 100 }), ...over };
}

/** A real McpServer with only the faucet tool, over an in-memory transport. */
export async function connectFaucet(deps: FaucetDeps, who: AuthInfo | null = authFor(USER)): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerFaucetTools(server, deps, who);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}
