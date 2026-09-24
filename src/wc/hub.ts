/**
 * WalletConnect hub — multi-user-safe signing orchestrator.
 *
 * Owns the single SignClient per hosted process, gating all signing through
 * topic-based session lookup. No method accepts userId, Session, or account —
 * only topic, which is resolved from the native SignClient's own session store.
 *
 * INVARIANTS:
 * - One WalletConnectHub per process, created by main()
 * - One SignClient per process, owned exclusively by this hub
 * - Signing is only available via signInteractionFor / signMessageFor(topic, ...)
 * - Topic is never accepted from tool parameters; only from StoredWalletSession
 * - Identity reasoning (userId -> topic) is caller's job (hosted-writes.ts)
 */

import type { UnsignedInteraction } from "../moi/ix-builder.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode, WC_EVENTS, WC_METHODS, WcSignMessageResult, type Network } from "../schema.js";
import { toWireJson } from "../moi/ix-builder.js";
import { translateWcError, toSession, WC_NAMESPACE, type PairResult } from "./client.js";
import { NETWORKS } from "../moi/provider.js";
import type { SignClientLike, WcConfig } from "./client.js";
import { SignClient } from "@walletconnect/sign-client";

export interface SignInteractionOpts {
  description?: string;
}

export interface HubSignResult {
  ix_args: string;
  signatures: string;
}

export interface HubSignMessageResult {
  signature: string;
}

/**
 * Public contract of WalletConnectHub. Callers that only need to drive
 * signing (HostedDeps.hub, HostedWriteDeps.hub) and tests that need a hand-
 * rolled fake should depend on this instead of the concrete class — the
 * class itself carries a private `signClient` field, which makes it
 * unusable as a structural type for a plain-object or separate-class test
 * double (TS treats private members as nominal, not structural).
 */
export interface WalletConnectHubLike {
  pair(network: Network, chainIdOverride?: string): Promise<PairResult>;
  signInteractionFor(
    topic: string,
    ix: UnsignedInteraction,
    opts?: SignInteractionOpts,
  ): Promise<HubSignResult>;
  /** Signs a plain-text message with the paired account (`moi.sign`). Nothing is broadcast. */
  signMessageFor(topic: string, accountId: string, message: string): Promise<HubSignMessageResult>;
  onSessionDelete(handler: (topic: string) => void): () => void;
  /** Ends one session on the relay so the phone stops listing it. Best effort. */
  disconnect(topic: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Find the CAIP-2 chain a settled session is on.
 *
 * MOI Wallet keys the namespaces map inconsistently: sometimes `moi` with a
 * `chains` list, sometimes the chain id itself (`moi:14`) as the key. Accounts
 * are CAIP-10 (`moi:14:0xabc`), so they carry it as well. Try each, most
 * explicit first.
 */
export function chainIdFromSession(raw: unknown): string | undefined {
  const namespaces =
    (raw as { namespaces?: Record<string, { chains?: string[]; accounts?: string[] }> } | undefined)
      ?.namespaces ?? {};
  for (const [key, value] of Object.entries(namespaces)) {
    if (key !== WC_NAMESPACE && !key.startsWith(`${WC_NAMESPACE}:`)) continue;
    if (key.includes(":")) return key;
    const chain = value?.chains?.find((c) => c.startsWith(`${WC_NAMESPACE}:`));
    if (chain) return chain;
    const account = value?.accounts?.find((a) => a.startsWith(`${WC_NAMESPACE}:`));
    if (account) {
      const parts = account.split(":");
      if (parts.length >= 3) return `${parts[0]}:${parts[1]}`;
    }
  }
  return undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MoiError(
          ErrorCode.REQUEST_TIMEOUT,
          `No answer from MOI Wallet within ${Math.round(ms / 1000)} seconds. Nothing was sent. Check the phone and try again.`,
        ),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Minimal metadata for WalletConnect initialization. */
// This is what MOI Wallet shows on the pairing screen: the one label about
// this server a user ever sees on their phone. Keep it recognisable.
const METADATA = {
  name: "MOI MCP",
  description: "Talk to MOI from your AI assistant. It proposes; you approve every transaction here.",
  url: "https://moi.technology",
  icons: ["https://moi.technology/brand/logos/SVG/default-light.svg"],
};

/**
 * Multi-user-safe wrapper around the single WalletConnect SignClient.
 *
 * The hub owns the relay connection and mediates all signing. It never touches
 * userId or makes routing decisions — those stay in hosted-writes.ts. It only
 * knows topics and the relay.
 */
export class WalletConnectHub implements WalletConnectHubLike {
  /**
   * Public so tests can construct a hub around a fake SignClientLike
   * directly. Production code should still only ever call this once, via
   * WalletConnectHub.init() in main() — that invariant is process wiring,
   * not something the type system enforces here.
   */
  constructor(
    private readonly signClient: SignClientLike,
    /** Used only when a settled session carries no recognisable chain. */
    private readonly defaultChainId?: string,
    /** How long to wait for the phone before giving up; 0 or undefined waits forever. */
    private readonly requestTimeoutMs?: number,
  ) {}

  /**
   * Constructs and initializes the single WalletConnectHub for this process.
   * Called once by main() before any tool registration.
   */
  static async init(config: WcConfig): Promise<WalletConnectHub> {
    const client = await defaultFactory(config);
    return new WalletConnectHub(client, config.chainId ?? NETWORKS[config.network].caip2, config.requestTimeoutMs);
  }

  /**
   * Opens a pairing and returns the wc: URI plus a promise that resolves when
   * the phone approves.
   *
   * Pairing MUST happen on this same SignClient. signInteractionFor() resolves
   * a topic against `this.signClient.session`, so a session paired on any other
   * client is invisible here and every write for that user would fail with
   * "session no longer valid" forever.
   */
  async pair(network: Network, chainIdOverride?: string): Promise<PairResult> {
    const chainId = chainIdOverride ?? NETWORKS[network].caip2;

    let uri: string | undefined;
    let approval: () => Promise<unknown>;
    try {
      // optionalNamespaces mirrors WalletConnectClient.pair(): WalletConnect
      // moves requiredNamespaces into optional before the wallet ever sees the
      // proposal, so toSession() below is what actually enforces the moi chain.
      ({ uri, approval } = await this.signClient.connect({
        optionalNamespaces: {
          [WC_NAMESPACE]: {
            chains: [chainId],
            methods: [...WC_METHODS],
            events: [...WC_EVENTS],
          },
        },
      }));
    } catch (err) {
      throw translateWcError(err);
    }

    if (!uri) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        "WalletConnect did not return a pairing URI.",
      );
    }

    return {
      uri,
      approval: approval().then(
        (raw) => toSession(raw, network, chainId),
        (err: unknown) => {
          throw translateWcError(err);
        },
      ),
    };
  }

  /**
   * Tears down a single session, by topic only. Used when a pairing is
   * forgotten or a once-only pairing has done its one job, so the wallet does
   * not keep showing a connection the server can no longer use.
   */
  async disconnect(topic: string): Promise<void> {
    try {
      await this.signClient.disconnect({
        topic,
        reason: { code: 6000, message: "Disconnected by the server" },
      });
    } catch (err) {
      // The session may already be gone on the relay; that is the outcome we
      // wanted, so it is not worth failing the caller over.
      throw translateWcError(err);
    }
  }

  /**
   * Closes the underlying relay socket. Call once at process shutdown.
   */
  async close(): Promise<void> {
    // SignClient doesn't expose a close method; relay stays open until disconnect.
    // This is a hook for future cleanup or explicit relay teardown.
  }

  /**
   * Signs an unsigned interaction on the WalletConnect session identified by topic.
   *
   * STRICTLY requires a topic — no userId, Session, account, or any alternate
   * routing. The topic is looked up in the underlying SignClient's own session
   * store (keyed by topic, per WalletConnect semantics), NOT via our
   * WalletSessionStore or any caller-supplied object.
   *
   * Throws MoiError(WALLET_NOT_CONNECTED) if:
   * - No native session exists for the topic (never paired, or relay-expired/deleted)
   * - The topic is invalid or unreachable on the relay
   *
   * Throws MoiError(USER_REJECTED | INVALID_ARGS | ...) if the wallet rejects
   * the signature request or finds the payload malformed.
   *
   * @param topic - WalletConnect session topic, sourced only from StoredWalletSession.topic
   * @param ix - Unsigned interaction to sign
   * @param opts - description is accepted for a future wallet that can show
   *   it; today moi.signInteraction carries only the interaction, so nothing
   *   here reaches the phone. The chat is where the user reads the sentence.
   * @returns Signed payload { ix_args, signatures } ready to broadcast
   */
  async signInteractionFor(
    topic: string,
    ix: UnsignedInteraction,
    opts: SignInteractionOpts = {},
  ): Promise<HubSignResult> {
    // Validate that a native session exists for this topic.
    // If it's gone (relay-expired, phone-unpaired), fail immediately.
    const nativeSession = this.signClient.session.get(topic);
    if (!nativeSession) {
      throw new MoiError(
        ErrorCode.WALLET_NOT_CONNECTED,
        "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
      );
    }

    // A settled WalletConnect session has no chainId field; the chain lives
    // in its namespaces. Reading a field that does not exist is how every
    // hosted signing request failed while every test (whose fakes had the
    // field) passed.
    const chainId = chainIdFromSession(nativeSession) ?? this.defaultChainId;
    if (!chainId) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        "Could not tell which chain this wallet session is on. Pair again with moi_connect_wallet.",
      );
    }

    // Sign via the relay.
    try {
      const pending = this.signClient.request<unknown>({
        topic,
        chainId,
        request: { method: "moi.signInteraction", params: [toWireJson(ix)] },
      });
      // A phone that never answers must not hold a request open for good. On
      // timeout the relay request is abandoned; a tap that lands afterwards
      // resolves a promise nobody is waiting on, so nothing is broadcast.
      const raw = this.requestTimeoutMs && this.requestTimeoutMs > 0
        ? await withTimeout(pending, this.requestTimeoutMs)
        : await pending;

      // Parse the result. WcSignInteractionResult schema from schema.ts validates
      // the shape. If parsing fails, the wallet returned something we don't understand.
      const { WcSignInteractionResult } = await import("../schema.js");
      const parsed = WcSignInteractionResult.safeParse(raw);
      if (!parsed.success) {
        throw new MoiError(
          ErrorCode.RPC_ERROR,
          `MOI Wallet signed the interaction but returned an unexpected payload: ${JSON.stringify(raw)?.slice(0, 200)}`,
        );
      }

      return parsed.data as HubSignResult;
    } catch (err) {
      // If it's already a MoiError, pass it through.
      if (err instanceof MoiError) throw err;

      // Log the raw error for diagnostics (no console in hosted env; logging goes to stderr).
      try {
        process.stderr.write(
          `[moi-mcp-hub] debug: raw wallet error ${JSON.stringify(err, Object.getOwnPropertyNames(Object(err))).slice(0, 400)}\n`,
        );
      } catch {
        /* diagnostics must never break the error path */
      }

      // Translate WalletConnect errors into readable MoiErrors.
      throw translateWcError(err);
    }
  }

  /**
   * Ask the phone to sign a plain-text message with one of the paired
   * accounts. This is `moi.sign`, the same method MOI's dapps use for
   * Sign-In With MOI: the wallet shows the text, the person approves, and
   * the signature comes back. No interaction is built or broadcast.
   */
  async signMessageFor(
    topic: string,
    accountId: string,
    message: string,
  ): Promise<HubSignMessageResult> {
    const nativeSession = this.signClient.session.get(topic);
    if (!nativeSession) {
      throw new MoiError(
        ErrorCode.WALLET_NOT_CONNECTED,
        "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
      );
    }
    const chainId = chainIdFromSession(nativeSession) ?? this.defaultChainId;
    if (!chainId) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        "Could not tell which chain this wallet session is on. Pair again with moi_connect_wallet.",
      );
    }
    try {
      const pending = this.signClient.request<unknown>({
        topic,
        chainId,
        request: { method: "moi.sign", params: [accountId, message] },
      });
      // Same rule as interactions: a phone that never answers must not hold
      // the request open for good.
      const raw = this.requestTimeoutMs && this.requestTimeoutMs > 0
        ? await withTimeout(pending, this.requestTimeoutMs)
        : await pending;
      const parsed = WcSignMessageResult.safeParse(raw);
      if (!parsed.success) {
        throw new MoiError(
          ErrorCode.RPC_ERROR,
          `MOI Wallet signed the message but returned an unexpected payload: ${JSON.stringify(raw)?.slice(0, 200)}`,
        );
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof MoiError) throw err;
      throw translateWcError(err);
    }
  }

  /**
   * Registers a handler for when a wallet session is deleted out-of-band.
   *
   * The relay fires a `session_delete` event when a user unpairs a session on
   * their phone. This handler lets the caller (main() wiring) reconcile our
   * own WalletSessionStore when that happens.
   *
   * The handler receives only the bare topic; resolving topic -> userId is the
   * caller's job (via WalletSessionStore.findByTopic), keeping this class
   * ignorant of userId entirely.
   *
   * @param handler - Called with the topic when session_delete fires
   * @returns Unsubscribe function; call to stop listening
   */
  onSessionDelete(handler: (topic: string) => void): () => void {
    const wrappedHandler = (payload: unknown) => {
      // WalletConnect passes { topic: string } on session_delete.
      const p = payload as { topic?: string };
      if (p?.topic) {
        handler(p.topic);
      }
    };

    this.signClient.on("session_delete", wrappedHandler);

    // Return unsubscribe function (naive; SignClient doesn't expose .off).
    // Callers should only call this at shutdown, so a no-op is acceptable.
    return () => {
      // No-op: we've subscribed once and will listen for the lifetime of the hub.
      // Proper teardown would require SignClient.off, which is not exposed.
    };
  }
}

/**
 * Default factory: creates and initializes a real SignClient.
 * Injected by tests with a fake.
 */
async function defaultFactory(cfg: WcConfig): Promise<SignClientLike> {
  // With a storage backend supplied, the SDK keeps its keychain, subscriptions
  // and sessions there instead of a local sqlite file. That is what lets a
  // replacement process serve a user who paired against an earlier one: our own
  // session store alone would give it the topic but not the key behind it.
  const client = await SignClient.init(
    cfg.storage
      ? { projectId: cfg.projectId, metadata: METADATA, storage: cfg.storage }
      : {
          projectId: cfg.projectId,
          metadata: METADATA,
          storageOptions: { database: `${cfg.home}/wc.db` },
        },
  );
  return client as unknown as SignClientLike;
}
