/**
 * MAS2: the token-id standard with amounts: a token id names a kind of token and an amount says how many.
 *
 * WRITTEN FROM THE SDK, NOT RUN AGAINST A NODE. No MAS2 asset exists on devnet and none was seen, so these routines
 * come from the SDK's mas2-schema and MAS2AssetLogic (node_modules/js-moi-asset), and the tests run them against a
 * synthetic manifest built from those same tables. The reviewer's table has a token id on mint; the SDK's MAS2 Mint
 * takes {beneficiary, amount} and these files follow the SDK until a devnet mint settles it. The manifest types a real
 * MAS2 asset picks for its inputs are unknown, so a routine is described when its inputs match by kind (specFor).
 */

import { tokenIdStandard } from "./common.js";

export const mas2File = tokenIdStandard("MAS2", true);
