/**
 * MAS1: the token-id standard without amounts. Each token is whole and is named by its token id, so a transfer or a
 * burn names the id and no amount, and a Mint takes only a recipient.
 *
 * WRITTEN FROM THE SDK, NOT RUN AGAINST A NODE. No MAS1 asset exists on devnet and none was seen, so these routines
 * come from the SDK's mas1-schema and MAS1AssetLogic (node_modules/js-moi-asset), and the tests run them against a
 * synthetic manifest built from those same tables. Two things follow. The reviewer's table has a token id on mint; the
 * SDK's MAS1 Mint takes none, and these files follow the SDK until a devnet mint settles it. And the manifest types a
 * real MAS1 asset picks for its inputs (token_id as u64 or u256, beneficiary as identifier) are unknown, so a routine is
 * described when its inputs match by kind (specFor); a real manifest that differs in a label makes the routine
 * undescribed, which is safe: the caller then passes participants.
 */

import { tokenIdStandard, type StandardFile } from "./common.js";

const base = tokenIdStandard("MAS1", false);

export const mas1File: StandardFile = {
  ...base,
  /**
   * A MAS1 routine never takes an amount. A model that carries an amount over from a MAS0 or MAS2 call would otherwise
   * be told only "no such input"; this says why, and it runs before the manifest is read.
   */
  refusal: (_routine, args) =>
    Object.hasOwn(args, "amount")
      ? "A MAS1 asset has no amounts: each token is whole and is named by its token id, so `amount` is refused instead of being ignored. Leave it out."
      : undefined,
};
