/**
 * Compare what MOI Wallet signed with the interaction that was previewed. No MCP imports and no config: the caller decides
 * what a mismatch costs (broadcastSigned in src/tools/write-core.ts, under MOI_SIGNED_CHECK).
 *
 * The phone is handed toWireJson(ix) (src/wc/hub.ts, src/wc/client.ts) and answers `ix_args`, the POLO bytes it signed, as
 * unprefixed hex. js-moi-wallet's signInteraction serialises the object it is given and changes no field (serializeIxObject,
 * node_modules/js-moi-wallet/src.ts/wallet.ts). So the honest answers are the POLO encodings of that same interaction, and
 * there are two, because POLO writes a number compactly and a bigint full width:
 *
 *   - "wire": the wallet parses the JSON it received and encodes the numbers it finds. Bigints crossed the relay as numbers
 *     (toWireJson), so this is the encoding of the wire form.
 *   - "full-width": the wallet revives integers as bigints before it encodes. This is the interaction as this server holds it.
 *
 * They are the same bytes unless the interaction carries a bigint (max_supply of a create, funds).
 *
 * This rests on the library the wallet is built on. The mobile app's own code is not public and no real answer from it has
 * been captured, which is why the check ships in warn mode (MOI_SIGNED_CHECK in src/schema.ts).
 *
 * Decided on bytes only, on purpose. A field-by-field comparison would need a decoder for every operation payload, which are
 * themselves POLO bytes, and nothing shows that the wallet changes any field. If a real capture shows that it does, the
 * answer is a different check, not a longer list here.
 *
 * Every encoding is made from a COPY. toPoloHex runs toRawInteractionObject, which rewrites `participants` in place on the
 * object it is given, and the interaction that was previewed is the one that was sent to the phone.
 *
 * The result carries lengths and form names, never the bytes, so it is safe to log.
 */

import { toPoloHex, toWireJson, type UnsignedInteraction } from "./ix-builder.js";

export type SignedForm = "wire" | "full-width";

export interface SignedComparison {
  /** The forms the answer equals. Both when the two encodings are the same bytes for this interaction; empty when it equals neither. */
  matched: SignedForm[];
  /** Length of the answer in hex characters. */
  answerLength: number;
  /** Length of each encoding that could be made. A form the SDK refused to encode is absent. */
  expectedLength: Partial<Record<SignedForm, number>>;
}

/** The encoding, or undefined when the SDK cannot make it. The wire form of a value beyond 2^53 is a string, which POLO refuses. */
function encode(make: () => string): string | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}

/**
 * Compare `ixArgs`, the hex the phone returned, with the encodings of `ix`, the interaction that was simulated, previewed and
 * sent to it. Never throws, and never changes `ix`. The answer's case is ignored, because the bytes are what count; a 0x
 * prefix is not stripped, because the hub and the client already refuse one (PoloHex in src/schema.ts) and nothing here
 * should make a wrong answer look right.
 */
export function compareSigned(ixArgs: string, ix: UnsignedInteraction): SignedComparison {
  const answer = typeof ixArgs === "string" ? ixArgs.toLowerCase() : "";
  const forms: Array<[SignedForm, string | undefined]> = [
    ["wire", encode(() => toPoloHex(toWireJson(ix) as never))],
    ["full-width", encode(() => toPoloHex(structuredClone(ix)))],
  ];
  const matched: SignedForm[] = [];
  const expectedLength: Partial<Record<SignedForm, number>> = {};
  for (const [form, hex] of forms) {
    if (hex === undefined) continue;
    expectedLength[form] = hex.length;
    if (hex === answer) matched.push(form);
  }
  return { matched, answerLength: answer.length, expectedLength };
}
