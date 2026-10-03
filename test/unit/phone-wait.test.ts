/**
 * What a write or a sign-in does while the phone has not answered yet: a client that asked for progress hears a notice
 * every 15 seconds, a client that did not hears nothing and no timer is armed, and the timer is gone however the wait
 * ends.
 *
 * Only setInterval and clearInterval are faked, and only after the preview call. The SDK client's 60 second request
 * timeout, the mock node's HTTP and the Launchpad fake all run on real timers, and advancing four minutes of fake time
 * must not trip any of them. Nothing here fakes Date either: progress is counted in ticks, not read off a clock.
 *
 * The same wait on the stdio server is pinned at the end, since both servers go through the same write path.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Progress } from "@modelcontextprotocol/sdk/types.js";

import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import { awaitPhone, PROGRESS_EVERY_MS, type ToolExtra } from "../../src/tools/hosted-writes.js";
import { fakeWallet, installWallet, seedSession, signatureFor, startHarness, type Harness } from "../helpers/harness.js";
import { connect, deps, fakeHub, fakeStore, session, slowPhone, structured, USER } from "../helpers/hosted.js";
import { KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A handler's extra, by hand: a token (or none) and a sendNotification that records. */
function extraWith(token: string | number | undefined, send = vi.fn(async (_notification: unknown) => {})) {
  return {
    extra: { _meta: token === undefined ? {} : { progressToken: token }, sendNotification: send } as ToolExtra,
    send,
  };
}

const NOTICE = (seconds: number) =>
  `Still waiting for your approval in MOI Wallet (${seconds} s). Nothing is sent until you approve.`;
const SIGN_IN_NOTICE = (seconds: number) =>
  `Still waiting for you to approve the sign-in message in MOI Wallet (${seconds} s). Nothing is sent on chain.`;

const fakeClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

describe("awaitPhone", () => {
  beforeEach(() => {
    fakeClock();
  });

  it("sends a notice every 15 seconds with the seconds waited, and no total", async () => {
    const { extra, send } = extraWith("tok");
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS - 1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 + 2 * PROGRESS_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(3);
    for (const n of [1, 2, 3]) {
      expect(send).toHaveBeenNthCalledWith(n, {
        method: "notifications/progress",
        params: { progressToken: "tok", progress: 15 * n, message: NOTICE(15 * n) },
      });
      const sent = send.mock.calls[n - 1]![0] as { params: object };
      expect("total" in sent.params).toBe(false);
    }

    wait.resolve("tapped");
    await expect(p).resolves.toBe("tapped");
    await vi.advanceTimersByTimeAsync(4 * PROGRESS_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, ""])("a token of %j still counts", async (token) => {
    const { extra, send } = extraWith(token);
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: token, progress: 15, message: NOTICE(15) },
    });

    wait.resolve("tapped");
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says what a sign-in is waiting for", async () => {
    const { extra, send } = extraWith("tok");
    const wait = deferred<string>();
    const p = awaitPhone(extra, "sign-in", () => wait.promise);

    await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "tok", progress: 15, message: SIGN_IN_NOTICE(15) },
    });

    wait.resolve("signed");
    await p;
  });

  const unwanted = vi.fn(async (_notification: unknown) => {});
  it.each([
    ["no extra at all", undefined],
    ["an extra with no _meta", { sendNotification: unwanted } as unknown as ToolExtra],
    ["an extra with _meta but no token", { _meta: {}, sendNotification: unwanted } as ToolExtra],
  ])("sends nothing and arms no timer with %s", async (_label, extra) => {
    unwanted.mockClear();
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unwanted).not.toHaveBeenCalled();

    wait.resolve("tapped");
    await expect(p).resolves.toBe("tapped");
  });

  it.each([
    ["is refused", new MoiError(ErrorCode.USER_REJECTED, "refused on the phone")],
    [
      "times out",
      new MoiError(
        ErrorCode.REQUEST_TIMEOUT,
        "No answer from MOI Wallet within 240 seconds. Nothing was sent. Check the phone and try again.",
      ),
    ],
    ["breaks", new Error("relay down")],
  ])("clears the timer when the wait %s, and passes the error on unchanged", async (_label, err) => {
    const { extra, send } = extraWith("tok");
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    wait.reject(err);
    await expect(p).rejects.toBe(err);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the wait throws before it returns a promise", async () => {
    const { extra } = extraWith("tok");
    const boom = new Error("sync");
    const p = awaitPhone(extra, "approval", () => {
      throw boom;
    });

    await expect(p).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing for a wait that is over before the first mark", async () => {
    const { extra, send } = extraWith("tok");
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    await vi.advanceTimersByTimeAsync(14_000);
    wait.resolve("quick");
    await expect(p).resolves.toBe("quick");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // An unhandled rejection fails the vitest run on its own, which is the assertion that a failed notice leaks nothing.
  it.each<[string, Mock]>([
    ["rejects", vi.fn(async () => { throw new Error("Not connected"); }) as unknown as Mock],
    ["throws at once", vi.fn(() => { throw new Error("boom"); }) as unknown as Mock],
    ["returns nothing", vi.fn(() => undefined) as unknown as Mock],
  ])("a notice that cannot be sent never fails the wait: a send that %s", async (_label, failing) => {
    failing.mockClear();
    const extra = { _meta: { progressToken: "tok" }, sendNotification: failing } as unknown as ToolExtra;
    const wait = deferred<string>();
    const p = awaitPhone(extra, "approval", () => wait.promise);

    await vi.advanceTimersByTimeAsync(2 * PROGRESS_EVERY_MS);
    expect(failing).toHaveBeenCalledTimes(2);

    wait.resolve("tapped");
    await expect(p).resolves.toBe("tapped");
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("the log line", () => {
    let lines: string[];
    let savedLevel: string | undefined;
    let restoreStderr: () => void;
    beforeEach(() => {
      lines = [];
      savedLevel = process.env["LOG_LEVEL"];
      process.env["LOG_LEVEL"] = "info";
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
      restoreStderr = () => spy.mockRestore();
    });
    afterEach(() => {
      restoreStderr();
      if (savedLevel === undefined) delete process.env["LOG_LEVEL"];
      else process.env["LOG_LEVEL"] = savedLevel;
    });

    it("says once per wait whether the client sent a token, and never the token", async () => {
      const secret = "secret-progress-value";
      await awaitPhone(extraWith(secret).extra, "approval", async () => "tapped");

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("waiting for the phone (approval)");
      expect(lines[0]).toContain("sent a progress token");
      expect(lines.join("")).not.toContain(secret);

      lines.length = 0;
      await awaitPhone(extraWith(undefined).extra, "sign-in", async () => "signed");

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("waiting for the phone (sign-in)");
      expect(lines[0]).toContain("sent no progress token");
    });
  });
});

describe("a hosted write waiting for the phone", () => {
  let node: MockNode;
  let h: Harness;
  const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };

  beforeEach(async () => {
    node = await startMockNode();
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());
  });

  afterEach(async () => {
    await h.close();
    await node.close();
  });

  const setup = async () => {
    const hub = fakeHub();
    const phone = slowPhone(hub);
    const client = await connect(deps(fakeStore(new Map([[USER, session()]])), hub));
    return { hub, phone, client };
  };

  async function preview(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
    const out = structured<{ status: string; confirm: string }>(
      await client.callTool({ name: "moi_transfer", arguments: TRANSFER }),
    );
    expect(out.status).toBe("preview");
    return out.confirm;
  }

  it("tells a client that asked for progress, and stops when the phone answers", async () => {
    const { phone, client } = await setup();
    const confirm = await preview(client);
    fakeClock();

    const seen: Progress[] = [];
    const call = client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm } }, undefined, {
      onprogress: (p) => seen.push(p),
    });
    await phone.asked;
    await vi.advanceTimersByTimeAsync(3 * PROGRESS_EVERY_MS);
    // The client strips the token, so what is left is the progress and the message, and, with no total sent, no total.
    expect(seen).toEqual([15, 30, 45].map((s) => ({ progress: s, message: NOTICE(s) })));

    phone.tap();
    expect(structured(await call)).toMatchObject({ status: "sent", hash: SENT_HASH });
    await vi.advanceTimersByTimeAsync(4 * PROGRESS_EVERY_MS);
    expect(seen).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing, and arms no timer, to a client that did not ask", async () => {
    const { phone, client } = await setup();
    const confirm = await preview(client);
    fakeClock();

    const call = client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm } });
    await phone.asked;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * PROGRESS_EVERY_MS);

    phone.tap();
    expect(structured(await call)).toMatchObject({ status: "sent", hash: SENT_HASH });
  });

  it("sends nothing for a preview or for a confirm that does not match", async () => {
    const { hub, client } = await setup();
    fakeClock();
    const seen: Progress[] = [];
    const onprogress = (p: Progress) => seen.push(p);

    const first = await client.callTool({ name: "moi_transfer", arguments: TRANSFER }, undefined, { onprogress });
    const bogus = await client.callTool(
      { name: "moi_transfer", arguments: { ...TRANSFER, confirm: "bogus" } },
      undefined,
      { onprogress },
    );

    expect(structured<{ status: string }>(first).status).toBe("preview");
    expect(structured<{ status: string }>(bogus).status).toBe("preview");
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "refuses on the phone",
      new MoiError(ErrorCode.USER_REJECTED, "You rejected it on the phone."),
      "user_rejected",
    ],
    [
      "does not answer in time",
      new MoiError(
        ErrorCode.REQUEST_TIMEOUT,
        "No answer from MOI Wallet within 240 seconds. Nothing was sent. Check the phone and try again.",
      ),
      "timeout",
    ],
  ])("clears the timer when the person %s", async (_label, err, reason) => {
    const { phone, client } = await setup();
    const confirm = await preview(client);
    fakeClock();

    const seen: Progress[] = [];
    const call = client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm } }, undefined, {
      onprogress: (p) => seen.push(p),
    });
    await phone.asked;
    await vi.advanceTimersByTimeAsync(PROGRESS_EVERY_MS);
    expect(seen).toHaveLength(1);

    phone.fail(err);
    expect(structured(await call)).toMatchObject({ status: "rejected", reason });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a stdio write waiting for the phone", () => {
  let node: MockNode;
  let h: Harness;

  beforeEach(async () => {
    node = await startMockNode();
    h = await startHarness(node.url);
  });

  afterEach(async () => {
    await h.close();
    await node.close();
  });

  it("also notifies on the stdio server, which waits through the same path", async () => {
    seedSession(h.home);
    const gate = deferred();
    const asked = deferred();
    installWallet(
      h.home,
      fakeWallet(async (req) => {
        asked.resolve();
        await gate.promise;
        return signatureFor(req);
      }),
    );

    const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };
    const first = await h.call("moi_transfer", TRANSFER);
    const token = (first.structuredContent as { confirm?: string }).confirm;
    expect(token).toBeTruthy();
    fakeClock();

    const seen: Progress[] = [];
    const call = h.client.callTool({ name: "moi_transfer", arguments: { ...TRANSFER, confirm: token } }, undefined, {
      onprogress: (p) => seen.push(p),
    });
    await asked.promise;
    await vi.advanceTimersByTimeAsync(2 * PROGRESS_EVERY_MS);
    expect(seen).toEqual([15, 30].map((s) => ({ progress: s, message: NOTICE(s) })));

    gate.resolve();
    expect(structured(await call)).toMatchObject({ status: "sent" });
    await vi.advanceTimersByTimeAsync(4 * PROGRESS_EVERY_MS);
    expect(seen).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
