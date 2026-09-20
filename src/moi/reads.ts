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
function invalidId(kind: string, value: string, err: unknown): MoiError {
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

export async function getAccount(
  provider: Provider,
  address: string,
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

  // TDU = the account's holdings across every asset it touches.
  const balances: Array<{ assetId: string; symbol?: string; amount: string }> = [];
  try {
    const tdu = (await provider.getTDU(address)) as unknown as Array<Record<string, unknown>>;
    for (const entry of tdu ?? []) {
      const assetId = String(entry["asset_id"] ?? entry["token_id"] ?? "");
      if (!/^0x[0-9a-fA-F]+$/.test(assetId)) continue;
      balances.push({ assetId, amount: toBigInt(entry["amount"]).toString() });
    }
  } catch (err) {
    throw asRpcError(err, `moi.TDU(${address})`);
  }

  void state;
  return {
    address,
    nonce,
    balances,
    isRegistered,
  };
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

export async function getInteraction(
  provider: Provider,
  hash: string,
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
  if (receipt) out.receipt = receipt;

  return out;
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
