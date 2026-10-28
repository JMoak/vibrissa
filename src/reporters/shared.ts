/**
 * Helpers shared by the built-in reporters: a run-state collector that folds RunEvents
 * into a queryable model, duration/path formatting, JSON-safe serialization, and the
 * failure-detail renderer (reason, mismatch list, budget, Jest-style diff, trace).
 */
import path from 'node:path'
import { diffStringsUnified } from 'jest-diff'
import type {
  CaseOutcome,
  CaseRef,
  CaseStatus,
  CheckOutcome,
  Mismatch,
  RunEvent,
  RunSummary,
  StepRef,
} from '../events.js'
import type { JsonValue } from '../types.js'
import { type Colors, createColors } from './ansi.js'

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (safe < 1000) return `${safe}ms`
  if (safe < 60_000) return `${(safe / 1000).toFixed(2)}s`
  const totalSeconds = Math.round(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/**
 * `2/3 passed (67%)`, or just `60% pass rate` when the runs this reporter saw do not
 * account for the rate the runner reported (e.g. sharded or partially reported runs).
 */
export function formatPassRate(r: { rate: number; runs: number; passes: number }): string {
  const consistent = r.runs > 0 && Math.abs(r.passes / r.runs - r.rate) < 0.005
  return consistent
    ? `${r.passes}/${r.runs} passed (${formatPercent(r.rate)})`
    : `${formatPercent(r.rate)} pass rate`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function truncate(text: string, max: number, ellipsis = '...'): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - ellipsis.length))}${ellipsis}`
}

/** First line of a possibly multi-line string. */
export function firstLine(text: string): string {
  const idx = text.search(/\r?\n/)
  return idx === -1 ? text : text.slice(0, idx)
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Forward-slash a path; make it relative to rootDir when it is absolute and inside it. */
export function displayPath(p: string, rootDir?: string): string {
  let out = p
  if (rootDir && path.isAbsolute(p)) {
    const rel = path.relative(rootDir, p)
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) out = rel
  }
  return out.replace(/\\/g, '/')
}

export function resolveOutDir(rootDir: string, outDir: string): string {
  return path.resolve(rootDir, outDir)
}

/**
 * GitHub Actions treats any stdout line that starts with `::` (after leading whitespace)
 * as a workflow command. Server output we echo (diffs of raw strings) must never be able
 * to inject one, so neutralize the leading `::` with a zero-width space.
 */
export function neutralizeWorkflowCommand(line: string): string {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('::')) return line
  const lead = line.length - trimmed.length
  return `${line.slice(0, lead)}:​${trimmed.slice(1)}`
}

/** Compact one-line JSON rendering of an arbitrary value. */
export function formatValue(value: unknown, max = 120): string {
  if (value === undefined) return 'undefined'
  let text: string
  try {
    text = JSON.stringify(toJsonSafe(value)) ?? String(value)
  } catch {
    text = String(value)
  }
  return truncate(text, max)
}

/**
 * Convert an arbitrary value into a JsonValue: drops undefined/functions/symbols in
 * objects (null in arrays), stringifies bigints, breaks cycles, maps non-finite numbers
 * to null, and turns Error/Map/Set/Date into plain JSON.
 */
export function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      return null
  }
  const obj = value as object
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => toJsonSafe(item, seen))
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString()
    if (obj instanceof Error) return { name: obj.name, message: obj.message }
    if (obj instanceof Map) {
      const out: Record<string, JsonValue> = {}
      for (const [k, v] of obj) out[String(k)] = toJsonSafe(v, seen)
      return out
    }
    if (obj instanceof Set) return Array.from(obj, (item) => toJsonSafe(item, seen))
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
      out[k] = toJsonSafe(v, seen)
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const RUN_SUFFIX = /#(\d+)$/

/** Case id without the `#<n>` repeat suffix. */
export function baseCaseId(id: string): string {
  return id.replace(RUN_SUFFIX, '')
}

/** Repeat index parsed from a `#<n>` id suffix, if any. */
export function runIndexOf(id: string): number | undefined {
  const match = RUN_SUFFIX.exec(id)
  return match ? Number(match[1]) : undefined
}

/**
 * Human label for a flow step: `2. fetch session [tool session.get]`, or
 * `2. tool session.get` when the step has no distinct name. StepRef.index is 0-based.
 */
export function stepLabel(step: StepRef): string {
  const target = `${step.kind} ${step.target}`.trim()
  if (step.name && step.name !== step.target) return `${step.index + 1}. ${step.name} [${target}]`
  return `${step.index + 1}. ${target}`
}

// ---------------------------------------------------------------------------
// Run-state collector
// ---------------------------------------------------------------------------

export interface StepRecord {
  step: StepRef
  durationMs: number
  status: CaseStatus
  reason?: string
}

export interface CaseRecord {
  ref: CaseRef
  outcome: CaseOutcome
  /** `outcome.steps` when present, otherwise steps gathered from step:end events. */
  steps: StepRecord[]
  /** Id without the repeat suffix. */
  caseId: string
  /** Repeat index (from the `#<n>` id suffix) when the run repeats cases. */
  run?: number
}

export interface ManifestRecord {
  path: string
  server?: string
  status: 'ok' | 'diff'
  summary?: string
  diff?: JsonValue
}

export interface SessionRecord {
  server: string
  era?: 'legacy' | 'modern'
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
}

export interface PassRateRecord {
  caseId: string
  name: string
  file?: string
  server?: string
  /** The case declared `flaky: true` (a pass-rate floor applies). */
  declaredFlaky?: boolean
  rate: number
  runs: number
  passes: number
}

/** `echo-server 1.2.0`, or undefined when the server did not identify itself. */
export function serverInfoLabel(info?: { name?: string; version?: string }): string | undefined {
  const label = [info?.name, info?.version].filter((x) => x).join(' ')
  return label || undefined
}

export class RunCollector {
  startedAt?: number
  totalCases?: number
  /** run:start.repeat, when the runner announced it. */
  repeat?: number
  /** run:end.ok: the runner's own verdict, which wins over our derivation. */
  runOk?: boolean
  readonly servers: string[] = []
  readonly sessions = new Map<string, SessionRecord>()
  readonly cases: CaseRecord[] = []
  readonly checks: CheckOutcome[] = []
  readonly manifests: ManifestRecord[] = []
  readonly warnings: string[] = []
  summary?: RunSummary
  ended = false
  private readonly pendingSteps = new Map<string, StepRecord[]>()

  /** Fold one event into the model; returns the CaseRecord on case:end. */
  handle(event: RunEvent): CaseRecord | undefined {
    switch (event.type) {
      case 'run:start':
        this.startedAt = event.startedAt
        this.totalCases = event.totalCases
        this.repeat = event.repeat
        for (const server of event.servers) this.addServer(server)
        return undefined
      case 'session:start':
        this.addServer(event.server)
        this.sessions.set(event.server, {
          server: event.server,
          era: event.era,
          protocolVersion: event.protocolVersion,
          serverInfo: event.serverInfo,
        })
        return undefined
      case 'manifest:ok':
        this.manifests.push({ path: event.path, server: event.server, status: 'ok' })
        return undefined
      case 'manifest:diff':
        this.manifests.push({
          path: event.path,
          server: event.server,
          status: 'diff',
          summary: event.summary,
          diff: event.diff,
        })
        return undefined
      case 'check':
        this.checks.push(event.outcome)
        return undefined
      case 'step:end': {
        const list = this.pendingSteps.get(event.case.id) ?? []
        list.push({
          step: event.step,
          durationMs: event.durationMs,
          status: event.status,
          reason: event.reason,
        })
        this.pendingSteps.set(event.case.id, list)
        return undefined
      }
      case 'case:end': {
        this.addServer(event.case.server)
        const collected = this.pendingSteps.get(event.case.id) ?? []
        this.pendingSteps.delete(event.case.id)
        const steps = event.outcome.steps?.length ? event.outcome.steps : collected
        const record: CaseRecord = {
          ref: event.case,
          outcome: event.outcome,
          steps: [...steps].sort((a, b) => a.step.index - b.step.index),
          caseId: baseCaseId(event.case.id),
          run: runIndexOf(event.case.id),
        }
        this.cases.push(record)
        return record
      }
      case 'warning':
        this.warnings.push(event.message)
        return undefined
      case 'run:end':
        this.summary = event.summary
        this.runOk = event.ok
        this.ended = true
        return undefined
      default:
        return undefined
    }
  }

  private addServer(server: string): void {
    if (!this.servers.includes(server)) this.servers.push(server)
  }

  get multiServer(): boolean {
    return this.servers.length > 1
  }

  /** The run:end summary, or one computed from collected cases when the run was cut short. */
  resolvedSummary(): RunSummary {
    if (this.summary) return this.summary
    const count = (status: CaseStatus) => this.cases.filter((c) => c.outcome.status === status)
    const durationMs = this.cases.reduce((sum, c) => sum + (c.outcome.durationMs || 0), 0)
    return {
      total: this.cases.length,
      passed: count('passed').length,
      failed: count('failed').length,
      skipped: count('skipped').length,
      updated: count('updated').length,
      durationMs,
    }
  }

  casesWith(status: CaseStatus): CaseRecord[] {
    return this.cases.filter((c) => c.outcome.status === status)
  }

  checkCounts(): { passed: number; failed: number; warned: number } {
    let passed = 0
    let failed = 0
    let warned = 0
    for (const check of this.checks) {
      if (check.status === 'passed') passed++
      else if (check.status === 'failed') failed++
      else warned++
    }
    return { passed, failed, warned }
  }

  manifestDrift(): ManifestRecord[] {
    return this.manifests.filter((m) => m.status === 'diff')
  }

  /**
   * The run's verdict: run:end.ok when the runner sent it; otherwise true when nothing
   * failed (no failed cases, no failed checks, no manifest drift).
   */
  ok(): boolean {
    if (this.runOk !== undefined) return this.runOk
    return (
      this.resolvedSummary().failed === 0 &&
      this.checkCounts().failed === 0 &&
      this.manifestDrift().length === 0
    )
  }

  /**
   * Pass rates per case when cases were repeated. Uses `summary.passRates` when the runner
   * provided it; otherwise derives rates from cases that ran more than once.
   */
  passRates(): PassRateRecord[] {
    const groups = new Map<string, CaseRecord[]>()
    for (const record of this.cases) {
      const list = groups.get(record.caseId) ?? []
      list.push(record)
      groups.set(record.caseId, list)
    }
    const byId = new Map<string, CaseRecord>()
    for (const record of this.cases) {
      byId.set(record.ref.id, record)
      if (!byId.has(record.caseId)) byId.set(record.caseId, record)
    }
    const tally = (caseId: string) => {
      const runs = (groups.get(caseId) ?? []).filter((c) => c.outcome.status !== 'skipped')
      const passes = runs.filter((c) => c.outcome.status !== 'failed').length
      return { runs: runs.length, passes }
    }
    const records: PassRateRecord[] = []
    const provided = this.summary?.passRates
    if (provided && Object.keys(provided).length > 0) {
      const seen = new Set<string>()
      for (const [key, rate] of Object.entries(provided)) {
        const record = byId.get(key)
        const caseId = record?.caseId ?? baseCaseId(key)
        if (seen.has(caseId)) continue
        seen.add(caseId)
        records.push({
          caseId,
          name: record?.ref.name ?? caseId,
          file: record?.ref.file,
          server: record?.ref.server,
          ...(record?.ref.flaky ? { declaredFlaky: true } : {}),
          rate,
          ...tally(caseId),
        })
      }
    } else {
      if (![...groups.values()].some((list) => list.length > 1)) return []
      for (const [caseId, list] of groups) {
        const { runs, passes } = tally(caseId)
        if (runs === 0) continue
        records.push({
          caseId,
          name: list[0].ref.name,
          file: list[0].ref.file,
          server: list[0].ref.server,
          ...(list[0].ref.flaky ? { declaredFlaky: true } : {}),
          rate: passes / runs,
          runs,
          passes,
        })
      }
    }
    return records.sort((a, b) => compareStrings(a.caseId, b.caseId))
  }

  /** Cases that both passed and failed across repeats (0 < pass rate < 1). */
  flaky(): PassRateRecord[] {
    return this.passRates().filter((r) => r.rate > 0 && r.rate < 1)
  }
}

/** Locale-independent string comparison for stable output ordering. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareCases(a: CaseRecord, b: CaseRecord): number {
  return compareStrings(a.caseId, b.caseId) || (a.run ?? 0) - (b.run ?? 0)
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DIRECTIVE_KEYS = new Set(['$regex', '$wildcard', '$unordered'])

function isDirective(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) => DIRECTIVE_KEYS.has(key) || (key.startsWith('$') && key !== '$partial'),
  )
}

/**
 * Shape expected/actual for display. Under `$partial`, keys the expectation does not
 * mention (and array elements past its length) are irrelevant to the failure, so they are
 * omitted from the actual side; the `$partial` marker itself is dropped from the expected
 * side. Matcher directives are shown as written.
 */
export function projectForDiff(
  expected: unknown,
  actual: unknown,
  partial = false,
): { expected: unknown; actual: unknown } {
  if (isPlainObject(expected) && !isDirective(expected)) {
    const isPartial = partial || expected.$partial === true
    const exp: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(expected)) if (k !== '$partial') exp[k] = v
    if (!isPlainObject(actual)) return { expected: exp, actual }
    const outExp: Record<string, unknown> = {}
    const outAct: Record<string, unknown> = {}
    for (const key of Object.keys(exp)) {
      if (key in actual) {
        const child = projectForDiff(exp[key], actual[key], isPartial)
        outExp[key] = child.expected
        outAct[key] = child.actual
      } else {
        outExp[key] = exp[key]
      }
    }
    if (!isPartial) {
      for (const key of Object.keys(actual)) if (!(key in exp)) outAct[key] = actual[key]
    }
    return { expected: outExp, actual: outAct }
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const limit = partial ? Math.min(actual.length, expected.length) : actual.length
    const outExp: unknown[] = []
    const outAct: unknown[] = []
    for (let i = 0; i < Math.max(expected.length, limit); i++) {
      if (i < expected.length && i < limit) {
        const child = projectForDiff(expected[i], actual[i], partial)
        outExp.push(child.expected)
        outAct.push(child.actual)
      } else if (i < expected.length) {
        outExp.push(expected[i])
      } else {
        outAct.push(actual[i])
      }
    }
    return { expected: outExp, actual: outAct }
  }
  return { expected, actual }
}

function stringifyForDiff(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(toJsonSafe(value), null, 2)
}

export interface DiffOptions {
  aAnnotation?: string
  bAnnotation?: string
  maxLines?: number
  ellipsis?: string
}

/**
 * Jest-style unified diff between expected and actual. Returns undefined when there is
 * nothing to show (one side missing, or the two render identically).
 */
export function renderDiff(
  expected: unknown,
  actual: unknown,
  colors: Colors,
  opts: DiffOptions = {},
): string[] | undefined {
  if (expected === undefined || actual === undefined) return undefined
  const projected = projectForDiff(expected, actual)
  const bothStrings = typeof projected.expected === 'string' && typeof projected.actual === 'string'
  const a = bothStrings ? (projected.expected as string) : stringifyForDiff(projected.expected)
  const b = bothStrings ? (projected.actual as string) : stringifyForDiff(projected.actual)
  if (a === b) return undefined
  const id = (s: string) => s
  const unified = diffStringsUnified(a, b, {
    aAnnotation: opts.aAnnotation ?? 'expected',
    bAnnotation: opts.bAnnotation ?? 'actual',
    aColor: colors.enabled ? colors.green : id,
    bColor: colors.enabled ? colors.red : id,
    changeColor: colors.enabled ? colors.inverse : id,
    commonColor: colors.enabled ? colors.dim : id,
    patchColor: colors.enabled ? colors.yellow : id,
    changeLineTrailingSpaceColor: id,
    commonLineTrailingSpaceColor: id,
    includeChangeCounts: true,
    expand: false,
    contextLines: 3,
  })
  const lines = splitLines(unified)
  const max = opts.maxLines ?? 80
  if (lines.length > max) {
    const hidden = lines.length - max
    return [
      ...lines.slice(0, max),
      colors.dim(`${opts.ellipsis ?? '...'} ${plural(hidden, 'more diff line')}`),
    ]
  }
  return lines
}

// ---------------------------------------------------------------------------
// Failure details (plain-text body shared by junit / tap / github / summary)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_MISMATCHES = 10

export function budgetText(budget: { budgetMs: number; actualMs: number }): string {
  return `Budget exceeded: took ${formatDuration(budget.actualMs)}, budget ${formatDuration(budget.budgetMs)}`
}

/** Budget line to add to failure details, unless the reason already says it. */
export function budgetNote(outcome: CaseOutcome): string | undefined {
  if (!outcome.budget) return undefined
  const text = budgetText(outcome.budget)
  return outcome.reason?.includes(text) ? undefined : text
}

export function mismatchLine(m: Mismatch): string {
  return `${m.path || '(root)'}: ${m.message}`
}

/** One-line reason for a non-passing outcome. */
export function outcomeHeadline(outcome: CaseOutcome): string {
  if (outcome.reason) return firstLine(outcome.reason)
  const first = outcome.mismatches?.[0]
  if (first) {
    const more = (outcome.mismatches?.length ?? 1) - 1
    return `Expectation failed at ${mismatchLine(first)}${more > 0 ? ` (+${more} more)` : ''}`
  }
  const failedStep = outcome.steps?.find((s) => s.status === 'failed')
  if (failedStep) return `Step ${stepLabel(failedStep.step)} failed`
  if (outcome.budget) {
    return budgetText(outcome.budget)
  }
  return outcome.status === 'skipped' ? 'skipped' : 'failed'
}

export interface FailureTextOptions {
  rootDir?: string
  maxMismatches?: number
  maxDiffLines?: number
  includeDiff?: boolean
}

/** Plain-text failure body: reason, steps, mismatches, budget, diff, trace. */
export function failureText(record: CaseRecord, opts: FailureTextOptions = {}): string[] {
  const { outcome } = record
  const lines: string[] = []
  if (outcome.reason) lines.push(...splitLines(outcome.reason))
  else lines.push(outcomeHeadline(outcome))
  if (record.steps.length > 0) {
    lines.push('', 'Steps:')
    for (const s of record.steps) {
      const reason = s.reason ? ` - ${firstLine(s.reason)}` : ''
      lines.push(`  [${s.status}] ${stepLabel(s.step)} (${formatDuration(s.durationMs)})${reason}`)
    }
  }
  const mismatches = outcome.mismatches ?? []
  if (mismatches.length > 0) {
    const max = opts.maxMismatches ?? DEFAULT_MAX_MISMATCHES
    lines.push('', `Mismatches (${mismatches.length}):`)
    for (const m of mismatches.slice(0, max)) lines.push(`  ${mismatchLine(m)}`)
    if (mismatches.length > max) lines.push(`  ... and ${mismatches.length - max} more`)
  }
  const budget = budgetNote(outcome)
  if (budget) lines.push('', budget)
  if (opts.includeDiff !== false) {
    const diff = renderDiff(outcome.expected, outcome.actual, createColors(false), {
      maxLines: opts.maxDiffLines,
    })
    if (diff) lines.push('', ...diff)
  }
  const artifacts = artifactLines(outcome, opts.rootDir)
  if (artifacts.length > 0) lines.push('', ...artifacts)
  return lines
}

/** `Trace: …` / `Stderr: …` lines for the files the runner captured for a case. */
export function artifactLines(outcome: CaseOutcome, rootDir?: string): string[] {
  const lines: string[] = []
  if (outcome.tracePath) lines.push(`Trace: ${displayPath(outcome.tracePath, rootDir)}`)
  if (outcome.stderrPath) lines.push(`Stderr: ${displayPath(outcome.stderrPath, rootDir)}`)
  return lines
}

/** Short label for non-assertion failures (`timeout`, `error`, `load error`). */
export function errorKindLabel(outcome: CaseOutcome): string | undefined {
  switch (outcome.errorKind) {
    case 'error':
      return 'error'
    case 'timeout':
      return 'timeout'
    case 'load':
      return 'load error'
    default:
      return undefined
  }
}

/** JUnit/CI notion of an error (vs an assertion failure). */
export function isErrorOutcome(outcome: CaseOutcome): boolean {
  return (
    outcome.errorKind === 'error' || outcome.errorKind === 'timeout' || outcome.errorKind === 'load'
  )
}

/** Pretty-printed JSON lines for a manifest diff, capped. */
export function manifestDiffLines(diff: JsonValue | undefined, maxLines = 40): string[] {
  if (diff === undefined || diff === null) return []
  const lines = splitLines(JSON.stringify(diff, null, 2))
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines), `... ${plural(lines.length - maxLines, 'more line')}`]
}
