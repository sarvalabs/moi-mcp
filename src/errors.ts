/**
 * Maps the string error codes in schema.ErrorCode onto JSON-RPC errors that
 * MCP clients understand, while preserving the string code at `data.code`
 * so an agent can branch on it.
 */

import { McpError, ErrorCode as JsonRpcErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { MoiError } from "./moi-error.js";
import { ErrorCode } from "./schema.js";

/** Which JSON-RPC code best represents each MOI condition. */
const JSONRPC_FOR: Record<ErrorCode, number> = {
  // Bad or unresolvable arguments.
  [ErrorCode.INVALID_ARGS]: JsonRpcErrorCode.InvalidParams,
  [ErrorCode.AGENT_NOT_FOUND]: JsonRpcErrorCode.InvalidParams,
  [ErrorCode.LOGIC_ROUTINE_NOT_FOUND]: JsonRpcErrorCode.InvalidParams,

  // Valid arguments, wrong state — the caller must change something first.
  [ErrorCode.WALLET_NOT_CONNECTED]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.NETWORK_MISMATCH]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.INSUFFICIENT_BALANCE]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.USER_REJECTED]: JsonRpcErrorCode.InvalidRequest,

  // Timing and upstream failures.
  [ErrorCode.REQUEST_TIMEOUT]: JsonRpcErrorCode.RequestTimeout,
  [ErrorCode.RPC_ERROR]: JsonRpcErrorCode.InternalError,
  [ErrorCode.RELAY_UNAVAILABLE]: JsonRpcErrorCode.InternalError,

  // The Launchpad: sign in first, or it answered with an error.
  [ErrorCode.LAUNCHPAD_NOT_SIGNED_IN]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.LAUNCHPAD_ERROR]: JsonRpcErrorCode.InternalError,
};

/** Build an McpError carrying the MOI string code in `data.code`. */
export function mcpError(
  code: ErrorCode,
  message: string,
  data?: Record<string, unknown>,
): McpError {
  // The string code ALSO goes into the message: the SDK's tools/call wrapper
  // renders a thrown McpError as {isError, content:[{text: error.message}]}
  // and drops `data`, so data.code alone never reaches the client. Agents
  // branch on text; give them a stable token to branch on.
  return new McpError(
    JSONRPC_FOR[code] ?? JsonRpcErrorCode.InternalError,
    `[${code}] ${message}`,
    { code, ...data },
  );
}

/** Throwing form. Use inside tool handlers. */
export function fail(
  code: ErrorCode,
  message: string,
  data?: Record<string, unknown>,
): never {
  throw mcpError(code, message, data);
}

/** Narrow an unknown catch value to a readable message. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * Boundary converter. src/moi/* and src/wc/* throw MoiError (framework-free);
 * tool handlers turn it into the McpError the client understands. Anything
 * else becomes an InternalError with its message preserved.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof MoiError) return mcpError(err.code, err.message, err.data);
  return new McpError(JsonRpcErrorCode.InternalError, messageOf(err));
}
