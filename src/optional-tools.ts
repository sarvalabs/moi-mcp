/**
 * The gated tools that exist only when an operator allows them (src/tools/register.ts), kept apart from src/server.ts, which
 * re-exports the list. While the operator has not, a `tools/call` for one is not gated: it reaches the SDK, which answers that
 * the tool is not found, with no sign-in prompt. Gating it would send a signed-out caller to the Connect card for a tool that is
 * not listed, and then say "not found". Every name here is also in GATED, which a test checks.
 */
import { accountKeyToolsOn } from "./config.js";

export const OPTIONAL_GATED: readonly string[] = ["moi_configure_account"];

/** True for an optional gated tool the operator has not switched on: it is not registered, so a call to it is unknown. */
export const isSwitchedOff = (name: string): boolean => OPTIONAL_GATED.includes(name) && !accountKeyToolsOn();
