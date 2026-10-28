/**
 * Fuzz invariants as data: properties every tool call must satisfy without any golden.
 * Each invariant says which generated cases it applies to and judges one call outcome.
 * The runner (phase 2) supplies the outcome; this module never touches a session.
 */
import type { JsonValue } from '../types.js'
import type { GeneratedCase } from './generate.js'
import { INJECTION_PAYLOADS, type InjectionPayload } from './payloads.js'

export interface FuzzOutcome {
  /**
   * result: the call returned a CallToolResult (possibly `isError: true`).
   * error: a JSON-RPC / tool / transport error. input_required: an MRTR pause.
   * crash: the server process died or the connection dropped. timeout: no answer in time.
   */
  kind: 'result' | 'error' | 'input_required' | 'crash' | 'timeout'
  result?: JsonValue
  /** `kind` mirrors the session's ToolError: 'protocol' | 'tool' | 'transport' | 'timeout'. */
  error?: { kind: string; code?: number; codeName?: string; message: string }
  durationMs: number
  /** structuredContent validated against the tool's outputSchema; undefined = no outputSchema. */
  structuredValid?: boolean
}

export interface Verdict {
  ok: boolean
  detail?: string
  /** The invariant did not judge this outcome (e.g. no outputSchema declared). Always ok. */
  skipped?: boolean
}

export type InvariantLevel = 'error' | 'warn'

export interface Invariant {
  id: string
  title: string
  /** 'warn' verdicts are reported but never fail a run. */
  level: InvariantLevel
  applies: (c: GeneratedCase) => boolean
  check: (c: GeneratedCase, outcome: FuzzOutcome) => Verdict
}

export interface EvaluatedVerdict extends Verdict {
  invariant: string
  title: string
  level: InvariantLevel
}

export const JSONRPC_INVALID_PARAMS = -32602
export const JSONRPC_INTERNAL_ERROR = -32603

const PASS: Verdict = { ok: true }

function skip(detail: string): Verdict {
  return { ok: true, skipped: true, detail }
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A CallToolResult with `isError: true`, or an error the session classified as a tool error. */
export function isToolError(outcome: FuzzOutcome): boolean {
  if (outcome.kind === 'result') return isObject(outcome.result) && outcome.result.isError === true
  return outcome.kind === 'error' && outcome.error?.kind === 'tool'
}

export function isTimeout(outcome: FuzzOutcome): boolean {
  return (
    outcome.kind === 'timeout' || (outcome.kind === 'error' && outcome.error?.kind === 'timeout')
  )
}

export function isInvalidParams(outcome: FuzzOutcome): boolean {
  const err = outcome.error
  if (outcome.kind !== 'error' || !err) return false
  return err.code === JSONRPC_INVALID_PARAMS || /^invalid[_ -]?params$/i.test(err.codeName ?? '')
}

function isInternalError(outcome: FuzzOutcome): boolean {
  const err = outcome.error
  if (outcome.kind !== 'error' || !err) return false
  return err.code === JSONRPC_INTERNAL_ERROR || /^internal[_ -]?error$/i.test(err.codeName ?? '')
}

function describeError(outcome: FuzzOutcome): string {
  const err = outcome.error
  if (!err) return outcome.kind
  const name = err.codeName ?? (err.code !== undefined ? `code ${err.code}` : err.kind)
  const code = err.codeName && err.code !== undefined ? ` (${err.code})` : ''
  return `${name}${code}: ${truncate(err.message, 160)}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Text the server sent back as an error: the error message, or an isError result's text content. */
export function errorText(outcome: FuzzOutcome): string | undefined {
  if (outcome.kind === 'error') return outcome.error?.message ?? ''
  if (outcome.kind === 'result' && isObject(outcome.result) && outcome.result.isError === true) {
    const content = outcome.result.content
    if (!Array.isArray(content)) return ''
    return content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
  }
  return undefined
}

/** Payloads a case carries: its `payloadIds`, or any payload value found in its string args. */
export function payloadsInCase(
  c: GeneratedCase,
  payloads: readonly InjectionPayload[] = INJECTION_PAYLOADS,
): InjectionPayload[] {
  if (c.payloadIds) return payloads.filter((p) => c.payloadIds?.includes(p.id))
  const strings: string[] = []
  const walk = (v: JsonValue) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isObject(v)) Object.values(v).forEach(walk)
  }
  walk(c.args)
  return payloads.filter((p) => strings.some((s) => s.includes(p.value)))
}

function notJudged(outcome: FuzzOutcome): Verdict | undefined {
  if (outcome.kind === 'crash') return skip('not judged: the server crashed (see never-crash)')
  return undefined
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export const validArgsNoProtocolError: Invariant = {
  id: 'valid-args-no-protocol-error',
  title: 'Valid arguments never produce a protocol error',
  level: 'error',
  applies: (c) => c.expectation === 'success',
  check: (c, outcome) => {
    const skipped = notJudged(outcome)
    if (skipped) return skipped
    if (outcome.kind !== 'error' || isToolError(outcome) || isTimeout(outcome)) return PASS
    return {
      ok: false,
      detail: `schema-valid args (${c.reason}) were rejected with ${describeError(outcome)}. If the tool cannot handle this input, its inputSchema should exclude it, or it should return a tool error (isError: true).`,
    }
  },
}

export const validArgsNoTimeout: Invariant = {
  id: 'valid-args-no-timeout',
  title: 'Valid arguments get an answer before the timeout',
  level: 'error',
  applies: (c) => c.expectation === 'success',
  check: (c, outcome) => {
    if (!isTimeout(outcome)) return PASS
    return {
      ok: false,
      detail: `no answer within the timeout for schema-valid args (${c.reason}) after ${outcome.durationMs}ms`,
    }
  },
}

export interface InvalidParamsOptions {
  /**
   * Accept a tool error (`isError: true`) as a correct rejection. MCP 2025-11-25 asks
   * servers to report input validation failures as tool errors so the model can
   * self-correct, so this defaults to true. Set false to require JSON-RPC InvalidParams.
   */
  acceptToolError?: boolean
}

export function invalidArgsYieldInvalidParams(opts: InvalidParamsOptions = {}): Invariant {
  const acceptToolError = opts.acceptToolError ?? true
  return {
    id: 'invalid-args-yield-invalid-params',
    title: 'Invalid arguments are rejected with InvalidParams (not InternalError, not success)',
    level: 'error',
    applies: (c) => c.expectation === 'invalid-params',
    check: (c, outcome) => {
      const skipped = notJudged(outcome)
      if (skipped) return skipped
      if (isInvalidParams(outcome)) return PASS
      if (isToolError(outcome)) {
        if (acceptToolError) return PASS
        return {
          ok: false,
          detail: `invalid args (${c.reason}) produced a tool error instead of InvalidParams (-32602)`,
        }
      }
      if (outcome.kind === 'result') {
        return {
          ok: false,
          detail: `invalid args were accepted silently (${c.reason}). Validate arguments against the inputSchema and reject with InvalidParams.`,
        }
      }
      if (isTimeout(outcome)) {
        return {
          ok: false,
          detail: `invalid args (${c.reason}) timed out after ${outcome.durationMs}ms instead of being rejected`,
        }
      }
      if (outcome.kind === 'input_required') {
        return {
          ok: false,
          detail: `invalid args (${c.reason}) led to an input_required round instead of InvalidParams`,
        }
      }
      if (isInternalError(outcome)) {
        return {
          ok: false,
          detail: `invalid args (${c.reason}) caused ${describeError(outcome)} instead of InvalidParams (-32602)`,
        }
      }
      return {
        ok: false,
        detail: `invalid args (${c.reason}) produced ${describeError(outcome)} instead of InvalidParams (-32602)`,
      }
    },
  }
}

export const neverCrash: Invariant = {
  id: 'never-crash',
  title: 'The server survives every call',
  level: 'error',
  applies: () => true,
  check: (c, outcome) => {
    if (outcome.kind === 'crash') {
      const why = outcome.error?.message ? `: ${truncate(outcome.error.message, 160)}` : ''
      return {
        ok: false,
        detail: `server crashed on ${c.strategy} case ${c.id} (${c.reason})${why}`,
      }
    }
    if (outcome.kind === 'error' && outcome.error?.kind === 'transport') {
      return {
        ok: false,
        detail: `transport failed on ${c.strategy} case ${c.id} (${c.reason}): ${truncate(outcome.error.message, 160)}`,
      }
    }
    return PASS
  },
}

export const outputMatchesOutputSchema: Invariant = {
  id: 'output-matches-output-schema',
  title: 'structuredContent matches the declared outputSchema',
  level: 'error',
  applies: () => true,
  check: (c, outcome) => {
    if (outcome.kind !== 'result') return skip('not judged: no result')
    if (outcome.structuredValid === undefined)
      return skip('not judged: tool declares no outputSchema')
    if (isToolError(outcome)) return skip('not judged: isError results need not match outputSchema')
    if (outcome.structuredValid) return PASS
    return {
      ok: false,
      detail: `structuredContent does not match the tool's outputSchema (${c.reason})`,
    }
  },
}

export const noEchoOfInjectionPayload: Invariant = {
  id: 'no-echo-of-injection-payload-in-error-message',
  title: 'Error messages do not echo injection payloads verbatim',
  level: 'warn',
  applies: (c) => c.strategy === 'inject' || (c.payloadIds?.length ?? 0) > 0,
  check: (c, outcome) => {
    const text = errorText(outcome)
    if (text === undefined) return skip('not judged: the call did not fail')
    const echoed = payloadsInCase(c).filter((p) => text.includes(p.marker))
    if (echoed.length === 0) return PASS
    return {
      ok: false,
      detail: `error message echoes injection payload ${echoed.map((p) => `'${p.id}'`).join(', ')} verbatim; a model reading this error sees attacker-controlled text. Quote or summarize user input in errors.`,
    }
  },
}

export function latencyUnderBudget(budgetMs: number): Invariant {
  return {
    id: 'latency-under-budget',
    title: `Calls finish within ${budgetMs}ms`,
    level: 'error',
    applies: () => true,
    check: (c, outcome) => {
      if (outcome.kind === 'crash' || isTimeout(outcome)) return skip(`not judged: ${outcome.kind}`)
      if (outcome.durationMs <= budgetMs) return PASS
      return {
        ok: false,
        detail: `took ${outcome.durationMs}ms, over the ${budgetMs}ms budget (${c.reason})`,
      }
    },
  }
}

export interface InvariantOptions extends InvalidParamsOptions {
  /** Adds latency-under-budget when set. */
  budgetMs?: number
}

/** The standard invariant set; `latency-under-budget` only when `budgetMs` is given. */
export function createDefaultInvariants(opts: InvariantOptions = {}): Invariant[] {
  const list = [
    validArgsNoProtocolError,
    validArgsNoTimeout,
    invalidArgsYieldInvalidParams(opts),
    neverCrash,
    outputMatchesOutputSchema,
    noEchoOfInjectionPayload,
  ]
  if (opts.budgetMs !== undefined) list.push(latencyUnderBudget(opts.budgetMs))
  return list
}

export const defaultInvariants: readonly Invariant[] = Object.freeze(createDefaultInvariants())

/** Judge one outcome against every applicable invariant. */
export function evaluate(
  c: GeneratedCase,
  outcome: FuzzOutcome,
  invariants: readonly Invariant[] = defaultInvariants,
): EvaluatedVerdict[] {
  return invariants
    .filter((inv) => inv.applies(c))
    .map((inv) => ({
      ...inv.check(c, outcome),
      invariant: inv.id,
      title: inv.title,
      level: inv.level,
    }))
}

/** True when any error-level invariant failed (warnings never fail). */
export function hasFailures(verdicts: readonly EvaluatedVerdict[]): boolean {
  return verdicts.some((v) => !v.ok && v.level === 'error')
}
