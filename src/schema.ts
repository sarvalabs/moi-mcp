/**
 * @moi-protocol/mcp-server — canonical schemas
 *
 * Single source of truth for:
 *   1. MCP tool input/output shapes (zod, used by McpServer.registerTool)
 *   2. WalletConnect v2 request/response payloads (moi.* namespace)
 *   3. On-disk session store
 *   4. Error codes returned to the agent
 *
 * TODO(adithya): confirm CAIP-2 chain ids + exact ix_args encoding against
 * sarvalabs/moi-wallet-mobile/Dapp-docs (private repo) before Phase 2.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 0. Shared primitives
// ---------------------------------------------------------------------------

export const Network = z.enum(["voyage", "mainnet", "custom"]);
export type Network = z.infer<typeof Network>;

/** MOI identifiers are 0x-prefixed hex. Keep loose; SDK validates strictly. */
export const HexId = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");

/** Asset id on MOI (native assets). */
export const AssetId = HexId;

/** Logic (Cocolang program) id. */
export const LogicId = HexId;

/** Human-readable amount as string to avoid float drift. e.g. "12.5" */
export const Amount = z.string().regex(/^\d+(\.\d+)?$/, "decimal string");

export const InteractionHash = HexId;

/**
 * An amount as it arrives over the wire.
 *
 * Amounts are decimal STRINGS internally so that values beyond 2^53 survive,
 * but an MCP client handed a numeric-looking field sends a JSON number — and
 * a string-only schema then rejects it with no value able to satisfy both.
 * Accept a number too, and normalise it to the canonical string.
 *
 * A number above Number.MAX_SAFE_INTEGER is refused rather than silently
 * rounded; those callers must send a string.
 */
export const WireAmount = z
  .union([Amount, z.number()])
  .transform((value, ctx) => {
    if (typeof value === "string") return value;
    if (!Number.isFinite(value) || value < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be a non-negative number" });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(value) && !Number.isInteger(value)) {
      // A non-integer is fine (1.5); an unsafe integer is not.
      return String(value);
    }
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `amount ${value} exceeds the safe integer range — pass it as a string to keep full precision`,
      });
      return z.NEVER;
    }
    return String(value);
  });

/** CAIP-2 chain id used in WalletConnect namespaces. CONFIRM VALUES. */
export const CAIP2 = z.record(Network, z.string()).default({
  voyage: "moi:14",         // verified against MOI Wallet + sarvalabs/wallet-connect-dapp
  mainnet: "moi:mainnet",   // PLACEHOLDER — no published mainnet chain id
  custom: "moi:custom",     // PLACEHOLDER — set to your chain's id
});

// ---------------------------------------------------------------------------
// 1. Wallet / session tools
// ---------------------------------------------------------------------------

export const ConnectWalletInput = z.object({
  network: Network.default("voyage"),
  /** If true, return QR as PNG image block. Else return URI text only. */
  qr: z.boolean().default(true),
});

export const ConnectWalletOutput = z.object({
  status: z.enum(["awaiting_scan", "connected", "already_connected"]),
  uri: z.string().optional(),          // wc:...@2?relay-protocol=...
  expiresAt: z.number().optional(),    // unix ms
  account: HexId.optional(),
  network: Network.optional(),
});

export const WalletStatusInput = z.object({});

export const WalletStatusOutput = z.object({
  connected: z.boolean(),
  account: HexId.optional(),
  network: Network.optional(),
  chainId: z.string().optional(),      // CAIP-2 from session
  peerName: z.string().optional(),     // "MOI Wallet"
  expiry: z.number().optional(),
  pendingRequests: z.number(),
});

export const DisconnectWalletInput = z.object({
  reason: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// 2. Read tools (js-moi-providers, no wallet needed)
// ---------------------------------------------------------------------------

export const GetAccountInput = z.object({
  address: HexId.describe("Account address (0x…). Required; ask moi_wallet_status for the paired wallet's address if the user means their own."),
});

export const GetAccountOutput = z.object({
  address: HexId,
  nonce: z.number(),
  balances: z.array(
    z.object({ assetId: AssetId, symbol: z.string().optional(), amount: Amount })
  ),
  isRegistered: z.boolean(),
});

export const GetAssetInput = z.object({ assetId: AssetId });

export const GetAssetOutput = z.object({
  assetId: AssetId,
  symbol: z.string(),
  standard: z.string(),                 // MAS0 etc.
  supply: Amount,
  /** How far amounts of this asset are scaled. KMOI reports 9. */
  decimals: z.number(),
  /** The asset's kind: 0 Economic, 1 Possession. */
  dimension: z.number(),
  owner: HexId,
  isLogical: z.boolean(),
  logicId: LogicId.optional(),
});

export const GetInteractionInput = z.object({ hash: InteractionHash });

export const GetInteractionOutput = z.object({
  hash: InteractionHash,
  status: z.enum(["pending", "success", "failed", "unknown"]),
  sender: HexId,
  operations: z.array(
    z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })
  ),
  fuelUsed: z.number().optional(),
  blockHeight: z.number().optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
});

export const GetLogicInput = z.object({ logicId: LogicId });

export const GetLogicOutput = z.object({
  logicId: LogicId,
  name: z.string().optional(),
  routines: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["invoke", "deploy", "enlist", "view"]),
      inputs: z.array(z.object({ name: z.string(), type: z.string() })),
      outputs: z.array(z.object({ name: z.string(), type: z.string() })),
    })
  ),
});

export const ResolveAgentInput = z.object({
  /** Agent registry handle, name, or address. */
  query: z.string().min(1),
});

export const ResolveAgentOutput = z.object({
  found: z.boolean(),
  agentId: z.string().optional(),
  address: HexId.optional(),
  name: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  endpoint: z.string().url().optional(),   // x402 / service URL
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// 3. Write tools (build ix locally → moi.sendInteractions via WalletConnect)
//    All write tools return the same envelope.
// ---------------------------------------------------------------------------

export const WriteResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sent"),
    hash: InteractionHash,
    explorerUrl: z.string().url(),
    /** The plain-language sentence the user was asked to approve. */
    summary: z.string().optional(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["user_rejected", "timeout", "network_mismatch", "wallet_disconnected"]),
    message: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
  /**
   * Hosted writes only. Nothing has reached the phone: this is what it will
   * be asked to sign, for the user to read in the chat first. Calling again
   * with the same arguments and `confirm` sends it.
   */
  z.object({
    status: z.literal("preview"),
    confirm: z.string(),
    summary: z.string(),
    /** The values the wallet will render, labelled in the user's terms. */
    details: z.record(z.string(), z.string()),
    fuel: z.string(),
    network: z.string(),
    expiresAt: z.string(),
    /** Why this is a preview again when the caller expected to send. */
    note: z.string().optional(),
  }),
]);
export type WriteResult = z.infer<typeof WriteResult>;

export const TransferInput = z.object({
  to: HexId,
  assetId: AssetId.describe("Native asset id. Use MOI asset id for gas token."),
  amount: WireAmount,
  memo: z.string().max(140).optional(),
});

export const CreateAssetInput = z.object({
  symbol: z.string().min(1).max(12),
  supply: WireAmount,
  /**
   * KMOI to fund the new asset with so it can pay its own storage, in BASE
   * UNITS. KMOI has 9 decimals, so 10000000000 is 10 KMOI. Omitted, this
   * takes the SDK's default of 10 KMOI. Below about 6.1 KMOI the chain
   * refuses the create; more than you hold and the funding transfer fails.
   */
  storageFund: WireAmount.optional().describe(
    "KMOI base units, not whole KMOI. 10000000000 is 10 KMOI. Leave it out unless you have a reason.",
  ),
  /** How far amounts are scaled: 2 gives cents. Separate from `dimension`. */
  decimals: z.number().int().min(0).max(18).default(0),
  /** The asset's kind. The chain accepts only 0 (Economic) or 1 (Possession). */
  dimension: z.union([z.literal(0), z.literal(1)]).default(0),
  standard: z.string().default("MAS0"),
  isStateful: z.boolean().default(false),
  isFungible: z.boolean().default(true),
});

/**
 * Mint tokens of an asset you manage.
 *
 * Creating a MAS0 asset sets a max_supply CEILING and mints nothing —
 * circulating supply starts at 0, so the creator holds none and the asset is
 * invisible in a wallet until this is called.
 */
export const MintInput = z.object({
  assetId: AssetId.describe("The asset to mint. You must be its manager."),
  amount: WireAmount.describe("How many tokens to mint, scaled by the asset's decimals."),
  to: HexId.optional().describe("Recipient. Defaults to the connected wallet."),
});

export const CallLogicInput = z.object({
  logicId: LogicId,
  routine: z.string().min(1),
  args: z.array(z.unknown()).default([]),
  /** "view" runs locally via provider (no wallet). "invoke" goes to wallet. */
  kind: z.enum(["invoke", "view"]).default("invoke"),
});

export const CallLogicViewOutput = z.object({
  routine: z.string(),
  outputs: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// 4. WalletConnect v2 payloads (moi.* namespace)
//    Mirrors docs.wallet.moi.technology/features/dapp-connections
// ---------------------------------------------------------------------------

export const WC_METHODS = ["moi.signInteraction", "moi.sendInteractions"] as const;
export const WC_EVENTS = ["accountsChanged", "chainChanged"] as const;

/** Namespace we request on pairing. */
export const WcRequiredNamespaces = z.object({
  moi: z.object({
    chains: z.array(z.string()),                  // ["moi:voyage"]
    methods: z.array(z.enum(WC_METHODS)),
    events: z.array(z.enum(WC_EVENTS)),
  }),
});

/**
 * TWO TRANSPORTS CARRY A MOI INTERACTION. Conflating them breaks the write path.
 *
 *   A. dapp -> MOI Wallet, over WalletConnect  <- this is us
 *      The wallet receives the plain, unsigned `InteractionObject`, passed
 *      POSITIONALLY as a one-element `params` array.
 *      Evidence: sarvalabs/wallet-connect-dapp `src/contexts/JsonRpcContext.tsx`
 *      calls `client.request({ ..., request: { method: "moi.sendInteractions",
 *      params: [assetContext] } })` where `assetContext = await
 *      builder.ixData(senderInfo)`, typed `Promise<InteractionObject>`.
 *
 *   B. MOI Wallet -> MOI node, over JSON-RPC   <- NOT us
 *      `moi.SendInteractions` takes `{ ix_args, signatures }`, where `ix_args`
 *      is POLO-encoded UNPREFIXED hex.
 *      Evidence: js-moi-wallet `signInteraction` returns
 *      `{ ix_args: bytesToHex(serializeIxObject(ixObject)),
 *         signatures: bytesToHex(serializeIxSignatures(signatures)) }`.
 *
 * We send form A by default. Form B is retained below because no public doc
 * gives a literal request body for `moi.sendInteractions`, so if the wallet
 * turns out to want the encoded form, MOI_WC_PARAM_STYLE=ix_args switches to it
 * with no code change. See PLAN.md open question 1.
 */

/** POLO-encoded hex. UNPREFIXED — bytesToHex emits no "0x" and the node's
 *  documented ix_args is bare hex. Adding a prefix breaks the wallet. */
export const PoloHex = z.string().regex(/^[0-9a-fA-F]+$/, "expected unprefixed POLO hex");

export const WcSender = z.object({
  id: HexId,
  sequence: z.number(),
  key_id: z.number(),
});

export const WcFund = z.object({
  asset_id: AssetId,
  /**
   * Number, or a decimal string past 2^53. Never a bigint: this crosses a
   * JSON transport, and JSON.stringify throws on bigint.
   */
  amount: z.union([z.string(), z.number()]),
});

export const WcParticipant = z.object({
  id: HexId,
  /** LockType: 0 MUTATE_LOCK, 1 READ_LOCK, 2 NO_LOCK. */
  lock_type: z.number(),
  notary: z.boolean().optional(),
});

export const WcIxOperation = z.object({
  /** OpType — 4 ASSET_CREATE, 5 ASSET_INVOKE, 12 LOGIC_INVOKE. */
  type: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * The unsigned interaction, mirroring js-moi-sdk's `InteractionObject`.
 *
 * Structural only: the three-operation cap is node policy, enforced by
 * ix-builder's assertSendable rather than by the wire shape.
 */
export const WcInteractionObject = z.object({
  sender: WcSender,
  payer: HexId.optional(),
  fuel_price: z.union([z.number(), z.string()]),
  fuel_limit: z.number(),
  funds: z.array(WcFund).optional(),
  ix_operations: z.array(WcIxOperation),
  participants: z.array(WcParticipant).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  perception: HexId.optional(),
});

/** Optional UI hints. Whether the wallet renders these is undocumented. */
export const WcMeta = z.object({
  dappName: z.string().default("MOI MCP Server"),
  description: z.string().optional(),   // "Transfer 50 MOI to pricefeed-01"
});

/**
 * DEFAULT (form A): `params: [accountId, ixObject]` — TWO positional args.
 *
 * UNCONFIRMED. `params: [ixObject]` alone is answered with "Invalid request:
 * account id is required", so an account is clearly mandatory, and the
 * reference dapp's `moi.sign` uses a two-positional shape
 * (`params: [address, message]`). But no shape we have tried has yet produced
 * an approval prompt: the wallet answers this one with the same "account id is
 * required" after 60-190 seconds.
 *
 * Beware of probing this with a short timeout — the wallet's rejection is slow,
 * so "no reply yet" reads as acceptance and is not. See PLAN.md open question 1;
 * this needs the private Dapp-docs or a definitive answer from Sarva Labs.
 */
export const WcSendInteractionsParams = z.tuple([HexId, WcInteractionObject]);

/**
 * ALTERNATE (form B), selected by MOI_WC_PARAM_STYLE=ix_args.
 *
 * An account is required — the wallet answers every payload lacking one with
 * "Invalid request: account id is required". Which key it wants is UNKNOWN:
 * `account`, `address` and `account_id` were all rejected quickly, while
 * `accountId` merely took longer to be rejected. Do not read the slow
 * rejection as acceptance. See PLAN.md open question 1.
 */
export const WcSendInteractionsParamsIxArgs = z.tuple([
  z.object({ accountId: HexId, ix_args: PoloHex, meta: WcMeta.optional() }),
]);

/** Either form — what the client validates against before sending. */
export const WcSendInteractionsParamsAny = z.union([
  WcSendInteractionsParams,
  WcSendInteractionsParamsIxArgs,
]);

/**
 * Response to moi.sendInteractions.
 *
 * NOT DOCUMENTED. The wallet docs say only "Transaction hash" in prose, and the
 * reference dapp types the result as an opaque `string`. We accept a bare hash
 * or an object carrying one under any plausible key; see wc/client.ts
 * extractHash, which fails loudly rather than inventing a hash.
 */
export const WcSendInteractionsResult = z.union([
  InteractionHash,
  z.object({ hash: InteractionHash }),
  z.object({ ix_hash: InteractionHash }),
  z.object({ interaction_hash: InteractionHash }),
]);

/**
 * moi.signInteraction — sign only, the dapp broadcasts. Same two param forms.
 * Unused in v1 (see PLAN.md Phase 5) but kept in step with send.
 */
export const WcSignInteractionParams = WcSendInteractionsParams;
export const WcSignInteractionParamsIxArgs = WcSendInteractionsParamsIxArgs;
export const WcSignInteractionParamsAny = WcSendInteractionsParamsAny;

/**
 * The "signed interaction payload" the docs describe in prose. This is exactly
 * js-moi-sdk's `InteractionRequest`: `{ ix_args: string; signatures: string }`.
 *
 * Note `signatures`, plural — an interaction can carry one signature per
 * registered key, and js-moi-wallet builds an array before serialising them.
 */
export const WcSignInteractionResult = z.object({
  ix_args: PoloHex,
  signatures: PoloHex,
});

// ---------------------------------------------------------------------------
// 5. Session store  (~/.moi-mcp/session.json)
// ---------------------------------------------------------------------------

export const SessionStore = z.object({
  version: z.literal(1),
  topic: z.string(),                 // WC session topic
  pairingTopic: z.string().optional(),
  account: HexId,
  chainId: z.string(),               // CAIP-2
  network: Network,
  peer: z.object({ name: z.string(), url: z.string().optional() }),
  expiry: z.number(),                // unix s (WC expiry)
  createdAt: z.number(),
});
export type SessionStore = z.infer<typeof SessionStore>;

// ---------------------------------------------------------------------------
// 6. Config (env)
// ---------------------------------------------------------------------------

export const Config = z.object({
  MOI_NETWORK: Network.default("voyage"),
  MOI_RPC_URL: z.string().url().optional(),     // override for "custom"
  WC_PROJECT_ID: z.string().min(1),             // ship a default in package
  MOI_MCP_HOME: z.string().default("~/.moi-mcp"),
  MOI_EXPLORER_URL: z.string().url().default("https://voyage.moi.technology"), // TODO confirm
  /**
   * How long to wait for the phone.
   *
   * MUST stay under the MCP client's own request timeout, which defaults to
   * 60s (SDK DEFAULT_REQUEST_TIMEOUT_MSEC). If we wait longer, the client
   * gives up and reports "Request timed out" while the approval is STILL live
   * on the phone — and a tap minutes later broadcasts an interaction the user
   * believes was cancelled. Losing the request is safe; a surprise transfer is
   * not.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().default(55_000),
  LOG_LEVEL: z.enum(["silent", "error", "info", "debug"]).default("error"),
});
export type Config = z.infer<typeof Config>;

// ---------------------------------------------------------------------------
// 7. Error codes (string codes in WriteResult.error.code / thrown McpError data)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  WALLET_NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  NETWORK_MISMATCH: "NETWORK_MISMATCH",       // session chain != MOI_NETWORK
  USER_REJECTED: "USER_REJECTED",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INVALID_ARGS: "INVALID_ARGS",
  RPC_ERROR: "RPC_ERROR",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  LOGIC_ROUTINE_NOT_FOUND: "LOGIC_ROUTINE_NOT_FOUND",
  RELAY_UNAVAILABLE: "RELAY_UNAVAILABLE",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// 8. Tool registry manifest (name → schema) — used by index.ts to register
// ---------------------------------------------------------------------------

export const TOOLS = {
  moi_connect_wallet:    { input: ConnectWalletInput,    write: false },
  moi_wallet_status:     { input: WalletStatusInput,     write: false },
  moi_disconnect_wallet: { input: DisconnectWalletInput, write: false },
  moi_get_account:       { input: GetAccountInput,       write: false },
  moi_get_asset:         { input: GetAssetInput,         write: false },
  moi_get_interaction:   { input: GetInteractionInput,   write: false },
  moi_get_logic:         { input: GetLogicInput,         write: false },
  moi_resolve_agent:     { input: ResolveAgentInput,     write: false },
  moi_transfer:          { input: TransferInput,         write: true  },
  moi_create_asset:      { input: CreateAssetInput,      write: true  },
  moi_call_logic:        { input: CallLogicInput,        write: true  },
} as const;
export type ToolName = keyof typeof TOOLS;
