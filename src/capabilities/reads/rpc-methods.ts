/**
 * The node's own methods, one row each.
 *
 * Every JSON-RPC method that the installed provider (js-moi-providers) calls has a row here: 34 `moi.` methods, 5
 * `ixpool.` and 3 `net.`. src/capabilities/reads/rpc-tools.ts turns each row whose status is "tool" into one tool, in one
 * loop, so no tool is written by hand. A method with no row fails test/unit/rpc-coverage.test.ts, so a provider upgrade
 * that adds one shows up as a failing test, not as a surprise.
 *
 * A row's status says what becomes of it:
 *   tool      one tool, moi_rpc_ and the method in snake case, on the read gateway.
 *   internal  used by this server and never listed as a tool: moi.SendInteractions, which the write path broadcasts through.
 *   out       a filter or a subscription. The node keeps state for it and streams, so a request-and-answer tool cannot
 *             represent it.
 *
 * Each tool calls the provider method named in its row, not fetch, so the SDK's own encoding and checks apply. Every row,
 * tool or not, carries the parameters its method takes, as zod, so the table describes the node's whole interface; where
 * the provider takes tesseract options the tool takes tesseract_number and tesseract_hash as two plain fields. The group
 * only organises the README and the tests.
 */

import { ResourceType, toInteractionArgs, type InteractionObject, type JsonRpcProvider, type Options } from "js-moi-sdk";
import { z } from "zod";

import { MoiError } from "../../moi-error.js";
import { AssetId, ErrorCode, HexId, InteractionHash, LogicId, WcInteractionObject } from "../../schema.js";

export type RpcGroup =
  | "account"
  | "asset"
  | "logic"
  | "interaction"
  | "tesseract"
  | "access"
  | "logs"
  | "pool"
  | "network"
  | "submit"
  /** The seven filter and subscription methods, which have no tool. */
  | "filter";

interface RpcRowBase {
  /** The method name on the wire, as the provider sends it: moi.AccountState, ixpool.Status, net.Peers. */
  readonly wire: string;
  /** The provider method that sends it. */
  readonly method: string;
  readonly group: RpcGroup;
  /** What the method takes, as zod. For a tool, the input is what z.object(params) parses, so defaults are filled in. */
  readonly params: z.ZodRawShape;
}

export interface RpcToolRow extends RpcRowBase {
  readonly status: "tool";
  /** moi_rpc_account_state, moi_rpc_ixpool_content_from, moi_rpc_net_peers. */
  readonly tool: string;
  readonly description: string;
  readonly call: (provider: JsonRpcProvider, input: Record<string, unknown>) => Promise<unknown>;
}

export interface RpcSkippedRow extends RpcRowBase {
  readonly status: "internal" | "out";
  /** Why there is no tool. */
  readonly why: string;
}

export type RpcRow = RpcToolRow | RpcSkippedRow;

/** moi.AccountState is moi_rpc_account_state; a method of another namespace keeps it: ixpool.ContentFrom is moi_rpc_ixpool_content_from. */
export function toolNameFor(wire: string): string {
  const [namespace = "", method = ""] = wire.split(".");
  const words = method
    // LogicIDs is logic_ids, not logic_i_ds.
    .replace(/IDs\b/g, "Ids")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  return `moi_rpc_${namespace === "moi" ? "" : `${namespace}_`}${words}`;
}

/**
 * One row that becomes a tool. `call` is typed from `params`, then stored with its input widened, which is the one cast
 * in this file. `returns` finishes the sentence "Raw node method moi.X: returns ...", so every description says it is the
 * raw node method; `note` is an optional second sentence, used to point at the combined read.
 */
function tool<S extends z.ZodRawShape>(spec: {
  wire: string;
  method: string;
  group: RpcGroup;
  returns: string;
  note?: string;
  params: S;
  call: (provider: JsonRpcProvider, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}): RpcToolRow {
  return {
    wire: spec.wire,
    method: spec.method,
    group: spec.group,
    status: "tool",
    tool: toolNameFor(spec.wire),
    description: `Raw node method ${spec.wire}: returns ${spec.returns}.${spec.note ? ` ${spec.note}` : ""}`,
    params: spec.params,
    call: spec.call as unknown as RpcToolRow["call"],
  };
}

const STATEFUL = "Keeps state on the node (a filter or a subscription) and streams, which a request-and-answer tool cannot represent.";

function out(wire: string, method: string, params: z.ZodRawShape): RpcSkippedRow {
  return { wire, method, group: "filter", status: "out", params, why: STATEFUL };
}

// ---------------------------------------------------------------------------
// Parameters
//
// Each of these builds fresh zod objects every time it is called. One zod instance used twice in one tool's shape makes the
// JSON schema generator emit a $ref, which the dialect rewrite (src/json-schema-dialect.ts) then has to inline.
// ---------------------------------------------------------------------------

const account = (what = "The account's id (0x…).") => HexId.describe(what);

/** The tesseract the provider's `options` names, as two plain fields. */
const at = () => ({
  tesseract_number: z.number().int().min(-1).optional().describe("Read at this tesseract height; -1, the default, is the latest."),
  tesseract_hash: HexId.describe("Read at the tesseract with this hash. Not together with tesseract_number.").optional(),
});

/** Which of the account's keys, by index. The provider has no default for it; 0 is the key every account starts with. */
const keyId = () => z.number().int().min(0).default(0).describe("Which of the account's keys, by index. 0 is the first.");

const resourceType = () =>
  z
    .enum(["storage", "asset", "logic", "key"])
    .describe("What the policy governs. The node implements storage only today and rejects the other three.");

/** A full interaction, for moi.Call and moi.FuelEstimate. */
const interaction = () =>
  WcInteractionObject.describe(
    "The full interaction object, as the SDK's InteractionObject: sender (id, sequence, key_id), fuel_price, fuel_limit, " +
      "ix_operations (each a type number and its payload), and funds, participants, preferences or perception if used. " +
      "fuel_price and the amounts in funds may be decimal strings. Amounts inside an operation payload must be JSON numbers " +
      "(at most 9007199254740991), and a payload cannot carry its own funds.",
  );

const callOptions = () =>
  z
    .record(
      z.string(),
      z.object({
        tesseract_number: z.number().int().min(-1).optional(),
        tesseract_hash: HexId.optional(),
      }),
    )
    .optional()
    .describe(
      "Optional. The SDK's CallorEstimateOptions: a map from an account id to {tesseract_number} or {tesseract_hash}. Leave it " +
        "out for the latest state.",
    );

/** A log query: an account, a height range and optional topics. moi.GetLogs takes it, and so does the filter that has no tool. */
const logQuery = () => ({
  id: account("The account whose tesseracts' logs to read (0x…)."),
  start_height: z.number().int().min(0).describe("The first tesseract height. The SDK notes the start is inclusive."),
  end_height: z
    .number()
    .int()
    .min(0)
    .describe("The end of the range. The SDK notes it is exclusive and that the node refuses a range wider than 10."),
  topics: z
    .array(z.array(z.string()))
    .optional()
    .describe(
      "Optional topic filter: a list of lists of topic names, which the SDK hashes. A log must match every list, and a list " +
        "matches on any one of its names.",
    ),
});

// ---------------------------------------------------------------------------
// What the provider is handed
// ---------------------------------------------------------------------------

/** tesseract_number or tesseract_hash as the provider's Options, or undefined, which the provider reads as the latest. */
function optionsOf(a: { tesseract_number?: number | undefined; tesseract_hash?: string | undefined }): Options | undefined {
  if (a.tesseract_number !== undefined && a.tesseract_hash !== undefined) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Give tesseract_number or tesseract_hash, not both.");
  }
  if (a.tesseract_number !== undefined) return { tesseract_number: a.tesseract_number };
  if (a.tesseract_hash !== undefined) return { tesseract_hash: a.tesseract_hash };
  return undefined;
}

/** A tesseract asked for with no account is found by its hash alone. */
function byHash(options: Options | undefined): Options {
  if (options?.tesseract_hash === undefined) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Without id, a tesseract is found by its hash: give tesseract_hash.");
  }
  return options;
}

/** A whole number, from a JSON number or a string of digits. The SDK takes number or bigint, never a string. */
function whole(what: string, value: number | string): number | bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new MoiError(ErrorCode.INVALID_ARGS, `${what} must be a whole number.`);
    return value;
  }
  if (!/^\d+$/.test(value)) throw new MoiError(ErrorCode.INVALID_ARGS, `${what} must be a whole number.`);
  return BigInt(value);
}

/**
 * The interaction as the schema parsed it, with the amounts the SDK wants as number or bigint. The SDK encodes it before it
 * sends it and throws a plain Error for a payload it cannot encode; that is the caller's mistake, so it is tried here first,
 * on a copy because the encoder writes `participants` back onto what it is given, and refused as INVALID_ARGS.
 */
function toInteractionObject(ix: z.infer<typeof WcInteractionObject>): InteractionObject {
  const object = {
    ...ix,
    fuel_price: whole("fuel_price", ix.fuel_price),
    ...(ix.funds ? { funds: ix.funds.map((f) => ({ asset_id: f.asset_id, amount: whole("A fund's amount", f.amount) })) } : {}),
  } as unknown as InteractionObject;
  try {
    toInteractionArgs({ ...object });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A TypeError is the encoder choking on the shape of a field, such as a payload `funds` object where it wants a Map, and its
    // own text is about its internals ("map.keys is not a function"), so it comes second.
    const said =
      err instanceof Error && err.name === "TypeError"
        ? `an operation payload has a field of a shape the SDK cannot encode, such as a funds object (${detail})`
        : detail;
    throw new MoiError(ErrorCode.INVALID_ARGS, `The interaction cannot be encoded: ${said}`);
  }
  return object;
}

/** The label the node takes, as the provider's ResourceType enum value. */
const toResourceType = (label: "storage" | "asset" | "logic" | "key"): ResourceType =>
  ResourceType[label.toUpperCase() as "STORAGE" | "ASSET" | "LOGIC" | "KEY"];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const RPC_METHODS: readonly RpcRow[] = [
  // account
  tool({
    wire: "moi.AccountState",
    method: "getAccountState",
    group: "account",
    returns: "the account's state record at a tesseract: its type and the roots and hashes of what it holds",
    note: "For balances use moi_get_account.",
    params: { id: account(), ...at() },
    call: (p, a) => p.getAccountState(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.AccountMetaInfo",
    method: "getAccountMetaInfo",
    group: "account",
    returns: "the account's meta record: its type, its latest tesseract height and hash, and whether its lattice and state exist",
    params: { id: account() },
    call: (p, a) => p.getAccountMetaInfo(a.id),
  }),
  tool({
    wire: "moi.AccountKeys",
    method: "getAccountKeys",
    group: "account",
    returns: "the account's keys, each with its id, public key, weight, signature algorithm and whether it is revoked",
    params: { id: account(), ...at() },
    call: (p, a) => p.getAccountKeys(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.Balance",
    method: "getBalance",
    group: "account",
    returns: "the account's balance of one asset, as a whole number in base units",
    note: "It takes no token id; moi_rpc_tdu lists every asset and token id the account holds.",
    params: { id: account(), asset_id: AssetId.describe("The asset id (0x…)."), ...at() },
    call: (p, a) => p.getBalance(a.id, a.asset_id, optionsOf(a)),
  }),
  tool({
    wire: "moi.TDU",
    method: "getTDU",
    group: "account",
    returns: "the account's holdings, one entry per asset id and token id with its amount",
    note: "moi_get_account shows the same rows, one per asset and token id.",
    params: { id: account(), ...at() },
    call: (p, a) => p.getTDU(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.InteractionCount",
    method: "getInteractionCount",
    group: "account",
    returns: "how many interactions the account has sent with one of its keys, which is that key's nonce",
    params: { id: account(), key_id: keyId(), ...at() },
    call: (p, a) => p.getInteractionCount(a.id, a.key_id, optionsOf(a)),
  }),
  tool({
    wire: "moi.PendingInteractionCount",
    method: "getPendingInteractionCount",
    group: "account",
    returns: "that count again with the interactions still waiting in the pool included",
    params: { id: account(), key_id: keyId() },
    call: (p, a) => p.getPendingInteractionCount(a.id, a.key_id),
  }),
  tool({
    wire: "moi.SubAccountCount",
    method: "getSubAccountCount",
    group: "account",
    returns: "how many sub accounts the account has",
    params: { id: account(), ...at() },
    call: (p, a) => p.getSubAccountCount(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.Deeds",
    method: "getRegistry",
    group: "account",
    returns: "the account's deeds: a list of registry entries, each an asset id with that asset's info",
    params: { id: account(), ...at() },
    call: (p, a) => p.getRegistry(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.ContextInfo",
    method: "getContextInfo",
    group: "account",
    returns: "the account's context: the nodes that serve it at a tesseract",
    params: { id: account(), ...at() },
    call: (p, a) => p.getContextInfo(a.id, optionsOf(a)),
  }),
  tool({
    wire: "moi.Syncing",
    method: "getSyncStatus",
    group: "account",
    returns: "the node's sync status, or one account's when id is given: current and expected height, and whether the sync is done",
    params: { id: account("An account id (0x…). Leave out for the node's own sync status.").optional() },
    call: (p, a) => p.getSyncStatus(a.id),
  }),

  // asset
  tool({
    wire: "moi.AssetInfoByAssetID",
    method: "getAssetInfoByAssetID",
    group: "asset",
    returns: "an asset's info record: symbol, dimension, decimals, creator, manager and supplies",
    note: "moi_get_asset adds the standard and scales the supply.",
    params: { asset_id: AssetId.describe("The asset id (0x…)."), ...at() },
    call: (p, a) => p.getAssetInfoByAssetID(a.asset_id, optionsOf(a)),
  }),
  tool({
    wire: "moi.StorageMetric",
    method: "getStorageMetric",
    group: "asset",
    returns: "one participant's storage allowance on a logic or asset account: storage granted and consumed, and tokens deposited",
    params: {
      target_account: HexId.describe("The logic or asset account the allowance is on (0x…)."),
      user_account: HexId.describe("The participant whose allowance to look up (0x…)."),
      ...at(),
    },
    call: (p, a) => p.getStorageMetric(a.target_account, a.user_account, optionsOf(a)),
  }),
  tool({
    wire: "moi.StoragePricing",
    method: "getStoragePricing",
    group: "asset",
    returns: "the network's storage pricing: price per byte, multiplier and anu per byte",
    params: {},
    call: (p) => p.getStoragePricing(),
  }),

  // logic
  tool({
    wire: "moi.LogicManifest",
    method: "getLogicManifest",
    group: "logic",
    returns: "a logic's manifest, or an asset's, as parsed JSON, or as POLO hex when encoding is POLO",
    note: "moi_get_logic and moi_asset_routines turn it into routines.",
    params: {
      logic_id: LogicId.describe("A logic id, or an asset id: an asset has a manifest too."),
      encoding: z.enum(["JSON", "POLO"]).default("JSON").describe("JSON gives the parsed manifest; POLO gives it encoded, as hex."),
      ...at(),
    },
    call: (p, a) => p.getLogicManifest(a.logic_id, a.encoding, optionsOf(a)),
  }),
  tool({
    wire: "moi.LogicStorage",
    method: "getStorageAt",
    group: "logic",
    returns: "one value from a logic's storage, by key, as the node's hex string",
    params: {
      logic_id: LogicId.describe("The logic id (0x…)."),
      storage_key: z.string().min(1).describe("The storage key, as the node expects it."),
      id: account("The account the storage key relates to, when it has one (0x…).").optional(),
      ...at(),
    },
    call: (p, a) =>
      a.id
        ? p.getStorageAt(a.logic_id, a.storage_key, a.id, optionsOf(a))
        : p.getStorageAt(a.logic_id, a.storage_key, optionsOf(a)),
  }),
  tool({
    wire: "moi.LogicIDs",
    method: "getLogicIds",
    group: "logic",
    returns: "the ids of the logics associated with the account",
    params: { id: account(), ...at() },
    call: (p, a) => p.getLogicIds(a.id, optionsOf(a)),
  }),

  // interaction
  tool({
    wire: "moi.Call",
    method: "call",
    group: "interaction",
    returns: "the receipt of simulating a full interaction object, with nothing signed or sent",
    note:
      "The caller must supply the whole interaction object (sender, fuel, operations and their payloads). What a person " +
      "normally wants is the signing server's write tools, which build, preview and sign the interaction.",
    params: { interaction: interaction(), options: callOptions() },
    // The provider answers { receipt, result }, and result is a function; only the receipt is data.
    call: async (p, a) => (await p.call(toInteractionObject(a.interaction), a.options)).receipt,
  }),
  tool({
    wire: "moi.FuelEstimate",
    method: "estimateFuel",
    group: "interaction",
    returns: "the fuel the node estimates a full interaction object would use",
    note:
      "The caller must supply the whole interaction object, as for moi_rpc_call. What a person normally wants is the signing " +
      "server's write tools, which estimate the fuel themselves.",
    params: { interaction: interaction(), options: callOptions() },
    call: (p, a) => p.estimateFuel(toInteractionObject(a.interaction), a.options),
  }),
  tool({
    wire: "moi.InteractionByHash",
    method: "getInteractionByHash",
    group: "interaction",
    returns: "an interaction by its hash: sender, fuel, operations, signature and its tesseract hash",
    note: "moi_get_interaction adds its status.",
    params: { hash: InteractionHash.describe("The interaction hash (0x…).") },
    call: (p, a) => p.getInteractionByHash(a.hash),
  }),
  tool({
    wire: "moi.InteractionByTesseract",
    method: "getInteractionByTesseract",
    group: "interaction",
    returns: "one interaction of a tesseract, by its index in that tesseract",
    params: {
      id: account("The account whose tesseract it is (0x…). Leave out to find the tesseract by tesseract_hash alone.").optional(),
      ix_index: z
        .number()
        .int()
        .min(0)
        .describe(
          "Which interaction of the tesseract. Required: the SDK would send 1 if it were left out, and whether the node counts " +
            "from 0 or 1 is not confirmed.",
        ),
      ...at(),
    },
    call: async (p, a) => {
      const options = optionsOf(a);
      return a.id ? p.getInteractionByTesseract(a.id, options, a.ix_index) : p.getInteractionByTesseract(byHash(options), a.ix_index);
    },
  }),
  tool({
    wire: "moi.InteractionReceipt",
    method: "getInteractionReceipt",
    group: "interaction",
    returns: "an interaction's receipt: its status, the fuel it used and what each operation did",
    params: { hash: InteractionHash.describe("The interaction hash (0x…).") },
    call: (p, a) => p.getInteractionReceipt(a.hash),
  }),

  // tesseract
  tool({
    wire: "moi.Tesseract",
    method: "getTesseract",
    group: "tesseract",
    returns:
      "a tesseract (MOI's block) of one account, by height or hash: its participants with their heights, its time stamp, fuel " +
      "and hash, and with with_interactions the interactions at that height",
    params: {
      id: account("The account whose tesseract it is (0x…). Leave out to find the tesseract by tesseract_hash alone.").optional(),
      with_interactions: z.boolean().default(false).describe("Include the interactions at that height."),
      with_commit_info: z.boolean().default(false).describe("Include the consensus commit information."),
      ...at(),
    },
    call: async (p, a) => {
      const options = optionsOf(a);
      return a.id
        ? p.getTesseract(a.id, a.with_interactions, a.with_commit_info, options)
        : p.getTesseract(a.with_interactions, a.with_commit_info, byHash(options));
    },
  }),

  // access
  tool({
    wire: "moi.AccessPolicy",
    method: "getAccessPolicy",
    group: "access",
    returns: "one access policy an account has set on a resource: the actions it covers and who may call or originate them",
    params: {
      id: account("The account that owns the policy (0x…)."),
      resource_type: resourceType(),
      resource_id: HexId.describe("The id of the resource the policy governs (0x…)."),
      ...at(),
    },
    call: (p, a) => p.getAccessPolicy(a.id, toResourceType(a.resource_type), a.resource_id, optionsOf(a)),
  }),
  tool({
    wire: "moi.AccessPolicies",
    method: "getAccessPolicies",
    group: "access",
    returns: "every access policy an account has set on resources of one type",
    params: { id: account("The account that owns the policies (0x…)."), resource_type: resourceType(), ...at() },
    call: (p, a) => p.getAccessPolicies(a.id, toResourceType(a.resource_type), optionsOf(a)),
  }),

  // logs
  tool({
    wire: "moi.GetLogs",
    method: "getLogs",
    group: "logs",
    returns: "the logs an account's tesseracts emitted within a height range, each with its topics, data and interaction hash",
    params: logQuery(),
    call: (p, a) => p.getLogs({ id: a.id, height: [a.start_height, a.end_height], ...(a.topics ? { topics: a.topics } : {}) }),
  }),

  // pool
  tool({
    wire: "ixpool.Content",
    method: "getContent",
    group: "pool",
    returns: "every interaction waiting in the node's pool, pending and queued, by account and nonce",
    params: {},
    call: (p) => p.getContent(),
  }),
  tool({
    wire: "ixpool.ContentFrom",
    method: "getContentFrom",
    group: "pool",
    returns: "the pending and queued interactions in the pool from one account, by nonce",
    params: { id: account() },
    call: (p, a) => p.getContentFrom(a.id),
  }),
  tool({
    wire: "ixpool.Status",
    method: "getStatus",
    group: "pool",
    returns: "how many interactions are pending and how many are queued in the pool",
    params: {},
    call: (p) => p.getStatus(),
  }),
  tool({
    wire: "ixpool.Inspect",
    method: "getInspect",
    group: "pool",
    returns: "the pool in summary: pending and queued interactions per account, and each account's wait time",
    params: {},
    call: (p) => p.getInspect(),
  }),
  tool({
    wire: "ixpool.WaitTime",
    method: "getWaitTime",
    group: "pool",
    returns: "how long an account's interactions have waited in the pool: whether the wait has expired, and the time",
    params: { id: account() },
    call: (p, a) => p.getWaitTime(a.id),
  }),

  // network
  tool({
    wire: "net.Peers",
    method: "getPeers",
    group: "network",
    returns: "the peers this node is connected to",
    params: {},
    call: (p) => p.getPeers(),
  }),
  tool({
    wire: "net.Version",
    method: "getVersion",
    group: "network",
    returns: "the node's version",
    params: {},
    call: (p) => p.getVersion(),
  }),
  tool({
    wire: "net.Info",
    method: "getNodeInfo",
    group: "network",
    returns: "the node's info, which is its krama id",
    params: {},
    call: (p) => p.getNodeInfo(),
  }),

  // submit
  {
    wire: "moi.SendInteractions",
    method: "sendInteraction",
    group: "submit",
    status: "internal",
    // The SDK's InteractionRequest, which the node takes as it is.
    params: {
      ix_args: z.string().describe("The POLO-encoded interaction arguments, as hex."),
      signatures: z.string().describe("The signatures over them, as hex."),
    },
    why:
      "The write path broadcasts every signed interaction through it (src/tools/write-core.ts), so it is used, but it is " +
      "deliberately not a tool on the public read gateway: it is the one node method that changes the chain, and listing it " +
      "would make the gateway no longer read-only.",
  },

  // filters and subscriptions
  out("moi.NewLogFilter", "getLogsFilter", logQuery()),
  out("moi.NewTesseractFilter", "getNewTesseractFilter", {}),
  out("moi.NewTesseractsByAccountFilter", "getNewTesseractsByAccountFilter", { id: account() }),
  out("moi.PendingIxnsFilter", "getPendingInteractionFilter", {}),
  out("moi.GetFilterChanges", "getFilterChanges", { filter_id: z.string().describe("The id a filter call returned.") }),
  out("moi.RemoveFilter", "removeFilter", { filter_id: z.string().describe("The id of the filter to remove.") }),
  out("moi.Subscribe", "getSubscription", {
    event: z.enum(["newTesseracts", "newTesseractsByAccount", "newLogs", "newPendingInteractions"]).describe("What to subscribe to."),
    id: account("The account, for newTesseractsByAccount and newLogs.").optional(),
  }),
];
