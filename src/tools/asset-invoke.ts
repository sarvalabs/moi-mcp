/**
 * The half of moi_asset_invoke that needs the node and the write path.
 *
 * The domain logic (reading the manifest, validating and encoding the inputs, describing a routine, naming the accounts
 * it locks) is in src/capabilities/assets and imports nothing from src/tools. This file adds what only the tools layer
 * can have: the provider, the sender's sequence number, fuel measurement and simulation from write-core.ts, and the
 * read-only call. runWrite (src/tools/hosted-writes.ts) does the rest for a write: preview, confirm token, phone,
 * broadcast, journal.
 *
 * Whether a call is a read or a write is the manifest's word (mode static or not), so the manifest is read before
 * anything else. A routine that only reads runs here, at once, with no wallet, no preview and no journal entry, like a
 * kind=view logic call. Every other routine is a write.
 *
 * The SDK's AssetDriver is not used: it signs and sends by itself, and this server holds no keys.
 *
 * HONEST LIMIT. The read path (viewAssetRoutine) has run against a mock node only. It sends what the SDK's own
 * InteractionContext.call sends (fuel price 50, limit 100000, a placeholder caller), which is the path the registry and
 * logic reads already use live, but an ASSET_INVOKE of a static asset routine as a read has not been run on devnet. It
 * fails closed: a missing status, no result, empty outputs for a routine that declares returns, and an output that does
 * not decode are all refusals, never a partial answer.
 */

import { DEFAULT_FUEL_LIMIT as SDK_DEFAULT_FUEL_LIMIT, ManifestCoder } from "js-moi-sdk";

import { shapeOutputs } from "../capabilities/assets/codec.js";
import {
  planAssetCall,
  resolveFromManifest,
  type AssetCallInput,
  type ResolvedAssetCall,
} from "../capabilities/assets/invoke.js";
import { assetRef, loadAssetManifest } from "../capabilities/assets/routines.js";
import { standardFileFor } from "../capabilities/assets/standards/index.js";
import { boundedResult } from "../bounds.js";
import { asRpcError, MoiError } from "../moi-error.js";
import { assertSendable, buildAssetInvoke, decodeErrorHex, quoteChainText } from "../moi/ix-builder.js";
import { getProvider, getReadOnlySigner } from "../moi/provider.js";
import { clampChainText, getAsset } from "../moi/reads.js";
import { callerRejected, isCallerRejected } from "../moi/registry.js";
import { ErrorCode } from "../schema.js";
import { assertWillSucceed, providerOptions, senderFor, withMeasuredFuel, type PreparedWrite } from "./write-core.js";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Read the asset and its manifest and find the routine. A refusal the standard knows about (the native asset cannot be
 * minted or burned, a MAS1 asset has no amounts) comes before the manifest is read, so it answers even when the node has
 * no manifest, and says why instead of "no such routine".
 */
export async function resolveAssetCall(input: AssetCallInput): Promise<ResolvedAssetCall> {
  const provider = getProvider(providerOptions());
  const asset = assetRef(await getAsset(provider, input.assetId));
  const refusal = standardFileFor(asset.standard)?.refusal?.(input.routine, input.args);
  if (refusal) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `${refusal} Nothing was sent to your wallet.`, {
      assetId: asset.assetId,
      standard: asset.standard,
    });
  }
  return resolveFromManifest(asset, await loadAssetManifest(provider, asset), input.routine);
}

/** A write routine: plan it, build the interaction, measure its fuel and simulate it. runWrite previews and sends it. */
export async function prepareAssetInvoke(
  account: string,
  target: ResolvedAssetCall,
  input: AssetCallInput,
): Promise<PreparedWrite> {
  const plan = planAssetCall(target, input);
  const ix = await withMeasuredFuel(
    buildAssetInvoke(await senderFor(account), {
      assetId: input.assetId,
      callsite: target.callable.name,
      ...(plan.calldata ? { calldata: plan.calldata } : {}),
      participants: plan.participants,
    }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix, plan.hint);
  return { ix, description: plan.description, details: plan.details };
}

/** A routine that only reads: run it as a simulation as the placeholder caller and decode what comes back. */
export async function viewAssetRoutine(
  target: ResolvedAssetCall,
  input: AssetCallInput,
): Promise<ReturnType<typeof boundedResult>> {
  const plan = planAssetCall(target, input);
  const { asset, callable } = target;
  const name = callable.name;
  const where = `${name} on ${asset.assetId}`;
  const fail = (message: string) => new MoiError(ErrorCode.RPC_ERROR, message);

  // What AssetBase.processArguments does for a read: the read-only signer's identifier as the sender, no sequence.
  const caller = String(await getReadOnlySigner(providerOptions()).getIdentifier());
  const ix = buildAssetInvoke(
    { id: caller, sequence: 0, keyId: 0 },
    { assetId: asset.assetId, callsite: name, ...(plan.calldata ? { calldata: plan.calldata } : {}) },
    // The SDK's read-path default, as the registry and logic reads send it.
    { fuelLimit: Number(SDK_DEFAULT_FUEL_LIMIT) },
  );
  assertSendable(ix);

  const provider = getProvider(providerOptions()) as unknown as { call: (ix: unknown) => Promise<{ receipt?: unknown }> };
  let response: { receipt?: unknown };
  try {
    response = await provider.call(ix);
  } catch (err) {
    if (isCallerRejected(err)) throw callerRejected();
    throw asRpcError(err, `moi.Call(${where})`);
  }

  // From here every step refuses rather than shows a partial answer: a read that went wrong must not look like a value.
  const receipt = response?.receipt;
  const op = isObject(receipt) && Array.isArray(receipt["ix_operations"]) ? receipt["ix_operations"][0] : undefined;
  if (!isObject(receipt) || !isObject(op)) throw fail(`The node returned no result for ${where}.`);

  // Not `?? 0`: a receipt with no status must not read as success.
  let status: number;
  try {
    if (receipt["status"] === undefined || receipt["status"] === null) throw new Error("no status");
    status = Number(BigInt(String(receipt["status"])));
  } catch {
    throw fail(`The node's answer for ${where} carried no readable status, so it is not shown.`);
  }

  const data = isObject(op["data"]) ? op["data"] : {};
  let exception: ReturnType<typeof ManifestCoder.decodeException> = null;
  try {
    exception = ManifestCoder.decodeException(String(data["error"] ?? "0x"));
  } catch {
    exception = null; // not decodable: the status decides
  }
  if (exception || status !== 0) {
    const reason = exception
      ? quoteChainText(`${exception.class}: ${exception.error}`)
      : (decodeErrorHex(String(data["error"] ?? "")) ?? quoteChainText(`receipt status ${status}`));
    throw fail(`${where} failed: ${reason}`);
  }

  let decoded: unknown;
  try {
    decoded = target.view.coder.decodeOutput(name, String(data["outputs"] ?? "0x"));
  } catch (err) {
    throw fail(`Could not decode the outputs of ${name}: ${clampChainText(err instanceof Error ? err.message : String(err), 160)}`);
  }
  if (callable.returns.length > 0 && !isObject(decoded)) {
    throw fail(`${where} returned no outputs although its manifest says it returns ${callable.returns.map((f) => f.label).join(", ")}.`);
  }

  const { outputs, truncated } = shapeOutputs(callable.returns, decoded ?? {});
  return boundedResult({ assetId: asset.assetId, routine: name, outputs, decimals: asset.decimals, truncated });
}
