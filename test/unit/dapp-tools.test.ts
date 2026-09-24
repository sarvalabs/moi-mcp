/**
 * The generic dapp tools against the fake Launchpad, which for this purpose
 * is just a dapp that follows the conventions and publishes an OpenAPI
 * document.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AuthInfo } from "../../src/auth/types.js";
import { dappOrigin } from "../../src/dapp/origin.js";
import { summarizeOpenApi } from "../../src/dapp/client.js";
import { registerDappTools, type DappDeps } from "../../src/tools/dapp.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { authFor, deps as writeDeps, fakeHub, fakeJournal, fakeStore, session, structured, USER } from "../helpers/hosted.js";
import { COOKIE, fakeSessions, signedInRecord, startFakeLaunchpad, type FakeLaunchpad } from "../helpers/launchpad.js";
import { ACCOUNT } from "../helpers/mock-node.js";

let fake: FakeLaunchpad;
beforeAll(async () => {
  applyEnv("http://127.0.0.1:1", tempHome());
  fake = await startFakeLaunchpad();
});
afterAll(async () => {
  await fake.close();
  restoreEnv();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.state.cookieValid = true;
  fake.state.verifyOk = true;
});

function wallet(paired = true) {
  const records = new Map([[USER, session()]]);
  if (!paired) records.clear();
  return writeDeps(fakeStore(records), fakeHub(), fakeJournal());
}

async function connect(deps: Partial<DappDeps> = {}, who: AuthInfo | null = authFor(USER)): Promise<{ client: Client; sessions: ReturnType<typeof fakeSessions> }> {
  const sessions = (deps.sessions as ReturnType<typeof fakeSessions>) ?? fakeSessions();
  const server = new McpServer({ name: "t", version: "0" });
  registerDappTools(server, { writes: wallet(), allowInsecure: true, ...deps, sessions }, who);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return { client, sessions };
}

describe("dappOrigin", () => {
  it("keeps only a public https origin", () => {
    expect(dappOrigin("https://launchpad.moi.technology/some/path?x=1")).toBe("https://launchpad.moi.technology");
    expect(dappOrigin("https://app.example:8443/")).toBe("https://app.example:8443");
    for (const bad of ["http://launchpad.moi.technology", "https://127.0.0.1", "https://localhost", "https://box.local", "https://intranet", "ftp://x.example", "not a url"]) {
      expect(() => dappOrigin(bad), bad).toThrow();
    }
    expect(dappOrigin("http://127.0.0.1:8080/x", { allowInsecure: true })).toBe("http://127.0.0.1:8080");
  });
});

describe("summarizeOpenApi", () => {
  it("reduces a document to callable operations and rejects anything else", () => {
    expect(summarizeOpenApi({ not: "openapi" })).toBeUndefined();
    const api = summarizeOpenApi({
      openapi: "3.0.0",
      info: { title: "T", version: "2" },
      paths: {
        "/items/{id}": {
          parameters: [{ name: "id", in: "path" }],
          get: { summary: "One item" },
          delete: { operationId: "removeItem", parameters: [{ name: "force", in: "query", required: true }] },
        },
        "/items": { post: { operationId: "addItem", requestBody: {} } },
      },
    })!;
    expect(api.title).toBe("T");
    expect(api.operations.map((o) => o.operationId)).toEqual(["get_items_id", "removeItem", "addItem"]);
    expect(api.operations[0]!.parameters).toEqual([{ name: "id", in: "path", required: true }]);
    expect(api.operations[1]!.parameters.map((p) => p.name)).toEqual(["id", "force"]);
    expect(api.operations[2]!.hasBody).toBe(true);
  });
});

describe("moi_dapp_sign_in", () => {
  it("signs the dapp's message on the phone and keeps the session for that origin", async () => {
    const { client, sessions } = await connect();
    const res = await client.callTool({ name: "moi_dapp_sign_in", arguments: { url: `${fake.url}/dashboard` } });
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ dapp: fake.url, signedIn: true, wallet: ACCOUNT });
    const rec = await sessions.get(USER, fake.url);
    expect(rec?.cookie).toBe(COOKIE);
    const verify = fake.requests.find((r) => r.path === "/api/auth/verify")!;
    expect(verify.body).toMatchObject({ address: ACCOUNT, signature: "0xfeed" });
  });

  it("refuses a non-https or local origin before any request", async () => {
    const { client } = await connect({ allowInsecure: false });
    const res = await client.callTool({ name: "moi_dapp_sign_in", arguments: { url: fake.url } });
    expect(res.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("needs a paired wallet", async () => {
    const { client } = await connect({ writes: wallet(false) });
    const res = await client.callTool({ name: "moi_dapp_sign_in", arguments: { url: fake.url } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No wallet paired/);
  });
});

describe("moi_dapp_api and moi_dapp_call", () => {
  it("lists the published operations and calls one with the session", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const { client } = await connect({ sessions });

    const api = structured<{ published: boolean; title: string; operations: Array<{ operationId: string; method: string; path: string }> }>(
      await client.callTool({ name: "moi_dapp_api", arguments: { url: fake.url } }),
    );
    expect(api.published).toBe(true);
    expect(api.title).toBe("Fake Launchpad");
    expect(api.operations.map((o) => o.operationId)).toEqual(["me", "getAgent", "echo"]);

    const call = structured<{ status: number; ok: boolean; body: { echoed: unknown; tag: string } }>(
      await client.callTool({
        name: "moi_dapp_call",
        arguments: { url: fake.url, operationId: "echo", params: { tag: "t1" }, body: { hello: "world" } },
      }),
    );
    expect(call).toMatchObject({ status: 200, ok: true, body: { echoed: { hello: "world" }, tag: "t1" } });
    const echo = fake.requests.find((r) => r.path === "/api/echo")!;
    expect(echo.cookie).toBe(`moi_session=${COOKIE}`);

    const one = structured<{ status: number; body: { agent: { id: string } } }>(
      await client.callTool({ name: "moi_dapp_call", arguments: { url: fake.url, operationId: "getAgent", params: { id: "rec-1" } } }),
    );
    expect(one.status).toBe(200);
    expect(one.body.agent.id).toBe("rec-1");
  });

  it("refuses an operation the dapp does not publish, and a call without a session", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const { client } = await connect({ sessions });
    const unknown = await client.callTool({ name: "moi_dapp_call", arguments: { url: fake.url, operationId: "dropEverything" } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toMatch(/publishes no operation "dropEverything"/);
    expect(fake.requests.some((r) => r.path.includes("dropEverything"))).toBe(false);

    const { client: signedOut } = await connect();
    const res = await signedOut.callTool({ name: "moi_dapp_call", arguments: { url: fake.url, operationId: "me" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/moi_dapp_sign_in/);
  });

  it("forgets a session the dapp no longer accepts", async () => {
    const sessions = fakeSessions(new Map([[USER, signedInRecord(fake.url)]]));
    const { client } = await connect({ sessions });
    fake.state.cookieValid = false;
    const res = await client.callTool({ name: "moi_dapp_call", arguments: { url: fake.url, operationId: "me" } });
    expect(res.isError).toBe(true);
    expect(await sessions.get(USER, fake.url)).toBeUndefined();
  });

  it("says when a dapp publishes nothing", async () => {
    const bare = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    try {
      const { client } = await connect({ sessions: fakeSessions(new Map([[USER, signedInRecord(url)]])) });
      const api = structured<{ published: boolean; operations: unknown[] }>(
        await client.callTool({ name: "moi_dapp_api", arguments: { url } }),
      );
      expect(api.published).toBe(false);
      expect(api.operations).toEqual([]);
      const call = await client.callTool({ name: "moi_dapp_call", arguments: { url, operationId: "anything" } });
      expect(call.isError).toBe(true);
      expect((call.content as Array<{ text: string }>)[0]!.text).toMatch(/publishes no OpenAPI document/);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});

describe("moi_dapp_sessions and moi_dapp_sign_out", () => {
  it("list what is live and forget on sign-out", async () => {
    const sessions = fakeSessions(
      new Map([
        [USER, signedInRecord(fake.url)],
        [`${USER}-old`, signedInRecord("https://old.example", { expiresAt: 1 })],
      ]),
    );
    const { client } = await connect({ sessions });
    const list = structured<{ sessions: Array<{ dapp: string }> }>(await client.callTool({ name: "moi_dapp_sessions", arguments: {} }));
    expect(list.sessions.map((s) => s.dapp)).toEqual([fake.url]);

    await client.callTool({ name: "moi_dapp_sign_out", arguments: { url: fake.url } });
    expect(await sessions.get(USER, fake.url)).toBeUndefined();
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/auth/logout"]);
  });
});
