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
    return await response.result();
  } catch (err) {
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
  if (v && typeof v === "object" && "toHex" in v && typeof (v as { toHex: unknown }).toHex === "function") {
    return (v as { toHex: () => string }).toHex();
  }
  return undefined;
}

/** Registry values arrive as bigint/Identifier; make them JSON-safe. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
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
    | { profile?: RawProfile; found?: boolean }
    | undefined;
  if (!out) return undefined;
  if (out.found === false) return undefined;
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

  // Fast path: the query is already an agent id.
  if (/^0x[0-9a-fA-F]+$/.test(needle)) {
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
