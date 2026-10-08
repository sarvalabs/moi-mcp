/**
 * Network registry and provider factory.
 *
 * No MCP imports here — this module is usable as a plain TS library.
 *
 * The voyage RPC URL is the one js-moi-sdk's own VoyageProvider hardcodes for
 * `devnet` (node_modules/js-moi-providers/lib.esm/voyage-provider.js). Verified
 * live: it answers moi.Syncing / moi.AccountState with real JSON-RPC results.
 *
 * No public mainnet RPC URL ships in the SDK, so `mainnet` has none here.
 * Point MOI_NETWORK=custom + MOI_RPC_URL at a node until one is published.
 */

import {
  createParticipantId,
  JsonRpcProvider,
  ParticipantId,
  ParticipantTagV0,
  Signer,
  type AbstractProvider,
  type Identifier,
  type InteractionObject,
  type InteractionRequest,
  type SigType,
} from "js-moi-sdk";

import { MoiError } from "../moi-error.js";
import { ErrorCode, type Network } from "../schema.js";

export interface NetworkInfo {
  readonly network: Network;
  readonly label: string;
  /** JSON-RPC endpoint, or null when it must be supplied via MOI_RPC_URL. */
  readonly rpcUrl: string | null;
  /**
   * CAIP-2 chain id used in the WalletConnect namespace.
   *
   * voyage = "moi:14", from sarvalabs/wallet-connect-dapp src/chains/moi.ts
   * ({ name: "Moi devnet", id: "moi:14", rpc: [<the URL above>], slip44: 614 }).
   * That repo is a MOI-specific fork of WalletConnect's official react-dapp-v2
   * example, and its method names match the wallet docs exactly.
   *
   * mainnet has NO published CAIP-2 id. The value below is a placeholder and
   * will not pair. See PLAN.md open question 2.
   */
  readonly caip2: string;
  /** False when the CAIP-2 id is a placeholder that will not pair. */
  readonly caip2Verified: boolean;
  readonly explorerUrl: string;
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  voyage: {
    network: "voyage",
    label: "Voyage devnet",
    rpcUrl: "https://dev.voyage-rpc.moi.technology/devnet/",
    caip2: "moi:14",
    caip2Verified: true,
    explorerUrl: "https://voyage.moi.technology",
  },
  mainnet: {
    network: "mainnet",
    label: "MOI mainnet",
    rpcUrl: null,
    caip2: "moi:mainnet", // PLACEHOLDER — unpublished, will not pair
    caip2Verified: false,
    explorerUrl: "https://voyage.moi.technology",
  },
  custom: {
    network: "custom",
    label: "Custom node",
    rpcUrl: null,
    caip2: "moi:custom", // PLACEHOLDER — set MOI_CAIP2 to override
    caip2Verified: false,
    explorerUrl: "https://voyage.moi.technology",
  },
};

export interface ProviderOptions {
  network: Network;
  /** Overrides NETWORKS[network].rpcUrl. Required for custom and mainnet. */
  rpcUrl?: string | undefined;
}

/** Resolve the RPC URL for a network, or explain what is missing. */
export function resolveRpcUrl({ network, rpcUrl }: ProviderOptions): string {
  const url = rpcUrl ?? NETWORKS[network].rpcUrl;
  if (url) return url;

  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    network === "mainnet"
      ? `No public RPC URL is published for MOI mainnet. Set MOI_NETWORK=custom and MOI_RPC_URL to a mainnet node.`
      : `MOI_NETWORK=${network} requires MOI_RPC_URL.`,
    { network },
  );
}

const cache = new Map<string, JsonRpcProvider>();

/** Memoised provider, keyed by resolved URL so tests can swap networks freely. */
export function getProvider(options: ProviderOptions): JsonRpcProvider {
  const url = resolveRpcUrl(options);
  let provider = cache.get(url);
  if (!provider) {
    provider = new JsonRpcProvider(url);
    cache.set(url, provider);
  }
  return provider;
}

export function resetProviderCache(): void {
  cache.clear();
}

/**
 * Explorer deep links.
 *
 * The Voyage explorer appends the value as a BARE query string with no key —
 * `/interaction/?0xabc…`, not `/interaction/0xabc…` and not `?hash=0xabc…`.
 * Confirmed in sarvalabs/voyage src/components/explorer/searchCard.tsx
 * (`router.push(`/interaction/?${searchText}`)`).
 */
function explorerBaseFor(network: Network, override?: string): string {
  return (override ?? NETWORKS[network].explorerUrl).replace(/\/+$/, "");
}

export function interactionUrl(network: Network, hash: string, override?: string): string {
  return `${explorerBaseFor(network, override)}/interaction/?${hash}`;
}

export function participantUrl(network: Network, address: string, override?: string): string {
  return `${explorerBaseFor(network, override)}/participant/?${address}`;
}


// ---------------------------------------------------------------------------
// Read-only signer
// ---------------------------------------------------------------------------

/**
 * js-moi-sdk routes read-only logic calls (`provider.call`) through a Signer,
 * because it needs a sender identifier to simulate against. This server holds
 * no keys, so we supply a Signer that can address the chain but physically
 * cannot sign: both signing methods throw.
 *
 * That keeps the zero-key invariant enforced by the type system rather than by
 * convention — there is no code path from an MCP tool to a private key.
 */
export class ReadOnlySigner extends Signer {
  private readonly caller: Identifier;

  constructor(provider: AbstractProvider, caller?: Identifier) {
    super(provider);
    this.caller =
      caller ??
      createParticipantId({
        // Non-zero: the node rejects an all-zero identifier as "empty".
        fingerprint: new Uint8Array(24).fill(1),
        variant: 0,
        tag: ParticipantTagV0,
      });
  }

  override connect(provider: AbstractProvider): void {
    this.provider = provider;
  }

  async getKeyId(): Promise<number> {
    return 0;
  }

  async getIdentifier(): Promise<Identifier> {
    return this.caller;
  }

  isInitialized(): boolean {
    return this.provider != null;
  }

  /**
   * A read-only simulation never consumes a sequence number, and asking the
   * node for the nonce of a placeholder identifier fails with "empty
   * identifier". Short-circuit it.
   */
  override async getNonce(): Promise<number> {
    return 0;
  }

  async sign(_message: Uint8Array, _keyId: number, _sigAlgo: SigType): Promise<string> {
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "This MCP server holds no private keys. Signing happens in MOI Wallet on your phone.",
    );
  }

  async signInteraction(_ix: InteractionObject, _sigAlgo: SigType): Promise<InteractionRequest> {
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "This MCP server holds no private keys. Use moi_transfer / moi_call_logic, which route signing to MOI Wallet over WalletConnect.",
    );
  }
}

/**
 * The value of MOI_READ_CALLER when getReadOnlySigner would actually use it:
 * set, not empty and a valid participant id. Undefined otherwise. Kept apart
 * so that the signer and the message that names the setting (read-caller.ts)
 * cannot disagree about what counts as set.
 */
export function readCallerFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env["MOI_READ_CALLER"];
  if (!value) return undefined;
  try {
    // The constructor throws on anything that is not a participant id.
    void new ParticipantId(value as `0x${string}`);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * A Signer suitable only for reads, bound to the given network.
 *
 * Logic-call simulation asks the node for the caller's account meta info, so
 * on some networks the placeholder identity is rejected with "account not
 * found". Set MOI_READ_CALLER to any participant id that exists on the network
 * to make reads work there. A value that is not a valid participant id is
 * ignored and the placeholder is used (see readCallerFromEnv).
 */
export function getReadOnlySigner(options: ProviderOptions, caller?: Identifier): ReadOnlySigner {
  let identity = caller;
  const override = readCallerFromEnv();
  if (!identity && override) identity = new ParticipantId(override as `0x${string}`);
  return new ReadOnlySigner(getProvider(options) as unknown as AbstractProvider, identity);
}
