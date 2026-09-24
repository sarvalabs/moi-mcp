/**
 * A stand-in for the MOI Agent Launchpad: an in-process HTTP server speaking
 * the routes the connector uses, with the shapes read from the Launchpad's
 * source. Records every request so a test can assert what was sent, and
 * exposes a little mutable state so a test can move an agent through its
 * statuses or invalidate the session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, type Mock } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AuthInfo } from "../../src/auth/types.js";
import { LaunchpadClient } from "../../src/launchpad/client.js";
import type { DappSessionStore, StoredDappSession } from "../../src/dapp/store.js";
import { registerLaunchpadTools, type LaunchpadDeps } from "../../src/tools/launchpad.js";
import type { HostedWriteDeps } from "../../src/tools/hosted-writes.js";
import { authFor, USER } from "./hosted.js";

export const COOKIE = "jwt-abc";
export const AGENT_WALLET = "0x000000002497e599b212a83896919005863b05511d46d0a32ad0af8600000000";
export const RECORD_ID = "rec-1";

export interface SeenRequest {
  method: string;
  path: string;
  cookie: string | undefined;
  body: unknown;
}

export interface FakeLaunchpad {
  url: string;
  requests: SeenRequest[];
  state: { agentStatus: string; cookieValid: boolean; keyReadable: boolean; telegramLinked: boolean; verifyOk: boolean };
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeLaunchpad(): Promise<FakeLaunchpad> {
  const requests: SeenRequest[] = [];
  const state = { agentStatus: "pending_grant", cookieValid: true, keyReadable: true, telegramLinked: false, verifyOk: true };
  let url = "";

  const agent = (extra: Record<string, unknown> = {}) => ({
    id: RECORD_ID,
    name: "Rain Check",
    moi_address: AGENT_WALLET,
    template_id: "weather_brief",
    status: state.agentStatus,
    visibility: "private",
    registry_tx: null,
    ...extra,
  });

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = await readBody(req);
    const cookieHeader = req.headers.cookie;
    requests.push({ method, path, cookie: cookieHeader, body });
    const signedIn = state.cookieValid && cookieHeader === `moi_session=${COOKIE}`;
    const needCookie = (): boolean => {
      if (signedIn) return true;
      json(res, 401, { error: "unauthorized" });
      return false;
    };
    const b = (body ?? {}) as Record<string, unknown>;

    if (method === "POST" && path === "/api/auth/nonce") {
      const wallet = String(b["walletAddress"]).trim().toLowerCase();
      return json(res, 200, {
        nonce: "n1",
        message: `MOI Agent Launchpad wants you to sign in with your MOI account.\n\nWallet: ${wallet}\nNonce: n1\nIssued At: 2026-09-23T23:00:00.000Z\nOrigin: ${url}`,
      });
    }
    if (method === "POST" && path === "/api/auth/verify") {
      if (!state.verifyOk || b["signature"] !== "0xfeed") return json(res, 401, { error: "invalid_signature" });
      return json(
        res,
        200,
        { ok: true, profile: { id: "p1", walletAddress: String(b["address"]) } },
        { "set-cookie": `moi_session=${COOKIE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` },
      );
    }
    if (method === "POST" && path === "/api/auth/logout") return json(res, 200, { ok: true });
    if (method === "GET" && path === "/api/templates") {
      return json(res, 200, {
        templates: [
          {
            id: "weather_brief",
            name: "Weather Brief",
            tagline: "A 2-line forecast for your city, every morning.",
            emoji: "🌤",
            scaffold: "scheduled",
            scopes: ["deliver:telegram", "read:weather"],
            requiresApiKey: false,
            apiKeyPresent: true,
            configFields: [
              { key: "city", label: "City", type: "text", placeholder: "Mumbai", maxLength: 60 },
              { key: "time", label: "Delivery time", type: "time" },
            ],
            examplePrompts: ["Rain today?"],
          },
          {
            id: "job_search",
            name: "Job Search",
            scopes: ["deliver:telegram", "read:jobs"],
            requiresApiKey: true,
            apiKeyPresent: false,
            configFields: [],
            examplePrompts: [],
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/me") {
      if (!needCookie()) return;
      return json(res, 200, {
        profile: { id: "p1", walletAddress: "0xowner", telegramLinked: state.telegramLinked },
        usage: { interactions: 0, max: 40 },
      });
    }
    if (method === "POST" && path === "/api/agents") {
      if (!needCookie()) return;
      if (b["name"] === "Taken") return json(res, 409, { error: "name_taken" });
      return json(res, 200, { agent: agent({ name: String(b["name"]), template_id: String(b["templateId"]) }), grant: { message: "MOI Agent Launchpad grant", scopes: [] } });
    }
    if (method === "GET" && path === "/api/agents") {
      if (!needCookie()) return;
      return json(res, 200, { agents: [agent({ keyReadable: state.keyReadable })] });
    }
    if (method === "GET" && path === `/api/agents/${RECORD_ID}`) {
      if (!needCookie()) return;
      return json(res, 200, { agent: agent({ keyReadable: state.keyReadable, config: {} }), grantScopes: [], runs: [] });
    }
    if (method === "POST" && path === `/api/agents/${RECORD_ID}/register-intent`) {
      if (!needCookie()) return;
      if (state.agentStatus !== "pending_grant") return json(res, 409, { error: "wrong_status" });
      return json(res, 200, { interaction: { sender: {} }, blocked: null });
    }
    if (method === "POST" && path === `/api/agents/${RECORD_ID}/register-confirm`) {
      if (!needCookie()) return;
      if (state.agentStatus !== "pending_grant") return json(res, 409, { error: "wrong_status" });
      state.agentStatus = "active";
      return json(res, 200, { ok: true, registryTx: String(b["txHash"]) });
    }
    if (method === "GET" && path === `/api/agents/${RECORD_ID}/setup-script`) {
      if (!needCookie()) return;
      if (!state.keyReadable) return json(res, 500, { error: "agent_key_unreadable" });
      res.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-disposition": 'attachment; filename="setup-rain-check.sh"',
        "cache-control": "no-store, max-age=0",
      });
      return res.end("#!/usr/bin/env bash\nAGENT_KEY=very-secret\n");
    }
    if (method === "GET" && path === "/openapi.json") {
      return json(res, 200, {
        openapi: "3.1.0",
        info: { title: "Fake Launchpad", version: "1" },
        paths: {
          "/api/me": { get: { operationId: "me", summary: "Who is signed in" } },
          "/api/agents/{id}": {
            parameters: [{ name: "id", in: "path", required: true }],
            get: { operationId: "getAgent", summary: "One agent" },
          },
          "/api/echo": {
            post: { operationId: "echo", summary: "Echo the body (writes nothing)", requestBody: {}, parameters: [{ name: "tag", in: "query" }] },
          },
        },
      });
    }
    if (method === "POST" && path === "/api/echo") {
      if (!needCookie()) return;
      const tag = new URL(req.url ?? "/", "http://x").searchParams.get("tag");
      return json(res, 200, { echoed: body, tag });
    }
    if (method === "POST" && path === "/api/telegram/link") {
      if (!needCookie()) return;
      return json(res, 200, { deepLink: "https://t.me/moinetworkbot?start=abc-123" });
    }
    json(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function fakeSessions(
  seed: Map<string, StoredDappSession> = new Map(),
): DappSessionStore & { records: Map<string, StoredDappSession> } {
  // Keyed by "<userId> <baseUrl>"; a seed keyed by userId alone is re-keyed.
  const records = new Map<string, StoredDappSession>();
  for (const r of seed.values()) records.set(`${r.userId} ${r.baseUrl}`, r);
  const key = (userId: string, baseUrl: string) => `${userId} ${baseUrl.replace(/\/+$/, "")}`;
  return {
    records,
    get: vi.fn(async (userId: string, baseUrl: string) => records.get(key(userId, baseUrl))),
    set: vi.fn(async (r: StoredDappSession) => void records.set(key(r.userId, r.baseUrl), r)),
    delete: vi.fn(async (userId: string, baseUrl: string) => void records.delete(key(userId, baseUrl))),
    listFor: vi.fn(async (userId: string) => [...records.values()].filter((r) => r.userId === userId)),
  };
}

export function signedInRecord(baseUrl: string, over: Partial<StoredDappSession> = {}): StoredDappSession {
  return {
    version: 1,
    userId: USER,
    baseUrl,
    cookie: COOKIE,
    walletAddress: "0xowner",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

export type DownloadLinkMock = Mock<(userId: string, agentId: string) => { url: string; expiresAt: number }>;

export function launchpadDeps(
  fake: FakeLaunchpad,
  writes: HostedWriteDeps,
  sessions: DappSessionStore,
  over: Partial<LaunchpadDeps> = {},
): LaunchpadDeps & { createDownloadLink: DownloadLinkMock } {
  const createDownloadLink: DownloadLinkMock = vi.fn((_userId: string, agentId: string) => ({
    url: `https://mcp.test/launchpad/download/tok-${agentId}`,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  }));
  return {
    client: new LaunchpadClient(fake.url),
    sessions,
    writes,
    registryWaitMs: 0,
    ...over,
    createDownloadLink: (over.createDownloadLink ?? createDownloadLink) as DownloadLinkMock,
  };
}

/** A real McpServer with only the launchpad tools, over an in-memory transport. */
export async function connectLaunchpad(deps: LaunchpadDeps, who: AuthInfo | null = authFor(USER)): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerLaunchpadTools(server, deps, who);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}
