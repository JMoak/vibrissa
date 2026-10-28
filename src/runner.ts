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
  manifestPathFor,
  readManifest,
  summarizeDiff,
  writeManifest,
} from './manifest.js'
import { escapeDirectives, matchValue } from './match.js'
import { normalizeResult } from './normalize.js'
import { resolveRootDir, resolveServerConfig } from './paths.js'
import { createReporters, fanout } from './reporters/index.js'
import type { JsonReport } from './reporters/json.js'
import { baseCaseId, resolveOutDir } from './reporters/shared.js'
import { validate } from './schema.js'
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
  status: 'ok' | 'diff' | 'missing' | 'updated' | 'created' | 'error'
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
  return `${base}.${relative}`
}

function summarizeMismatches(label: string, mismatches: Mismatch[]): string {
  const first = mismatches[0]
  const more = mismatches.length > 1 ? ` (+${mismatches.length - 1} more)` : ''
  return `${label} at ${first.path}: ${first.message}${more}`
}

function hasDirective(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDirective)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, child]) => key.startsWith('$') || hasDirective(child))
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{')
  if (Array.isArray(value)) return value.some(hasPlaceholder)
  if (isObject(value)) return Object.values(value).some(hasPlaceholder)
  return false
}

function getIn(root: unknown, source: Array<string | number>): unknown {
  let node = root as Record<string | number, unknown> | undefined
  for (const key of source) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined
    node = node[key] as Record<string | number, unknown> | undefined
  }
  return node
}

// ---------------------------------------------------------------------------
// expectInputRequired views
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

function describeRequests(requests: JsonValue): { text: string; method?: string } {
  if (!isObject(requests)) return { text: short(requests) }
  const parts: string[] = []
  let method: string | undefined
  for (const [key, entry] of Object.entries(requests)) {
    const m = isObject(entry) && typeof entry.method === 'string' ? entry.method : key
    method ??= m
    const params = isObject(entry) && isObject(entry.params) ? entry.params : undefined
    const message = typeof params?.message === 'string' ? ` ${JSON.stringify(params.message)}` : ''
    parts.push(`${m}${message}`)
  }
  return { text: parts.join(', ') || 'input', method }
}

function exampleAnswer(method: string | undefined): string {
  switch (method) {
    case 'sampling/createMessage':
      return '{ "role": "assistant", "content": { "type": "text", "text": "..." }, "model": "scripted" }'
    case 'roots/list':
      return '{ "roots": [] }'
    default:
      return '{ "action": "accept", "content": { ... } }'
  }
}

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
  /** Tool definitions by name: outputSchema enforcement and args pre-validation. */
  tools?: Map<string, ToolSummary>
  /** Values visible to `{{name}}` before the case captures anything (suite setup). */
  vars?: Record<string, JsonValue>
  env?: Record<string, string | undefined>
  /** `failing` (= --update) rewrites plain goldens; `all` also rewrites matcher goldens. */
  update?: 'off' | 'failing' | 'all'
  /** Case as written in its file (no `$ref` expansion): decides what --update may rewrite. */
  source?: TestCase
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
  observations: Array<{ step: StepRef; observed: JsonValue }>
  /** Goldens accepted under --update (the caller writes them). */
  updates: ExpectationUpdate[]
  warnings: string[]
  /** Final `{{name}}` scope (suite setup uses this). */
  vars: Record<string, JsonValue>
}

type FailureKind = NonNullable<CaseOutcome['errorKind']>

interface Failure {
  kind: FailureKind
  reason: string
  mismatches?: Mismatch[]
  expected?: JsonValue
  actual?: JsonValue
  budget?: { budgetMs: number; actualMs: number }
  /** A plain `expect` mismatch (eligible for --update). */
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

function callFailedReason(what: string, error: ToolError): string {
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
    code !== undefined
      ? `Add "expectError": { "code": ${JSON.stringify(code)} } if this error is the expected behavior.`
      : 'Add "expectError" if this error is the expected behavior.'
  return `Call failed at ${what}: ${label}${error.message}. ${hint}`
}

function checkOutputSchema(
  tool: ToolSummary | undefined,
  raw: JsonValue,
  what: string,
  warnings: string[],
): Failure | undefined {
  if (!tool || tool.outputSchema === undefined || !isObject(raw) || raw.isError === true) {
    return undefined
  }
  const structured = raw.structuredContent
  if (structured === undefined) {
    return {
      kind: 'assertion',
      reason: `Output schema violation at ${what}: structuredContent is missing, but the tool declares an outputSchema. Fix the server, or set "validateOutput": false.`,
      mismatches: [
        {
          path: 'structuredContent',
          message: 'missing (the tool declares an outputSchema, so results must include it)',
        },
      ],
    }
  }
  const result = validate(tool.outputSchema, structured)
  if (result.schemaError !== undefined) {
    warnings.push(
      `outputSchema of tool "${tool.name}" could not be compiled (${result.schemaError}); structuredContent was not validated. Run "vib check" for details.`,
    )
    return undefined
  }
  if (result.ok) return undefined
  const mismatches: Mismatch[] = result.errors.map((issue) => ({
    path: joinPath('structuredContent', issue.path),
    message: `does not match the tool's outputSchema: ${issue.message}`,
    actual: (getPath(structured, issue.path) ?? null) as unknown,
  }))
  return {
    kind: 'assertion',
    reason: `${summarizeMismatches('Output schema violation', mismatches)}. The outputSchema of ${what} rejects its own structuredContent; fix the server, or set "validateOutput": false.`,
    mismatches,
    actual: structured,
  }
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
      const { text, method } = describeRequests(outcome.requests)
      failures.push({
        kind: 'error',
        reason: `Unanswered input request at ${what}: the server asked for ${text}. Add "respond": { "${method ?? 'elicitation/create'}": ${exampleAnswer(method)} } to the step, or assert only the request with "expectInputRequired".`,
        actual: norm(outcome.requests),
      })
    }
  }

  if (step.expectInputRequired !== undefined) {
    if (rounds.length === 0) {
      failures.push({
        kind: 'assertion',
        reason: `Expected an input request at ${what}, but the server answered without asking (no input_required round). Remove "expectInputRequired", or check the server.`,
        expected: step.expectInputRequired,
      })
    } else {
      const view = norm(inputRequestView(step.expectInputRequired, rounds))
      const mismatches = matchValue(step.expectInputRequired, view)
      if (mismatches.length > 0) {
        failures.push({
          kind: 'assertion',
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
        reason: `Expected a task at ${what}, but the server answered directly (tasks need a 2026-07-28 connection and a server that supports the tasks extension).`,
        expected: step.expectTask,
      })
    } else {
      const task = norm(outcome.task)
      const mismatches = matchValue(step.expectTask, task)
      if (mismatches.length > 0) {
        failures.push({
          kind: 'assertion',
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
          reason: `Error code mismatch at ${what}: expected ${JSON.stringify(expected.code)}, got ${got}. Message: ${error.message}`,
          mismatches: [
            { path: 'code', message: `expected ${JSON.stringify(expected.code)}, got ${got}` },
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
          golden: true,
          reason: `${summarizeMismatches('Expectation failed', mismatches)}. Use --update to accept the new output.`,
          mismatches,
          expected: step.expect,
          actual: normalized,
        })
      }
    } else {
      failures.push({
        kind: error.kind === 'timeout' ? 'timeout' : 'error',
        reason: callFailedReason(what, error),
        actual: view,
      })
    }
  } else if (outcome.kind === 'result') {
    normalized = norm(outcome.result)
    observed = normalized
    captureSource = normalized
    if (step.expectError !== undefined) {
      failures.push({
        kind: 'assertion',
        reason: `Expected an error at ${what}, but the call succeeded. Remove "expectError", or fix the server.`,
        expected: step.expectError as unknown as JsonValue,
        actual: normalized,
      })
    } else {
      const raw = outcome.result
      const isTaskHandle = isObject(raw) && raw.resultType === 'task'
      if (kind === 'tool' && step.validateOutput !== false && !isTaskHandle) {
        const schemaFailure = checkOutputSchema(tool, raw, what, warnings)
        if (schemaFailure) failures.push(schemaFailure)
      }
      if (step.expect !== undefined) {
        const mismatches = matchValue(step.expect, normalized)
        if (mismatches.length > 0) {
          failures.push({
            kind: 'assertion',
            golden: true,
            reason: `${summarizeMismatches('Expectation failed', mismatches)}. Use --update to accept the new output.`,
            mismatches,
            expected: step.expect,
            actual: normalized,
          })
        }
      }
    }
  }

  return {
    durationMs: outcome.durationMs,
    failures,
    observed,
    captureSource,
    normalized,
    warnings,
  }
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

function updatable(
  ctx: ExecuteContext,
  planned: PlannedStep,
): { ok: true } | { ok: false; why: string } {
  if (!ctx.source) return { ok: false, why: 'it is not backed by a case file' }
  const written = getIn(ctx.source, [...planned.source, 'expect'])
  if (written === undefined) return { ok: false, why: 'the case file has no "expect" there' }
  if (hasPlaceholder(written)) {
    return {
      ok: false,
      why: '"expect" uses {{captured}} values; accepting live output would freeze them. Update it by hand',
    }
  }
  if (ctx.update !== 'all' && hasDirective(written)) {
    return {
      ok: false,
      why: '"expect" contains matchers ($partial, $regex, $ref, ...); update it by hand, or rerun with --update=all to replace it with the literal output',
    }
  }
  return { ok: true }
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
  let first: { failure: Failure; label: string } | undefined
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
    if (multi) await ctx.onStepStart?.(ref)

    let evaluation: StepEvaluation
    try {
      const step = interpolateStep(planned.step, scope, planned.at)
      const normalize = effectiveNormalize(ctx.normalize, data.normalize, planned.step.normalize)
      evaluation = await evaluateStep(
        { ...step, validateOutput: planned.step.validateOutput ?? data.validateOutput },
        normalize,
        { ...ctx, timeoutMs: planned.step.timeoutMs ?? data.timeoutMs ?? ctx.timeoutMs },
      )
    } catch (err) {
      const reason =
        err instanceof InterpolationError ? err.message : `Step crashed: ${errorText(err)}`
      evaluation = {
        durationMs: 0,
        observed: null,
        warnings: [],
        failures: [{ kind: 'error', reason }],
      }
    }
    warnings.push(...evaluation.warnings)
    observations.push({ step: ref, observed: evaluation.observed })

    // --update: accept a plain golden mismatch, keep going with the live value.
    let updated = false
    const golden = evaluation.failures.find((f) => f.golden)
    if (golden && ctx.update && ctx.update !== 'off') {
      const verdict = updatable(ctx, planned)
      if (verdict.ok && evaluation.normalized !== undefined) {
        updates.push({
          source: [...planned.source, 'expect'],
          value: escapeDirectives(evaluation.normalized),
        })
        accepted ??= { expected: golden.expected, actual: golden.actual }
        evaluation.failures = evaluation.failures.filter((f) => f !== golden)
        updated = true
      } else if (!verdict.ok) {
        warnings.push(
          `Not updating ${ctx.caseId ?? 'case'}${multi ? ` (${label})` : ''}: ${verdict.why}.`,
        )
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
        if (!first) first = { failure, label }
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
    if (f.mismatches) outcome.mismatches = f.mismatches
    if (f.expected !== undefined) outcome.expected = f.expected
    if (f.actual !== undefined) outcome.actual = f.actual
    if (f.budget) outcome.budget = f.budget
  } else if (accepted) {
    if (accepted.expected !== undefined) outcome.expected = accepted.expected
    if (accepted.actual !== undefined) outcome.actual = accepted.actual
  }
  if (multi) outcome.steps = steps
  return { outcome, observations, updates, warnings, vars }
}

/** Write accepted goldens back into the case file (2-space JSON, key order kept). */
export function applyUpdates(loaded: LoadedCase, updates: ExpectationUpdate[]): void {
  if (!loaded.source || updates.length === 0) return
  const clone = structuredClone(loaded.source) as unknown as Record<string, unknown>
  for (const update of updates) setIn(clone, update.source, update.value)
  const eol = loaded.text?.includes('\r\n') ? '\r\n' : '\n'
  const json = JSON.stringify(clone, null, 2).replace(/\n/g, eol)
  fs.writeFileSync(loaded.path, `${json}${eol}`, 'utf8')
  loaded.source = clone as unknown as TestCase
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/** `cases/echo.basic.json#2` → `cases/echo.basic.run2` (a safe relative path, no extension). */
export function traceName(caseId: string): string {
  const hash = caseId.lastIndexOf('#')
  const file = hash === -1 ? caseId : caseId.slice(0, hash)
  const run = hash === -1 ? undefined : caseId.slice(hash + 1)
  const safe = file
    .replace(/\.jsonc?$/i, '')
    .replace(/^[A-Za-z]:/, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => (segment === '..' ? '_up' : segment.replace(/[<>:"|?*\\#]/g, '_')))
    .join('/')
  return `${safe || 'case'}${run ? `.run${run}` : ''}`
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
      ...createReporters(opts.reporters?.length ? opts.reporters : ['console'], this.ctx),
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
    })
    for (const warning of loaded.warnings) await this.warn(warning)

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
          : `No test cases left after filters (${filters}): ${loaded.matched} case file(s) matched the globs. Loosen the filters.`
      await this.warn(message)
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
    await this.emit({ type: 'session:end', server })
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
      outcome = { status: 'failed', durationMs: 0, errorKind: 'load', reason: run.loaded.error }
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
    let update: ExecuteContext['update'] = 'off'
    if (opts.update || opts.updateAll) {
      if (loaded.text !== undefined && caseFileHasComments(loaded.text)) {
        await this.warn(
          `Not updating ${loaded.ref.id}: the file has comments that a rewrite would drop. Update it by hand.`,
        )
      } else {
        update = opts.updateAll ? 'all' : 'failing'
      }
    }
    worker.trace = []
    const execution = await executeCase(
      loaded.data as TestCase,
      this.executeContext(worker, state, update, loaded, ref),
    )
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
      if (lock) {
        this.manifests.push({ server, path: file, status: 'missing' })
        await this.warn(
          `No manifest lock at ${path.relative(this.rootDir, file).replace(/\\/g, '/') || file}${server === opts.defaultServer ? '' : ` for server "${server}"`}. Run "vib manifest record" to pin tools, schemas and descriptions; vib run then fails on drift.`,
        )
      }
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
        this.manifests.push({ server, path: file, status: 'missing' })
        await this.warn(
          `No manifest lock at ${path.relative(this.rootDir, file).replace(/\\/g, '/') || file}. Run "vib manifest record" (or vib run --update-manifest) to pin tools, schemas and descriptions.`,
        )
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
      await this.emit({
        type: 'manifest:diff',
        path: file,
        server,
        summary,
        diff: diff as unknown as JsonValue,
      })
    }
    return captured
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
    const outcomes = runChecks(data.manifest, {
      toolsListSamples: data.toolsListSamples,
      allow: this.options.checks?.allow,
      severity: this.options.checks?.severity,
    })
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
    const count = (status: CaseStatus) =>
      this.results.filter((r) => r.outcome.status === status).length
    const summary: RunSummary = {
      total: this.results.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      updated: count('updated'),
      durationMs: Date.now() - startedAt,
    }
    const verdicts = this.caseVerdicts()
    if (repeat > 1) {
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
      const manifestsOk = this.manifests.every((m) => m.status !== 'diff' && m.status !== 'error')
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
