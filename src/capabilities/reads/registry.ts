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

import { limitDepth, readWhole } from "../../bounds.js";
import { MoiError, asRpcError } from "../../moi-error.js";
import { ReadCallerRejected, rejectedCallerError } from "../../moi/read-caller.js";
import { capRecord, clampChainText } from "../../moi/reads.js";
import { dappOrigin, publicFetch, type FetchLike } from "../../public-fetch.js";
import { ErrorCode, type ResolveAgentOutput } from "../../schema.js";
import type { ReadOnlySigner } from "../../moi/provider.js";

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
 * i.e. nobody has registered an agent on this network. The honest answer to
 * "resolve this agent" is then "not found", not a server error. A read caller
 * the node does not know is not that: callRoutine turns it into a
 * ReadCallerRejected, which is never an empty registry (see below).
 */
const EMPTY_REGISTRY = /account not found|state object fetch failed|failed to fetch transition objects/i;

export function isEmptyRegistryError(err: unknown): boolean {
  // Its message quotes the node's "account not found", so the pattern below would match it.
  if (err instanceof ReadCallerRejected) return false;
  return EMPTY_REGISTRY.test(err instanceof Error ? err.message : String(err));
}

/** How many registry entries a name/handle lookup will scan before giving up. */
export const MAX_SCAN = 200;
const PAGE = 50;
/** The most time a name or url lookup spends scanning the registry before it stops and says so. */
export const SCAN_BUDGET_MS = 20_000;

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
    // The node refusing the placeholder caller is named in src/moi/read-caller.ts, not reported as an empty registry.
    throw rejectedCallerError(err) ?? asRpcError(err, `registry.${name}`);
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

/** How much of an agent's own text is kept: a name or capability, the longest text in the record or card, a key, and the entries of a list or an object. */
const MAX_NAME_CHARS = 64;
const MAX_FIELD_CHARS = 512;
const MAX_KEY_CHARS = 64;
const MAX_ENTRIES = 50;
/** The most capabilities listed, the longest endpoint returned, and the most characters of JSON the card keeps in metadata. */
const MAX_CAPABILITIES = 20;
const MAX_URL_CHARS = 2_048;
export const MAX_CARD_CHARS = 8_000;
/** The longest url or cardUri moi_list_agents lists, and status. */
const MAX_LISTED_URL_CHARS = 256;
const MAX_LISTED_STATUS_CHARS = 32;
const CUT_NOTE =
  "Some text from this agent's record or card was cut to a fixed length, or left out because it was too long; the registry holds the full record.";

/** `value` cleaned and cut like other chain text. `seen.cut` is set when characters were cut off (cleaning alone is not a cut). */
function tidy(value: unknown, max: number, seen: { cut: boolean }): string {
  const whole = clampChainText(value, Number.POSITIVE_INFINITY);
  if (whole.length > max) seen.cut = true;
  return clampChainText(whole, max);
}

/** Every text in a JSON value cleaned and cut, lists and objects cut at MAX_ENTRIES. The value is already JSON-safe and at most MAX_DEPTH deep (fetchCard cuts the card; jsonSafe made the profile plain). */
function cleanTree(value: unknown, seen: { cut: boolean }): unknown {
  if (typeof value === "string") return tidy(value, MAX_FIELD_CHARS, seen);
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) seen.cut = true;
    return value.slice(0, MAX_ENTRIES).map((v) => cleanTree(v, seen));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_ENTRIES) seen.cut = true;
    return Object.fromEntries(entries.slice(0, MAX_ENTRIES).map(([k, v]) => [tidy(k, MAX_KEY_CHARS, seen), cleanTree(v, seen)]));
  }
  return value;
}

const isUrl = (s: string): boolean => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

function toOutput(raw: RawProfile, agentId: string, outcome?: CardOutcome): z.infer<typeof ResolveAgentOutput> {
  const seen = { cut: false };
  const card = outcome && "card" in outcome ? outcome.card : undefined;
  const address = str(raw.agent_wallet) ?? str(raw.owner);
  // The card comes from a URL the agent's owner controls, so every text in it is cleaned and cut like other chain text.
  const rawName = card?.["name"];
  const name = typeof rawName === "string" ? tidy(rawName, MAX_NAME_CHARS, seen) : "";
  const url = str(raw.url);

  const capabilities: string[] = [];
  const skills = card?.["skills"];
  if (Array.isArray(skills)) {
    for (const s of skills) {
      const id = (s as Record<string, unknown>)?.["id"] ?? (s as Record<string, unknown>)?.["name"];
      if (typeof id !== "string") continue;
      if (capabilities.length >= MAX_CAPABILITIES) {
        seen.cut = true;
        break;
      }
      const shown = tidy(id, MAX_NAME_CHARS, seen);
      if (shown) capabilities.push(shown);
    }
  }

  // The output schema wants a URL. One that does not parse would fail the whole answer, and a clamped one would be wrong, so
  // an endpoint that is not a plain URL of reasonable length is left out, and the answer says so.
  let endpoint: string | undefined;
  if (url && /^https?:\/\//.test(url)) {
    if (url.length <= MAX_URL_CHARS && isUrl(url)) endpoint = url;
    else seen.cut = true;
  }

  // metadata: the registry's own record with its text cleaned, and the card, held to MAX_CARD_CHARS. Only the card can be
  // replaced by { truncated, chars, preview }, so a hostile card cannot make the record's own fields disappear.
  const profile = cleanTree(jsonSafe(raw), seen) as Record<string, unknown>;
  const shownCard = card ? capRecord(cleanTree(card, seen), MAX_CARD_CHARS) : undefined;
  if (shownCard?.truncated) seen.cut = true;

  return {
    found: true,
    agentId,
    ...(address ? { address } : {}),
    ...(name ? { name } : {}),
    capabilities,
    ...(endpoint ? { endpoint } : {}),
    metadata: { ...profile, ...(shownCard ? { card: shownCard.value } : {}) },
    ...(outcome && "reason" in outcome ? { cardNote: cardNote(outcome.reason) } : {}),
    ...(seen.cut ? { truncated: true, note: CUT_NOTE } : {}),
  };
}

const NOT_FOUND: z.infer<typeof ResolveAgentOutput> = { found: false, capabilities: [] };

/** A not-found from a search that did not cover the registry: found false is not the last word. A fresh object each time (NOT_FOUND is shared). */
const notFoundYet = (note: string): z.infer<typeof ResolveAgentOutput> => ({ found: false, capabilities: [], truncated: true, note });

/** A card is one agent owner's text, and a name lookup can read up to MAX_SCAN of them, so the cap is small. */
const MAX_CARD_BYTES = 64 * 1024;
const CARD_TIMEOUT_MS = 5_000;
/** The statuses undici itself treats as a redirect. Any other non-2xx answer is an ordinary failure. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Why a card was not read, and what to do about it, in words that are the same every time. None of it comes from the card's
 * URL, from the address its host resolved to, or from an error: the URL is the agent owner's, and an internal address or an
 * error's own text must not reach the model. A name that does not resolve and one that resolves to a private address are
 * both notPublic, in the same words, so the answer is no oracle for what exists inside the network.
 */
const CARD_REASONS = {
  notHttps: {
    why: "its address is not an https URL",
    next: "This server reads only https cards on public hosts, so the owner has to register the agent with an https card address.",
  },
  notPublic: {
    why: "its host is not a public internet address this server may reach (a local or private name, an IP address, or a name that did not resolve)",
    next: "This server reads only cards on public hosts, so the owner has to register a card address on a public name; if the name is public and working, try again in a minute, because a failed name lookup reads the same.",
  },
  redirected: {
    why: "it answered with a redirect, which this server does not follow",
    next: "The owner has to register the address the card is actually served from.",
  },
  tooLarge: {
    why: `it is over ${MAX_CARD_BYTES / 1024} KB`,
    next: `The owner has to publish a card under ${MAX_CARD_BYTES / 1024} KB.`,
  },
  timedOut: {
    why: "it did not answer in time",
    next: "Try again in a minute; if it keeps happening, the card host is down or very slow.",
  },
  unreadable: {
    why: "it could not be fetched, or what it returned is not a JSON card",
    next: "Try again in a minute; if it keeps happening, the card host is down or is serving something that is not a JSON object.",
  },
} as const;
type CardReason = keyof typeof CARD_REASONS;

/** The card, or the one reason it was not read. */
type CardOutcome = { card: Record<string, unknown> } | { reason: CardReason };

const cardNote = (reason: CardReason): string =>
  `The agent's card was not fetched: ${CARD_REASONS[reason].why}. ${CARD_REASONS[reason].next} ` +
  "Its name and capabilities come from the card, so they are left out; the registry's own fields, including the card address in metadata.card_uri, are unaffected.";

/**
 * Fetch an agent card. The URL is chosen by whoever registered the agent, so it is held to what a dapp's address is held to
 * (src/public-fetch.ts): https, a host that does not read as local or an IP address, and, in the default `get`, a connection
 * only to the address the host was checked to resolve to. A redirect is never followed: the guard looks at an IP literal
 * only on the first URL, and the socket skips the name lookup for one, so a followed redirect to http://169.254.169.254/
 * would not be checked. A card that is refused, too large, too slow or not a JSON object does not fail the lookup: the
 * outcome says why. Undefined means the agent has no card URL.
 */
async function fetchCard(cardUri: string | undefined, get?: FetchLike, timeoutMs = CARD_TIMEOUT_MS): Promise<CardOutcome | undefined> {
  if (!cardUri) return undefined;
  let https = false;
  try {
    https = new URL(cardUri).protocol === "https:";
  } catch {
    /* not a URL: refused below with the other schemes */
  }
  if (!https) return { reason: "notHttps" };
  try {
    dappOrigin(cardUri);
  } catch {
    return { reason: "notPublic" };
  }
  // The timer runs until the body is read, not just until the headers arrive, so a card that never finishes cannot hang a lookup.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      // The guarded fetch is picked here, inside the try, so nothing about building it can fail the lookup.
      res = await (get ?? publicFetch())(cardUri, { redirect: "manual", signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) return { reason: "timedOut" };
      // The guard refuses with a MoiError, which undici reports as the cause of its own "fetch failed" (src/public-fetch.ts).
      const refused = err instanceof MoiError || (err instanceof Error && err.cause instanceof MoiError);
      return { reason: refused ? "notPublic" : "unreadable" };
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return { reason: "redirected" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { reason: "unreadable" };
    }
    let text: string;
    try {
      text = await readWhole(res, MAX_CARD_BYTES, "The agent card");
    } catch (err) {
      if (ac.signal.aborted) return { reason: "timedOut" };
      // Only whether the size limit was the reason is taken from the error (readWhole sets limitBytes), never its text.
      return { reason: err instanceof MoiError && "limitBytes" in err.data ? "tooLarge" : "unreadable" };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // A card is a JSON object. null, a number, a string, a boolean or an array has no name to show.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: "unreadable" };
      // Cut in depth here: jsonSafe below recurses without a limit and would overflow the stack on a deeply nested card.
      return { card: limitDepth(parsed).value as Record<string, unknown> };
    } catch {
      return { reason: "unreadable" };
    }
  } finally {
    clearTimeout(timer);
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
 * Returns `{found:false}` rather than throwing on a miss — an agent that is simply not registered is a normal answer, not an
 * error. A miss from a scan that stopped before it covered the registry is marked `truncated`, with a note, because it does
 * not say the agent is not registered.
 */
export async function resolveAgent(
  signer: ReadOnlySigner,
  query: string,
  options: { logicId?: string; maxScan?: number; fetchCards?: boolean; budgetMs?: number; cardFetch?: FetchLike } = {},
): Promise<z.infer<typeof ResolveAgentOutput>> {
  const driver = await getRegistryDriver(signer, options.logicId ?? registryLogicId());
  // Cards are read through the address guard the dapp tools use (one Agent for the process). Tests pass a stand-in.
  const readCard = (cardUri: string | undefined) => fetchCard(cardUri, options.cardFetch);
  const needle = query.trim();
  if (!needle) return NOT_FOUND;

  // Fast path: the query is already an agent id. The registry names them
  // "agent_<n>"; a hex id is accepted for registries that key differently.
  if (/^agent_\d+$/i.test(needle) || /^0x[0-9a-fA-F]+$/.test(needle)) {
    try {
      const raw = await profileFor(driver, needle);
      if (raw) return toOutput(raw, needle, await readCard(str(raw.card_uri)));
    } catch (err) {
      if (!isEmptyRegistryError(err)) throw err;
      return NOT_FOUND;
    }
    // The registry writes its ids agent_<n>, so a direct read of one, spelled that way, that finds no profile is a complete
    // answer; scanning for it could only end as a miss that says it ran out of time. A mixed-case spelling or a hex id may be
    // another spelling of an id, a wallet or a name, so those go on to the scan.
    if (/^agent_\d+$/.test(needle)) return NOT_FOUND;
  }

  // Slow path: scan the registry. Bounded in entries (MAX_SCAN) and in time, and it says so when it stops short: a miss
  // from a scan that did not cover the registry does not mean the agent is not registered. The time is checked between
  // entries, so one card fetch (5 seconds at most) can run past it.
  const limit = options.maxScan ?? MAX_SCAN;
  const deadline = Date.now() + (options.budgetMs ?? SCAN_BUDGET_MS);
  const lowered = needle.toLowerCase();
  // A card is read during the scan only to match its NAME. A query shaped like a hex id or a url cannot be a name, so no card
  // is read for it, and an address lookup does not spend its time on card fetches.
  const nameQuery = !/^0x[0-9a-f]+$/i.test(needle) && !/^https?:\/\//i.test(needle);
  let scanned = 0; // profiles read
  let start = 0; // where the page being read starts in the registry's list; counts every id a page held
  let total: number | undefined;
  let exhausted = false; // the registry has no entry after the ones read
  let outOfTime = false;

  while (scanned < limit) {
    let page: unknown;
    try {
      page = await callRoutine(driver, "GetAllAgentIds", [start, PAGE]);
    } catch (err) {
      // An unwritten registry is an empty registry.
      if (isEmptyRegistryError(err)) return NOT_FOUND;
      throw err;
    }
    const listed = idsOf(page);
    total ??= listed.total;
    if (listed.held === 0) {
      exhausted = true;
      break;
    }

    const room = limit - scanned;
    for (const agentId of listed.ids.slice(0, room)) {
      if (Date.now() >= deadline) {
        outOfTime = true;
        break;
      }
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
        return toOutput(raw, agentId, await readCard(str(raw.card_uri)));
      }

      if (options.fetchCards !== false && nameQuery) {
        const outcome = await readCard(str(raw.card_uri));
        const card = outcome && "card" in outcome ? outcome.card : undefined;
        const name = typeof card?.["name"] === "string" ? (card["name"] as string).toLowerCase() : undefined;
        if (name && (name === lowered || name.includes(lowered))) {
          return toOutput(raw, agentId, outcome);
        }
      }
    }
    // Stopped in the middle of a page (out of time, or the limit fell inside it): the registry is not covered.
    if (outOfTime || listed.ids.length > room) break;
    start += listed.held;
    // A short page is the last one; so is a page that ends at the registry's own total.
    if (listed.held < PAGE || (total !== undefined && start >= total)) exhausted = true;
    if (exhausted) break;
  }

  if (exhausted) return NOT_FOUND;
  const why = outOfTime ? "ran out of time" : `reached its limit of ${limit} entries`;
  return notFoundYet(
    `Searched ${scanned} of ${total ?? "an unknown number of"} registry entries and then ${why}, so this agent may still be registered. ` +
      "An agent id (agent_<n>) is read directly, and moi_list_agents with owner lists the agents one account registered; " +
      "a card name or a service URL can be found only by this search.",
  );
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
    ...(status ? { status: clampChainText(status, MAX_LISTED_STATUS_CHARS) } : {}),
    ...(url ? { url: clampChainText(url, MAX_LISTED_URL_CHARS) } : {}),
    ...(cardUri ? { cardUri: clampChainText(cardUri, MAX_LISTED_URL_CHARS) } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/** `held` is how many ids the page held, decodable or not: the next page starts that far on. */
function idsOf(page: unknown): { ids: string[]; held: number; total?: number } {
  const typed = page as { ids?: unknown[]; total?: unknown } | unknown[] | undefined;
  const rawIds = Array.isArray(typed) ? typed : (typed?.ids ?? []);
  const ids = rawIds.map(str).filter((id): id is string => typeof id === "string" && id.length > 0);
  const rawTotal = Array.isArray(typed) ? undefined : typed?.total;
  const total =
    typeof rawTotal === "bigint" || typeof rawTotal === "number" || typeof rawTotal === "string"
      ? Number(rawTotal)
      : undefined;
  return { ids, held: rawIds.length, ...(total !== undefined && Number.isFinite(total) ? { total } : {}) };
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
