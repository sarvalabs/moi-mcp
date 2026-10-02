/**
 * Create a participant (an account) on chain: decode the registration hash MOI Wallet shows, check that the public key
 * belongs to the address, check the funding and the balance, and build the interaction. Moved from
 * src/tools/write-core.ts.
 */

import { KMOI_ASSET_ID } from "js-moi-sdk";
import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { MoiError } from "../../moi-error.js";
import { assertSendable, buildCreateAccount, FUEL_RESERVE, parseAmount } from "../../moi/ix-builder.js";
import { getProvider } from "../../moi/provider.js";
import { getAccount, getAsset, toBigInt } from "../../moi/reads.js";
import { CreateAccountInput, ErrorCode } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  assertWillSucceed, providerOptions, senderFor, withMeasuredFuel, WriteOutputShape, type PreparedWrite,
} from "../../tools/write-core.js";

/** The identifier a compressed public key produces for a primary (variant 0) account. */
export async function accountIdForPublicKey(publicKey: string): Promise<string> {
  const { createParticipantId, ParticipantTagV0, hexToBytes } = await import("js-moi-sdk");
  const bytes = hexToBytes(publicKey as `0x${string}`);
  if (bytes.length !== 33) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `publicKey must be a compressed public key, 33 bytes (0x plus 66 hex characters); got ${bytes.length} bytes.`,
    );
  }
  return createParticipantId({ fingerprint: bytes.slice(1, 25), variant: 0, tag: ParticipantTagV0 }).toHex();
}

/**
 * POLO layout of the registration hash MOI Wallet produces for a new account:
 * a whole PARTICIPANT_CREATE operation, with the address and key inside.
 * Matches the decoder in MOI's own participant-registration service.
 */
const REGISTRATION_HASH_SCHEMA = {
  kind: "struct",
  fields: {
    opType: { kind: "integer" },
    payload: {
      kind: "struct",
      fields: {
        id: { kind: "string" },
        keys_payload: {
          kind: "array",
          fields: {
            values: {
              kind: "struct",
              fields: {
                public_key: { kind: "string" },
                weight: { kind: "integer" },
                signature_algorithm: { kind: "integer" },
              },
            },
          },
        },
        value: {
          kind: "struct",
          fields: { asset_id: { kind: "string" }, callsite: { kind: "string" }, calldata: { kind: "string" } },
        },
      },
    },
  },
} as const;

/** The address and public key inside a wallet registration hash. */
export async function decodeRegistrationHash(hash: string): Promise<{ address: string; publicKey: string }> {
  const { Depolorizer } = await import("js-polo");
  const { hexToBytes } = await import("js-moi-sdk");
  let decoded: { payload?: { id?: string; keys_payload?: Array<{ public_key?: string }> } };
  try {
    decoded = new Depolorizer(hexToBytes(hash as `0x${string}`)).depolorize(REGISTRATION_HASH_SCHEMA as never) as never;
  } catch (err) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `That is not a registration hash: ${messageOfError(err)}`);
  }
  const address = decoded?.payload?.id;
  const publicKey = decoded?.payload?.keys_payload?.[0]?.public_key;
  if (!address || !publicKey) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "The registration hash decodes but carries no address or public key.");
  }
  return { address, publicKey };
}

function messageOfError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Least a new account can be funded with; below it the chain silently refuses the registration. */
export const MIN_ACCOUNT_FUND = 1_000_000_000n;

export async function prepareCreateAccount(
  account: string,
  params: z.infer<typeof CreateAccountInput>,
): Promise<PreparedWrite> {
  const provider = getProvider(providerOptions());
  if (!params.registrationHash && !(params.address && params.publicKey)) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      "Give either the registration hash MOI Wallet shows for the new account, or both its address and public key.",
    );
  }
  const target = params.registrationHash
    ? await decodeRegistrationHash(params.registrationHash)
    : { address: params.address as string, publicKey: params.publicKey as string };
  const derived = await accountIdForPublicKey(target.publicKey);
  if (derived.toLowerCase() !== target.address.toLowerCase()) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `That public key belongs to ${derived}, not ${target.address}. Ask for the address and public key of the same account.`,
      { derived },
    );
  }
  // From here on only the resolved pair is used.
  params = { ...params, address: target.address, publicKey: target.publicKey };
  // Already on chain: registering again fails, and a plain transfer is what they want.
  let exists = false;
  try {
    exists = (await getAccount(provider, params.address as string)).isRegistered;
  } catch {
    exists = false; // "account not found" is the expected answer here
  }
  if (exists) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `${params.address} is already registered on chain. Use moi_transfer to send it KMOI.`,
    );
  }

  const kmoi = await getAsset(provider, KMOI_ASSET_ID);
  const raw = parseAmount(params.amount, kmoi.decimals);
  if (raw < MIN_ACCOUNT_FUND) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `amount must be at least 1 KMOI; the chain refuses a registration funded with less, after every operation in it reports success.`,
    );
  }
  const held = toBigInt(
    (await getAccount(provider, account)).balances.find((b) => b.assetId.toLowerCase() === KMOI_ASSET_ID.toLowerCase())?.amount ?? 0,
  );
  if (held < raw + FUEL_RESERVE) {
    throw new MoiError(
      ErrorCode.INSUFFICIENT_BALANCE,
      `Funding ${params.address} with ${params.amount} KMOI needs ${raw} base units plus fuel, but this account holds ${held}.`,
      { held: held.toString(), needed: (raw + FUEL_RESERVE).toString() },
    );
  }

  const ix = await withMeasuredFuel(
    buildCreateAccount(await senderFor(account), { id: params.address as string, publicKey: params.publicKey as string, amount: raw }),
  );
  assertSendable(ix);
  await assertWillSucceed(ix);

  return {
    ix,
    description: `Create account ${params.address} with ${params.amount} KMOI`,
    details: {
      Operation: "Register a new account and fund it",
      "New account": params.address as string,
      "Funded with": `${params.amount} KMOI`,
      "Funded with (base units)": raw.toString(),
      "Controlling key": params.publicKey as string,
    },
  };
}

export function createAccountTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_create_account",
    {
      title: "Create a MOI account",
      description:
        "Register a brand-new MOI account on chain and fund it with KMOI from the user's paired wallet; nothing happens until they tap Send on their phone. " +
        "Needed because a transfer to an address that has never existed is refused by the node. Takes the new account's address and its public key, " +
        "which MOI Wallet or the SDK shows for a freshly generated account; the tool refuses a key that does not produce that address." +
        APPROVAL_PROTOCOL,
      inputSchema: { ...CreateAccountInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "create_account", args, confirm, (s) => prepareCreateAccount(s.address, args)),
  );
}
