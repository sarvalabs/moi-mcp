/**
 * Chain reads. No MCP imports — plain TS library.
 *
 * Every function returns the exact shape declared in schema.*Output so the
 * tool layer can hand the result straight to structuredContent.
 */

import { AssetId, AssetStandard, OpType, type JsonRpcProvider } from "js-moi-sdk";
import { z } from "zod";

import { MoiError, asRpcError } from "../moi-error.js";
import {
  ErrorCode,
  GetAccountOutput,
  GetAssetOutput,
  GetInteractionOutput,
  GetLogicOutput,
} from "../schema.js";

// ---------------------------------------------------------------------------
// Amount handling
// ---------------------------------------------------------------------------

/** RPC returns quantities as hex strings ("0x1e"), decimal strings, or numbers. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return 0n;
    try {
      return /^0[xX]/.test(s) ? BigInt(s) : BigInt(s);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Scale a raw integer amount by an asset's dimension into an exact decimal
 * string. Never uses floating point — MOI supplies are up to 2^64 and a
 * double would silently lose precision above 2^53.
 *
 * normalizeAmount(1500n, 2) === "15"
 * normalizeAmount(1234n, 6) === "0.001234"
 */
export function normalizeAmount(raw: unknown, dimension: number): string {
  const value = toBigInt(raw);
  const scale = Number.isFinite(dimension) ? Math.max(0, Math.trunc(dimension)) : 0;
  if (scale === 0) return value.toString();

  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();

  const digits = fraction.toString().padStart(scale, "0").replace(/0+$/, "");
  return `${whole}.${digits}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type Provider = JsonRpcProvider;

/** MOI ids are typed (participant/asset/logic); the SDK validates the kind. */
export function invalidId(kind: string, value: string, err: unknown): MoiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new MoiError(ErrorCode.INVALID_ARGS, `Not a valid MOI ${kind} id: ${value}. ${detail}`, {
    value,
  });
}

/** Longest list a read tool hands back; beyond it the model is not reading anyway. */
const MAX_LIST = 200;

/**
 * A string that came from the chain (a symbol, a routine name) cut to a
 * sane length with control characters removed. Asset symbols are chosen by
 * whoever creates the asset, which makes them the one place an outsider can
 * put words in front of the model.
 */
export function clampChainText(text: unknown, max = 64): string {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

/** How long an extra read waits for the node: the Deeds read of an account, and each of the two pool reads of an interaction. */
export const EXTRA_READ_TIMEOUT_MS = 20_000;

/**
 * `work`, or a REQUEST_TIMEOUT once `ms` have passed. The provider's request is a bare fetch that cannot be cancelled, so it can
 * run on after this gives up; Promise.race has already attached to it, so a late failure is handled and does not become an
 * unhandled rejection. src/capabilities/reads/rpc-tools.ts has the same helper for the node-method tools; this file cannot
 * import it, because that file imports the read tools, which import this one.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MoiError(ErrorCode.REQUEST_TIMEOUT, `${what}: the node did not answer in time.`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * `deeds: true` also reads the assets the account created (moi.Deeds), and waits at most `timeoutMs` for it. Only the tool asks
 * for it: the write tools use this function for the balance check before a transfer and need the balances alone, and without
 * it they make no extra node call and wait for nothing extra.
 */
export async function getAccount(
  provider: Provider,
  address: string,
  options: { deeds?: boolean; timeoutMs?: number } = {},
): Promise<z.infer<typeof GetAccountOutput>> {
  let state: Awaited<ReturnType<Provider["getAccountState"]>>;
  try {
    state = await provider.getAccountState(address);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("participant", address, err);
    throw asRpcError(err, `moi.AccountState(${address})`);
  }

  // AccountState carries no `nonce` field despite the SDK's type claiming one
  // — the node simply does not return it, so reading it yields undefined and
  // silently reports 0. The real counter is the per-key interaction count.
  let nonce = 0;
  try {
    nonce = Number(toBigInt(await provider.getInteractionCount(address, 0)));
  } catch {
    // Non-fatal: an unregistered account has no count.
  }

  // A participant with no state has never been registered on chain.
  let isRegistered = true;
  try {
    const meta = await provider.getAccountMetaInfo(address);
    isRegistered = Boolean(meta?.state_exists ?? true);
  } catch {
    // Non-fatal: meta info is a nicety, the account state above is the truth.
  }

  // TDU = the account's holdings: one entry for each asset and token id it holds, kept as the node lists them. An asset
  // with several token ids has several rows, and nothing here caps or sums them, so the balance check before a transfer
  // (which looks an asset up by id) still sees every asset.
  const balances: Array<{ assetId: string; symbol?: string; tokenId: string; amount: string }> = [];
  try {
    const tdu = (await provider.getTDU(address)) as unknown as Array<Record<string, unknown>>;
    for (const entry of tdu ?? []) {
      const assetId = String(entry["asset_id"] ?? entry["token_id"] ?? "");
      if (!/^0x[0-9a-fA-F]+$/.test(assetId)) continue;
      // The provider has already turned token_id into a number or a bigint (and fails the whole read for a row that has
      // none), so every row has one. A decimal string, because a token id can pass 2^53.
      balances.push({
        assetId,
        tokenId: toBigInt(entry["token_id"]).toString(),
        amount: toBigInt(entry["amount"]).toString(),
      });
    }
  } catch (err) {
    throw asRpcError(err, `moi.TDU(${address})`);
  }

  void state;
  const result: z.infer<typeof GetAccountOutput> = {
    address,
    nonce,
    balances,
    isRegistered,
  };
  if (options.deeds) Object.assign(result, await readDeeds(provider, address, options.timeoutMs ?? EXTRA_READ_TIMEOUT_MS));
  return result;
}

/** The most deeds moi_get_account lists. */
export const MAX_DEEDS = 50;

/**
 * The assets the account created, from the node's Deeds read (the provider's getRegistry). A failure of this one read, or a
 * node that does not answer it, must not fail or hold up the account read, so every throw becomes deedsError. The sentence is
 * fixed on purpose: the node's own message can carry its address, and this runs on a public gateway.
 */
async function readDeeds(
  provider: Provider,
  address: string,
  timeoutMs: number,
): Promise<Pick<z.infer<typeof GetAccountOutput>, "deeds" | "deedsTruncated" | "deedsError">> {
  let listed: unknown;
  try {
    listed = await withTimeout(provider.getRegistry(address), timeoutMs, "moi.Deeds");
  } catch {
    return {
      deedsError: "The node's Deeds read failed or did not answer in time, so the assets this account created are not listed.",
    };
  }
  // The provider types the answer as one Registry; the node sends a list of them.
  const entries: unknown[] = Array.isArray(listed) ? listed : listed && typeof listed === "object" ? [listed] : [];
  const deeds: Array<{ assetId: string; symbol: string }> = [];
  let truncated = false;
  for (const entry of entries) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const assetId = record["asset_id"];
    if (typeof assetId !== "string" || !/^0x[0-9a-fA-F]+$/.test(assetId)) continue;
    if (deeds.length >= MAX_DEEDS) {
      truncated = true;
      break;
    }
    const info = (record["asset_info"] ?? {}) as Record<string, unknown>;
    // An asset's symbol is written by whoever created it.
    deeds.push({ assetId, symbol: clampChainText(info["symbol"] ?? "") });
  }
  return { deeds, ...(truncated ? { deedsTruncated: true } : {}) };
}

export async function getAsset(
  provider: Provider,
  assetId: string,
): Promise<z.infer<typeof GetAssetOutput>> {
  let info: Awaited<ReturnType<Provider["getAssetInfoByAssetID"]>>;
  try {
    info = await provider.getAssetInfoByAssetID(assetId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("asset", assetId, err);
    throw asRpcError(err, `moi.AssetInfoByAssetID(${assetId})`);
  }

  // Two different numbers since the September 2026 upgrade. `decimals` is how
  // far an amount is scaled (KMOI reports 9). `dimension` is the asset's kind:
  // 0 Economic, 1 Possession. Reading amounts off `dimension`, as this did
  // when the chain had only one field, scales every KMOI amount by 1e9 too
  // little.
  const decimals = Number(toBigInt(info.decimals ?? 0));
  const dimension = Number(toBigInt(info.dimension ?? 0));

  return {
    assetId,
    symbol: clampChainText(info.symbol ?? ""),
    standard: assetStandardName(assetId),
    supply: normalizeAmount(info.circulating_supply ?? info.max_supply ?? 0, decimals),
    decimals,
    dimension,
    owner: info.creator ?? info.manager ?? "0x0",
    isLogical: Boolean(info.logic_id),
    ...(info.logic_id ? { logicId: info.logic_id } : {}),
  };
}

/** Receipt status is numeric on the wire; 0 means the interaction succeeded. */
function receiptStatus(status: unknown): "pending" | "success" | "failed" | "unknown" {
  const n = Number(toBigInt(status));
  if (Number.isNaN(n)) return "unknown";
  return n === 0 ? "success" : "failed";
}

/** `timeoutMs` is how long each of the two pool reads waits when the interaction has no receipt; only tests change it. */
export async function getInteraction(
  provider: Provider,
  hash: string,
  options: { timeoutMs?: number } = {},
): Promise<z.infer<typeof GetInteractionOutput>> {
  let ix: Record<string, unknown>;
  try {
    ix = (await provider.getInteractionByHash(hash)) as unknown as Record<string, unknown>;
  } catch (err) {
    throw asRpcError(err, `moi.InteractionByHash(${hash})`);
  }

  // The receipt carries execution status; it is absent while still pending.
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = (await provider.getInteractionReceipt(hash)) as unknown as Record<string, unknown>;
  } catch {
    receipt = undefined;
  }

  const rawOps = (ix["ix_operations"] ?? ix["operations"] ?? []) as Array<Record<string, unknown>>;
  const operations = (Array.isArray(rawOps) ? rawOps : []).slice(0, MAX_LIST).map((op) => ({
    // Name the op rather than emitting a bare enum value — an agent reading
    // "ASSET_INVOKE" can act on it; "5" tells it nothing.
    type: opTypeName(op["type"] ?? op["tx_type"]),
    payload: (op["payload"] ?? op["data"] ?? {}) as Record<string, unknown>,
  }));

  const out: z.infer<typeof GetInteractionOutput> = {
    hash,
    status: receipt ? receiptStatus(receipt["status"]) : "pending",
    // The interaction's `sender` is an object ({id, sequence, key_id}); the
    // receipt's `from` is already the participant id. Prefer the latter and
    // reach into the former rather than stringifying an object.
    sender: senderId(receipt?.["from"] ?? ix["sender"]),
    operations,
  };

  if (receipt?.["fuel_used"] !== undefined) {
    out.fuelUsed = Number(toBigInt(receipt["fuel_used"]));
  }
  if (receipt) {
    out.receipt = receipt;
  } else {
    // No receipt: the interaction is waiting, and the node's pool is where it waits. Ask the pool why, so the answer to
    // "is it stuck" does not stop at "pending".
    Object.assign(out, await explainPending(provider, hash, ix, options.timeoutMs ?? EXTRA_READ_TIMEOUT_MS));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Why an interaction is still pending
// ---------------------------------------------------------------------------

type Pool = NonNullable<z.infer<typeof GetInteractionOutput>["pool"]>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One side of the pool's answer for a sender, pending or queued, as [nonce, entry] pairs. The provider hands each side back as a Map keyed by nonce. */
function poolEntries(side: unknown): Array<[bigint, Record<string, unknown>]> {
  if (!(side instanceof Map)) return [];
  return [...side.entries()].map(([nonce, entry]): [bigint, Record<string, unknown>] => [toBigInt(nonce), isRecord(entry) ? entry : {}]);
}

/**
 * The interaction's nonce, which is only used to count what is ahead of it. No real moi.InteractionByHash answer has been
 * observed: the SDK's response type says `nonce`, the mock and the request side say `sender.sequence`, and the node's account
 * keys say `sequence_id`. The first of the three that is a number or numeric text is used; with none there is no `ahead`. A
 * number that is not finite (JSON.parse reads 1e400 as Infinity) is not usable: BigInt would throw on it, and a pool question
 * that goes wrong must not fail the read.
 */
function nonceOf(ix: Record<string, unknown>): bigint | undefined {
  const sender = isRecord(ix["sender"]) ? ix["sender"] : {};
  for (const raw of [ix["nonce"], sender["sequence"], sender["sequence_id"]]) {
    const usable =
      (typeof raw === "number" && Number.isFinite(raw)) ||
      typeof raw === "bigint" ||
      (typeof raw === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(raw.trim()));
    if (usable) return toBigInt(raw);
  }
  return undefined;
}

/**
 * Where the sender's pool entries put this interaction: the pending or queued entry whose hash is this one's. In neither list
 * it is "not_listed", which is weaker than "dropped" on purpose: the receipt read above treats any failure as no receipt, so
 * the same answer is an interaction that was just included, or replaced, or whose receipt read failed. `ahead` counts the
 * sender's pool entries with a lower nonce, only when the nonce is known, and only what the pool holds.
 */
function locateInPool(content: unknown, hash: string, nonce: bigint | undefined): Pick<Pool, "state" | "ahead"> {
  const body = isRecord(content) ? content : {};
  const pending = poolEntries(body["pending"]);
  const queued = poolEntries(body["queued"]);
  const wanted = hash.toLowerCase();
  const isMine = ([, entry]: [bigint, Record<string, unknown>]): boolean =>
    typeof entry["hash"] === "string" && entry["hash"].toLowerCase() === wanted;
  const state = pending.some(isMine) ? "pending" : queued.some(isMine) ? "queued" : undefined;
  if (state === undefined) return { state: "not_listed" };
  return { state, ...(nonce !== undefined ? { ahead: [...pending, ...queued].filter(([key]) => key < nonce).length } : {}) };
}

/**
 * What the node's pool says about the sender of an interaction that has no receipt: ixpool.ContentFrom for where it sits
 * and what is ahead of it, ixpool.WaitTime for whether the sender's wait has expired. The provider types getWaitTime as a
 * number, but the node answers { expired, time }; only `expired` is read, because the unit of `time` is not stated. Either
 * call may fail, or not answer within `timeoutMs`, alone. The error sentence names the method and never carries the node's
 * message.
 */
async function explainPending(
  provider: Provider,
  hash: string,
  ix: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ pool?: Pool; poolError?: string }> {
  const sender = senderId(ix["sender"]);
  if (sender === "0x0") {
    return { poolError: "The sender of this interaction could not be read, so the pool was not asked about it." };
  }
  const [content, wait] = await Promise.allSettled([
    withTimeout(provider.getContentFrom(sender), timeoutMs, "ixpool.ContentFrom"),
    withTimeout(provider.getWaitTime(sender), timeoutMs, "ixpool.WaitTime"),
  ]);
  const pool: Pool = {};
  const failed: string[] = [];

  if (content.status === "fulfilled") {
    Object.assign(pool, locateInPool(content.value as unknown, hash, nonceOf(ix)));
  } else {
    failed.push("ixpool.ContentFrom");
  }
  if (wait.status === "fulfilled") {
    const answer = wait.value as unknown;
    if (isRecord(answer) && typeof answer["expired"] === "boolean") pool.waitExpired = answer["expired"];
  } else {
    failed.push("ixpool.WaitTime");
  }

  return {
    ...(Object.keys(pool).length > 0 ? { pool } : {}),
    ...(failed.length > 0
      ? { poolError: `The pool could not be read in full (${failed.join(" and ")} failed), so what it says about this interaction is incomplete.` }
      : {}),
  };
}

const ROUTINE_KINDS = new Set(["invoke", "deploy", "enlist", "view"]);

/** Map a manifest routine's declared kind onto the four the schema allows. */
function routineKind(raw: unknown): "invoke" | "deploy" | "enlist" | "view" {
  const k = String(raw ?? "").toLowerCase();
  if (ROUTINE_KINDS.has(k)) return k as "invoke" | "deploy" | "enlist" | "view";
  // Cocolang marks read-only routines with a `!` mutability flag in some
  // manifest versions; anything not otherwise named is treated as invoke.
  return k.includes("view") || k.includes("read") ? "view" : "invoke";
}

export async function getLogic(
  provider: Provider,
  logicId: string,
): Promise<z.infer<typeof GetLogicOutput>> {
  let manifest: unknown;
  try {
    // "JSON" encoding returns a parsed manifest rather than POLO bytes.
    manifest = await provider.getLogicManifest(logicId, "JSON" as never);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("logic", logicId, err);
    throw asRpcError(err, `moi.LogicManifest(${logicId})`);
  }

  const parsed = (typeof manifest === "string" ? safeJson(manifest) : manifest) as
    | Record<string, unknown>
    | undefined;

  const elements = (parsed?.["elements"] ?? []) as Array<Record<string, unknown>>;
  // The wire format names routines "callable" (js-moi-utils ElementType.ROUTINE
  // === "callable"; the SDK's own logic-driver matches on it). Filtering on
  // "routine" returned zero routines for every real logic. Accept both, since
  // "routine" is the name the enum KEY uses and may appear in older manifests.
  const routines = (Array.isArray(elements) ? elements : []).slice(0, MAX_LIST)
    .filter((el) => ["callable", "routine"].includes(String(el["kind"] ?? "")))
    .map((el) => {
      const data = (el["data"] ?? {}) as Record<string, unknown>;
      const accepts = (data["accepts"] ?? []) as Array<Record<string, unknown>>;
      const returns = (data["returns"] ?? []) as Array<Record<string, unknown>>;
      const field = (f: Record<string, unknown>) => ({
        name: clampChainText(f["label"] ?? f["name"] ?? ""),
        type: String(f["type"] ?? ""),
      });
      return {
        name: clampChainText(data["name"] ?? ""),
        kind: routineKind(data["kind"] ?? data["mode"]),
        inputs: (Array.isArray(accepts) ? accepts : []).map(field),
        outputs: (Array.isArray(returns) ? returns : []).map(field),
      };
    });

  const name = parsed?.["name"];

  return {
    logicId,
    ...(typeof name === "string" ? { name } : {}),
    routines,
  };
}

/**
 * AssetInfo carries no `standard` field — the standard is encoded in the asset
 * identifier itself (bytes 2..3). Decode it and name it (MAS0/MAS1/...).
 */
export function assetStandardName(assetId: string): string {
  try {
    const code = new AssetId(assetId as `0x${string}`).getStandard();
    return (AssetStandard as unknown as Record<number, string>)[code] ?? `UNKNOWN(${code})`;
  } catch {
    return "";
  }
}

/** Map an OpType value onto its name, tolerating hex or decimal. */
export function opTypeName(raw: unknown): string {
  if (raw == null) return "unknown";
  const code = Number(toBigInt(raw));
  const name = (OpType as unknown as Record<number, string>)[code];
  return name ?? String(raw);
}

/** Pull a participant id out of either a bare string or a sender object. */
export function senderId(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const id = (raw as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
    if (id && typeof id === "object" && "toHex" in id) {
      return (id as { toHex: () => string }).toHex();
    }
  }
  return "0x0";
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
