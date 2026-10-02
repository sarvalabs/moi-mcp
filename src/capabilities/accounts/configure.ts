/**
 * Add keys to, or revoke keys on, the paired wallet's own account: moi_configure_account, one ACCOUNT_CONFIGURE operation
 * (type 2). This is the most dangerous write the server has. A key that is added can sign for the account, and a key that is
 * revoked can no longer sign, so the words the person reads say that plainly, every public key is shown in full, and what the
 * request would do is checked against the account's current keys before the person is asked anything.
 *
 * What the operation is, and what is taken from where. The payload is a list of keys to add (public key, weight, signature
 * algorithm) and a list of key ids to revoke; it names no account, so it acts on the sender's, which is the paired wallet's.
 * The SDK builds it (js-moi-interactions, AccountConfigure) with no participants of its own, and buildConfigureAccount writes
 * the same interaction, which a test compares key for key and byte for byte. The words come from the protocol docs
 * (learn/fundamentals/interactions.md, "AccountConfigure" and "Validation Constraints"; learn/fundamentals/multi-sig.md;
 * build/tutorials/multi-sig-tutorial.md): an interaction is valid only when the combined weight of its signatures reaches the
 * account's threshold, which the docs give as 1000 by default and as the least any interaction needs; a key's weight is 0 to
 * 1000; and one AccountConfigure operation does either an add or a revoke, never both. Where the sources disagree, or are
 * silent, this file takes the safe side and says so:
 *   - Add and revoke are never sent together. The SDK builds both in one operation and its validator accepts that, but the docs
 *     say twice that it is not allowed (the multi-sig tutorial revokes in a second interaction because one cannot do both), and
 *     nothing here shows what a node does with it. A request that names both is refused with the two-call way to do it, which is
 *     also the safe way to rotate a key: add the new one, check that it signs, then revoke the old one.
 *   - Every key is added at weight 1000, and the caller cannot choose another. The installed SDK (0.9.0-rc2) accepts any
 *     positive weight, the docs give 0 to 1000, the docs' multi-sig tutorial adds keys of 500 and their multi-sig page splits
 *     1000 into 400, 350 and 250, while the newer SDK (0.9.0-rc3) refuses a weight under 1000 and says the chain does too. 1000 is
 *     the one weight all of them accept, and it makes "anyone who holds this key can sign for this account" true of every key
 *     this tool adds. A lighter weight would also let a request add several keys that sign together without any of the
 *     account's own keys, which no one-line preview can say. The price is that the multi-sig setups of the docs cannot be made
 *     from here. Lifting this needs a supervised run on devnet that shows what the chain does with a lighter key.
 *   - A key that is on the account as a revoked one is not added again. The docs describe a revoke as for compromised and
 *     obsolete keys and say nothing about adding one back, and the node lists a revoked key as a key of the account.
 *   - The signature algorithm is always 0, the only value the SDK accepts. The docs do not say which scheme 0 is, so nothing here
 *     names it.
 *
 * What is refused before the phone is asked, all of it from the account's own keys (moi.AccountKeys) and its interaction
 * counts: an account whose key 0 cannot sign alone, a key id the account does not have or has already revoked, a key it already
 * has (revoked or not), the same key or id twice, a request that revokes every key that is not revoked, a request that leaves
 * the keys that remain under 1000 in weight, and an interaction of this account that is still pending (the keys are read at
 * the latest tesseract, so a revoke that has not landed would not show, and two quick revokes could together leave nothing).
 * The node lists a key as its 32-byte x coordinate and the SDK and MOI Wallet give 33 bytes, so two keys are the same key when
 * their x coordinates are (keyIdentity). Nothing checks that a new key is a point on the curve: about half of all random
 * 32-byte values are, so a pass would prove nothing, and the person is told to see the key sign before revoking the old one.
 *
 * Key 0 is special for this server: senderFor signs every interaction as key 0, alone, so key 0 has to be on the account, not
 * revoked, and weigh 1000 or more, or nothing sent from here can be valid. Revoking it does not lock the account when other
 * keys carry the threshold, but it ends what this server can do for the account, and the preview says so.
 *
 * ACCOUNT_INHERIT (type 3) has no tool, on purpose. Its payload (a target account, an asset action and a sub-account index) is
 * known and the SDK builds it, but what it does on chain is not settled by anything this repository can read, and a value-moving
 * tool with a guessed preview is worse than none. The docs say the asset action "funds the new sub-account", yet the payload
 * names a beneficiary inside the transfer calldata, the SDK lets the caller choose it, and the docs' own example sends it to an
 * account that is neither the sender nor the sub-account its receipt reports. Three documents say three directions: the
 * protocol docs have the sub-account inherit the context of a target application, the August 2026 release notes have it inherit
 * from its parent, and the account tutorial says "from one participant (or target account) to another". How the sub-account index
 * gives the sub-account's id, what the sub-account can do, whether it can be removed and what funding it needs are not written
 * anywhere; the docs say a document on inherited accounts is "coming soon". README.md lists these.
 *
 * Nothing here has run against a node. The mock node in the tests answers any simulation, so no test shows that a chain accepts
 * an ACCOUNT_CONFIGURE, and what MOI Wallet shows for one is not known: the summary in the chat is where it is described. The
 * journal records that a configure_account was proposed, signed and broadcast, with the interaction's hash once it is sent; the
 * keys that were added or revoked are in the interaction on chain (read it with that hash) and nowhere else.
 */

import { OpType } from "js-moi-sdk";
import type { z } from "zod";

import type { AuthInfo } from "../../auth/types.js";
import { MoiError } from "../../moi-error.js";
import {
  assertSendable,
  DEFAULT_FUEL_LIMIT,
  DEFAULT_FUEL_PRICE,
  quoteChainText,
  SINGLE_KEY_WEIGHT,
  type BuildOptions,
  type SenderInfo,
  type UnsignedInteraction,
} from "../../moi/ix-builder.js";
import { getProvider } from "../../moi/provider.js";
import { ConfigureAccountInput, ErrorCode } from "../../schema.js";
import { defineTool, type ToolDef } from "../../tools/define.js";
import { APPROVAL_PROTOCOL, ConfirmArg, runWrite, WRITE_ANNOTATIONS, type WriteDeps } from "../../tools/hosted-writes.js";
import {
  assertWillSucceed, providerOptions, senderFor, withMeasuredFuel, WriteOutputShape, type PreparedWrite,
} from "../../tools/write-core.js";

/** The weight every key this tool adds gets: the one weight all the sources accept (see the header). */
export const NEW_KEY_WEIGHT = SINGLE_KEY_WEIGHT;

/**
 * The least combined weight any interaction needs, from the protocol docs (interactions.md, "Validation Constraints"), which is
 * also the default account threshold (multi-sig.md). An account's own threshold can be read nowhere this server looks, so this
 * is a floor and not the threshold.
 */
export const MIN_SIGNING_WEIGHT = 1000;

/** The key id this server signs with: senderFor (src/tools/write-core.ts) sends every interaction as key 0. */
export const SIGNING_KEY_ID = 0;

/** Keys the preview and a refusal list. The keys a request names are always shown, whatever this is. */
export const MAX_LISTED_KEYS = 10;

/** Keys one moi.AccountKeys answer may hold before it is refused as unreadable. */
export const MAX_KEYS_READ = 200;

/** Characters of a node's error text that a refusal passes on. */
export const MAX_NODE_TEXT = 200;

const NOT_SENT = "Nothing was sent to your wallet.";

/** One key of the account as the node lists it, read strictly. The public key is lower-case hex, 32 bytes as the node lists it. */
export interface AccountKey {
  id: number;
  publicKey: string;
  weight: number;
  revoked: boolean;
}

/** What one call changes: lower-case 33-byte public keys to add (each at NEW_KEY_WEIGHT), or key ids to revoke. */
export interface KeyChange {
  add: string[];
  revoke: number[];
}

// ---------------------------------------------------------------------------
// Reading the account's keys and counts
// ---------------------------------------------------------------------------

/**
 * A whole number from what the node sends: a number, a bigint, a hex quantity ("0x3e8", as the docs show) or decimal digits.
 * Anything else, a fraction, a negative, a number past 2^53, is undefined, which the caller refuses: a garbled weight read as 0
 * would make a revoke look harmless.
 */
function quantity(value: unknown): number | undefined {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "bigint") n = Number(value);
  else if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) n = Number(BigInt(value));
  else return undefined;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** A node call that failed. The node's words are data, not instructions, so they are quoted and capped before the model sees them. */
function nodeFailure(what: string, err: unknown): MoiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new MoiError(ErrorCode.RPC_ERROR, `${what} failed: ${quoteChainText(detail, MAX_NODE_TEXT)}. ${NOT_SENT}`);
}

const unreadable = (what: string, why: string): MoiError =>
  new MoiError(
    ErrorCode.RPC_ERROR,
    `${what}: the node's answer is not one this server can read (${why}), and without it nothing can be said about what this would change. ${NOT_SENT}`,
    { why },
  );

/**
 * The node's moi.AccountKeys answer, read strictly and sorted by key id. A shape this does not understand is refused and not
 * guessed at: the answer is what the safety checks below rest on. The key text comes from the chain, so it must be plain hex.
 */
export function parseAccountKeys(raw: unknown, account: string): AccountKey[] {
  const what = `moi.AccountKeys(${account})`;
  if (!Array.isArray(raw)) throw unreadable(what, "it is not a list");
  if (raw.length > MAX_KEYS_READ) throw unreadable(what, `it lists ${raw.length} keys, more than the ${MAX_KEYS_READ} this server reads`);
  const keys: AccountKey[] = [];
  raw.forEach((item: unknown, index) => {
    const entry = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const id = quantity(entry["id"]);
    if (id === undefined) throw unreadable(what, `entry ${index} has no readable key id`);
    const weight = quantity(entry["weight"]);
    if (weight === undefined) throw unreadable(what, `key ${id} has no readable weight`);
    const publicKey = entry["publicKey"];
    if (typeof publicKey !== "string" || !/^0x([0-9a-fA-F]{2}){1,65}$/.test(publicKey)) throw unreadable(what, `key ${id} has no readable public key`);
    const revoked = entry["revoked"];
    if (typeof revoked !== "boolean") throw unreadable(what, `key ${id} does not say whether it is revoked`);
    if (keys.some((key) => key.id === id)) throw unreadable(what, `key ${id} is listed twice`);
    keys.push({ id, publicKey: publicKey.toLowerCase(), weight, revoked });
  });
  return keys.sort((a, b) => a.id - b.id);
}

/** Read the account's keys: moi.AccountKeys at the latest tesseract, through the provider, so the SDK's own request and checks apply. */
export async function readAccountKeys(
  provider: { getAccountKeys: (id: string) => Promise<unknown> },
  account: string,
): Promise<AccountKey[]> {
  let raw: unknown;
  try {
    raw = await provider.getAccountKeys(account);
  } catch (err) {
    throw nodeFailure(`moi.AccountKeys(${account})`, err);
  }
  return parseAccountKeys(raw, account);
}

/**
 * Refuse while an interaction signed with the sender's key is still waiting. senderFor takes the sequence from
 * moi.PendingInteractionCount, which counts the waiting ones, and moi.InteractionCount counts only those that landed; when
 * the first is higher, something is in the pool. The account's keys are read at the latest tesseract, so a key change in the
 * pool is not in them yet, and a second change checked against the same list could leave nothing able to sign.
 */
export async function assertNothingPending(
  provider: { getInteractionCount: (id: string, keyId: number) => Promise<unknown> },
  sender: SenderInfo,
): Promise<void> {
  const keyId = sender.keyId ?? SIGNING_KEY_ID;
  const what = `moi.InteractionCount(${sender.id}, key ${keyId})`;
  let raw: unknown;
  try {
    raw = await provider.getInteractionCount(sender.id, keyId);
  } catch (err) {
    throw nodeFailure(what, err);
  }
  const landed = quantity(raw);
  if (landed === undefined) throw unreadable(what, "it is not a count");
  if (sender.sequence > landed) {
    throw refuse(
      `An interaction from this account is still waiting to be confirmed: key ${keyId} has ${landed} confirmed and ${sender.sequence} counting the ones waiting. ` +
        "The keys read here do not include it yet, so wait until it has landed and ask again.",
    );
  }
}

/**
 * What makes two keys the same key: the 32-byte x coordinate, lower-case, without 0x. The node lists a key that way (the docs'
 * moi.AccountKeys answer), while the SDK and MOI Wallet give 33 bytes, the same with a leading 02 or 03; the SDK's own verify()
 * drops that byte too. A key of another length is compared whole.
 */
export function keyIdentity(publicKey: string): string {
  const hex = publicKey.toLowerCase().replace(/^0x/, "");
  return hex.length === 66 ? hex.slice(2) : hex;
}

// ---------------------------------------------------------------------------
// What a request would do, checked against the account's keys
// ---------------------------------------------------------------------------

const keyText = (key: AccountKey): string => `key ${key.id} (${key.publicKey}, weight ${key.weight}${key.revoked ? ", revoked" : ""})`;

/** The account's keys in a sentence, public keys in full: what a refusal shows so the person can pick a key id. */
function listing(keys: AccountKey[]): string {
  if (keys.length === 0) return "This account has no keys on record.";
  const more = keys.length - MAX_LISTED_KEYS;
  return `This account's keys: ${keys.slice(0, MAX_LISTED_KEYS).map(keyText).join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

const refuse = (message: string): MoiError => new MoiError(ErrorCode.INVALID_ARGS, `${message} ${NOT_SENT}`);

/** "2", "2 and 3", "2, 3 and 4". */
function joinAnd(items: Array<string | number>): string {
  const parts = items.map(String);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const liveWeight = (keys: AccountKey[]): number => keys.reduce((sum, key) => sum + (key.revoked ? 0 : key.weight), 0);

/** Refuse when this server cannot sign for the account alone: it signs as key 0 only, and one signature has to weigh enough. */
function checkSigningKey(keys: AccountKey[]): void {
  const key = keys.find((candidate) => candidate.id === SIGNING_KEY_ID);
  const problem = !key
    ? `this account has no key ${SIGNING_KEY_ID}`
    : key.revoked
      ? `key ${SIGNING_KEY_ID} is revoked`
      : key.weight < MIN_SIGNING_WEIGHT
        ? `key ${SIGNING_KEY_ID} weighs ${key.weight}, under ${MIN_SIGNING_WEIGHT}`
        : undefined;
  if (problem === undefined) return;
  throw refuse(
    `This server signs every interaction as key ${SIGNING_KEY_ID}, and ${problem}. The signatures of an interaction have to weigh at least ${MIN_SIGNING_WEIGHT} together ` +
      `(the protocol docs' floor, which is also their default account threshold), so nothing this server sends for this account can be valid. ${listing(keys)}`,
  );
}

/**
 * Refuse a request that would do nothing, that the docs say is not allowed, that names a key the account does not have, that
 * adds a key it already has, or that would leave nothing able to sign for the account. Returns the combined weight of the keys
 * that are not revoked, before and after, for the preview. Everything it throws is INVALID_ARGS, before anything is simulated or
 * sent to the phone.
 */
export function checkKeyChange(keys: AccountKey[], change: KeyChange): { before: number; after: number } {
  const { add, revoke } = change;
  if (add.length === 0 && revoke.length === 0) {
    throw refuse(`Name at least one key to add or one key id to revoke. ${listing(keys)}`);
  }
  checkSigningKey(keys);
  if (add.length > 0 && revoke.length > 0) {
    throw refuse(
      "One call can add keys or revoke keys, not both: the protocol docs say an AccountConfigure operation does either an add or a revoke, never both. " +
        "Add the new key first, check that it works, and then call again to revoke the old one.",
    );
  }
  const seen = new Map<string, string>();
  for (const key of add) {
    const first = seen.get(keyIdentity(key));
    if (first !== undefined) throw refuse(`add lists the same key twice (${first} and ${key}); a key is added once.`);
    seen.set(keyIdentity(key), key);
  }
  const ids = new Set<number>();
  for (const id of revoke) {
    if (ids.has(id)) throw refuse(`revoke lists key ${id} twice; a key is revoked once.`);
    ids.add(id);
  }

  for (const id of revoke) {
    const key = keys.find((candidate) => candidate.id === id);
    if (!key) throw refuse(`This account has no key ${id}. ${listing(keys)}`);
    if (key.revoked) throw refuse(`Key ${id} is already revoked. ${listing(keys)}`);
  }
  for (const key of add) {
    const present = keys.find((candidate) => keyIdentity(candidate.publicKey) === keyIdentity(key));
    if (!present) continue;
    throw refuse(
      present.revoked
        ? `That key is already on this account as key ${present.id} (${present.publicKey}), and it is revoked. The protocol docs describe a revoke as for compromised and obsolete keys, ` +
            `so a revoked key is not added again: use a new key. ${listing(keys)}`
        : `That key is already on this account as key ${present.id} (${present.publicKey}), and it is not revoked. ${listing(keys)}`,
    );
  }

  const before = liveWeight(keys);
  const removed = keys.filter((key) => ids.has(key.id)).reduce((sum, key) => sum + key.weight, 0);
  const after = before - removed + add.length * NEW_KEY_WEIGHT;
  if (revoke.length > 0) {
    const live = keys.filter((key) => !key.revoked);
    if (live.length > 0 && live.every((key) => ids.has(key.id))) {
      throw refuse(
        `That would revoke every key this account has that is not already revoked (${joinAnd(live.map((key) => key.id))}), and then nothing could sign for the account again.`,
      );
    }
    if (after < MIN_SIGNING_WEIGHT) {
      throw refuse(
        `After this change the keys of this account that are not revoked would weigh ${after} in total. The signatures of an interaction have to weigh at least ${MIN_SIGNING_WEIGHT} ` +
          `together (the protocol docs' floor, which is also their default account threshold), so nothing could sign for the account again. ${listing(keys)}`,
      );
    }
  }
  return { before, after };
}

// ---------------------------------------------------------------------------
// The interaction
// ---------------------------------------------------------------------------

/**
 * One ACCOUNT_CONFIGURE operation, written as the SDK's AccountConfigure builder writes it: both lists always present, each
 * added key at NEW_KEY_WEIGHT with signature algorithm 0, and no participants (the SDK declares none for this operation). The
 * sender, fuel price and fuel limit are the three fields every builder in ix-builder.ts starts from; that file's own helper is
 * private. The key is sent as given, 0x and 33 bytes: the same format moi_create_account sends, and the one the SDK's own tests use.
 */
export function buildConfigureAccount(sender: SenderInfo, change: KeyChange, options: BuildOptions = {}): UnsignedInteraction {
  return {
    sender: { id: sender.id, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    fuel_price: options.fuelPrice ?? DEFAULT_FUEL_PRICE,
    fuel_limit: options.fuelLimit ?? DEFAULT_FUEL_LIMIT,
    ix_operations: [
      {
        type: OpType.ACCOUNT_CONFIGURE,
        payload: {
          add: change.add.map((publicKey) => ({ public_key: publicKey, weight: NEW_KEY_WEIGHT, signature_algorithm: 0 })),
          revoke: change.revoke.map((id) => ({ key_id: id })),
        },
      },
    ],
    participants: [],
  };
}

// ---------------------------------------------------------------------------
// The words the person reads
// ---------------------------------------------------------------------------

/**
 * The summary and the lines the phone will show. runWrite sends the interaction alone, so the summary is the only place the chat
 * says what happens, and `details` is what runWrite compares between the preview and the confirm: it holds the account's keys as
 * they are now, so a key list that changed in between gives a fresh preview. Nothing in it moves with the fuel estimate. Public
 * keys are written in full.
 */
export function describeConfigure(input: {
  account: string;
  keys: AccountKey[];
  change: KeyChange;
  before: number;
  after: number;
}): { description: string; details: Record<string, string> } {
  const { account, keys, change, before, after } = input;
  const adding = change.add.length > 0;
  const n = adding ? change.add.length : change.revoke.length;

  let description: string;
  if (adding) {
    description =
      n === 1
        ? "Add a key to your account. Anyone who holds this key can sign for this account."
        : `Add ${n} keys to your account. Anyone who holds any one of these keys can sign for this account.`;
  } else {
    description =
      n === 1
        ? `Revoke key ${change.revoke[0]}. That key can no longer sign for this account.`
        : `Revoke keys ${joinAnd(change.revoke)}. Those keys can no longer sign for this account.`;
    if (change.revoke.includes(SIGNING_KEY_ID)) {
      description += ` Key ${SIGNING_KEY_ID} is the key your MOI Wallet signs with here, so after this it can no longer sign for this account, and this server can send nothing more for it.`;
    }
  }

  const details: Record<string, string> = {
    Operation: adding
      ? n === 1 ? "Add a key to your account (ACCOUNT_CONFIGURE)" : `Add ${n} keys to your account (ACCOUNT_CONFIGURE)`
      : n === 1 ? "Revoke a key on your account (ACCOUNT_CONFIGURE)" : `Revoke ${n} keys on your account (ACCOUNT_CONFIGURE)`,
    Account: account,
  };
  change.add.forEach((publicKey, index) => {
    details[`New key ${index + 1}`] = `${publicKey} (weight ${NEW_KEY_WEIGHT}, signature algorithm 0)`;
  });
  for (const id of change.revoke) {
    const key = keys.find((candidate) => candidate.id === id);
    details[`Revoke key ${id}`] = key ? `${key.publicKey} (weight ${key.weight})` : "(not listed)";
  }
  details["Combined weight of keys not revoked"] =
    `${before} now, ${after} after this change. An interaction is valid only when the weight of its signatures reaches the account's threshold, which the protocol docs give as ${MIN_SIGNING_WEIGHT} ` +
    "by default and as the least any interaction needs; this server cannot read this account's own threshold.";
  keys.slice(0, MAX_LISTED_KEYS).forEach((key) => {
    details[`Current key ${key.id}`] = `${key.publicKey} (weight ${key.weight}, ${key.revoked ? "revoked" : "not revoked"})`;
  });
  if (keys.length > MAX_LISTED_KEYS) details["More keys"] = `${keys.length - MAX_LISTED_KEYS} more keys are not listed here.`;
  return { description, details };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** Added to the refusal when the node's simulation says the change would fail: what, besides the checks above, can make it refuse. */
const CONFIGURE_REFUSAL_HINT =
  "Besides the checks made before this, too little KMOI to pay the fuel, or a key the chain does not accept, can make the node refuse an ACCOUNT_CONFIGURE.";

/**
 * Two sentences of the approval instructions every write ends with do not fit an ACCOUNT_CONFIGURE, and are replaced: the shared
 * text sends the person to check "the amount and address" on the phone, which this operation does not have, and calls the preview
 * "the exact values the wallet will display", which is not known for this operation (see the header). A test fails if the shared
 * text is ever reworded and a replacement stops matching.
 */
export const APPROVAL_REWORDINGS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["the exact values the wallet will display", "the values of the interaction, with every key in full"],
  ["check that the amount and address on the phone match the preview", "compare the key on the phone, if it shows one, with the public key in the preview"],
];

export const KEY_APPROVAL_PROTOCOL = APPROVAL_REWORDINGS.reduce((text, [from, to]) => text.replace(from, to), APPROVAL_PROTOCOL);

/**
 * Read the account's keys, check the request against them, check nothing of this account is pending, build the operation,
 * measure its fuel and simulate it. runWrite (src/tools/hosted-writes.ts) previews and sends it, as it does every write. The
 * keys are read on the confirm call too, so a list that changed since the preview shows as changed details and gives a fresh
 * preview.
 */
export async function prepareConfigureAccount(
  account: string,
  params: z.infer<typeof ConfigureAccountInput>,
): Promise<PreparedWrite> {
  const provider = getProvider(providerOptions());
  const keys = await readAccountKeys(provider, account);
  const change: KeyChange = { add: (params.add ?? []).map((key) => key.toLowerCase()), revoke: params.revoke ?? [] };
  const { before, after } = checkKeyChange(keys, change);
  const sender = await senderFor(account, SIGNING_KEY_ID);
  await assertNothingPending(provider, sender);
  const ix = await withMeasuredFuel(buildConfigureAccount(sender, change));
  assertSendable(ix);
  await assertWillSucceed(ix, CONFIGURE_REFUSAL_HINT);
  return { ix, ...describeConfigure({ account, keys, change, before, after }) };
}

export function configureAccountTool(deps: WriteDeps, auth: AuthInfo | null): ToolDef {
  return defineTool(
    "moi_configure_account",
    {
      title: "Add or revoke a key on your MOI account",
      description:
        "Add keys to the user's own MOI account, or revoke keys on it, from their paired wallet; nothing happens until they tap Send on their phone. " +
        "This is the most dangerous write this server has: every key that is added can sign for the account (each is added with weight 1000, the default account threshold), and a key that is revoked can no longer sign. " +
        "`add` takes compressed public keys (0x plus 66 hex characters). `revoke` takes key ids; the first key is 0, and key 0 is the key the user's wallet signs with here, so revoking it ends what this server can do for the account. " +
        "One call adds keys or revokes keys, never both, because the protocol docs say one operation does an add or a revoke. To rotate a key, add the new one, make sure it signs for the account, then revoke the old one in a second call. " +
        "Call with neither `add` nor `revoke` to see the account's keys and their ids: that call is refused, and the refusal lists them. " +
        "The tool reads the account's keys first and refuses, before anything reaches the phone: an account whose key 0 cannot sign alone, a key id the account does not have or has already revoked, " +
        "a key it already has (a revoked key is not added again), a request that revokes every key or leaves them weighing under 1000, and an interaction of this account that is still waiting to land. At most 5 keys per call. " +
        "Show the user the summary and every public key in the preview in full, not shortened, and get an explicit yes. What MOI Wallet shows for this operation is not known." +
        KEY_APPROVAL_PROTOCOL,
      inputSchema: { ...ConfigureAccountInput.shape, confirm: ConfirmArg },
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ confirm, ...args }) =>
      runWrite(deps, auth, "configure_account", args, confirm, (s) => prepareConfigureAccount(s.address, args)),
  );
}
