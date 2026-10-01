/**
 * WalletConnect v2 transport to MOI Wallet. No MCP imports.
 *
 * This module is the only place that talks to the relay, and it never sees a
 * private key: it ships an unsigned interaction to the phone and waits for the
 * user to approve. The wallet signs and broadcasts.
 */

// NAMED import. The package's ESM entry puts the class on `SignClient`; the
// default export is the CJS module object of constants, whose `.init` is
// undefined. `import SignClient from ...` fails at runtime, not compile time.
import { SignClient } from "@walletconnect/sign-client";

import { log, WC_PROJECT_ID_HELP } from "../config.js";
import { MoiError } from "../moi-error.js";
import {
  ErrorCode,
  WC_EVENTS,
  WC_METHODS,
  WcSendInteractionsParams,
  WcSendInteractionsParamsIxArgs,
  WcSignInteractionResult,
  type Network,
} from "../schema.js";
import { toWireJson, type UnsignedInteraction } from "../moi/ix-builder.js";
import { NETWORKS } from "../moi/provider.js";
import { clearSession, loadSession, saveSession, type Session } from "./session.js";

export const WC_NAMESPACE = "moi";

/**
 * How the interaction is placed in the WalletConnect request. Both forms and
 * the evidence for each are modelled in schema.ts §4.
 *
 * "positional" — schema.WcSendInteractionsParams: `params: [ixObject]`.
 * "ix_args"    — schema.WcSendInteractionsParamsIxArgs: `params: [{ ix_args }]`.
 */
export type ParamStyle = "positional" | "ix_args";

export function paramStyle(env: NodeJS.ProcessEnv = process.env): ParamStyle {
  return env["MOI_WC_PARAM_STYLE"] === "ix_args" ? "ix_args" : "positional";
}

export interface WcConfig {
  projectId: string;
  home: string;
  network: Network;
  requestTimeoutMs: number;
  /** Overrides the network's CAIP-2 chain id. */
  chainId?: string;
  /**
   * Pluggable key/value store for the WalletConnect SDK's own state
   * (IKeyValueStorage). Supply it to keep that state somewhere shared, such as
   * Redis, instead of a local sqlite file. Omit it and the SDK uses `home`.
   */
  storage?: {
    getKeys(): Promise<string[]>;
    getEntries<T = unknown>(): Promise<[string, T][]>;
    getItem<T = unknown>(key: string): Promise<T | undefined>;
    setItem<T = unknown>(key: string, value: T): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
}

export interface PairResult {
  uri: string;
  /** Resolves when the user approves on their phone; rejects if they reject. */
  approval: Promise<Session>;
}

const METADATA = {
  name: "MOI MCP Server",
  description: "Lets an AI agent read MOI chain state and propose interactions for you to approve.",
  url: "https://moi.technology",
  icons: ["https://moi.technology/favicon.ico"],
};

/** Minimal surface we need from SignClient — lets tests inject a fake. */
export interface SignClientLike {
  connect(args: unknown): Promise<{ uri?: string; approval: () => Promise<unknown> }>;
  request<T>(args: unknown): Promise<T>;
  disconnect(args: unknown): Promise<void>;
  on(event: string, cb: (payload: unknown) => void): void;
  session: { keys: string[]; get(topic: string): unknown };
}

export class WalletConnectClient {
  private client?: SignClientLike;
  private readonly config: WcConfig;
  private readonly factory: (cfg: WcConfig) => Promise<SignClientLike>;
  /** Requests sent to the phone and not yet answered. */
  private pending = 0;

  constructor(config: WcConfig, factory?: (cfg: WcConfig) => Promise<SignClientLike>) {
    this.config = config;
    this.factory = factory ?? defaultFactory;
  }

  get pendingRequests(): number {
    return this.pending;
  }

  chainId(): string {
    return this.config.chainId ?? NETWORKS[this.config.network].caip2;
  }

  async init(): Promise<SignClientLike> {
    if (this.client) return this.client;
    try {
      this.client = await this.factory(this.config);
    } catch (err) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        `Could not reach the WalletConnect relay: ${firstLine(err instanceof Error ? err.message : String(err))}. ` +
          `Check your network connection and WC_PROJECT_ID. ${WC_PROJECT_ID_HELP}`,
      );
    }

    // The wallet can end the session from its side; drop our copy when it does.
    for (const event of ["session_delete", "session_expire"]) {
      this.client.on(event, () => clearSession(this.config.home));
    }
    return this.client;
  }

  session(): Session | undefined {
    return loadSession(this.config.home);
  }

  /**
   * Load our session, or adopt one WalletConnect is already holding.
   *
   * The two stores can diverge: SignClient persists its own session the moment
   * the wallet approves, while ours is written afterwards. If that second step
   * ever fails, the user has a live wallet session and we would otherwise ask
   * them to pair again for nothing.
   */
  async currentSession(): Promise<Session | undefined> {
    const own = this.session();
    if (own) return own;

    let client: SignClientLike;
    try {
      client = await this.init();
    } catch {
      return undefined;
    }

    const chainId = this.chainId();
    for (const topic of client.session.keys ?? []) {
      try {
        const adopted = toSession(client.session.get(topic), this.config.network, chainId);
        saveSession(this.config.home, adopted);
        return adopted;
      } catch {
        // Not a MOI session, or unusable. Try the next.
      }
    }
    return undefined;
  }

  /** Start pairing. Returns the URI to render as a QR immediately. */
  async pair(): Promise<PairResult> {
    const client = await this.init();
    const chainId = this.chainId();

    let uri: string | undefined;
    let approval: () => Promise<unknown>;
    try {
      // optionalNamespaces, not requiredNamespaces: WalletConnect deprecated
      // the latter and silently moves it to the former before the proposal
      // reaches the wallet, so "required" never meant required. We therefore
      // verify the wallet actually granted the moi chain after approval —
      // toSession() throws if the session carries no moi account.
      ({ uri, approval } = await client.connect({
        optionalNamespaces: {
          [WC_NAMESPACE]: {
            chains: [chainId],
            methods: [...WC_METHODS],
            events: [...WC_EVENTS],
          },
        },
      }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // The relay rejects an unknown or malformed project id at publish time.
      if (/publish|project|unauthorized|forbidden|403|401/i.test(detail)) {
        throw new MoiError(
          ErrorCode.RELAY_UNAVAILABLE,
          `The WalletConnect relay refused the pairing, which almost always means ` +
            `WC_PROJECT_ID is wrong. ${WC_PROJECT_ID_HELP} (relay said: ${firstLine(detail)})`,
        );
      }
      throw translateWcError(err);
    }

    if (!uri) {
      throw new MoiError(ErrorCode.RELAY_UNAVAILABLE, "WalletConnect returned no pairing URI.");
    }

    const settled = approval().then((raw) => {
      const session = toSession(raw, this.config.network, chainId);
      saveSession(this.config.home, session);
      return session;
    });

    return { uri, approval: settled };
  }

  async disconnect(reason = "User requested disconnect"): Promise<boolean> {
    const session = this.session();
    clearSession(this.config.home);
    if (!session) return false;
    try {
      const client = await this.init();
      await client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: reason },
      });
    } catch {
      // The local session is already gone; a relay failure must not block.
    }
    return true;
  }

  /**
   * Ask the wallet to sign, and return the signed payload for us to broadcast.
   *
   * This is the primary write path. `moi.sendInteractions` — where the wallet
   * signs AND broadcasts — is broken in MOI Wallet as of 2026-08-26: it fails
   * with "Calling the 'finalizeAsync' function has failed → NOT NULL
   * constraint failed: interactions_metadata.number_of_operations", a SQLite
   * error from inside the wallet's own database. That reproduces with a
   * payload built by the SDK's own MAS0AssetLogic builder, i.e. byte-for-byte
   * what the official reference dapp sends, so it is a wallet bug rather than
   * a malformed request.
   *
   * `moi.signInteraction` works. We broadcast the result via the node's
   * moi.SendInteractions, which keeps the zero-key property intact: the
   * signature is produced on the phone and we only relay it.
   */
  async signInteraction(
    session: Session,
    ix: UnsignedInteraction,
    opts: { description?: string } = {},
  ): Promise<{ ix_args: string; signatures: string }> {
    const client = await this.init();
    void opts;

    this.pending += 1;
    try {
      const raw = await withTimeout(
        client.request<unknown>({
          topic: session.topic,
          chainId: session.chainId,
          request: { method: "moi.signInteraction", params: [toWireJson(ix)] },
        }),
        this.config.requestTimeoutMs,
      );

      const parsed = WcSignInteractionResult.safeParse(raw);
      if (!parsed.success) {
        throw new MoiError(
          ErrorCode.RPC_ERROR,
          `MOI Wallet signed the interaction but returned an unexpected payload: ${JSON.stringify(raw)?.slice(0, 200)}`,
        );
      }
      return parsed.data;
    } catch (err) {
      try {
        process.stderr.write(
          `[moi-mcp] debug: raw wallet error ${JSON.stringify(err, Object.getOwnPropertyNames(Object(err))).slice(0, 400)}\n`,
        );
      } catch {
        /* diagnostics must never break the error path */
      }
      throw translateWcError(err);
    } finally {
      this.pending -= 1;
    }
  }

  /**
   * Send an unsigned interaction to the phone and wait for the user.
   * Returns the interaction hash the wallet reports after broadcasting.
   *
   * NOTE: broken in MOI Wallet — see signInteraction above. Retained because
   * it is the documented method and should be preferred once fixed.
   */
  async sendInteraction(
    session: Session,
    ix: UnsignedInteraction,
    opts: { description?: string; poloHex?: string } = {},
  ): Promise<string> {
    const client = await this.init();
    const style = paramStyle();

    // Validate against the schema before anything reaches the relay: a
    // malformed interaction should fail here with a readable message, not on
    // the user's phone.
    let params: unknown[];
    if (style === "ix_args") {
      if (!opts.poloHex) {
        throw new MoiError(
          ErrorCode.INVALID_ARGS,
          "MOI_WC_PARAM_STYLE=ix_args requires a POLO-encoded interaction, but none was supplied.",
        );
      }
      params = parseParams(WcSendInteractionsParamsIxArgs, [
        {
          accountId: ix.sender.id,
          ix_args: opts.poloHex,
          meta: {
            dappName: METADATA.name,
            ...(opts.description ? { description: opts.description } : {}),
          },
        },
      ]);
    } else {
      // Convert bigints before validating or sending: they are valid POLO
      // values but cannot cross a JSON transport.
      params = parseParams(WcSendInteractionsParams, [ix.sender.id, toWireJson(ix)]);
    }

    this.pending += 1;
    try {
      const raw = await withTimeout(
        client.request<unknown>({
          topic: session.topic,
          chainId: session.chainId,
          request: { method: "moi.sendInteractions", params },
        }),
        this.config.requestTimeoutMs,
      );
      return extractHash(raw);
    } catch (err) {
      // Log the raw shape once: the translated message is for the agent, but
      // an unrecognised wallet error is only debuggable from the original.
      try {
        // Through log() so LOG_LEVEL=silent actually silences it.
        log("debug", `raw wallet error ${JSON.stringify(err, Object.getOwnPropertyNames(Object(err))).slice(0, 500)}`);
      } catch {
        /* never let diagnostics break the error path */
      }
      throw translateWcError(err);
    } finally {
      this.pending -= 1;
    }
  }
}

// ---------------------------------------------------------------------------

/** Validate outgoing params, turning a zod failure into a readable MoiError. */
function parseParams<T extends { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } }>(
  schema: T,
  value: unknown,
): unknown[] {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = (result.error?.issues ?? [])
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `The interaction does not match what MOI Wallet expects — ${detail}`,
    );
  }
  return result.data as unknown[];
}

async function defaultFactory(cfg: WcConfig): Promise<SignClientLike> {
  const client = await SignClient.init({
    projectId: cfg.projectId,
    metadata: METADATA,
    storageOptions: { database: `${cfg.home}/wc.db` },
  });
  return client as unknown as SignClientLike;
}

/** Relay errors arrive with stack traces attached; keep the first line only. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim().slice(0, 240);
}

/**
 * Get a readable message out of whatever the relay threw.
 *
 * WalletConnect rejects with plain objects as often as with Errors — often
 * `{ code, message }` or `{ error: { code, message } }`. String(err) on those
 * yields "[object Object]", which discards the only diagnostic the wallet
 * gave us.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const nested = (o["error"] ?? o["data"]) as Record<string, unknown> | undefined;
    for (const candidate of [o["message"], nested?.["message"], o["reason"], nested?.["reason"]]) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MoiError(
          ErrorCode.REQUEST_TIMEOUT,
          `The wallet did not respond within ${Math.round(ms / 1000)}s. The request may still be waiting on your phone.`,
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * The wallet's response shape is not documented — the reference dapp types it
 * as an opaque string. Accept a bare hash, or an object carrying one.
 */
export function extractHash(raw: unknown): string {
  if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw.trim())) return raw.trim();
  if (raw && typeof raw === "object") {
    for (const key of ["hash", "ix_hash", "interaction_hash", "txHash", "result"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value;
    }
  }
  throw new MoiError(
    ErrorCode.RPC_ERROR,
    `MOI Wallet approved the interaction but returned an unrecognised response: ${JSON.stringify(raw)?.slice(0, 200)}`,
    { raw: raw as never },
  );
}

const REJECTION = /reject|denied|declined|user closed|cancell?ed/i;

/**
 * The wallet failed on its own terms rather than the user declining.
 * "Failed to sign interaction" is js-moi-sdk's own throw string — MOI Wallet
 * uses the SDK internally, so seeing it means OUR payload broke the wallet's
 * POLO serialisation. Reporting that as "you rejected it" sends the user
 * hunting for a phone tap that never happened.
 */
const WALLET_FAILURE =
  /failed to (sign|serial|create|build)|invalid request|invalid interaction|unsupported|malformed|is required|constraint failed|finalizeasync/i;

/** Map WalletConnect's error vocabulary onto ours. */
export function translateWcError(err: unknown): MoiError {
  if (err instanceof MoiError) return err;
  const message = describeError(err);
  const o = (err ?? {}) as Record<string, unknown>;
  const nested = (o["error"] ?? o["data"]) as Record<string, unknown> | undefined;
  const code = (o["code"] ?? nested?.["code"]) as number | undefined;

  // Check wallet-side failures FIRST: they can arrive under code 5000, which
  // would otherwise be misread as a user rejection.
  if (WALLET_FAILURE.test(message)) {
    return new MoiError(
      ErrorCode.INVALID_ARGS,
      `MOI Wallet could not process the interaction: "${firstLine(message)}". ` +
        `This is a malformed payload, not a rejection — you did not decline anything.`,
    );
  }

  // 5000/4001 are the conventional user-rejected codes.
  if (code === 5000 || code === 4001 || REJECTION.test(message)) {
    return new MoiError(
      ErrorCode.USER_REJECTED,
      `You rejected the interaction on your phone. (wallet said: "${firstLine(message)}")`,
    );
  }
  if (/expired|no matching key|session topic doesn't exist/i.test(message)) {
    return new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
    );
  }
  return new MoiError(ErrorCode.RPC_ERROR, `WalletConnect request failed: ${message}`);
}

/**
 * Collect accounts across every namespace entry that belongs to us.
 *
 * CAIP-25 lets a wallet key the GRANTED namespaces differently from how they
 * were requested. We request `{ moi: {...} }`; MOI Wallet responds with
 * `{ "moi:14": {...} }`, keyed by the full CAIP-2 chain id. Reading only
 * `namespaces.moi` finds nothing and throws away a perfectly good session,
 * so accept both spellings.
 */
export function accountsFrom(
  namespaces: Record<string, { accounts?: string[] }> | undefined,
  chainId: string,
): string[] {
  const matched: string[] = [];
  for (const [key, value] of Object.entries(namespaces ?? {})) {
    if (key !== WC_NAMESPACE && !key.startsWith(`${WC_NAMESPACE}:`)) continue;
    matched.push(...(value?.accounts ?? []));
  }
  // Prefer an account actually on the chain we asked for.
  const onChain = matched.filter((a) => a.startsWith(`${chainId}:`));
  return onChain.length > 0 ? onChain : matched;
}

/** Normalise the settled WalletConnect session into our on-disk shape. */
export function toSession(raw: unknown, network: Network, chainId: string): Session {
  const s = raw as {
    topic?: string;
    pairingTopic?: string;
    expiry?: number;
    peer?: { metadata?: { name?: string; url?: string } };
    namespaces?: Record<string, { accounts?: string[] }>;
  };

  const accounts = accountsFrom(s.namespaces, chainId);
  // CAIP-10: "moi:14:0xabc..." — the account is the last colon-separated part.
  const account = accounts[0]?.split(":").pop() ?? "";

  if (!s.topic) {
    throw new MoiError(ErrorCode.RELAY_UNAVAILABLE, "WalletConnect session carried no topic.");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(account)) {
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      `MOI Wallet approved but returned no usable account (got "${account}").`,
    );
  }

  return {
    version: 1,
    topic: s.topic,
    ...(s.pairingTopic ? { pairingTopic: s.pairingTopic } : {}),
    account,
    chainId,
    network,
    peer: {
      name: s.peer?.metadata?.name ?? "MOI Wallet",
      ...(s.peer?.metadata?.url ? { url: s.peer.metadata.url } : {}),
    },
    expiry: s.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    createdAt: Math.floor(Date.now() / 1000),
  };
}
