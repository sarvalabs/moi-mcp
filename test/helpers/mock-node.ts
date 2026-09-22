/**
 * In-process fake MOI node.
 *
 * Speaks exactly the JSON-RPC dialect js-moi-sdk's JsonRpcProvider sends:
 * `{ jsonrpc: "2.0", id, method, params: [ { … } ] }` — params is always a
 * one-element array wrapping the SDK's param object. Every request is
 * recorded so a test can assert on the ORDER of calls (e.g. that no
 * moi.SendInteractions happened before a guard fired).
 *
 * Numeric results are hex strings because that is what the SDK's hexToBN
 * expects — it calls `.trim()` on the value, so a bare number would throw.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RpcCall {
  method: string;
  /** params[0] as sent by the SDK. */
  params: Record<string, unknown>;
}

/** Throw from a handler to send a JSON-RPC error object back. */
export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

type Handler = (params: Record<string, unknown>, call: RpcCall) => unknown;

/** Real voyage devnet identifiers, so ids exercise the SDK's validators. */
export const ACCOUNT = "0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000";
export const KMOI = "0x1080fffe4cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000";
/**
 * An ordinary MAS0 asset. KMOI became a native (MASN) asset in the September
 * 2026 chain upgrade, and the SDK refuses Mint on it: "callsite Mint is
 * reserved for protocol code". Mint tests need a user asset, and the standard
 * is decoded from the id itself, so the 0000 in place of KMOI's fffe is what
 * makes this one MAS0.
 */
export const MAS0_ASSET = "0x108000004cd973c4eb83cdb8870c0de209736270491b7acc99873da100000000";
export const IX_HASH = "0x3c568254d339090d1e0ec256f9ac46fe288aab7d7739275e2267ddff3fdbc009";
export const LOGIC = "0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000";
/** A second participant (fingerprint 0x07…), valid but distinct from ACCOUNT. */
export const OTHER = "0x0000000007070707070707070707070707070707070707070707070700000000";
export const SENT_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc";

const ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Manifest in the node's JSON encoding; the SDK marks routines as "callable". */
export const MANIFEST = {
  syntax: 1,
  engine: { kind: "PISA", flags: [], version: "0.0.0" },
  kind: "logic",
  name: "PingLogic",
  elements: [
    {
      ptr: 0,
      deps: [],
      kind: "callable",
      data: {
        name: "Ping",
        mode: "readonly",
        kind: "invoke",
        accepts: [],
        returns: [],
        executes: { hex: "", asm: [] },
        catches: [],
      },
    },
  ],
};

export interface NodeState {
  /** Balance of KMOI held by ACCOUNT, in base units. */
  kmoiBalance: bigint;
  /** Receipt status moi.Call reports. 0 = would succeed. */
  callStatus: number;
  /** Receipt status moi.InteractionReceipt reports for IX_HASH. */
  receiptStatus: number;
  /** state_exists from moi.AccountMetaInfo. */
  registered: boolean;
}

export interface MockNode {
  url: string;
  calls: RpcCall[];
  state: NodeState;
  /** Override or add a method handler for one test. `reset()` undoes it. */
  on(method: string, handler: Handler): void;
  /** Methods called, in order. */
  methods(): string[];
  /** Forget recorded calls AND drop every `on()` override. */
  reset(): void;
  close(): Promise<void>;
}

function hex(n: bigint | number): string {
  return `0x${BigInt(n).toString(16)}`;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    // The real node's wording, which reads.ts pattern-matches on.
    throw new RpcFailure(`invalid identifier: ${String(value)}`);
  }
  return value;
}

/**
 * The real node rejects a tesseract-addressed read whose `options` block is
 * missing or empty, with `empty options` (docs/upstream-issues.md §4). Without
 * this the mock answers a request devnet would refuse — so dropping the block,
 * or passing an explicit `{}`, stays green in CI and fails live.
 */
function requireOptions(p: Record<string, unknown>): void {
  const options = p["options"];
  if (typeof options !== "object" || options === null || Object.keys(options).length === 0) {
    throw new RpcFailure("empty options");
  }
}

/** `moi.Call` / `moi.FuelEstimate` carry the interaction under `ix_args`. */
function requireIxArgs(p: Record<string, unknown>): Array<Record<string, unknown>> {
  const args = p["ix_args"];
  if (typeof args !== "object" || args === null) {
    throw new RpcFailure("empty ix_args");
  }
  const ops = (args as Record<string, unknown>)["ix_operations"];
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new RpcFailure("interaction has no operations");
  }
  return ops as Array<Record<string, unknown>>;
}

function defaultHandlers(state: NodeState): Record<string, Handler> {
  return {
    "moi.AccountState": (p) => {
      requireId(p["id"]);
      requireOptions(p);
      return { balance: {}, context_hash: "0x00" };
    },
    // No options block on this one: the SDK sends `{ id }` alone.
    "moi.AccountMetaInfo": (p) => {
      requireId(p["id"]);
      return { state_exists: state.registered, key_ids: [0] };
    },
    "moi.InteractionCount": (p) => {
      requireId(p["id"]);
      requireOptions(p);
      return hex(5);
    },
    // Likewise: the pending counter is not tesseract-addressed.
    "moi.PendingInteractionCount": (p) => {
      requireId(p["id"]);
      return hex(5);
    },
    "moi.TDU": (p) => {
      requireId(p["id"]);
      requireOptions(p);
      return [{ asset_id: KMOI, token_id: "0x0", amount: hex(state.kmoiBalance) }];
    },
    "moi.AssetInfoByAssetID": (p) => {
      requireId(p["asset_id"]);
      requireOptions(p);
      return {
        symbol: "KMOI",
        dimension: "0x0",
        decimals: 0,
        creator: ACCOUNT,
        max_supply: "0x51dac207a000",
        circulating_supply: hex(90_000_000_100_000n),
      };
    },
    "moi.InteractionByHash": (p) => ({
      hash: p["hash"],
      sender: { id: ACCOUNT, sequence: 4, key_id: 0 },
      fuel_price: "0x1",
      fuel_limit: "0x1c1",
      ix_operations: [{ type: 5, payload: { asset_id: KMOI, callsite: "Transfer", calldata: "0e" } }],
    }),
    "moi.InteractionReceipt": (p) => ({
      ix_hash: p["hash"],
      from: ACCOUNT,
      status: state.receiptStatus,
      fuel_used: "0x12b",
      ix_operations: [{ tx_type: "0x5", status: state.receiptStatus, data: { error: "0x" } }],
    }),
    "moi.LogicManifest": (p) => {
      requireId(p["logic_id"]);
      requireOptions(p);
      // encoding "JSON": the node returns the marshalled JSON as hex bytes.
      return `0x${Buffer.from(JSON.stringify(MANIFEST), "utf8").toString("hex")}`;
    },
    // Validate what is being simulated. Ignoring these params lets the server
    // dry-run an interaction unrelated to the one the phone is asked to sign —
    // the real node would reject an empty ix_operations outright.
    "moi.Call": (p) => {
      requireIxArgs(p);
      return {
        status: state.callStatus,
        fuel_used: "0x12b",
        ix_operations: [
          { tx_type: "0xc", status: state.callStatus, data: { outputs: "0x", error: "0x" } },
        ],
      };
    },
    "moi.FuelEstimate": (p) => {
      requireIxArgs(p);
      return "0x12b";
    },
    "moi.SendInteractions": (p) => {
      if (typeof p["ix_args"] !== "string" || typeof p["signatures"] !== "string") {
        throw new RpcFailure("ix_args and signatures are required");
      }
      return SENT_HASH;
    },
  };
}

export async function startMockNode(overrides: Partial<NodeState> = {}): Promise<MockNode> {
  const state: NodeState = {
    kmoiBalance: 110_000_000_000_000n,
    callStatus: 0,
    receiptStatus: 0,
    registered: true,
    ...overrides,
  };
  let handlers = defaultHandlers(state);
  const calls: RpcCall[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params: unknown;
      };
      const params = (Array.isArray(body.params) ? body.params[0] : body.params) ?? {};
      const call: RpcCall = { method: body.method, params: params as Record<string, unknown> };
      calls.push(call);

      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
      };

      // The real node requires the one-element array wrapper and rejects an
      // unwrapped param object (docs/upstream-issues.md §4). Accepting both
      // here would paper over a caller that sends the wrong shape.
      if (!Array.isArray(body.params)) {
        reply({ error: { code: -32000, message: "empty options" } });
        return;
      }

      const handler = handlers[body.method];
      if (!handler) {
        reply({ error: { code: -32601, message: `the method ${body.method} does not exist` } });
        return;
      }
      try {
        reply({ result: handler(call.params, call) });
      } catch (err) {
        const failure = err instanceof RpcFailure ? err : new RpcFailure(String(err));
        reply({ error: { code: failure.code, message: failure.message } });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    on(method, handler) {
      handlers[method] = handler;
    },
    methods() {
      return calls.map((c) => c.method);
    },
    reset() {
      calls.length = 0;
      // Restore the defaults too. Hand-written restores after an `on()`
      // override drift from the real handler — one that skipped requireOptions
      // would quietly disable that check for every later test on this node.
      handlers = defaultHandlers(state);
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
