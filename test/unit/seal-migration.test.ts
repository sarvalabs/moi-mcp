/**
 * The boot migration that seals the wallet pairings and the WalletConnect
 * state in place: the engine (against plain in-memory values, so the counting
 * rules are tested once), the atomic file replace, the boot function and its
 * stop, and the order main() runs it in. What differs per backend is in
 * wallet-seal-backends.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveKey, seal, unseal } from "../../src/auth/crypto.js";
import {
  replaceFile,
  sealValues,
  sealWalletStateOnBoot,
  walletConnectText,
  type StoredValue,
} from "../../src/wc/seal-migration.js";
import { WalletConnectHub } from "../../src/wc/hub.js";
import {
  FileKeyValueStorage,
  FileWalletSessionStore,
  walletSlot,
  WALLET_SESSION_KEY_LABEL,
  WC_STORAGE_KEY_LABEL,
} from "../../src/wc/store.js";
import { dappKey, SESSION_SECRET, session, walletKey, wcKey } from "../helpers/hosted.js";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "moi-seal-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = walletKey();
const OTHER_SECRET = "o".repeat(44);
const OTHER = walletKey(OTHER_SECRET);
const ZERO = { sealed: 0, alreadySealed: 0, unreadable: 0, failed: 0 };

/** The sealed text with one byte of its ciphertext changed. */
function flipped(sealed: string): string {
  const o = JSON.parse(sealed) as Record<string, string>;
  const bytes = Buffer.from(o["ct"]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return JSON.stringify({ ...o, ct: bytes.toString("base64url") });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Cell {
  aad: string;
  raw: string;
}

/** The cells as the engine sees them; replacing one changes its text, or throws for the aads in `failing`. */
function valuesOf(list: Cell[], failing: string[] = []): AsyncGenerator<StoredValue> {
  async function* run(): AsyncGenerator<StoredValue> {
    for (const cell of list) {
      yield {
        aad: cell.aad,
        raw: cell.raw,
        replace: (sealed) => {
          if (failing.includes(cell.aad)) throw new Error("disk full");
          cell.raw = sealed;
        },
      };
    }
  }
  return run();
}

const asIs = (raw: string): string | undefined => raw;

describe("sealValues", () => {
  it("seals a plain value so that it opens to exactly its own text", async () => {
    const list = [{ aad: "a", raw: '{"n":1, "kept":  "as written"}' }];
    expect(await sealValues(valuesOf(list), KEY, asIs)).toEqual({ ...ZERO, sealed: 1 });
    expect(unseal(list[0]!.raw, KEY, "a")).toBe('{"n":1, "kept":  "as written"}');
  });

  it("leaves a sealed value that opens alone, byte for byte, and never replaces it", async () => {
    const sealed = seal("x", KEY, "a");
    const list = [{ aad: "a", raw: sealed }];
    const replace = vi.fn();
    const counts = await sealValues(
      (async function* () {
        for (const c of list) yield { aad: c.aad, raw: c.raw, replace };
      })(),
      KEY,
      asIs,
    );
    expect(counts).toEqual({ ...ZERO, alreadySealed: 1 });
    expect(replace).not.toHaveBeenCalled();
    expect(list[0]!.raw).toBe(sealed);
  });

  it("keeps a value sealed under another key, or altered, or moved to another slot, and counts it unreadable", async () => {
    const list = [
      { aad: "a", raw: seal("x", OTHER, "a") },
      { aad: "b", raw: flipped(seal("x", KEY, "b")) },
      { aad: "c", raw: seal("x", KEY, "somewhere-else") },
    ];
    const before = list.map((c) => c.raw);
    expect(await sealValues(valuesOf(list), KEY, asIs)).toEqual({ ...ZERO, unreadable: 3 });
    expect(list.map((c) => c.raw)).toEqual(before);
  });

  it("counts a value the store does not recognise as unreadable and leaves it", async () => {
    const list = [{ aad: "a", raw: "not mine" }];
    expect(await sealValues(valuesOf(list), KEY, () => undefined)).toEqual({ ...ZERO, unreadable: 1 });
    expect(list[0]!.raw).toBe("not mine");
  });

  it("handles a mix, and a second run changes nothing", async () => {
    const list = [
      { aad: "p1", raw: '{"n":1}' },
      { aad: "p2", raw: '{"n":2}' },
      { aad: "s", raw: seal("x", KEY, "s") },
      { aad: "o", raw: seal("x", OTHER, "o") },
      { aad: "alt", raw: flipped(seal("x", KEY, "alt")) },
    ];
    expect(await sealValues(valuesOf(list), KEY, asIs)).toEqual({ sealed: 2, alreadySealed: 1, unreadable: 2, failed: 0 });
    const after = list.map((c) => c.raw);
    expect(await sealValues(valuesOf(list), KEY, asIs)).toEqual({ sealed: 0, alreadySealed: 3, unreadable: 2, failed: 0 });
    expect(list.map((c) => c.raw)).toEqual(after);
    expect(list).toHaveLength(5); // nothing was deleted
  });

  it("counts a failed replacement, leaves that value as it was, and still seals the others", async () => {
    const list = [
      { aad: "a", raw: '{"n":1}' },
      { aad: "b", raw: '{"n":2}' },
    ];
    expect(await sealValues(valuesOf(list, ["a"]), KEY, asIs)).toEqual({ ...ZERO, sealed: 1, failed: 1 });
    expect(list[0]!.raw).toBe('{"n":1}');
    expect(unseal(list[1]!.raw, KEY, "b")).toBe('{"n":2}');
    // Once the cause is gone, the next run finishes the job.
    expect(await sealValues(valuesOf(list), KEY, asIs)).toEqual({ ...ZERO, sealed: 1, alreadySealed: 1 });
  });

  it("never puts down a copy that does not open to the same text", async () => {
    // A lone surrogate does not survive UTF-8, so the copy would open to different text.
    const list = [{ aad: "a", raw: "plain" }];
    expect(await sealValues(valuesOf(list), KEY, () => "\ud800")).toEqual({ ...ZERO, failed: 1 });
    expect(list[0]!.raw).toBe("plain");
  });

  it("gives all zeros for nothing", async () => {
    expect(await sealValues(valuesOf([]), KEY, asIs)).toEqual(ZERO);
  });
});

describe("walletConnectText", () => {
  it("keeps JSON text as it is and turns any other text into a JSON string", () => {
    expect(walletConnectText('{"a":[1,2]}')).toBe('{"a":[1,2]}');
    expect(walletConnectText("123")).toBe("123");
    expect(walletConnectText("did:key:z6MkTestOnly")).toBe('"did:key:z6MkTestOnly"');
    expect(walletConnectText("")).toBe('""');
  });
});

// ---------------------------------------------------------------------------
// replaceFile
// ---------------------------------------------------------------------------

describe.each([
  ["", false],
  [" (durable)", true],
])("replaceFile%s", (_label, durable) => {
  it("puts the text in place with mode 0600 and leaves no temporary file", () => {
    const dir = freshDir();
    const file = join(dir, "v.json");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    replaceFile(file, "new", durable);
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["v.json"]);
  });

  it("leaves the old content when the temporary file cannot be written", () => {
    const dir = freshDir();
    const file = join(dir, "v.json");
    writeFileSync(file, "old");
    mkdirSync(`${file}.tmp`); // a directory where the temporary file must go
    expect(() => replaceFile(file, "new", durable)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// The boot function and its stop
// ---------------------------------------------------------------------------

describe("sealWalletStateOnBoot", () => {
  let lines: string[];
  let savedLevel: string | undefined;
  beforeEach(() => {
    lines = [];
    savedLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLevel === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = savedLevel;
  });

  const KEYCHAIN = ["wc@2", "core", "0.3", "keychain"];

  /** Both stores under one data directory, built the way main() builds them. */
  function stores(dir: string, secret?: string) {
    return {
      sessions: new FileWalletSessionStore(dir, walletKey(secret)),
      wcStorage: new FileKeyValueStorage(join(dir, "wc.db"), wcKey(secret)),
    };
  }
  function plantPairing(dir: string, userId: string, over: Record<string, unknown> = {}): void {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", `${walletSlot(userId)}.json`), `${JSON.stringify(session({ userId, ...over }), null, 2)}\n`);
  }
  function plantKeychain(dir: string, text = '{"symKey":"plain-key-material"}'): string {
    const file = join(dir, "wc.db", ...KEYCHAIN);
    mkdirSync(join(dir, "wc.db", ...KEYCHAIN.slice(0, -1)), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  it("seals both stores, logs one line with the counts only, and does not stop for a pairing it cannot open", async () => {
    const dir = freshDir();
    plantPairing(dir, "alice@example.com", { topic: "TOPIC-SECRET", address: "0xADDRESSSECRET" });
    await new FileWalletSessionStore(dir, OTHER).set(session({ userId: "bob", topic: "t-bob" }));
    plantKeychain(dir);

    const report = await sealWalletStateOnBoot(stores(dir));

    expect(report).toEqual({
      sessions: { sealed: 1, alreadySealed: 0, unreadable: 1, failed: 0 },
      wcStorage: { sealed: 1, alreadySealed: 0, unreadable: 0, failed: 0 },
    });
    expect(lines).toEqual([
      "[moi-mcp] error: wallet state: pairings sealed 1, already sealed 0, unreadable 1, failed 0; walletconnect sealed 1, already sealed 0, unreadable 0, failed 0\n",
    ]);
    for (const secret of ["alice", "TOPIC-SECRET", "0xADDRESSSECRET", dir, "MOI_SESSION_KEY", SESSION_SECRET, "plain-key-material"]) {
      expect(lines[0], secret).not.toContain(secret);
    }
    const { sessions, wcStorage } = stores(dir);
    expect((await sessions.get("alice@example.com"))?.topic).toBe("TOPIC-SECRET");
    expect(await wcStorage.getItem("wc@2:core:0.3//keychain")).toEqual({ symKey: "plain-key-material" });
  });

  it("is quiet at the default log level when everything is fine, and says so at info", async () => {
    delete process.env["LOG_LEVEL"];
    await sealWalletStateOnBoot(stores(freshDir()));
    expect(lines).toEqual([]);

    process.env["LOG_LEVEL"] = "info";
    await sealWalletStateOnBoot(stores(freshDir()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[moi-mcp\] info: wallet state: pairings sealed 0, already sealed 0, unreadable 0, failed 0; /);
  });

  it("is safe to run twice: the second run changes nothing", async () => {
    const dir = freshDir();
    plantPairing(dir, "alice");
    const file = plantKeychain(dir);
    await sealWalletStateOnBoot(stores(dir));
    const after = readFileSync(file, "utf8");

    const second = await sealWalletStateOnBoot(stores(dir));
    expect(second).toEqual({
      sessions: { ...ZERO, alreadySealed: 1 },
      wcStorage: { ...ZERO, alreadySealed: 1 },
    });
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(lines).toHaveLength(2);
  });

  describe("the stop", () => {
    it("refuses to go on when the WalletConnect state does not open, changes nothing, and works again with the right key", async () => {
      const dir = freshDir();
      const original = stores(dir);
      await original.wcStorage.setItem("wc@2:core:0.3//keychain", { symKey: "k" });
      const file = join(dir, "wc.db", ...KEYCHAIN);
      const before = readFileSync(file, "utf8");

      // The key is changed, or mistyped. What the SDK would see is "no key chain", and it would write a new one over this.
      const wrong = stores(dir, OTHER_SECRET);
      expect(await wrong.wcStorage.getItem("wc@2:core:0.3//keychain")).toBeUndefined();

      await expect(sealWalletStateOnBoot(wrong)).rejects.toThrow(/does not open with MOI_SESSION_KEY/);
      await expect(sealWalletStateOnBoot(wrong)).rejects.toThrow(/put the original value back in \.env/);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(lines.at(-1)).toContain("walletconnect sealed 0, already sealed 0, unreadable 1, failed 0");

      // The original key, and nothing is lost.
      await expect(sealWalletStateOnBoot(original)).resolves.toBeDefined();
      expect(await original.wcStorage.getItem("wc@2:core:0.3//keychain")).toEqual({ symKey: "k" });
    });

    it("says what to do in words only: no path, no key, no count", async () => {
      const dir = freshDir();
      await stores(dir).wcStorage.setItem("wc@2:core:0.3//keychain", 1);
      const err = (await sealWalletStateOnBoot(stores(dir, OTHER_SECRET)).catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/sessions\/ and wc\.db\//);
      expect(err.message).toMatch(/moi:wc:\*/);
      expect(err.message).toMatch(/everyone pairs again/);
      for (const secret of [dir, SESSION_SECRET, OTHER_SECRET, "unreadable"]) expect(err.message, secret).not.toContain(secret);
    });

    it("also stops when a plain WalletConnect value could not be sealed, leaving it as it was", async () => {
      const dir = freshDir();
      const file = plantKeychain(dir);
      mkdirSync(`${file}.tmp`); // the temporary file cannot be written
      await expect(sealWalletStateOnBoot(stores(dir))).rejects.toThrow(/could not be sealed/);
      expect(readFileSync(file, "utf8")).toBe('{"symKey":"plain-key-material"}');
      expect(lines.at(-1)).toContain("walletconnect sealed 0, already sealed 0, unreadable 0, failed 1");
    });

    it("does not stop for pairing records alone: they are counted, and the person pairs again", async () => {
      const dir = freshDir();
      await new FileWalletSessionStore(dir, OTHER).set(session({ userId: "bob" }));
      const report = await sealWalletStateOnBoot(stores(dir));
      expect(report.sessions.unreadable).toBe(1);
      expect(report.wcStorage).toEqual(ZERO);
    });
  });
});

// ---------------------------------------------------------------------------
// The order main() runs it in
// ---------------------------------------------------------------------------

describe("the hosted server's wiring for wallet state", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = readFileSync(join(root, "src/server.ts"), "utf8");
  const at = (needle: string) => {
    const i = server.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  // main() is not exported (the isMain guard), so the order it runs in is pinned against the source: the keys, then the
  // stores, then the migration, then anything that can start the WalletConnect client, read a record or listen.
  it("derives both keys, builds the four stores with them, then seals, before the client starts or the server listens", () => {
    const keys = [
      at("deriveKey(hosted.MOI_SESSION_KEY, WALLET_SESSION_KEY_LABEL)"),
      at("deriveKey(hosted.MOI_SESSION_KEY, WC_STORAGE_KEY_LABEL)"),
    ];
    const stores = [
      at("new RedisWalletSessionStore(redis, walletKey)"),
      at("new RedisKeyValueStorage(redis, wcKey)"),
      at("new FileWalletSessionStore(hosted.dataDir, walletKey)"),
      at('new FileKeyValueStorage(join(hosted.dataDir, "wc.db"), wcKey)'),
    ];
    const seals = at("await sealWalletStateOnBoot({ sessions: store, wcStorage })");
    const later = [at("mountAuth(app"), at("WalletConnectHub.init("), at("downloads.mountDownloads("), at("app.listen(")];
    expect(Math.max(...keys)).toBeLessThan(Math.min(...stores));
    expect(Math.max(...stores)).toBeLessThan(seals);
    for (const i of later) expect(seals).toBeLessThan(i);
    at("storage: wcStorage");
  });

  it("never logs the new keys", () => {
    expect(server).not.toMatch(/\$\{[^}]*(walletKey|wcKey)/);
    expect(server).not.toMatch(/log\([^;]*(walletKey|wcKey)/s);
  });

  it("derives each store's key under its own label", () => {
    expect(WALLET_SESSION_KEY_LABEL).toBe("wallet-session");
    expect(WC_STORAGE_KEY_LABEL).toBe("wc-storage");
    expect(walletKey().equals(deriveKey(SESSION_SECRET, WALLET_SESSION_KEY_LABEL))).toBe(true);
    expect(wcKey().equals(deriveKey(SESSION_SECRET, WC_STORAGE_KEY_LABEL))).toBe(true);
    const all = [walletKey(), wcKey(), dappKey()].map((k) => k.toString("hex"));
    expect(new Set(all).size).toBe(3);
  });

  it("cannot build the hosted hub without a storage, so there is no plain fallback", () => {
    // @ts-expect-error storage is required: `npm run typecheck` fails if this stops being an error
    const attempt = () => WalletConnectHub.init({ projectId: "p", home: "/nowhere", network: "voyage", requestTimeoutMs: 1 });
    expect(typeof attempt).toBe("function"); // never called: it would start a real client
  });
});
