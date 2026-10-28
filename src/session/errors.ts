/**
 * ToolError model and error-code naming for the v2 SDK.
 *
 * Protocol errors (JSON-RPC error responses) carry a numeric code; SDK errors (timeouts,
 * closed connections, invalid results) carry a string `SdkErrorCode`. Both are mapped to
 * a stable human `codeName` (`InvalidParams`, `RequestTimeout`, `ConnectionClosed`, ...)
 * so case files can say `expectError: { code: "InvalidParams" }` regardless of era.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client'
import type { JsonValue } from '../types.js'

export type ToolErrorKind = 'protocol' | 'tool' | 'transport' | 'timeout'

export interface ToolError {
  /**
   * - `protocol`: JSON-RPC error response (or an SDK-level protocol violation, see `local`)
   * - `tool`: the tool ran and returned `isError: true`
   * - `transport`: the connection failed / closed
   * - `timeout`: no response within the time budget
   */
  kind: ToolErrorKind
  /** Numeric JSON-RPC code, when the error has one. */
  code?: number
  /** Stable human name: `InvalidParams`, `MethodNotFound`, `RequestTimeout`, `ConnectionClosed`, ... */
  codeName?: string
  message: string
  /** JSON-RPC `error.data`, when present. */
  data?: JsonValue
  /** True when raised by the client SDK rather than received from the server. */
  local?: boolean
}

/** HTTP binding header mismatch (SEP-2243). Not in ProtocolErrorCode. */
export const HEADER_MISMATCH_CODE = -32020

/** Numeric code → stable name. Includes 2026-07-28 renumbered codes and v1-era names. */
const NUMERIC_CODE_NAMES: Record<number, string> = {
  [ProtocolErrorCode.ParseError]: 'ParseError',
  [ProtocolErrorCode.InvalidRequest]: 'InvalidRequest',
  [ProtocolErrorCode.MethodNotFound]: 'MethodNotFound',
  [ProtocolErrorCode.InvalidParams]: 'InvalidParams',
  [ProtocolErrorCode.InternalError]: 'InternalError',
  [ProtocolErrorCode.ResourceNotFound]: 'ResourceNotFound',
  [ProtocolErrorCode.MissingRequiredClientCapability]: 'MissingRequiredClientCapability',
  [ProtocolErrorCode.UnsupportedProtocolVersion]: 'UnsupportedProtocolVersion',
  [ProtocolErrorCode.UrlElicitationRequired]: 'UrlElicitationRequired',
  [HEADER_MISMATCH_CODE]: 'HeaderMismatch',
  // v1 SDK ErrorCode values that were numeric there (now SdkErrors in v2):
  [-32000]: 'ConnectionClosed',
  [-32001]: 'RequestTimeout',
}

/** Stable names for v2 SdkErrorCode values (string enum → PascalCase key). */
const SDK_CODE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SdkErrorCode).map(([key, value]) => [value, key]),
)

/** Reverse lookup: name → numeric code, for `expectError.code` given as a name. */
const NAME_TO_NUMERIC: Record<string, number> = Object.fromEntries(
  Object.entries(NUMERIC_CODE_NAMES).map(([code, name]) => [name, Number(code)]),
)

/** v1 / alternative spellings accepted in case files, mapped to the canonical name. */
const NAME_ALIASES: Record<string, string> = {
  RequestTimedOut: 'RequestTimeout',
  Timeout: 'RequestTimeout',
  ConnectionLost: 'ConnectionClosed',
  UnsupportedVersion: 'UnsupportedProtocolVersion',
  HeaderMismatchError: 'HeaderMismatch',
}

export function errorCodeName(code: number): string | undefined {
  return NUMERIC_CODE_NAMES[code]
}

export function sdkErrorCodeName(code: string): string {
  return SDK_CODE_NAMES[code] ?? code
}

/** Canonical code name for a user-supplied name (handles aliases); undefined when unknown. */
export function canonicalCodeName(name: string): string {
  return NAME_ALIASES[name] ?? name
}

export function numericCodeForName(name: string): number | undefined {
  return NAME_TO_NUMERIC[canonicalCodeName(name)]
}

/** Every code name known to Vibrissa (numeric + SDK), for docs / schema / migrate. */
export function knownCodeNames(): string[] {
  return [...new Set([...Object.values(NUMERIC_CODE_NAMES), ...Object.values(SDK_CODE_NAMES)])]
}

/**
 * True when a resource-not-found was reported. 2026-07-28 servers answer `-32602` with
 * `data` exactly `{ uri }`; older SDK builds used `-32002`.
 */
export function isResourceNotFound(error: Pick<ToolError, 'code' | 'data'>): boolean {
  if (error.code === ProtocolErrorCode.ResourceNotFound) return true
  if (error.code !== ProtocolErrorCode.InvalidParams) return false
  const data = error.data
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    typeof (data as { uri?: unknown }).uri === 'string'
  )
}

/**
 * Does an observed error satisfy `expectError.code`? Accepts names (with aliases) and
 * numbers. `ResourceNotFound` also matches the 2026-07-28 `-32602 + { uri }` shape.
 */
export function errorMatchesCode(error: ToolError, expected: string | number): boolean {
  if (typeof expected === 'number') return error.code === expected
  const wanted = canonicalCodeName(expected)
  if (error.codeName !== undefined && canonicalCodeName(error.codeName) === wanted) return true
  if (wanted === 'ResourceNotFound' && isResourceNotFound(error)) return true
  const numeric = NAME_TO_NUMERIC[wanted]
  return numeric !== undefined && error.code === numeric
}

export function stripMcpErrorPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/, '')
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: string; text: string } => {
      return (
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
      )
    })
    .map((item) => item.text)
    .join('\n')
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return String(value)
  }
}

/** Build a ToolError from a raw JSON-RPC `error` object (as received on the wire). */
export function fromJsonRpcError(error: {
  code?: unknown
  message?: unknown
  data?: unknown
}): ToolError {
  const code = typeof error.code === 'number' ? error.code : undefined
  const data = toJsonValue(error.data)
  return {
    kind: 'protocol',
    ...(code !== undefined ? { code } : {}),
    ...(code !== undefined && errorCodeName(code) ? { codeName: errorCodeName(code) } : {}),
    message: stripMcpErrorPrefix(
      typeof error.message === 'string' ? error.message : 'Unknown error',
    ),
    ...(data !== undefined ? { data } : {}),
  }
}

export interface ErrorContext {
  /** What was being done, e.g. `tools/call "echo"`. */
  what: string
  timeoutMs?: number
}

/**
 * Map anything thrown by the SDK into a ToolError. Never throws.
 * `local` is decided by the caller (it knows whether a wire error response arrived).
 */
export function toToolError(err: unknown, ctx: ErrorContext): ToolError {
  if (err instanceof ProtocolError) {
    const data = toJsonValue(err.data)
    return {
      kind: 'protocol',
      code: err.code,
      ...(errorCodeName(err.code) ? { codeName: errorCodeName(err.code) } : {}),
      message: stripMcpErrorPrefix(err.message),
      ...(data !== undefined ? { data } : {}),
    }
  }
  if (err instanceof SdkError) {
    const codeName = sdkErrorCodeName(err.code)
    const data = toJsonValue(err.data)
    const base = { codeName, ...(data !== undefined ? { data } : {}), local: true }
    switch (err.code) {
      case SdkErrorCode.RequestTimeout:
        return {
          ...base,
          kind: 'timeout',
          message: `Request timed out at ${ctx.what}: no response within ${ctx.timeoutMs ?? '?'}ms. Raise timeoutMs (step or config) if the server is legitimately slow.`,
        }
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.SendFailed:
        return {
          ...base,
          kind: 'transport',
          message: `Server connection closed at ${ctx.what}: ${err.message}. The server process exited or closed its output; check its stderr.`,
        }
      default:
        if (
          String(err.code).startsWith('CLIENT_HTTP') ||
          err.code === SdkErrorCode.EraNegotiationFailed
        ) {
          return { ...base, kind: 'transport', message: `${err.message} (at ${ctx.what})` }
        }
        return { ...base, kind: 'protocol', message: `${err.message} (at ${ctx.what})` }
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return {
    kind: 'transport',
    codeName: 'ClientError',
    message: `${message} (at ${ctx.what})`,
    local: true,
  }
}
