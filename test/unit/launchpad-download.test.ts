import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDownloadModule } from "../../src/launchpad/download.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function serve(mod: ReturnType<typeof createDownloadModule>, fetchScript: (u: string, a: string) => Promise<{ filename: string; body: string }>) {
  const app = express();
  mod.mountDownloads(app, { fetchScript });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("one-time setup script downloads", () => {
  it("serves the script once, as an attachment, then answers 410", async () => {
    let now = 1_000_000;
    const mod = createDownloadModule(() => now);
    const fetchScript = vi.fn(async (userId: string, agentId: string) => ({
      filename: `setup-${agentId}.sh`,
      body: `#!/bin/bash\n# for ${userId}\nAGENT_KEY=secret\n`,
    }));
    const base = await serve(mod, fetchScript);
    const link = mod.createDownloadLink("user-a", "rec-1", base);
    expect(link.url.startsWith(`${base}/launchpad/download/`)).toBe(true);
    expect(link.expiresAt).toBe(Math.floor((now + 10 * 60 * 1000) / 1000));

    const first = await fetch(link.url);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/text\/x-shellscript/);
    expect(first.headers.get("content-disposition")).toBe('attachment; filename="setup-rec-1.sh"');
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.text()).toContain("AGENT_KEY=secret");
    expect(fetchScript).toHaveBeenCalledWith("user-a", "rec-1");

    const again = await fetch(link.url);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("used or has expired");
    expect(fetchScript).toHaveBeenCalledTimes(1);

    now += 11 * 60 * 1000;
    const late = mod.createDownloadLink("user-a", "rec-1", base);
    now += 11 * 60 * 1000;
    expect((await fetch(late.url)).status).toBe(410);
  });

  it("hands the token back when the Launchpad fetch fails, so a reload can retry", async () => {
    const mod = createDownloadModule();
    let fail = true;
    const fetchScript = vi.fn(async () => {
      if (fail) throw new Error("launchpad down");
      return { filename: "setup.sh", body: "ok\n" };
    });
    const base = await serve(mod, fetchScript);
    const link = mod.createDownloadLink("user-a", "rec-1", base);

    const first = await fetch(link.url);
    expect(first.status).toBe(502);
    expect(await first.text()).not.toContain("launchpad down");

    fail = false;
    const second = await fetch(link.url);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ok\n");
    expect((await fetch(link.url)).status).toBe(410);
  });

  it("answers 410 for a token it never issued", async () => {
    const mod = createDownloadModule();
    const base = await serve(mod, async () => ({ filename: "x", body: "x" }));
    expect((await fetch(`${base}/launchpad/download/nope`)).status).toBe(410);
  });
});
