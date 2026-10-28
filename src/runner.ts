/**
 * Runner v2: executes case files against one or more MCP servers and emits RunEvents to
 * the configured reporters.
 *
 * - Cases are grouped by server. Each server gets `concurrency` workers, each with its own
 *   McpSession (sessions serialize operations). A case (and every step of a flow) runs on
 *   exactly one worker; flows are never split.
 * - Before cases run, the first session of each server verifies the manifest lock and (with
 *   `--check`) runs the spec / description checks.
 * - Per case: setup → steps (or the case's single operation) → teardown (always).
 * - `--repeat`, `--update`, `--baseline`, `--trace`, budgets, failFast and allowEmpty are
 *   all handled here; reporters only consume events.
 *
 * See docs/V2_ARCHITECTURE.md ("Runner") for the semantics of every case key.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  InterpolationError,
  type LoadedCase,
  type PlannedStep,
  caseFileHasComments,
  getPath,
  interpolateStep,
  isMultiStep,
  loadCases,
  opKindOf,
  planSteps,
  setIn,
} from './cases.js'
import { DEFAULT_NORMALIZE, defaultRunOptions } from './defaults.js'
import type {
  CaseOutcome,
  CaseRef,
  CaseStatus,
  CheckOutcome,
  Mismatch,
  Reporter,
  ReporterContext,
  RunEvent,
  RunSummary,
  StepRef,
} from './events.js'
import { runChecks } from './lint/index.js'
import {
  type CapturedManifest,
  DEFAULT_MANIFEST_IGNORE,
  type ManifestDiff,
  captureManifest,
  diffManifest,
  formatDiff,
  manifestPathFor,
  readManifest,
  summarizeDiff,
  writeManifest,
} from './manifest.js'
import { escapeDirectives, isMatcherObject, matchValue } from './match.js'
import { normalizeResult } from './normalize.js'
import { resolveRootDir, resolveServerConfig } from './paths.js'
import { createReporters, fanout } from './reporters/index.js'
import type { JsonReport } from './reporters/json.js'
import { baseCaseId, resolveOutDir } from './reporters/shared.js'
import { suggestRespond } from './respond-hint.js'
import { appendIndex, appendKey, validate } from './schema.js'
import {
  type CallOptions,
  McpSession,
  type Outcome,
  SessionStartError,
  type ToolError,
  errorMatchesCode,
} from './session/index.js'
import type {
  JsonObject,
  JsonValue,
  NormalizeConfig,
  RunOptions,
  ServerConfig,
  Step,
  TestCase,
  ToolSummary,
  TranscriptEntry,
} from './types.js'
import { isHttpServerConfig } from './types.js'

// ---------------------------------------------------------------------------
// Options & results
// ---------------------------------------------------------------------------

/**
 * RunOptions (incl. `outDir`, `manifestIgnore`, `checks` from config) plus runner-only knobs.
 * `outDir` holds results.json, junit.xml and traces/ (relative to rootDir; default "reports").
 */
export interface RunnerOptions extends RunOptions {
  /** Allow pretty console output (still subject to TTY / NO_COLOR). Default true. */
  pretty?: boolean
  /** Reporter output sinks. Default console.log / console.error. */
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Reporter instances added to the ones named in `reporters`. */
  extraReporters?: Reporter[]
  /** Informational lines (e.g. skipped `$ref` fragments). Default: `stdout`. */
  info?: (line: string) => void
  /** `--update=all`: also rewrite expectations that contain matchers. */
  updateAll?: boolean
  /** `--update-manifest`: rewrite the manifest lock on drift (or create it when missing). */
  updateManifest?: boolean
  /** Verify the manifest lock at all. Default true. */
  lockManifest?: boolean
  /** Minimum pass rate for `flaky: true` cases under --repeat. Default 0.5. */
  flakyFloor?: number
  /** --baseline: fail when a passing case's durationMs grows by more than this percent. Default 50. */
  baselineLatencyPct?: number
  /** --baseline: ignore latency growth smaller than this many ms (timer noise). Default 10. */
  baselineLatencyMinMs?: number
  /** Server stderr for runner sessions: kept out of the console and saved with traces by default. */
  serverStderr?: 'inherit' | 'capture' | 'ignore'
  /** Environment for `{{env.X}}`. Default process.env. */
  env?: Record<string, string | undefined>
}

export interface ManifestResult {
  server: string
  path: string
  /** `missing-required`: no lock while requireManifest is on (fails the run). */
  status: 'ok' | 'diff' | 'missing' | 'missing-required' | 'updated' | 'created' | 'error'
  diff?: ManifestDiff
  summary?: string
}

export interface RunResult {
  /** 0 ok, 1 failures, 2 configuration error (e.g. an invalid server entry). */
  exitCode: number
  ok: boolean
  summary: RunSummary
  cases: Array<{ ref: CaseRef; outcome: CaseOutcome }>
  checks: CheckOutcome[]
  manifests: ManifestResult[]
  warnings: string[]
}

export const DEFAULT_FLAKY_FLOOR = 0.5
export const DEFAULT_BASELINE_LATENCY_PCT = 50
export const DEFAULT_BASELINE_LATENCY_MIN_MS = 10

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function short(value: unknown, max = 80): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function joinPath(base: string, relative: string): string {
  if (relative === '') return base
  if (relative.startsWith('[')) return `${base}${relative}`
  return base === '' ? relative : `${base}.${relative}`
}

function summarizeMismatches(label: string, mismatches: Mismatch[]): string {
  const first = mismatches[0]
  const more = mismatches.length > 1 ? ` (+${mismatches.length - 1} more)` : ''
  return `${label} at ${first.path}: ${first.message}${more}`
}

function getIn(root: unknown, source: Array<string | number>): unknown {
  let node = root as Record<string | number, unknown> | undefined
  for (const key of source) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined
    node = node[key] as Record<string | number, unknown> | undefined
  }
  return node
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Closest name (case-insensitive edit distance within max(2, len/3)), for did-you-mean hints. */
function suggestName(input: string, names: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const name of names) {
    const score = levenshtein(input.toLowerCase(), name.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = name
    }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined
}

// ---------------------------------------------------------------------------
// Matcher paths → RFC 6901 pointers into the case file
// ---------------------------------------------------------------------------

/** `content[0].text` / `_meta["a/b"]` / `(root)` → path segments. */
export function matcherPathSegments(path: string): string[] {
  if (path === '' || path === '(root)') return []
  const out: string[] = []
  let i = 0
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      i++
    } else if (ch === '[') {
      if (path[i + 1] === '"') {
        let j = i + 2
        while (j < path.length && path[j] !== '"') j += path[j] === '\\' ? 2 : 1
        out.push(JSON.parse(path.slice(i + 1, j + 1)) as string)
        i = j + 2
      } else {
        const end = path.indexOf(']', i)
        out.push(path.slice(i + 1, end === -1 ? undefined : end))
        i = end === -1 ? path.length : end + 1
      }
    } else {
      let j = i
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
      out.push(path.slice(i, j))
      i = j
    }
  }
  return out
}

/** RFC 6901 JSON Pointer for path segments (`["steps", 1, "expect"]` → `/steps/1/expect`). */
export function toPointer(segments: Array<string | number>): string {
  return segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')
}

// ---------------------------------------------------------------------------
// expectInputRequired views & respond suggestions
// ---------------------------------------------------------------------------

/**
 * Does an `expectInputRequired` expectation address requests by method? True when every
 * plain (non-`$`) top-level key contains a `/` (`elicitation/create`, `sampling/createMessage`).
 */
function wantsMethodView(expected: JsonValue): boolean {
  if (!isObject(expected)) return false
  const keys = Object.keys(expected).filter((key) => !key.startsWith('$'))
  return keys.length > 0 && keys.every((key) => key.includes('/'))
}

/**
 * The value `expectInputRequired` is matched against, built from every InputRequests round
 * of the call:
 *
 * - **by key** (default): `{ "<request key>": { "method": "...", "params": {...} } }`, the
 *   server's own InputRequests keys merged over all rounds. On 2025-era connections the keys
 *   are JSON-RPC request ids, so prefer the method view for suites that run on both eras.
 * - **by method** (when every plain key of the expectation contains `/`):
 *   `{ "elicitation/create": <params> }`; a method asked several times maps to an array of
 *   params in order.
 */
export function inputRequestView(expected: JsonValue, rounds: JsonValue[]): JsonObject {
  const byKey: JsonObject = {}
  const byMethod: JsonObject = {}
  const repeated = new Set<string>()
  for (const round of rounds) {
    if (!isObject(round)) continue
    for (const [key, entry] of Object.entries(round)) {
      byKey[key] = entry
      if (!isObject(entry) || typeof entry.method !== 'string') continue
      const params = entry.params ?? {}
      const method = entry.method
      if (!Object.hasOwn(byMethod, method)) byMethod[method] = params
      else if (repeated.has(method)) (byMethod[method] as JsonValue[]).push(params)
      else {
        byMethod[method] = [byMethod[method], params]
        repeated.add(method)
      }
    }
  }
  return wantsMethodView(expected) ? byMethod : byKey
}

function describeRequests(requests: JsonValue): string {
  if (!isObject(requests)) return short(requests)
  const parts: string[] = []
  for (const [key, entry] of Object.entries(requests)) {
    const method = isObject(entry) && typeof entry.method === 'string' ? entry.method : key
    const params = isObject(entry) && isObject(entry.params) ? entry.params : undefined
    const message = typeof params?.message === 'string' ? ` ${JSON.stringify(params.message)}` : ''
    parts.push(`${method}${message}`)
  }
  return parts.join(', ') || 'input'
}

// Paste-ready `respond` suggestions are shared with `vib call` / `vib record`.
export { suggestRespond }

// ---------------------------------------------------------------------------
// Case execution (shared by the runner, the vitest bridge and `vib diff`)
// ---------------------------------------------------------------------------

export interface ExecuteContext {
  session: McpSession
  /** Run-level normalization (merged under case / step `normalize`). */
  normalize: NormalizeConfig
  timeoutMs: number
  /** Default case budget (config `budgetMs`). */
  budgetMs?: number
  /** Tool definitions by name: outputSchema enforcement, args pre-validation, name hints. */
  tools?: Map<string, ToolSummary>
  /** Values visible to `{{name}}` before the case captures anything (suite setup). */
  vars?: Record<string, JsonValue>
  env?: Record<string, string | undefined>
  /**
   * `failing` (= --update) rewrites mismatched plain leaves of `expect`; `all` (=
   * --update=all) also replaces mismatched matchers and `$ref`s with literal values.
   */
  update?: 'off' | 'failing' | 'all'
  /** Case as written in its file (no `$ref` expansion): decides what --update may rewrite. */
  source?: TestCase
  /** Set when the case file must not be rewritten (e.g. it has comments): the reason. */
  cannotRewrite?: string
  /** Mention `--update` in failure reasons when it would help. Default true. */
  updateHint?: boolean
  /** Case id for messages. */
  caseId?: string
  onStepStart?: (step: StepRef) => void | Promise<void>
  onStepEnd?: (
    step: StepRef,
    result: { durationMs: number; status: CaseStatus; reason?: string },
  ) => void | Promise<void>
}

export interface ExpectationUpdate {
  /** Path inside the case file, e.g. `["steps", 1, "expect"]`. */
  source: Array<string | number>
  value: JsonValue
}

export interface CaseExecution {
  /** tracePath / stderrPath are filled in by the runner. */
  outcome: CaseOutcome
  /** Normalized observation of every executed step, in run order (used by `vib diff`). */
  observations: Array<{ step: StepRef; observed: JsonValue; planned: PlannedStep }>
  /** Goldens accepted under --update (the caller writes them). */
  updates: ExpectationUpdate[]
  warnings: string[]
  /** Final `{{name}}` scope (suite setup uses this). */
  vars: Record<string, JsonValue>
}

type FailureKind = NonNullable<CaseOutcome['errorKind']>
type MismatchField = NonNullable<Mismatch['field']>

interface Failure {
  kind: FailureKind
  reason: string
  /** The case field the failure is about (drives pointers and --update notes). */
  field?: MismatchField
  mismatches?: Mismatch[]
  expected?: JsonValue
  actual?: JsonValue
  budget?: { budgetMs: number; actualMs: number }
  /** A mismatch of `expect` (the only field --update rewrites). */
  golden?: boolean
}

interface StepEvaluation {
  durationMs: number
  failures: Failure[]
  observed: JsonValue
  captureSource?: JsonValue
  normalized?: JsonValue
  warnings: string[]
}

function effectiveNormalize(
  base: NormalizeConfig,
  caseLevel: NormalizeConfig | false | undefined,
  stepLevel: NormalizeConfig | false | undefined,
): NormalizeConfig | false {
  if (stepLevel === false) return false
  if (isObject(stepLevel)) {
    return { ...base, ...(isObject(caseLevel) ? caseLevel : {}), ...stepLevel }
  }
  if (caseLevel === false) return false
  return { ...base, ...(isObject(caseLevel) ? caseLevel : {}) }
}

function describeOp(kind: string, target: string): string {
  return `${kind} "${target}"`
}

function errorView(error: ToolError): JsonObject {
  return {
    kind: error.kind,
    ...(error.codeName !== undefined ? { codeName: error.codeName } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
    message: error.message,
    ...(error.data !== undefined ? { data: error.data } : {}),
  }
}

/** "Tool "ech" is not on the server; did you mean "echo"? Available: ..." (or undefined). */
function unknownToolHint(
  kind: string,
  target: string,
  tools: Map<string, ToolSummary> | undefined,
): string | undefined {
  if (kind !== 'tool' || !tools || tools.size === 0 || tools.has(target)) return undefined
  const names = [...tools.keys()].sort()
  const near = suggestName(target, names)
  const shown = names.length > 12 ? `${names.slice(0, 12).join(', ')}, ...` : names.join(', ')
  return `Tool "${target}" is not on the server${near ? `; did you mean "${near}"?` : '.'} Available: ${shown}.`
}

function callFailedReason(what: string, error: ToolError, toolHint: string | undefined): string {
  if (error.kind === 'timeout' || error.kind === 'transport') return error.message
  if (error.kind === 'tool') {
    return `Tool returned an error at ${what}: ${error.message || '(no text content)'}. Add "expectError" (or an "expect" with "isError": true) if the error is the expected behavior.`
  }
  const code = error.codeName ?? error.code
  const label =
    error.codeName !== undefined && error.code !== undefined
      ? `[${error.codeName} ${error.code}] `
      : code !== undefined
        ? `[${code}] `
        : ''
  const hint =
    toolHint ??
    (code !== undefined
      ? `Add "expectError": { "code": ${JSON.stringify(code)} } if this error is the expected behavior.`
      : 'Add "expectError" if this error is the expected behavior.')
  return `Call failed at ${what}: ${label}${error.message}. ${hint}`
}

function schemaMismatches(tool: ToolSummary, raw: JsonValue, warnings: string[]): Mismatch[] {
  if (tool.outputSchema === undefined || !isObject(raw) || raw.isError === true) return []
  const structured = raw.structuredContent
  if (structured === undefined) {
    return [
      {
        path: 'structuredContent',
        message: 'missing (the tool declares an outputSchema, so results must include it)',
        field: 'structuredContent',
      },
    ]
  }
  const result = validate(tool.outputSchema, structured)
  if (result.schemaError !== undefined) {
    warnings.push(
      `outputSchema of tool "${tool.name}" could not be compiled (${result.schemaError}); structuredContent was not validated. Run "vib check" for details.`,
    )
    return []
  }
  if (result.ok) return []
  return result.errors.map((issue) => ({
    path: joinPath('structuredContent', issue.path),
    message: `does not match the tool's outputSchema: ${issue.message}`,
    actual: (getPath(structured, issue.path) ?? null) as unknown,
    field: 'structuredContent' as const,
  }))
}

async function callOperation(
  session: McpSession,
  step: Step,
  kind: string,
  target: string,
  opts: CallOptions,
): Promise<Outcome> {
  const args = step.args ?? {}
  switch (kind) {
    case 'tool':
      return session.callTool(target, args, opts)
    case 'resource':
      return session.readResource(target, opts)
    case 'resourceTemplate':
      return session.readResourceTemplate(target, args, opts)
    default:
      return session.getPrompt(target, args, opts)
  }
}

async function evaluateStep(
  step: Step,
  normalize: NormalizeConfig | false,
  ctx: ExecuteContext,
): Promise<StepEvaluation> {
  const warnings: string[] = []
  const kind = opKindOf(step)
  if (!kind) {
    return {
      durationMs: 0,
      observed: null,
      warnings,
      failures: [
        {
          kind: 'error',
          reason:
            'No operation: add one of "tool", "resource", "resourceTemplate" or "prompt" to the step.',
        },
      ],
    }
  }
  const target = String(step[kind])
  const what = describeOp(kind, target)
  const norm = (value: JsonValue): JsonValue =>
    normalize === false ? value : normalizeResult(value, normalize)

  const tool = kind === 'tool' ? ctx.tools?.get(target) : undefined
  if (tool && step.expectError === undefined && isObject(tool.inputSchema)) {
    const check = validate(tool.inputSchema, step.args ?? {})
    if (!check.ok && check.schemaError === undefined) {
      const issue = check.errors[0]
      warnings.push(
        `${ctx.caseId ? `${ctx.caseId}: ` : ''}args for ${what} do not match its inputSchema (${joinPath('args', issue.path)}: ${issue.message}). If that is deliberate, add "expectError".`,
      )
    }
  }

  const callOpts: CallOptions = { timeoutMs: step.timeoutMs ?? ctx.timeoutMs }
  if (step.respond !== undefined) callOpts.respond = step.respond
  if (step.await !== undefined && step.await !== false) callOpts.await = step.await

  let outcome: Outcome
  try {
    outcome = await callOperation(ctx.session, step, kind, target, callOpts)
  } catch (err) {
    return {
      durationMs: 0,
      observed: { error: { kind: 'client', message: errorText(err) } },
      warnings,
      failures: [{ kind: 'error', reason: `Call failed at ${what}: ${errorText(err)}.` }],
    }
  }

  const failures: Failure[] = []
  const rounds =
    outcome.inputRequests ?? (outcome.kind === 'input_required' ? [outcome.requests] : [])
  let observed: JsonValue = null
  let captureSource: JsonValue | undefined
  let normalized: JsonValue | undefined

  if (outcome.kind === 'input_required') {
    observed = { inputRequired: norm(outcome.requests) }
    captureSource = inputRequestView(step.expectInputRequired ?? {}, rounds)
    const assertsRequestOnly =
      step.expectInputRequired !== undefined &&
      step.expect === undefined &&
      step.expectError === undefined
    if (!assertsRequestOnly) {
      const respond = JSON.stringify({
        ...(step.respond ?? {}),
        ...suggestRespond(outcome.requests),
      })
      failures.push({
        kind: 'error',
        reason: `Unanswered input request at ${what}: the server asked for ${describeRequests(outcome.requests)}. Add to the step: "respond": ${respond} (edit the sample values), or assert only the request with "expectInputRequired".`,
        actual: norm(outcome.requests),
      })
    }
  }

  if (step.expectInputRequired !== undefined) {
    if (rounds.length === 0) {
      failures.push({
        kind: 'assertion',
        field: 'expectInputRequired',
        reason: `Expected an input request at ${what}, but the server answered without asking (no input_required round). Remove "expectInputRequired", or check the server.`,
        expected: step.expectInputRequired,
      })
    } else {
      const view = norm(inputRequestView(step.expectInputRequired, rounds))
      const mismatches = matchValue(step.expectInputRequired, view)
      if (mismatches.length > 0) {
        failures.push({
          kind: 'assertion',
          field: 'expectInputRequired',
          reason: `${summarizeMismatches('Input request mismatch', mismatches)} (${what}).`,
          mismatches,
          expected: step.expectInputRequired,
          actual: view,
        })
      }
    }
  }

  if (step.expectTask !== undefined) {
    if (outcome.task === undefined) {
      failures.push({
        kind: 'assertion',
        field: 'expectTask',
        reason: `Expected a task at ${what}, but the server answered directly (tasks need a 2026-07-28 connection and a server that supports the tasks extension).`,
        expected: step.expectTask,
      })
    } else {
      const task = norm(outcome.task)
      const mismatches = matchValue(step.expectTask, task)
      if (mismatches.length > 0) {
        failures.push({
          kind: 'assertion',
          field: 'expectTask',
          reason: `${summarizeMismatches('Task mismatch', mismatches)} (${what}).`,
          mismatches,
          expected: step.expectTask,
          actual: task,
        })
      }
    }
  }

  if (outcome.kind === 'error') {
    const error = outcome.error
    const view = errorView(error)
    observed = { error: view }
    if (step.expectError !== undefined) {
      captureSource = view
      const expected = step.expectError
      const actual: JsonObject = {
        ...(error.codeName !== undefined || error.code !== undefined
          ? { code: error.codeName ?? error.code ?? null }
          : {}),
        message: error.message,
      }
      if (expected.code !== undefined && !errorMatchesCode(error, expected.code)) {
        const got =
          error.codeName !== undefined
            ? `"${error.codeName}"${error.code !== undefined ? ` (${error.code})` : ''}`
            : error.code !== undefined
              ? String(error.code)
              : `no code (${error.kind} error)`
        failures.push({
          kind: 'assertion',
          field: 'expectError',
          reason: `Error code mismatch at ${what}: expected ${JSON.stringify(expected.code)}, got ${got}. Message: ${error.message}`,
          mismatches: [
            {
              path: 'code',
              message: `expected ${JSON.stringify(expected.code)}, got ${got}`,
              expected: expected.code,
              actual: error.codeName ?? error.code,
            },
          ],
          expected: expected as unknown as JsonValue,
          actual,
        })
      }
      if (expected.message !== undefined) {
        const mismatches = matchValue(expected.message as JsonValue, error.message)
        if (mismatches.length > 0) {
          failures.push({
            kind: 'assertion',
            field: 'expectError',
            reason: `Error message mismatch at ${what}: ${mismatches[0].message}.`,
            mismatches: mismatches.map((m) => ({
              ...m,
              path: m.path === '(root)' ? 'message' : `message.${m.path}`,
            })),
            expected: expected as unknown as JsonValue,
            actual,
          })
        }
      }
    } else if (error.kind === 'tool' && outcome.result !== undefined && step.expect !== undefined) {
      // A tool-level `isError` result compared as data (goldens recorded from error results).
      normalized = norm(outcome.result)
      observed = normalized
      captureSource = normalized
      const mismatches = matchValue(step.expect, normalized)
      if (mismatches.length > 0) {
        failures.push({
          kind: 'assertion',
          field: 'expect',
          golden: true,
          reason: `${summarizeMismatches('Expectation failed', mismatches)}.`,
          mismatches,
          expected: step.expect,
          actual: normalized,
        })
      }
    } else {
      failures.push({
        kind: error.kind === 'timeout' ? 'timeout' : 'error',
        reason: callFailedReason(what, error, unknownToolHint(kind, target, ctx.tools)),
        actual: view,
      })
    }
  } else if (outcome.kind === 'result') {
    normalized = norm(outcome.result)
    observed = normalized
    captureSource = normalized
    const raw = outcome.result
    const isTaskHandle = isObject(raw) && raw.resultType === 'task'
    const schemaIssues =
      kind === 'tool' && tool && step.validateOutput !== false && !isTaskHandle
        ? schemaMismatches(tool, raw, warnings)
        : []
    if (step.expectError !== undefined) {
      const violated =
        schemaIssues.length > 0
          ? ` and violated its outputSchema at ${schemaIssues[0].path}: ${schemaIssues[0].message.replace(/^does not match the tool's outputSchema: /, '')}`
          : ''
      failures.push({
        kind: 'assertion',
        field: 'expectError',
        reason: `Expected an error at ${what}, but the call succeeded${violated}. Remove "expectError", or fix the server.`,
        ...(schemaIssues.length > 0 ? { mismatches: schemaIssues } : {}),
        expected: step.expectError as unknown as JsonValue,
        actual: normalized,
      })
    } else {
      if (schemaIssues.length > 0) {
        failures.push({
          kind: 'assertion',
          field: 'structuredContent',
          reason: `${summarizeMismatches('Output schema violation', schemaIssues)}. The outputSchema of ${what} rejects its own structuredContent; fix the server, or set "validateOutput": false.`,
          mismatches: schemaIssues,
          actual: isObject(raw) ? (raw.structuredContent ?? null) : null,
        })
      }
      if (step.expect !== undefined) {
        const mismatches = matchValue(step.expect, normalized)
        if (mismatches.length > 0) {
          failures.push({
            kind: 'assertion',
            field: 'expect',
            golden: true,
            reason: `${summarizeMismatches('Expectation failed', mismatches)}.`,
            mismatches,
            expected: step.expect,
            actual: normalized,
          })
        }
      }
    }
  }

  return { durationMs: outcome.durationMs, failures, observed, captureSource, normalized, warnings }
}

function stepRefFor(planned: PlannedStep, index: number): StepRef {
  const kind = opKindOf(planned.step) ?? 'tool'
  const target = String(planned.step[kind] ?? '?')
  const base = planned.step.name ?? target
  const name =
    planned.phase === 'setup'
      ? `setup: ${base}`
      : planned.phase === 'teardown'
        ? `teardown: ${base}`
        : base
  return { index, name, kind, target }
}

function stepLabel(planned: PlannedStep, ref: StepRef, plan: PlannedStep[]): string {
  const position = plan.filter((p) => p.phase === planned.phase).indexOf(planned) + 1
  const phase =
    planned.phase === 'setup'
      ? 'Setup step'
      : planned.phase === 'teardown'
        ? 'Teardown step'
        : 'Step'
  return `${phase} ${position}${planned.step.name ? ` "${planned.step.name}"` : ''} (${ref.kind} ${ref.target})`
}

// ---------------------------------------------------------------------------
// --update: leaf-level rewrites
// ---------------------------------------------------------------------------

interface Blocked {
  path: string
  why: 'matcher' | 'placeholder' | 'ref'
  detail: string
}

interface Reconciled {
  value: JsonValue
  blocked: Blocked[]
  replaced: string[]
}

function displayPath(path: string): string {
  return path === '' ? '(root)' : path
}

function matcherNames(value: JsonObject): string {
  return Object.keys(value)
    .filter((key) => key.startsWith('$'))
    .join(' + ')
}

/**
 * Patch only what mismatches: walk the expectation as written (`src`) alongside its resolved
 * form (`res`: `$ref`s expanded, `{{captures}}` interpolated) and the actual value. Subtrees
 * that still match are kept verbatim (matchers included); mismatched plain leaves take the
 * actual value; mismatched matchers / `$ref`s are blocked, or replaced in `all` mode.
 */
function reconcile(
  src: JsonValue,
  res: JsonValue,
  act: JsonValue,
  path: string,
  partial: boolean,
  mode: 'failing' | 'all',
  out: Reconciled,
): JsonValue {
  if (matchValue(res, act, { partial }).length === 0) return src
  const where = displayPath(path)
  if (typeof src === 'string' && src.includes('{{')) {
    out.blocked.push({ path: where, why: 'placeholder', detail: src })
    return src
  }
  if (isObject(src) && Object.hasOwn(src, '$ref')) {
    if (mode === 'all') {
      out.replaced.push(`${where} ($ref ${short(src.$ref, 60)})`)
      return escapeDirectives(act)
    }
    out.blocked.push({ path: where, why: 'ref', detail: String(src.$ref) })
    return src
  }
  if (isMatcherObject(src)) {
    const names = isObject(src) ? matcherNames(src) : 'matcher'
    if (mode === 'all') {
      out.replaced.push(`${where} (${names})`)
      return escapeDirectives(act)
    }
    out.blocked.push({ path: where, why: 'matcher', detail: names })
    return src
  }
  if (isObject(src) && isObject(res) && isObject(act)) {
    const childPartial = typeof src.$partial === 'boolean' ? src.$partial : partial
    const result: JsonObject = {}
    for (const key of Object.keys(src)) {
      if (key === '$partial') {
        result[key] = src[key]
        continue
      }
      const child = appendKey(path, key)
      if (!Object.hasOwn(act, key)) {
        // Gone from the live result: drop it, unless it is a matcher that accepts absence.
        if (matchValue(res[key] ?? null, undefined, { partial: childPartial }).length === 0) {
          result[key] = src[key]
        }
        continue
      }
      result[key] = reconcile(src[key], res[key] ?? null, act[key], child, childPartial, mode, out)
    }
    if (!childPartial) {
      for (const key of Object.keys(act)) {
        if (!Object.hasOwn(src, key)) result[key] = escapeDirectives(act[key])
      }
    }
    return result
  }
  if (Array.isArray(src) && Array.isArray(res) && Array.isArray(act)) {
    return act.map((item, i) =>
      i < src.length
        ? reconcile(src[i], res[i] ?? null, item, appendIndex(path, i), partial, mode, out)
        : escapeDirectives(item),
    )
  }
  return escapeDirectives(act)
}

function blockedReason(blocked: Blocked[]): string {
  const placeholders = blocked.filter((b) => b.why === 'placeholder')
  if (placeholders.length > 0) {
    return `${placeholders.map((b) => b.path).join(', ')} uses {{captured}} values (accepting live output would freeze them); edit it by hand`
  }
  const refs = blocked.filter((b) => b.why === 'ref')
  const matchers = blocked.filter((b) => b.why === 'matcher')
  const parts: string[] = []
  if (matchers.length > 0) {
    const list = matchers.map((b) => `${b.path} (${b.detail})`).join(', ')
    parts.push(
      `${list} ${matchers.length === 1 ? 'is a matcher that no longer matches' : 'are matchers that no longer match'}; fix the matcher by hand`,
    )
  }
  if (refs.length > 0) {
    parts.push(
      `${refs.map((b) => `${b.path} ($ref ${b.detail})`).join(', ')} comes from a shared fragment; edit the fragment`,
    )
  }
  return `${parts.join('; ')}, or rerun with --update=all to replace ${blocked.length === 1 ? 'it' : 'them'} with the literal live value`
}

interface RewritePlan {
  ok: boolean
  /** Why --update cannot (or did not) rewrite this expectation. */
  why?: string
  value?: JsonValue
  replaced?: string[]
  previous?: JsonValue
}

function planRewrite(
  ctx: ExecuteContext,
  planned: PlannedStep,
  resolvedExpect: JsonValue,
  actual: JsonValue | undefined,
  mode: 'failing' | 'all',
): RewritePlan {
  if (ctx.cannotRewrite) return { ok: false, why: ctx.cannotRewrite }
  if (!ctx.source) return { ok: false, why: 'it is not backed by a case file' }
  const written = getIn(ctx.source, [...planned.source, 'expect']) as JsonValue | undefined
  if (written === undefined || actual === undefined) {
    return { ok: false, why: 'the case file has no "expect" there' }
  }
  const out: Reconciled = { value: null, blocked: [], replaced: [] }
  out.value = reconcile(written, resolvedExpect, actual, '', false, mode, out)
  if (out.blocked.length > 0) return { ok: false, why: blockedReason(out.blocked) }
  return { ok: true, value: out.value, replaced: out.replaced, previous: written }
}

/** Why --update does not help with a non-`expect` failure. */
function notRewrittenReason(failure: Failure): string {
  switch (failure.field) {
    case 'expectError':
      return '--update never rewrites "expectError"; edit it by hand (expected vs got is in the mismatch list)'
    case 'expectInputRequired':
      return '--update does not rewrite "expectInputRequired"; edit it by hand'
    case 'expectTask':
      return '--update does not rewrite "expectTask"; edit it by hand'
    case 'structuredContent':
      return 'the server violates its own outputSchema; --update cannot fix that (fix the server, or set "validateOutput": false)'
    default:
      if (failure.kind === 'budget')
        return 'a budget breach is not a golden; raise "budgetMs" or speed up the server'
      if (failure.kind === 'timeout')
        return 'the call timed out; --update only rewrites "expect" goldens'
      return 'the step failed before its "expect" could be compared; --update only rewrites "expect" goldens'
  }
}

function annotate(
  failure: Failure,
  planned: PlannedStep,
  stepIndex: number | undefined,
): Mismatch[] | undefined {
  if (!failure.mismatches) return undefined
  return failure.mismatches.map((m) => {
    const field = m.field ?? failure.field
    const pointer =
      field && field !== 'structuredContent'
        ? toPointer([...planned.source, field, ...matcherPathSegments(m.path)])
        : undefined
    return {
      ...m,
      ...(field ? { field } : {}),
      ...(pointer !== undefined ? { pointer } : {}),
      ...(stepIndex !== undefined ? { stepIndex } : {}),
    }
  })
}

/**
 * Run one case on a session: setup → steps → teardown, with interpolation, MRTR answers,
 * tasks, outputSchema enforcement, expectations, captures and budgets. Never throws.
 */
export async function executeCase(data: TestCase, ctx: ExecuteContext): Promise<CaseExecution> {
  const started = performance.now()
  const plan = planSteps(data)
  const multi = isMultiStep(data)
  const vars: Record<string, JsonValue> = { ...(ctx.vars ?? {}) }
  const scope = { vars, env: ctx.env }
  const observations: CaseExecution['observations'] = []
  const updates: ExpectationUpdate[] = []
  const warnings: string[] = []
  const steps: NonNullable<CaseOutcome['steps']> = []
  const mode = ctx.update ?? 'off'
  const hints = ctx.updateHint !== false
  let first: { failure: Failure; label: string; planned?: PlannedStep; index?: number } | undefined
  let updateSkipped: string | undefined
  let accepted: { expected?: JsonValue; actual?: JsonValue } | undefined
  let operationsMs = 0

  for (let i = 0; i < plan.length; i++) {
    const planned = plan[i]
    const ref = stepRefFor(planned, i)
    const label = stepLabel(planned, ref, plan)
    if (first && planned.phase !== 'teardown') {
      steps.push({ step: ref, durationMs: 0, status: 'skipped', reason: 'an earlier step failed' })
      continue
    }

    let step: Step
    try {
      step = interpolateStep(planned.step, scope, planned.at)
    } catch (err) {
      if (planned.phase === 'teardown' && err instanceof InterpolationError) {
        // A capture the teardown needs never happened (its step failed or was skipped).
        const reason = `skipped: {{${err.placeholder}}} was never captured (an earlier step failed or was skipped)`
        steps.push({ step: ref, durationMs: 0, status: 'skipped', reason })
        if (multi) {
          await ctx.onStepStart?.(ref)
          await ctx.onStepEnd?.(ref, { durationMs: 0, status: 'skipped', reason })
        }
        continue
      }
      step = planned.step
      if (multi) await ctx.onStepStart?.(ref)
      const failure: Failure = { kind: 'error', reason: errorText(err) }
      if (!planned.step.ignoreErrors && !first) first = { failure, label, planned, index: i }
      const status: CaseStatus = 'failed'
      const reason = planned.step.ignoreErrors
        ? `ignored (ignoreErrors): ${failure.reason}`
        : failure.reason
      steps.push({ step: ref, durationMs: 0, status, reason })
      if (multi) await ctx.onStepEnd?.(ref, { durationMs: 0, status, reason })
      continue
    }
    if (multi) await ctx.onStepStart?.(ref)

    let evaluation: StepEvaluation
    try {
      const normalize = effectiveNormalize(ctx.normalize, data.normalize, planned.step.normalize)
      evaluation = await evaluateStep(
        { ...step, validateOutput: planned.step.validateOutput ?? data.validateOutput },
        normalize,
        { ...ctx, timeoutMs: planned.step.timeoutMs ?? data.timeoutMs ?? ctx.timeoutMs },
      )
    } catch (err) {
      evaluation = {
        durationMs: 0,
        observed: null,
        warnings: [],
        failures: [{ kind: 'error', reason: `Step crashed: ${errorText(err)}` }],
      }
    }
    warnings.push(...evaluation.warnings)
    observations.push({ step: ref, observed: evaluation.observed, planned })

    // Golden mismatch: rewrite it (--update), or say whether --update would.
    let updated = false
    const golden = evaluation.failures.find((f) => f.golden)
    if (golden && step.expect !== undefined) {
      const rewrite = planRewrite(
        ctx,
        planned,
        step.expect,
        evaluation.normalized,
        mode === 'all' ? 'all' : 'failing',
      )
      if (mode !== 'off' && rewrite.ok && rewrite.value !== undefined) {
        updates.push({ source: [...planned.source, 'expect'], value: rewrite.value })
        accepted ??= { expected: rewrite.previous, actual: rewrite.value }
        if (rewrite.replaced?.length) {
          warnings.push(
            `Updated ${ctx.caseId ?? 'case'}${multi ? ` (${label})` : ''}: replaced ${rewrite.replaced.join(', ')} with literal values (--update=all).`,
          )
        }
        evaluation.failures = evaluation.failures.filter((f) => f !== golden)
        updated = true
      } else if (mode !== 'off') {
        golden.reason = `${golden.reason} Not rewritten by --update: ${rewrite.why}.`
        updateSkipped ??= rewrite.why
      } else if (hints) {
        golden.reason = rewrite.ok
          ? `${golden.reason} Use --update to accept the new output.`
          : `${golden.reason} --update would not rewrite it: ${rewrite.why}.`
      }
    }

    // Captures (only from a step that otherwise passed).
    if (evaluation.failures.length === 0 && planned.step.capture) {
      for (const [name, dotted] of Object.entries(planned.step.capture)) {
        const value = getPath(evaluation.captureSource, dotted)
        if (value === undefined) {
          const keys = isObject(evaluation.captureSource)
            ? Object.keys(evaluation.captureSource).join(', ')
            : 'none'
          evaluation.failures.push({
            kind: 'assertion',
            reason: `Capture failed at ${joinPath(planned.at || '(case)', `capture.${name}`)}: nothing at "${dotted}" in the result (top-level keys: ${keys || 'none'}). Fix the dotted path; "a.b[0].c" and "a.b.0.c" both work.`,
            actual: evaluation.captureSource,
          })
          break
        }
        vars[name] = value
      }
    }

    // Step budget.
    const stepBudget = multi ? planned.step.budgetMs : undefined
    if (
      evaluation.failures.length === 0 &&
      stepBudget !== undefined &&
      evaluation.durationMs > stepBudget
    ) {
      evaluation.failures.push({
        kind: 'budget',
        reason: `Budget exceeded at ${label}: took ${evaluation.durationMs}ms, budget ${stepBudget}ms. Raise "budgetMs", or make the server faster.`,
        budget: { budgetMs: stepBudget, actualMs: evaluation.durationMs },
      })
    }

    if (planned.phase !== 'teardown') operationsMs += evaluation.durationMs

    let status: CaseStatus = updated ? 'updated' : 'passed'
    let reason: string | undefined
    const failure = evaluation.failures[0]
    if (failure) {
      status = 'failed'
      if (planned.step.ignoreErrors) {
        // ignoreErrors: the step is recorded as failed, but never fails the case or stops a flow.
        reason = `ignored (ignoreErrors): ${failure.reason}`
        if (planned.phase !== 'teardown') {
          warnings.push(
            `${ctx.caseId ?? 'case'}${multi ? ` (${label})` : ''}: failure ignored because of "ignoreErrors": ${failure.reason}`,
          )
        }
      } else {
        reason = failure.reason
        if (!first) first = { failure, label, planned, index: i }
      }
    }
    steps.push({
      step: ref,
      durationMs: evaluation.durationMs,
      status,
      ...(reason ? { reason } : {}),
    })
    if (multi) {
      await ctx.onStepEnd?.(ref, {
        durationMs: evaluation.durationMs,
        status,
        ...(reason ? { reason } : {}),
      })
    }
  }

  // Case budget: time spent in server operations (setup + steps, not teardown).
  const caseBudget = data.budgetMs ?? ctx.budgetMs
  if (!first && caseBudget !== undefined && operationsMs > caseBudget) {
    first = {
      failure: {
        kind: 'budget',
        reason: `Budget exceeded: operations took ${operationsMs}ms, budget ${caseBudget}ms. Raise "budgetMs", or make the server faster.`,
        budget: { budgetMs: caseBudget, actualMs: operationsMs },
      },
      label: '',
    }
  }

  const durationMs = Math.round(performance.now() - started)
  const outcome: CaseOutcome = {
    status: first ? 'failed' : updates.length > 0 ? 'updated' : 'passed',
    durationMs,
  }
  if (first) {
    const f = first.failure
    outcome.reason = multi && first.label ? `${first.label}: ${f.reason}` : f.reason
    outcome.errorKind = f.kind
    const mismatches = first.planned
      ? annotate(f, first.planned, multi ? first.index : undefined)
      : f.mismatches
    if (mismatches) outcome.mismatches = mismatches
    if (f.expected !== undefined) outcome.expected = f.expected
    if (f.actual !== undefined) outcome.actual = f.actual
    if (f.budget) outcome.budget = f.budget
    if (mode !== 'off') {
      const why = f.golden ? updateSkipped : notRewrittenReason(f)
      if (why) outcome.updateSkipped = { reason: why }
    }
  } else if (accepted) {
    if (accepted.expected !== undefined) outcome.expected = accepted.expected
    if (accepted.actual !== undefined) outcome.actual = accepted.actual
  }
  if (multi) outcome.steps = steps
  return { outcome, observations, updates, warnings, vars }
}

/** The indent the file uses (`"  "`, `"    "`, `"\t"`), for rewrites that keep its format. */
export function detectIndent(text: string | undefined): string | number {
  const match = /^([ \t]+)["}\]]/m.exec(text ?? '')
  return match ? match[1] : 2
}

/** Write accepted goldens back into the case file (its own indent and EOL; key order kept). */
export function applyUpdates(loaded: LoadedCase, updates: ExpectationUpdate[]): void {
  if (!loaded.source || updates.length === 0) return
  const clone = structuredClone(loaded.source) as unknown as Record<string, unknown>
  for (const update of updates) setIn(clone, update.source, update.value)
  const eol = loaded.text?.includes('\r\n') ? '\r\n' : '\n'
  const json = JSON.stringify(clone, null, detectIndent(loaded.text)).replace(/\n/g, eol)
  fs.writeFileSync(loaded.path, `${json}${eol}`, 'utf8')
  loaded.source = clone as unknown as TestCase
  loaded.text = `${json}${eol}`
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/**
 * Trace file name (relative, no extension) for a case id: `cases/echo.basic.json#2` →
 * `cases/echo.basic.run2`. Cases outside rootDir (absolute ids) get a flat
 * `_external/<basename>-<hash>` name instead of mirroring the absolute path.
 */
export function traceName(caseId: string): string {
  const hash = caseId.lastIndexOf('#')
  const file = hash === -1 ? caseId : caseId.slice(0, hash)
  const run = hash === -1 ? undefined : caseId.slice(hash + 1)
  const suffix = run ? `.run${run}` : ''
  if (/^([A-Za-z]:)?[\\/]/.test(file)) {
    const base = (file.split(/[\\/]/).pop() ?? 'case')
      .replace(/\.jsonc?$/i, '')
      .replace(/[^\w.-]/g, '_')
    const digest = createHash('sha1').update(file).digest('hex').slice(0, 8)
    return `_external/${base || 'case'}-${digest}${suffix}`
  }
  const safe = file
    .replace(/\.jsonc?$/i, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => (segment === '..' ? '_up' : segment.replace(/[<>:"|?*\\#]/g, '_')))
    .join('/')
  return `${safe || 'case'}${suffix}`
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface CaseRun {
  loaded: LoadedCase
  ref: CaseRef
}

interface Worker {
  index: number
  server: string
  config: ServerConfig
  session?: McpSession
  startError?: Error
  trace?: TranscriptEntry[]
  vars: Record<string, JsonValue>
}

interface ServerState {
  tools?: Map<string, ToolSummary>
}

/** `session.stdoutNoise` when the session tracks it (feature-detected). */
function noiseOf(session: McpSession): { lines: number; sample: string[] } | undefined {
  const noise = (session as unknown as { stdoutNoise?: { lines?: unknown; sample?: unknown } })
    .stdoutNoise
  if (!noise || typeof noise.lines !== 'number') return undefined
  const sample = Array.isArray(noise.sample)
    ? noise.sample.filter((s): s is string => typeof s === 'string')
    : []
  return { lines: noise.lines, sample }
}

interface BaselineCase {
  failed: boolean
  durationMs: number
}

export class Runner {
  readonly options: RunnerOptions
  private reporter!: Reporter
  private ctx!: ReporterContext
  private rootDir = ''
  private readonly results: Array<{ ref: CaseRef; outcome: CaseOutcome }> = []
  private readonly checks: CheckOutcome[] = []
  private readonly manifests: ManifestResult[] = []
  private readonly warnings: string[] = []
  private readonly flakyIds = new Set<string>()
  /** Case ids that regressed against --baseline (set once the baseline was applied). */
  private readonly baselineFailures = new Set<string>()
  private baselineActive = false
  private stopped = false
  private fatal: Error | undefined
  /** Every session started per server (restarts included), for the stdout-noise report. */
  private readonly sessionsByServer = new Map<string, McpSession[]>()

  constructor(options: RunnerOptions) {
    this.options = options
  }

  /** Run and return the exit code (0 ok, 1 failures, 2 configuration error). */
  async run(): Promise<number> {
    return (await this.execute()).exitCode
  }

  async execute(): Promise<RunResult> {
    const opts = this.options
    this.rootDir = resolveRootDir(opts)
    this.ctx = {
      rootDir: this.rootDir,
      outDir: opts.outDir ?? 'reports',
      pretty: opts.pretty ?? true,
      stdout: opts.stdout ?? ((line) => console.log(line)),
      stderr: opts.stderr ?? ((line) => console.error(line)),
    }
    const reporters = [
      // `reporters: []` means none (e.g. `vib run --json` attaches its own); unset means console.
      ...createReporters(opts.reporters ?? ['console'], this.ctx),
      ...(opts.extraReporters ?? []),
    ]
    this.reporter = fanout(reporters)
    const startedAt = Date.now()
    try {
      return await this.runAll(startedAt)
    } finally {
      try {
        await this.reporter.close?.()
      } catch (err) {
        this.ctx.stderr(`vibrissa: ${errorText(err)}`)
      }
    }
  }

  private async emit(event: RunEvent): Promise<void> {
    if (event.type === 'warning') this.warnings.push(event.message)
    if (event.type === 'check') this.checks.push(event.outcome)
    if (event.type === 'case:end') this.results.push({ ref: event.case, outcome: event.outcome })
    try {
      await this.reporter.onEvent(event)
    } catch (err) {
      this.ctx.stderr(`vibrissa: ${errorText(err)}`)
    }
  }

  private async warn(message: string): Promise<void> {
    if (this.warnings.includes(message)) return
    await this.emit({ type: 'warning', message })
  }

  private async runAll(startedAt: number): Promise<RunResult> {
    const opts = this.options
    const loaded = await loadCases({
      rootDir: this.rootDir,
      globs: opts.globs,
      defaultServer: opts.defaultServer,
      servers: Object.keys(opts.servers),
      hooks: opts.hooks,
      env: opts.env,
      manifest: opts.manifest,
      tags: opts.tags,
      excludeTags: opts.excludeTags,
      grep: opts.grep,
      shard: opts.shard,
    })

    let repeat = Math.max(1, Math.floor(opts.repeat ?? 1))
    const updateMode = opts.update || opts.updateAll
    const repeatIgnored = updateMode && repeat > 1
    if (repeatIgnored) repeat = 1
    const runs: CaseRun[] = []
    for (let r = 1; r <= repeat; r++) {
      for (const c of loaded.cases) {
        runs.push({ loaded: c, ref: repeat > 1 ? { ...c.ref, id: `${c.ref.id}#${r}` } : c.ref })
      }
    }
    for (const c of loaded.cases) if (c.ref.flaky) this.flakyIds.add(c.ref.id)

    const servers = this.orderServers(loaded.cases.map((c) => c.ref.server))
    await this.emit({
      type: 'run:start',
      totalCases: runs.length,
      servers,
      startedAt,
      ...(repeat > 1 ? { repeat } : {}),
      ...(opts.shard && opts.shard.total > 1
        ? { shard: { index: opts.shard.index, total: opts.shard.total } }
        : {}),
    })
    for (const warning of loaded.warnings) await this.warn(warning)
    if (loaded.fragments?.length) {
      const shown = loaded.fragments.slice(0, 5).join(', ')
      const more = loaded.fragments.length > 5 ? `, +${loaded.fragments.length - 5} more` : ''
      ;(opts.info ?? this.ctx.stdout)(
        `info: skipped ${loaded.fragments.length} $ref fragment file(s) matched by the case globs (not cases): ${shown}${more}`,
      )
    }

    if (repeatIgnored) {
      await this.warn('--update ignores --repeat: each case runs once while goldens are rewritten.')
    }

    if (loaded.cases.length === 0) {
      const filters = [
        opts.tags?.length ? `--tag ${opts.tags.join(',')}` : '',
        opts.excludeTags?.length ? `--exclude-tag ${opts.excludeTags.join(',')}` : '',
        opts.grep ? `--grep ${opts.grep}` : '',
        opts.shard ? `--shard ${opts.shard.index}/${opts.shard.total}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      const message =
        loaded.matched === 0
          ? `No test cases matched globs: ${opts.globs.join(', ')} (from ${this.rootDir}). Check "globs" in vibrissa.json or pass --cases <glob>.`
          : `No test cases left after filters (${filters}): ${loaded.matched} case file(s) matched the globs. Check the tag / grep spelling, or loosen the filters (--allow-empty accepts an empty selection).`
      // Said once: an error (stderr, exit 1) when it fails the run, a warning under allowEmpty.
      if (opts.allowEmpty) await this.warn(message)
      else this.ctx.stderr(`error: ${message}`)
      return this.finish(startedAt, opts.allowEmpty, repeat)
    }

    for (const server of servers) {
      if (this.stopped) break
      await this.runServer(
        server,
        runs.filter((run) => run.ref.server === server),
      )
    }

    if (opts.baseline) await this.applyBaseline(opts.baseline)
    return this.finish(startedAt, undefined, repeat)
  }

  private orderServers(names: string[]): string[] {
    const unique = [...new Set(names)]
    const preferred = this.options.defaultServer
    return unique.sort((a, b) =>
      a === preferred ? -1 : b === preferred ? 1 : a < b ? -1 : a > b ? 1 : 0,
    )
  }

  // -------------------------------------------------------------------------
  // Per server
  // -------------------------------------------------------------------------

  private async startWorker(worker: Worker): Promise<void> {
    worker.session = undefined
    worker.startError = undefined
    try {
      worker.session = await McpSession.start(worker.config, {
        timeoutMs: this.options.timeoutMs,
        stderr: this.options.serverStderr ?? 'capture',
        transcript: (entry) => {
          worker.trace?.push(entry)
        },
      })
      const started = this.sessionsByServer.get(worker.server) ?? []
      started.push(worker.session)
      this.sessionsByServer.set(worker.server, started)
    } catch (err) {
      worker.startError = err instanceof Error ? err : new Error(String(err))
      if (err instanceof SessionStartError && err.code === 'config') this.fatal ??= err
    }
  }

  private async runServer(server: string, runs: CaseRun[]): Promise<void> {
    const opts = this.options
    const runnable = runs.filter((run) => !run.loaded.error && !run.loaded.skip)
    const queue = [...runs]
    if (runnable.length === 0) {
      while (queue.length > 0 && !this.stopped) await this.runImmediate(queue.shift() as CaseRun)
      return
    }

    const config = resolveServerConfig(opts, server)
    const count = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1), runnable.length))
    const workers: Worker[] = Array.from({ length: count }, (_, index) => ({
      index,
      server,
      config,
      vars: {},
    }))
    await Promise.all(workers.map((w) => this.startWorker(w)))
    const healthy = workers.filter((w) => w.session)
    const state: ServerState = {}

    if (healthy.length === 0) {
      const error = workers[0].startError ?? new Error(`Server "${server}" could not start.`)
      await this.warn(`Server "${server}" could not start: ${error.message}`)
      while (queue.length > 0 && !this.stopped) {
        await this.runImmediate(queue.shift() as CaseRun, error.message)
      }
      return
    }

    const control = healthy[0].session as McpSession
    try {
      const info = await control.discover()
      await this.emit({
        type: 'session:start',
        server,
        era: control.era,
        protocolVersion: control.protocolVersion || info.protocolVersion,
        ...(info.serverInfo
          ? {
              serverInfo: {
                ...(typeof info.serverInfo.name === 'string' ? { name: info.serverInfo.name } : {}),
                ...(typeof info.serverInfo.version === 'string'
                  ? { version: info.serverInfo.version }
                  : {}),
              },
            }
          : {}),
      })
    } catch (err) {
      await this.emit({
        type: 'session:start',
        server,
        era: control.era,
        protocolVersion: control.protocolVersion,
      })
      await this.warn(`server/discover failed on "${server}": ${errorText(err)}`)
    }

    const captured = await this.verifyManifest(server, control)
    if (opts.check) await this.runServerChecks(server, control, captured)
    state.tools = await this.toolDefinitions(server, control, captured)

    // Suite setup per worker.
    for (const worker of healthy) await this.suiteSetup(worker, state)

    await Promise.all(workers.map((worker) => this.workerLoop(worker, queue, state)))

    for (const worker of workers) {
      if (worker.session && !worker.session.closed) await this.suiteTeardown(worker, state)
      await worker.session?.close()
    }
    await this.warnStdoutNoise(server)
    await this.emit({ type: 'session:end', server })
  }

  /** stdio servers must keep stdout for JSON-RPC: report stray lines (even without --check). */
  private async warnStdoutNoise(server: string): Promise<void> {
    let lines = 0
    const sample: string[] = []
    for (const session of this.sessionsByServer.get(server) ?? []) {
      const noise = noiseOf(session)
      if (!noise) continue
      lines += noise.lines
      sample.push(...noise.sample)
    }
    if (lines === 0) return
    const shown = sample
      .slice(0, 2)
      .map((s) => JSON.stringify(s.length > 80 ? `${s.slice(0, 79)}…` : s))
      .join(', ')
    await this.warn(
      `Server "${server}" wrote ${lines} non-JSON-RPC line(s) to stdout${shown ? ` (e.g. ${shown})` : ''}. On stdio, stdout must carry only JSON-RPC: log to stderr instead (vib check: spec/stdout-clean).`,
    )
  }

  private async toolDefinitions(
    server: string,
    session: McpSession,
    captured: CapturedManifest | undefined,
  ): Promise<Map<string, ToolSummary>> {
    try {
      const tools = captured?.toolsListSamples[0] ?? (await session.listTools())
      return new Map(tools.map((tool) => [tool.name, tool]))
    } catch (err) {
      await this.warn(
        `tools/list failed on "${server}" (${errorText(err)}): outputSchema enforcement is off for this run.`,
      )
      return new Map()
    }
  }

  private async suiteSetup(worker: Worker, state: ServerState): Promise<void> {
    const setup = this.options.hooks?.setup
    if (!setup?.length || !worker.session) return
    const execution = await executeCase(
      { name: 'suite setup', steps: setup },
      this.executeContext(worker, state, 'off'),
    )
    for (const warning of execution.warnings) await this.warn(warning)
    if (execution.outcome.status === 'failed') {
      worker.startError = new Error(`Suite setup failed: ${execution.outcome.reason}`)
      await worker.session.close()
      worker.session = undefined
      await this.warn(`hooks.setup failed on "${worker.server}": ${execution.outcome.reason}`)
      return
    }
    worker.vars = execution.vars
  }

  private async suiteTeardown(worker: Worker, state: ServerState): Promise<void> {
    const teardown = this.options.hooks?.teardown
    if (!teardown?.length || !worker.session) return
    const execution = await executeCase(
      { name: 'suite teardown', steps: teardown },
      this.executeContext(worker, state, 'off'),
    )
    if (execution.outcome.status === 'failed') {
      await this.warn(`hooks.teardown failed on "${worker.server}": ${execution.outcome.reason}`)
    }
  }

  private executeContext(
    worker: Worker,
    state: ServerState,
    update: ExecuteContext['update'],
    loaded?: LoadedCase,
    ref?: CaseRef,
  ): ExecuteContext {
    const opts = this.options
    return {
      session: worker.session as McpSession,
      normalize: opts.normalize ?? DEFAULT_NORMALIZE,
      timeoutMs: opts.timeoutMs,
      budgetMs: opts.budgetMs,
      tools: state.tools,
      vars: worker.vars,
      env: opts.env,
      update,
      source: loaded?.source,
      caseId: ref ? baseCaseId(ref.id) : undefined,
      ...(ref
        ? {
            onStepStart: (step: StepRef) => this.emit({ type: 'step:start', case: ref, step }),
            onStepEnd: (step: StepRef, result) =>
              this.emit({ type: 'step:end', case: ref, step, ...result }),
          }
        : {}),
    }
  }

  private async workerLoop(worker: Worker, queue: CaseRun[], state: ServerState): Promise<void> {
    while (!this.stopped) {
      const run = queue.shift()
      if (!run) return
      if (run.loaded.error || run.loaded.skip) {
        await this.runImmediate(run)
        continue
      }
      if (!worker.session || worker.session.closed) {
        if (worker.session) await worker.session.close()
        await this.startWorker(worker)
        if (worker.session) await this.suiteSetup(worker, state)
      }
      if (!worker.session) {
        await this.runImmediate(
          run,
          `Server "${worker.server}" is not running: ${worker.startError?.message ?? 'unknown error'}`,
        )
        continue
      }
      await this.runCase(worker, run, state)
    }
  }

  /** Emit a case that needs no session: load errors, skips, or a dead server. */
  private async runImmediate(run: CaseRun, serverError?: string): Promise<void> {
    await this.emit({ type: 'case:start', case: run.ref })
    let outcome: CaseOutcome
    if (run.loaded.error) {
      outcome = {
        status: 'failed',
        durationMs: 0,
        errorKind: 'load',
        reason: run.loaded.error,
        ...(this.options.update || this.options.updateAll
          ? { updateSkipped: { reason: 'the case did not load; fix the file first' } }
          : {}),
      }
    } else if (run.loaded.skip) {
      outcome = { status: 'skipped', durationMs: 0, reason: run.loaded.skip }
    } else {
      outcome = {
        status: 'failed',
        durationMs: 0,
        errorKind: 'error',
        reason: serverError ?? 'Server unavailable.',
      }
    }
    await this.emit({ type: 'case:end', case: run.ref, outcome })
    if (outcome.status === 'failed' && this.options.failFast) this.stopped = true
  }

  private async runCase(worker: Worker, run: CaseRun, state: ServerState): Promise<void> {
    const opts = this.options
    const { loaded, ref } = run
    await this.emit({ type: 'case:start', case: ref })
    const update: ExecuteContext['update'] =
      opts.update || opts.updateAll ? (opts.updateAll ? 'all' : 'failing') : 'off'
    const cannotRewrite =
      loaded.text !== undefined && caseFileHasComments(loaded.text)
        ? 'the file has comments that a rewrite would drop; edit it by hand'
        : undefined
    worker.trace = []
    const execution = await executeCase(loaded.data as TestCase, {
      ...this.executeContext(worker, state, update, loaded, ref),
      ...(cannotRewrite ? { cannotRewrite } : {}),
    })
    if (update !== 'off' && execution.outcome.updateSkipped) {
      await this.warn(`Not updating ${loaded.ref.id}: ${execution.outcome.updateSkipped.reason}.`)
    }
    const trace = worker.trace
    worker.trace = undefined
    for (const warning of execution.warnings) await this.warn(warning)

    const outcome = execution.outcome
    if (execution.updates.length > 0) {
      try {
        applyUpdates(loaded, execution.updates)
      } catch (err) {
        outcome.status = 'failed'
        outcome.errorKind = 'error'
        outcome.reason = `Could not write the updated golden to ${loaded.ref.id}: ${errorText(err)}.`
      }
    }
    if (opts.trace || outcome.status === 'failed') {
      Object.assign(outcome, this.writeTrace(ref, trace ?? []))
    }
    await this.emit({ type: 'case:end', case: ref, outcome })
    if (outcome.status === 'failed' && opts.failFast) this.stopped = true
  }

  private writeTrace(
    ref: CaseRef,
    entries: TranscriptEntry[],
  ): { tracePath?: string; stderrPath?: string } {
    const base = path.join(
      resolveOutDir(this.rootDir, this.ctx.outDir),
      'traces',
      traceName(ref.id),
    )
    const out: { tracePath?: string; stderrPath?: string } = {}
    try {
      fs.mkdirSync(path.dirname(base), { recursive: true })
      const messages = entries.filter((e) => e.dir !== 'stderr')
      const tracePath = `${base}.ndjson`
      fs.writeFileSync(
        tracePath,
        messages.map((e) => JSON.stringify(e)).join('\n') + (messages.length ? '\n' : ''),
        'utf8',
      )
      out.tracePath = tracePath
      const stderr = entries
        .filter((e) => e.dir === 'stderr')
        .map((e) => e.text ?? '')
        .join('')
      const stderrPath = `${base}.stderr.txt`
      if (stderr) {
        fs.writeFileSync(stderrPath, stderr, 'utf8')
        out.stderrPath = stderrPath
      } else if (fs.existsSync(stderrPath)) {
        fs.rmSync(stderrPath)
      }
    } catch (err) {
      void this.warn(`Could not write the trace for ${ref.id}: ${errorText(err)}`)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Manifest lock & checks
  // -------------------------------------------------------------------------

  private async verifyManifest(
    server: string,
    session: McpSession,
  ): Promise<CapturedManifest | undefined> {
    const opts = this.options
    const lock = opts.lockManifest !== false
    const file = manifestPathFor({ ...opts, rootDir: this.rootDir }, server)
    const exists = lock && fs.existsSync(file)
    if (!exists && !opts.check && !(lock && opts.updateManifest)) {
      if (lock) await this.missingLock(server, file)
      return undefined
    }

    let captured: CapturedManifest
    try {
      captured = await captureManifest(session, { toolsListSamples: opts.check ? 2 : 1 })
    } catch (err) {
      if (exists) {
        this.manifests.push({ server, path: file, status: 'error', summary: errorText(err) })
        await this.emit({
          type: 'manifest:diff',
          path: file,
          server,
          summary: `could not build the live manifest: ${errorText(err)}`,
          diff: { error: errorText(err) },
        })
      } else {
        await this.warn(`Could not build the live manifest for "${server}": ${errorText(err)}`)
      }
      return undefined
    }
    if (!lock) return captured

    if (!exists) {
      if (opts.updateManifest) {
        writeManifest(file, captured.manifest)
        this.manifests.push({ server, path: file, status: 'created' })
        await this.warn(
          `Manifest lock created at ${path.relative(this.rootDir, file).replace(/\\/g, '/')}. Commit it.`,
        )
        await this.emit({ type: 'manifest:ok', path: file, server })
      } else {
        await this.missingLock(server, file)
      }
      return captured
    }

    let diff: ManifestDiff
    try {
      diff = diffManifest(readManifest(file), captured.manifest, {
        ignore: opts.manifestIgnore ?? DEFAULT_MANIFEST_IGNORE,
      })
    } catch (err) {
      this.manifests.push({ server, path: file, status: 'error', summary: errorText(err) })
      await this.emit({
        type: 'manifest:diff',
        path: file,
        server,
        summary: errorText(err),
        diff: { error: errorText(err) },
      })
      return captured
    }
    if (diff.identical) {
      this.manifests.push({ server, path: file, status: 'ok', diff })
      await this.emit({ type: 'manifest:ok', path: file, server })
    } else if (opts.updateManifest) {
      writeManifest(file, captured.manifest)
      const summary = summarizeDiff(diff)
      this.manifests.push({ server, path: file, status: 'updated', diff, summary })
      await this.warn(
        `Manifest lock updated at ${path.relative(this.rootDir, file).replace(/\\/g, '/')}: ${summary}. Review and commit it.`,
      )
      await this.emit({ type: 'manifest:ok', path: file, server })
    } else {
      const summary = summarizeDiff(diff)
      this.manifests.push({ server, path: file, status: 'diff', diff, summary })
      // First line: the one-liner; then the rendered drift; then what to do about it.
      const body = formatDiff(diff).split('\n').slice(1)
      const record = `vib manifest record${this.serverFlag(server)}`
      await this.emit({
        type: 'manifest:diff',
        path: file,
        server,
        summary: [
          summary,
          ...body,
          `Review the change, then accept it with --update-manifest (or "${record}").`,
        ].join('\n'),
        diff: diff as unknown as JsonValue,
      })
    }
    return captured
  }

  /** ` --server <name>` for non-default servers (CLI hints). */
  private serverFlag(server: string): string {
    return server === this.options.defaultServer ? '' : ` --server ${server}`
  }

  private async missingLock(server: string, file: string): Promise<void> {
    const opts = this.options
    const shown = path.relative(this.rootDir, file).replace(/\\/g, '/') || file
    const record = `vib manifest record${this.serverFlag(server)}`
    const who = server === opts.defaultServer ? '' : ` for server "${server}"`
    if (opts.requireManifest) {
      const summary = `No manifest lock at ${shown}${who}, and requireManifest is on. Record it with "${record}" (or vib run --update-manifest), review it, and commit it.`
      this.manifests.push({ server, path: file, status: 'missing-required', summary })
      await this.emit({
        type: 'manifest:diff',
        path: file,
        server,
        summary,
        diff: { error: 'missing', errorKind: 'load', path: shown },
      })
      return
    }
    this.manifests.push({ server, path: file, status: 'missing' })
    await this.warn(
      `No manifest lock at ${shown}${who}. Run "${record}" (or vib run --update-manifest) to pin tools, schemas and descriptions; vib run then fails on drift.`,
    )
  }

  private async runServerChecks(
    server: string,
    session: McpSession,
    captured: CapturedManifest | undefined,
  ): Promise<void> {
    let data = captured
    if (!data) {
      try {
        data = await captureManifest(session, { toolsListSamples: 2 })
      } catch (err) {
        await this.emit({
          type: 'check',
          outcome: {
            id: 'spec/manifest',
            server,
            title: 'Server manifest can be listed',
            status: 'failed',
            detail: errorText(err),
          },
        })
        return
      }
    }
    const config = resolveServerConfig(this.options, server)
    const noise = noiseOf(session)
    const outcomes = runChecks(
      {
        ...data.manifest,
        transport: isHttpServerConfig(config) ? 'http' : 'stdio',
        ...(noise ? { stdoutNoise: noise } : {}),
      },
      {
        toolsListSamples: data.toolsListSamples,
        allow: this.options.checks?.allow,
        severity: this.options.checks?.severity,
      },
    )
    for (const outcome of outcomes) {
      await this.emit({ type: 'check', outcome: { ...outcome, server } })
    }
  }

  // -------------------------------------------------------------------------
  // Baseline (delta gating)
  // -------------------------------------------------------------------------

  private async applyBaseline(file: string): Promise<void> {
    const abs = path.isAbsolute(file) ? file : path.resolve(this.rootDir, file)
    let report: JsonReport
    try {
      report = JSON.parse(fs.readFileSync(abs, 'utf8')) as JsonReport
      if (!Array.isArray(report.cases)) throw new Error('no "cases" array')
    } catch (err) {
      await this.warn(
        `Baseline not usable at ${file}: ${errorText(err)}. Gating on absolute results instead; write one with --reporter json (reports/results.json).`,
      )
      return
    }
    const before = new Map<string, BaselineCase>()
    const runs = new Map<string, { failed: number; total: number; ms: number }>()
    for (const c of report.cases) {
      if (c.status === 'skipped') continue
      const id = c.caseId ?? baseCaseId(c.id)
      const entry = runs.get(id) ?? { failed: 0, total: 0, ms: 0 }
      entry.total++
      entry.ms += c.durationMs ?? 0
      if (c.status === 'failed') entry.failed++
      runs.set(id, entry)
    }
    for (const [id, entry] of runs) {
      before.set(id, { failed: entry.failed > 0, durationMs: entry.ms / entry.total })
    }

    const pct = this.options.baselineLatencyPct ?? DEFAULT_BASELINE_LATENCY_PCT
    const floor = this.options.baselineLatencyMinMs ?? DEFAULT_BASELINE_LATENCY_MIN_MS
    const verdicts = this.caseVerdicts()
    const regressions: string[] = []
    const known: string[] = []
    for (const [id, verdict] of verdicts) {
      const prior = before.get(id)
      if (!verdict.ok) {
        if (prior?.failed) known.push(id)
        else {
          regressions.push(`${id}: newly failing${prior ? '' : ' (not in the baseline)'}`)
          this.baselineFailures.add(id)
        }
        continue
      }
      if (prior && !prior.failed && prior.durationMs > 0) {
        const limit = prior.durationMs * (1 + pct / 100)
        if (verdict.durationMs > limit && verdict.durationMs - prior.durationMs >= floor) {
          regressions.push(
            `${id}: slower, ${Math.round(verdict.durationMs)}ms vs ${Math.round(prior.durationMs)}ms in the baseline (+${Math.round((verdict.durationMs / prior.durationMs - 1) * 100)}%, limit +${pct}%)`,
          )
          this.baselineFailures.add(id)
        }
      }
    }
    this.baselineActive = true
    if (known.length > 0) {
      await this.warn(
        `Baseline: ${known.length} case(s) still failing, as in ${file} (not gated): ${known.slice(0, 5).join(', ')}${known.length > 5 ? ', ...' : ''}`,
      )
    }
    await this.emit({
      type: 'check',
      outcome: {
        id: 'baseline/regressions',
        title:
          regressions.length > 0
            ? `Baseline: ${regressions.length} regression(s) vs ${file}`
            : `Baseline: no regressions vs ${file}`,
        status: regressions.length > 0 ? 'failed' : 'passed',
        ...(regressions.length > 0 ? { detail: regressions.join('\n') } : {}),
      },
    })
  }

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------

  private caseVerdicts(): Map<string, { ok: boolean; rate: number; durationMs: number }> {
    const floor = this.options.flakyFloor ?? DEFAULT_FLAKY_FLOOR
    const groups = new Map<string, { runs: number; passes: number; ms: number }>()
    for (const { ref, outcome } of this.results) {
      if (outcome.status === 'skipped') continue
      const id = baseCaseId(ref.id)
      const entry = groups.get(id) ?? { runs: 0, passes: 0, ms: 0 }
      entry.runs++
      entry.ms += outcome.durationMs
      if (outcome.status === 'passed' || outcome.status === 'updated') entry.passes++
      groups.set(id, entry)
    }
    const out = new Map<string, { ok: boolean; rate: number; durationMs: number }>()
    for (const [id, entry] of groups) {
      const rate = entry.passes / entry.runs
      const ok = rate === 1 || (this.flakyIds.has(id) && rate >= floor)
      out.set(id, { ok, rate, durationMs: entry.ms / entry.runs })
    }
    return out
  }

  private async finish(
    startedAt: number,
    forcedOk: boolean | undefined,
    repeat: number,
  ): Promise<RunResult> {
    const verdicts = this.caseVerdicts()
    // Per execution: with --repeat the status counts sum to `runs` (= total); the per-case
    // verdict (flaky floors) lives in passRates and run:end.ok. Reporters derive the number
    // of distinct cases from the case ids.
    const counts: Record<CaseStatus, number> = { passed: 0, failed: 0, skipped: 0, updated: 0 }
    for (const { outcome } of this.results) counts[outcome.status]++
    const summary: RunSummary = {
      total: this.results.length,
      ...counts,
      durationMs: Date.now() - startedAt,
    }
    if (repeat > 1) {
      summary.runs = this.results.length
      summary.passRates = Object.fromEntries(
        [...verdicts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, v]) => [id, v.rate]),
      )
    }
    let ok: boolean
    if (forcedOk !== undefined) ok = forcedOk
    else {
      const casesOk = this.baselineActive
        ? this.baselineFailures.size === 0
        : [...verdicts.values()].every((v) => v.ok)
      const checksOk = this.checks.every((c) => c.status !== 'failed')
      const manifestsOk = this.manifests.every(
        (m) => m.status !== 'diff' && m.status !== 'error' && m.status !== 'missing-required',
      )
      ok = casesOk && checksOk && manifestsOk && !this.fatal
    }
    await this.emit({ type: 'run:end', summary, ok })
    return {
      exitCode: this.fatal ? 2 : ok ? 0 : 1,
      ok,
      summary,
      cases: [...this.results],
      checks: [...this.checks],
      manifests: [...this.manifests],
      warnings: [...this.warnings],
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/** v1-compatible partial options: `server` (singular) is sugar for `servers.default`. */
export type RunCasesInput = Partial<RunnerOptions> & { server?: ServerConfig }

/** Fill defaults (and map v1 `server` → `servers.default`). */
export function resolveRunnerOptions(input: RunCasesInput = {}): RunnerOptions {
  const { server, ...rest } = input
  const servers = rest.servers ?? (server ? { default: server } : defaultRunOptions.servers)
  const defaultServer =
    rest.defaultServer ?? (server || !rest.servers ? 'default' : Object.keys(servers)[0])
  return {
    ...defaultRunOptions,
    ...rest,
    servers,
    defaultServer,
    normalize: { ...DEFAULT_NORMALIZE, ...(rest.normalize ?? {}) },
    globs: rest.globs ?? defaultRunOptions.globs,
    reporters: rest.reporters ?? defaultRunOptions.reporters,
    rootDir: rest.rootDir ?? process.cwd(),
  }
}

/** Run cases and resolve to the exit code (0 ok, 1 failures, 2 configuration error). */
export async function runCases(options: RunCasesInput = {}): Promise<number> {
  return new Runner(resolveRunnerOptions(options)).run()
}
