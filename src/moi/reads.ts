/**
 * Chain reads. No MCP imports — plain TS library.
 *
 * Every function returns the exact shape declared in schema.*Output so the
 * tool layer can hand the result straight to structuredContent.
 */

import { AssetId, AssetStandard, KMOI_ASSET_ID, OpType, type JsonRpcProvider } from "js-moi-sdk";
import { z } from "zod";

import { clip, limitDepth } from "../bounds.js";
import { MoiError, asRpcError } from "../moi-error.js";
import {
  BALANCES_DEFAULT_LIMIT,
  BALANCES_MAX_LIMIT,
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

/** The most operations moi_get_interaction lists; operationCount says how many the interaction has. */
export const MAX_OPS = 20;
/** The most characters of JSON an operation's payload keeps, and the receipt. A longer one is cut (see capRecord and capReceipt). */
export const MAX_PAYLOAD_CHARS = 1_000;
export const MAX_RECEIPT_CHARS = 2_000;
/** Once a payload or receipt is over its limit, the longest any one text in it may be: an id or a hash (66 characters) keeps its place, calldata and a manifest do not. */
export const MAX_LEAF_CHARS = 200;
/** The most callable routines moi_get_logic lists, and the most characters of JSON they may take between them. */
export const MAX_LOGIC_ROUTINES = 100;
export const MAX_LOGIC_CHARS = 12_000;
/** The most inputs, and the most outputs, listed for one routine, and the longest a type is kept. */
export const MAX_LOGIC_FIELDS = 16;
export const MAX_TYPE_CHARS = 128;

/** `value` with every text over MAX_LEAF_CHARS shortened to that length and ended with an ellipsis. Only called on parsed JSON that capRecord has already cut to MAX_DEPTH, so the recursion is shallow. */
function shortenTexts(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_LEAF_CHARS ? `${clip(value, MAX_LEAF_CHARS)}\u2026` : value;
  if (Array.isArray(value)) return value.map(shortenTexts);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, shortenTexts(v)]));
  }
  return value;
}

export interface CappedRecord {
  value: Record<string, unknown>;
  /** True when anything at all was cut: nesting, a long text, or the whole record. */
  truncated: boolean;
  /** True only when the record was replaced by { truncated: true, chars, preview }. */
  replaced: boolean;
}

const bigintAsText = (_key: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

/**
 * A record from the chain (an operation's payload, a receipt, an agent's card) held to `max` characters of JSON, in three
 * tiers. Within the limit it comes back as a plain JSON copy (a bigint becomes its decimal digits, so the answer can be
 * serialised). Over it, every text longer than MAX_LEAF_CHARS is shortened and ends in an ellipsis; if that fits, that is the
 * answer, and every key, id and status is still where it was. Still over, the record is replaced by
 * { truncated: true, chars, preview }: chars is its full length and preview its first `max` characters. That is still a
 * record, so it passes an output schema that asks for one. Nesting deeper than MAX_DEPTH is cut first: JSON.stringify
 * overflows the stack at about 100,000 levels, and this is chain data. A value that is not a plain object (undefined, a
 * string, a list) becomes {} or { value }, so z.record holds.
 */
export function capRecord(value: unknown, max: number): CappedRecord {
  const shallow = limitDepth(value);
  const inner = shallow.value;
  const record: Record<string, unknown> =
    isRecord(inner) && !Array.isArray(inner) ? inner : inner === undefined || inner === null ? {} : { value: inner };
  const json = JSON.stringify(record, bigintAsText);
  if (json.length <= max) {
    return { value: JSON.parse(json) as Record<string, unknown>, truncated: shallow.truncated, replaced: false };
  }
  const shorter = shortenTexts(JSON.parse(json)) as Record<string, unknown>;
  if (JSON.stringify(shorter).length <= max) return { value: shorter, truncated: true, replaced: false };
  return { value: { truncated: true, chars: json.length, preview: clip(json, max) }, truncated: true, replaced: true };
}

/**
 * The receipt as shown, held to `max`: capRecord's tiers with one more before the last. `participants` (the state hash and
 * context changes of every account the interaction touched, about 650 characters each) is most of a real receipt and says
 * nothing about what its operations did, so when shortening texts is not enough it is left out, and `participantsOmitted` says
 * how many entries there were. Each operation's status and data (a deploy's data.logic_id) stay in view. Only a receipt whose
 * operations alone pass `max` is replaced by its preview.
 */
export function capReceipt(receipt: Record<string, unknown>, max: number): CappedRecord {
  const whole = capRecord(receipt, max);
  const participants = receipt["participants"];
  if (!whole.replaced || !Array.isArray(participants)) return whole;
  const rest: Record<string, unknown> = { ...receipt, participantsOmitted: participants.length };
  delete rest["participants"];
  const slim = capRecord(rest, max);
  return slim.replaced ? whole : { ...slim, truncated: true };
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
  // with several token ids has several rows, and nothing here caps, sorts, pages or sums them: the balance check before a
  // transfer, a mint or a create looks an asset up by id in this list and must see every row. The tool pages the answer
  // afterwards with pageBalances, and nothing else does.
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

type Account = z.infer<typeof GetAccountOutput>;

export interface BalanceRequest {
  /** Only this asset's rows; compared without regard to letter case. */
  assetId?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

const KMOI_ID = String(KMOI_ASSET_ID).toLowerCase();
const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const wholeNumber = (n: unknown, fallback: number): number => (typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : fallback);

/**
 * The account answer as moi_get_account shows it: only `assetId`'s rows when it is given, KMOI first, the rest by asset id
 * and then token id (a number), and one page of that. Sorting makes the pages the same on every call whatever order the
 * node lists rows in; amounts are not a sort key, because they are base units of assets with different decimals and a
 * sender who dusts the account picks them. `total` is present only when the page is not the whole list, `truncated` and
 * `nextOffset` only when more rows follow. `account` is not changed. ONLY the tool handler calls this: every other caller
 * of getAccount needs every row.
 */
export function pageBalances(account: Account, request: BalanceRequest = {}): Account {
  const wanted = request.assetId?.toLowerCase();
  const rows = account.balances
    .filter((b) => wanted === undefined || b.assetId.toLowerCase() === wanted)
    .sort((a, b) => {
      const x = a.assetId.toLowerCase();
      const y = b.assetId.toLowerCase();
      if (x !== y) return x === KMOI_ID ? -1 : y === KMOI_ID ? 1 : ascending(x, y);
      const tx = BigInt(a.tokenId ?? "0");
      const ty = BigInt(b.tokenId ?? "0");
      return tx < ty ? -1 : tx > ty ? 1 : 0;
    });
  const offset = Math.max(0, wholeNumber(request.offset, 0));
  const limit = Math.min(BALANCES_MAX_LIMIT, Math.max(1, wholeNumber(request.limit, BALANCES_DEFAULT_LIMIT)));
  const page = rows.slice(offset, offset + limit);
  const more = offset + page.length < rows.length;
  return {
    ...account,
    balances: page,
    ...(rows.length !== page.length ? { total: rows.length } : {}),
    ...(more ? { truncated: true, nextOffset: offset + page.length } : {}),
  };
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

/**
 * `timeoutMs` is how long each of the two pool reads waits when the interaction has no receipt; only tests change it.
 * `explorerUrl` builds the explorer link for the note when something was cut; it is a parameter because src/moi reads no config.
 */
export async function getInteraction(
  provider: Provider,
  hash: string,
  options: { timeoutMs?: number; explorerUrl?: (hash: string) => string } = {},
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

  const rawOps = ix["ix_operations"] ?? ix["operations"] ?? [];
  const list = Array.isArray(rawOps) ? (rawOps as unknown[]) : [];
  let payloadsCut = 0;
  const operations = list.slice(0, MAX_OPS).map((item) => {
    const op = isRecord(item) ? item : {};
    const payload = capRecord(op["payload"] ?? op["data"], MAX_PAYLOAD_CHARS);
    if (payload.truncated) payloadsCut += 1;
    return {
      // Name the op rather than emitting a bare enum value — an agent reading
      // "ASSET_INVOKE" can act on it; "5" tells it nothing.
      type: clampChainText(opTypeName(op["type"] ?? op["tx_type"]), 32),
      payload: payload.value,
    };
  });

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
  let receiptCut = false;
  if (receipt) {
    // status, sender and fuelUsed above were read from the whole receipt; only the copy shown is cut.
    const shown = capReceipt(receipt, MAX_RECEIPT_CHARS);
    out.receipt = shown.value;
    receiptCut = shown.truncated;
  } else {
    // No receipt: the interaction is waiting, and the node's pool is where it waits. Ask the pool why, so the answer to
    // "is it stuck" does not stop at "pending".
    Object.assign(out, await explainPending(provider, hash, ix, options.timeoutMs ?? EXTRA_READ_TIMEOUT_MS));
  }

  const parts: string[] = [];
  if (list.length > operations.length) parts.push(`Showing ${operations.length} of ${list.length} operations.`);
  if (payloadsCut > 0) parts.push(`${payloadsCut} operation payload${payloadsCut === 1 ? " was" : "s were"} cut short.`);
  if (receiptCut) parts.push("The receipt was cut short.");
  if (parts.length > 0) {
    out.truncated = true;
    if (list.length > operations.length) out.operationCount = list.length;
    out.note = [...parts, ...(options.explorerUrl ? [`The whole interaction: ${options.explorerUrl(hash)}`] : [])].join(" ");
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

type Routine = {
  name: string;
  kind: "invoke" | "deploy" | "enlist" | "view";
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
  truncated?: true;
};

/**
 * One callable element as a listed routine. A manifest is its author's text, so a name and a type are cleaned and cut, a
 * list of fields is cut at MAX_LOGIC_FIELDS (and the routine says so), and a null or a non-object where an element or a
 * field should be is read as empty rather than thrown on.
 */
function routineOf(el: Record<string, unknown>): Routine {
  const data = isRecord(el["data"]) ? el["data"] : {};
  const field = (f: unknown) => {
    const one = isRecord(f) ? f : {};
    return { name: clampChainText(one["label"] ?? one["name"] ?? ""), type: clampChainText(one["type"] ?? "", MAX_TYPE_CHARS) };
  };
  const fields = (list: unknown) => {
    const all = Array.isArray(list) ? list : [];
    return { shown: all.slice(0, MAX_LOGIC_FIELDS).map(field), cut: all.length > MAX_LOGIC_FIELDS };
  };
  const inputs = fields(data["accepts"]);
  const outputs = fields(data["returns"]);
  return {
    name: clampChainText(data["name"] ?? ""),
    kind: routineKind(data["kind"] ?? data["mode"]),
    inputs: inputs.shown,
    outputs: outputs.shown,
    ...(inputs.cut || outputs.cut ? { truncated: true as const } : {}),
  };
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

  const rawElements = parsed?.["elements"];
  const elements = Array.isArray(rawElements) ? (rawElements as unknown[]) : [];
  // The wire format names routines "callable" (js-moi-utils ElementType.ROUTINE
  // === "callable"; the SDK's own logic-driver matches on it). Filtering on
  // "routine" returned zero routines for every real logic. Accept both, since
  // "routine" is the name the enum KEY uses and may appear in older manifests.
  // Keep the callable ones FIRST and cut after: cutting the whole element list first listed none of the routines of a
  // logic whose routines come after its first 200 elements.
  const callable = elements.filter(
    (el): el is Record<string, unknown> => isRecord(el) && ["callable", "routine"].includes(String(el["kind"] ?? "")),
  );
  // Cut at MAX_LOGIC_ROUTINES, or when the JSON of what is listed would pass MAX_LOGIC_CHARS (names and types are
  // author-sized, so a count alone does not bound the answer). The first routine is always listed.
  const routines: Routine[] = [];
  let chars = 0;
  let cut = false;
  for (const el of callable) {
    const routine = routineOf(el);
    chars += JSON.stringify(routine).length;
    if (routines.length >= MAX_LOGIC_ROUTINES || (routines.length > 0 && chars > MAX_LOGIC_CHARS)) {
      cut = true;
      break;
    }
    routines.push(routine);
  }

  const name = parsed?.["name"];

  return {
    logicId,
    ...(typeof name === "string" ? { name: clampChainText(name) } : {}),
    routines,
    ...(cut || routines.some((r) => r.truncated) ? { truncated: true } : {}),
    ...(cut ? { routineCount: callable.length } : {}),
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
