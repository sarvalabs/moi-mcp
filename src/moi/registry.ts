/**
 * MOI agent registry reads. No MCP imports — plain TS library.
 *
 * The registry is an on-chain Cocolang logic. Its canonical id ships inside
 * js-moi-agent-registry (lib.cjs/client.js), which also honours the
 * MOI_AGENT_REGISTRY_LOGIC_ID override — we reuse that exact variable name so
 * both libraries can be pointed at a new deployment together.
 *
 * We deliberately do NOT use `AgentRegistry.init()`: it requires a Signer with
 * keys. Reads go through getLogicDriver with a ReadOnlySigner instead.
 */

import { getLogicDriver } from "js-moi-sdk";
import { z } from "zod";

import { MoiError, asRpcError } from "../moi-error.js";
import { ErrorCode, type ResolveAgentOutput } from "../schema.js";
import type { ReadOnlySigner } from "./provider.js";

/**
 * The registry logic id on the current devnet. Redeployed after the
 * September 2026 chain reset; the Launchpad moved to it on 2026-09-15.
 * js-moi-agent-registry@0.3.0-rc1 still ships the pre-reset id
 * (0x20000000c684f926...), which no longer exists on chain, so this value is
 * kept here rather than taken from that package.
 */
export const DEFAULT_REGISTRY_LOGIC_ID =
  "0x200000002f3e9469d94de695be18fc5839fb9535f543b381f903f7f800000000";

export function registryLogicId(env: NodeJS.ProcessEnv = process.env): string {
  return env["MOI_AGENT_REGISTRY_LOGIC_ID"] ?? DEFAULT_REGISTRY_LOGIC_ID;
}

/**
 * The node reports these when the registry logic has no state object yet —
 * i.e. nobody has registered an agent on this network, or the read-only
 * caller identity does not exist on chain. Either way the honest answer to
 * "resolve this agent" is "not found", not a server error.
 */
const EMPTY_REGISTRY = /account not found|state object fetch failed|failed to fetch transition objects/i;

export function isEmptyRegistryError(err: unknown): boolean {
  return EMPTY_REGISTRY.test(err instanceof Error ? err.message : String(err));
}

/** How many registry entries a name/handle lookup will scan before giving up. */
export const MAX_SCAN = 200;
const PAGE = 50;

interface RoutineRequest {
  call: () => Promise<{ result: () => unknown }>;
}
type Routines = Record<string, (...args: unknown[]) => Promise<RoutineRequest>>;

interface RegistryDriver {
  routines: Routines;
}

/** Load the registry logic read-only. Cached per logic id. */
const driverCache = new Map<string, Promise<RegistryDriver>>();

export function getRegistryDriver(
  signer: ReadOnlySigner,
  logicId = registryLogicId(),
): Promise<RegistryDriver> {
  let d = driverCache.get(logicId);
  if (!d) {
    d = (async () => {
      try {
        return (await getLogicDriver(logicId, signer as never)) as unknown as RegistryDriver;
      } catch (err) {
        driverCache.delete(logicId);
        throw new MoiError(
          ErrorCode.RPC_ERROR,
          `Could not load the MOI agent registry (logic ${logicId}). ` +
            `It may not be deployed on this network. ${err instanceof Error ? err.message : String(err)}`,
          { logicId },
        );
      }
    })();
    driverCache.set(logicId, d);
  }
  return d;
}

export function resetRegistryCache(): void {
  driverCache.clear();
}

/** Tests hand in a driver directly; nothing else should. */
export function primeRegistryDriverForTests(logicId: string, driver: RegistryDriver): void {
  driverCache.set(logicId, Promise.resolve(driver));
}

/**
 * js-moi-sdk 0.9 hands a routine's decoded result back as `{ output, error }`;
 * earlier builds returned the outputs bare. Accept either, and turn a
 * logic-side error into a thrown one rather than a silently empty answer.
 */
export function unwrapRoutineResult(raw: unknown, label: string): unknown {
  if (raw && typeof raw === "object" && "output" in raw && "error" in raw) {
    const { output, error } = raw as { output: unknown; error: unknown };
    if (error !== null && error !== undefined && error !== "" && error !== "0x") {
      const detail = typeof error === "string" ? error : JSON.stringify(jsonSafe(error));
      throw new MoiError(ErrorCode.RPC_ERROR, `${label} failed: ${detail}`);
    }
    return output;
  }
  return raw;
}

/**
 * The node simulates a read-only routine as some caller and refuses one it
 * has never seen: "failed to fetch acc meta info: account not found". With
 * the placeholder identity that is every call on a network that enforces it.
 * It used to be reported as an empty registry, which is how a live registry
 * holding 153 agents was once declared gone; now it is named.
 */
const CALLER_REJECTED = /acc meta info: account not found/i;

export function isCallerRejected(err: unknown): boolean {
  return CALLER_REJECTED.test(err instanceof Error ? err.message : String(err));
}

function callerRejected(env: NodeJS.ProcessEnv = process.env): MoiError {
  const set = env["MOI_READ_CALLER"];
  return new MoiError(
    ErrorCode.RPC_ERROR,
    set
      ? `The node rejected MOI_READ_CALLER (${set}) as the caller for read-only logic simulation: that participant does not exist on this network. Point it at an account that does.`
      : "The node rejected the placeholder caller used for read-only logic simulation. Set MOI_READ_CALLER in the server environment to any participant id that exists on this network (a funded account), then retry.",
  );
}

/** Invoke a read-only registry routine and unwrap its decoded result. */
async function callRoutine(
  driver: RegistryDriver,
  name: string,
  args: unknown[] = [],
): Promise<unknown> {
  const routine = driver.routines[name];
  if (typeof routine !== "function") {
    throw new MoiError(ErrorCode.LOGIC_ROUTINE_NOT_FOUND, `Registry has no routine ${name}`, {
      name,
    });
  }
  try {
    const request = await routine(...args);
    const response = await request.call();
    return unwrapRoutineResult(await response.result(), `registry.${name}`);
  } catch (err) {
    if (err instanceof MoiError) throw err;
    if (isCallerRejected(err)) throw callerRejected();
    throw asRpcError(err, `registry.${name}`);
  }
}

// ---------------------------------------------------------------------------

interface RawProfile {
  agent_id?: unknown;
  owner?: unknown;
  agent_wallet?: unknown;
  status?: unknown;
  url?: unknown;
  card_uri?: unknown;
  score?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  // js-moi-sdk 0.9 decodes an `identifier` output as its raw 32 bytes.
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (v && typeof v === "object" && "toHex" in v && typeof (v as { toHex: unknown }).toHex === "function") {
    return (v as { toHex: () => string }).toHex();
  }
  return undefined;
}

/** Registry values arrive as bigint / Identifier / raw byte arrays; make them JSON-safe. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return str(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const hex = str(value);
    if (hex !== undefined && !("length" in value)) return hex;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

function toOutput(raw: RawProfile, agentId: string, card?: Record<string, unknown>): z.infer<typeof ResolveAgentOutput> {
  const address = str(raw.agent_wallet) ?? str(raw.owner);
  const name = typeof card?.["name"] === "string" ? (card["name"] as string) : undefined;
  const url = str(raw.url);

  const capabilities: string[] = [];
  const skills = card?.["skills"];
  if (Array.isArray(skills)) {
    for (const s of skills) {
      const id = (s as Record<string, unknown>)?.["id"] ?? (s as Record<string, unknown>)?.["name"];
      if (typeof id === "string") capabilities.push(id);
    }
  }

  return {
    found: true,
    agentId,
    ...(address ? { address } : {}),
    ...(name ? { name } : {}),
    capabilities,
    ...(url && /^https?:\/\//.test(url) ? { endpoint: url } : {}),
    metadata: jsonSafe({ ...raw, ...(card ? { card } : {}) }) as Record<string, unknown>,
  };
}

const NOT_FOUND: z.infer<typeof ResolveAgentOutput> = { found: false, capabilities: [] };

/** Fetch an agent card if it is reachable over plain HTTP(S). */
async function fetchCard(cardUri: string | undefined, timeoutMs = 5_000): Promise<Record<string, unknown> | undefined> {
  if (!cardUri || !/^https?:\/\//i.test(cardUri)) return undefined;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(cardUri, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function profileFor(driver: RegistryDriver, agentId: string): Promise<RawProfile | undefined> {
  const out = (await callRoutine(driver, "GetAgentProfile", [agentId])) as
    | { profile?: RawProfile; found?: unknown }
    | undefined;
  if (!out || out.found === false) return undefined;
  return out.profile ?? (out as RawProfile);
}

/**
 * Resolve an agent by id, wallet address, url, or card name.
 *
 * Returns `{found:false}` rather than throwing on a miss — an agent that is
 * simply not registered is a normal answer, not an error.
 */
export async function resolveAgent(
  signer: ReadOnlySigner,
  query: string,
  options: { logicId?: string; maxScan?: number; fetchCards?: boolean } = {},
): Promise<z.infer<typeof ResolveAgentOutput>> {
  const driver = await getRegistryDriver(signer, options.logicId ?? registryLogicId());
  const needle = query.trim();
  if (!needle) return NOT_FOUND;

  // Fast path: the query is already an agent id. The registry names them
  // "agent_<n>"; a hex id is accepted for registries that key differently.
  if (/^agent_\d+$/i.test(needle) || /^0x[0-9a-fA-F]+$/.test(needle)) {
    try {
      const raw = await profileFor(driver, needle);
      if (raw) return toOutput(raw, needle, await fetchCard(str(raw.card_uri)));
    } catch (err) {
      if (!isEmptyRegistryError(err)) throw err;
      return NOT_FOUND;
    }
  }

  // Slow path: scan the registry. Bounded — the registry is unindexed.
  const limit = options.maxScan ?? MAX_SCAN;
  const lowered = needle.toLowerCase();
  let scanned = 0;

  while (scanned < limit) {
    let page: unknown;
    try {
      page = await callRoutine(driver, "GetAllAgentIds", [scanned, PAGE]);
    } catch (err) {
      // An unwritten registry is an empty registry.
      if (isEmptyRegistryError(err)) return NOT_FOUND;
      throw err;
    }
    const typedPage = page as
      | { ids?: unknown[]; total?: unknown }
      | unknown[]
      | undefined;
    const ids = (Array.isArray(typedPage) ? typedPage : (typedPage?.ids ?? [])) as unknown[];
    if (ids.length === 0) break;

    for (const rawId of ids) {
      const agentId = str(rawId);
      if (!agentId) continue;
      scanned += 1;

      let raw: RawProfile | undefined;
      try {
        raw = await profileFor(driver, agentId);
      } catch (err) {
        if (isEmptyRegistryError(err)) continue;
        throw err;
      }
      if (!raw) continue;

      const wallet = str(raw.agent_wallet)?.toLowerCase();
      const owner = str(raw.owner)?.toLowerCase();
      const url = str(raw.url)?.toLowerCase();
      if (agentId.toLowerCase() === lowered || wallet === lowered || owner === lowered || url === lowered) {
        return toOutput(raw, agentId, await fetchCard(str(raw.card_uri)));
      }

      if (options.fetchCards !== false) {
        const card = await fetchCard(str(raw.card_uri));
        const name = typeof card?.["name"] === "string" ? (card["name"] as string).toLowerCase() : undefined;
        if (name && (name === lowered || name.includes(lowered))) {
          return toOutput(raw, agentId, card);
        }
      }
    }

    if (ids.length < PAGE) break;
  }

  return NOT_FOUND;
}

/** Total number of agents registered on this network. */
export async function agentCount(signer: ReadOnlySigner, logicId?: string): Promise<number> {
  const driver = await getRegistryDriver(signer, logicId ?? registryLogicId());
  let raw: unknown;
  try {
    raw = await callRoutine(driver, "GetAgentCount");
  } catch (err) {
    if (isEmptyRegistryError(err)) return 0;
    throw err;
  }
  const value = typeof raw === "object" && raw !== null && "count" in raw ? (raw as { count: unknown }).count : raw;
  return Number(typeof value === "bigint" ? value : BigInt(String(value ?? 0)));
}

export type AgentSummary = {
  agentId: string;
  /** False when the registry lists the id but its profile cannot be read. */
  found: boolean;
  owner?: string;
  address?: string;
  status?: string;
  url?: string;
  cardUri?: string;
  score?: string;
  /** Unix nanoseconds as the registry stores it, as a decimal string. */
  createdAt?: string;
};

export type AgentPage = {
  agents: AgentSummary[];
  offset: number;
  limit: number;
  /** As the registry reports it; absent when the routine did not say. */
  total?: number;
  /** Offset to pass next; absent on the last page. */
  nextOffset?: number;
};

export const MAX_PAGE = 50;

function summaryOf(agentId: string, raw: RawProfile | undefined): AgentSummary {
  if (!raw) return { agentId, found: false };
  const owner = str(raw.owner);
  const address = str(raw.agent_wallet);
  const status = str(raw.status);
  const url = str(raw.url);
  const cardUri = str(raw.card_uri);
  const score = raw.score === undefined ? undefined : String(jsonSafe(raw.score));
  const createdAt = raw.created_at === undefined ? undefined : String(jsonSafe(raw.created_at));
  return {
    agentId,
    found: true,
    ...(owner ? { owner } : {}),
    ...(address ? { address } : {}),
    ...(status ? { status } : {}),
    ...(url ? { url } : {}),
    ...(cardUri ? { cardUri } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function idsOf(page: unknown): { ids: string[]; total?: number } {
  const typed = page as { ids?: unknown[]; total?: unknown } | unknown[] | undefined;
  const rawIds = Array.isArray(typed) ? typed : (typed?.ids ?? []);
  const ids = rawIds.map(str).filter((id): id is string => typeof id === "string" && id.length > 0);
  const rawTotal = Array.isArray(typed) ? undefined : typed?.total;
  const total =
    typeof rawTotal === "bigint" || typeof rawTotal === "number" || typeof rawTotal === "string"
      ? Number(rawTotal)
      : undefined;
  return { ids, ...(total !== undefined && Number.isFinite(total) ? { total } : {}) };
}

/**
 * One page of the registry: every agent, or those an owner registered. Each
 * id is followed by its profile, so a page costs limit + 1 node calls; the
 * cap keeps that bounded.
 */
export async function listAgents(
  signer: ReadOnlySigner,
  options: { owner?: string; offset?: number; limit?: number; logicId?: string } = {},
): Promise<AgentPage> {
  const driver = await getRegistryDriver(signer, options.logicId ?? registryLogicId());
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(options.limit ?? 20)));

  let page: unknown;
  try {
    page = options.owner
      ? await callRoutine(driver, "GetAgentsByOwner", [options.owner, offset, limit])
      : await callRoutine(driver, "GetAllAgentIds", [offset, limit]);
  } catch (err) {
    if (isEmptyRegistryError(err)) return { agents: [], offset, limit, total: 0 };
    throw err;
  }
  const { ids, total } = idsOf(page);

  const agents: AgentSummary[] = [];
  for (const agentId of ids) {
    let raw: RawProfile | undefined;
    try {
      raw = await profileFor(driver, agentId);
    } catch (err) {
      if (!isEmptyRegistryError(err)) throw err;
    }
    agents.push(summaryOf(agentId, raw));
  }

  const more = total !== undefined ? offset + ids.length < total : ids.length === limit;
  return {
    agents,
    offset,
    limit,
    ...(total !== undefined ? { total } : {}),
    ...(more && ids.length > 0 ? { nextOffset: offset + ids.length } : {}),
  };
}

/**
 * The registry's id for the agent whose wallet this is, under this owner,
 * watching for it to appear for up to `waitMs` after a registration was
 * broadcast. Undefined when it has not shown up in time, or the registry
 * cannot be read: a registration already on chain must not fail on that.
 */
export async function findAgentByWallet(
  signer: ReadOnlySigner,
  owner: string,
  agentWallet: string,
  waitMs: number,
  options: { logicId?: string; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | undefined> {
  const wanted = agentWallet.toLowerCase();
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const page = await listAgents(signer, { owner, limit: MAX_PAGE, ...(options.logicId ? { logicId: options.logicId } : {}) });
      const hit = page.agents.find((a) => a.address?.toLowerCase() === wanted);
      if (hit) return hit.agentId;
    } catch {
      return undefined;
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
