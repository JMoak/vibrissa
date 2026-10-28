/**
 * JSON reporter: writes `<outDir>/results.json`, a stable machine-readable record of the
 * run. Designed to be consumed by `--baseline` delta gating: every case carries its id,
 * status and durationMs, cases are sorted deterministically, and paths are relative to
 * the project root so a committed `last-green.json` compares cleanly across machines.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CaseStatus, CheckOutcome, Reporter, ReporterContext, RunEvent } from '../events.js'
import type { JsonValue } from '../types.js'
import {
  type CaseRecord,
  RunCollector,
  compareCases,
  displayPath,
  resolveOutDir,
  toJsonSafe,
  updateSkippedReason,
} from './shared.js'

export const RESULTS_FILE = 'results.json'

/**
 * Shape of `results.json` (version 1). Additive changes keep `version: 1`; any removal or
 * change of meaning bumps it.
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "generator": "vibrissa",
 *   "ok": false,                      // run:end.ok, else: no failed cases/checks, no drift
 *   "complete": true,                 // false when the run stopped before run:end
 *   "startedAt": "2026-10-28T12:00:00.000Z",
 *   "finishedAt": "2026-10-28T12:00:01.234Z",   // startedAt + summary.durationMs
 *   "repeat": 3,                                // run:start.repeat, when > 1
 *   "shard": { "index": 1, "total": 4 },        // run:start.shard, when sharded
 *   "servers": [{ "name": "local", "era": "modern", "protocolVersion": "2026-07-28",
 *                 "serverInfo": { "name": "echo-server", "version": "1.2.0" } }],
 *   "summary": {
 *     "total": 3,                                // distinct cases (not runs)
 *     "runs": 9,                                 // executions; only when repeated
 *     "passed": 1, "failed": 1, "skipped": 1, "updated": 0,   // per run when repeated
 *     "durationMs": 1234,
 *     "passRates": { "cases/echo.json": 0.6 },   // only with --repeat > 1
 *     "flaky": ["cases/echo.json"],              // 0 < pass rate < 1; omitted when none
 *     "checks": { "passed": 2, "failed": 0, "warned": 1 },
 *     "manifestDrift": 0,
 *     "warnings": 1
 *   },
 *   "cases": [{
 *     "id": "cases/echo.json#2",       // CaseRef.id as emitted (unique per run)
 *     "caseId": "cases/echo.json",     // id without the repeat suffix (stable across runs)
 *     "run": 2,                         // repeat index, only when repeated
 *     "name": "echo returns input", "file": "cases/echo.json", "server": "local",
 *     "tags": ["smoke"], "line": 1, "flaky": true,   // line/flaky only when known/declared
 *     "status": "failed", "durationMs": 12,
 *     "errorKind": "assertion",        // assertion | error | timeout | budget | load
 *     "reason": "Expectation failed at content[0].text: ...",
 *     "mismatches": [{ "path": "content[0].text", "message": "...", "expected": "A", "actual": "a",
 *                      "field": "expect", "pointer": "/steps/1/expect/content/0/text", "stepIndex": 1 }],
 *     "updateSkipped": { "reason": "expect contains matchers" },   // --update left it alone
 *     "expected": { ... }, "actual": { ... },
 *     "steps": [{ "index": 0, "name": "create", "kind": "tool", "target": "session.create",
 *                 "status": "passed", "durationMs": 5 }],
 *     "budget": { "budgetMs": 800, "actualMs": 812 },
 *     "tracePath": "reports/traces/echo.ndjson",
 *     "stderrPath": "reports/traces/echo.stderr.log"
 *   }],
 *   "checks": [{ "id": "spec/tools-list-stable", "server": "local", "title": "...", "status": "warned",
 *                "detail": "..." }],
 *   "manifests": [{ "path": "tests/integration/__manifest__.json", "server": "local", "status": "diff",
 *                   "summary": "1 tool changed", "diff": { ... } }],
 *   "warnings": ["..."]
 * }
 * ```
 *
 * Empty arrays are omitted (`tags`, `summary.flaky`, `checks`, `manifests`, `warnings`);
 * `servers` and `cases` are always present.
 */
export interface JsonReport {
  version: 1
  generator: 'vibrissa'
  /**
   * The run's verdict: run:end.ok when the runner sent it; otherwise true when no case
   * failed, no check failed and no manifest drifted.
   */
  ok: boolean
  /** False when the reporter was closed without seeing run:end (crash / abort). */
  complete: boolean
  /** ISO 8601, from run:start.startedAt; null if run:start never arrived. */
  startedAt: string | null
  /** ISO 8601, startedAt + summary.durationMs; null if unknown. */
  finishedAt: string | null
  /** run:start.repeat, when cases were repeated (> 1). */
  repeat?: number
  /** run:start.shard, when the run was one shard of several. */
  shard?: { index: number; total: number }
  servers: JsonServer[]
  summary: JsonSummary
  /** Sorted by caseId, then run. */
  cases: JsonCase[]
  /** In emission order; omitted when no checks ran. */
  checks?: CheckOutcome[]
  /** One entry per manifest:ok / manifest:diff event; omitted when no manifest was checked. */
  manifests?: JsonManifest[]
  /** Omitted when there were none. */
  warnings?: string[]
}

export interface JsonServer {
  name: string
  era?: 'legacy' | 'modern'
  protocolVersion?: string
  /** What the server reported about itself (session:start.serverInfo). */
  serverInfo?: { name?: string; version?: string }
}

export interface JsonSummary {
  /** Distinct cases. With --repeat this is not the number of executions (see `runs`). */
  total: number
  /** Executions (cases x repeat); present only when cases were repeated. */
  runs?: number
  /** Status counts; counted per run when repeated, so they sum to `runs`. */
  passed: number
  failed: number
  skipped: number
  updated: number
  durationMs: number
  /** Pass rate per case id; present only when cases were repeated. */
  passRates?: Record<string, number>
  /** Case ids (without repeat suffix) whose pass rate is strictly between 0 and 1; omitted when none. */
  flaky?: string[]
  checks: { passed: number; failed: number; warned: number }
  /** Number of manifests that differ from the lock file. */
  manifestDrift: number
  warnings: number
}

export interface JsonCase {
  /** CaseRef.id as emitted: relative case file path, plus `#<n>` for repeated runs. */
  id: string
  /** id without the `#<n>` repeat suffix; the key to aggregate or compare on. */
  caseId: string
  /** Repeat index, present only for repeated runs. */
  run?: number
  name: string
  /** Case file, forward slashes. */
  file: string
  server: string
  /** Omitted when the case has no tags. */
  tags?: string[]
  /** 1-based line of the case in its file, when known. */
  line?: number
  /** The case declared `flaky: true`. */
  flaky?: true
  status: CaseStatus
  durationMs: number
  /** Kind of failure: assertion | error | timeout | budget | load. */
  errorKind?: 'assertion' | 'error' | 'timeout' | 'budget' | 'load'
  reason?: string
  mismatches?: JsonMismatch[]
  /** Present when --update left this failing golden alone, and why. */
  updateSkipped?: { reason: string }
  expected?: JsonValue
  actual?: JsonValue
  steps?: JsonStep[]
  budget?: { budgetMs: number; actualMs: number }
  /** Transcript path, relative to the project root when inside it. */
  tracePath?: string
  /** Captured server stderr for this case, relative to the project root when inside it. */
  stderrPath?: string
}

export interface JsonMismatch {
  path: string
  message: string
  expected?: JsonValue
  actual?: JsonValue
  /** Case field the mismatch belongs to (`expect`, `expectError`, ...). */
  field?: string
  /** RFC 6901 pointer into the case file, e.g. `/steps/1/expect/content/0/text`. */
  pointer?: string
  /** 0-based step index for flows. */
  stepIndex?: number
}

export interface JsonStep {
  /** 0-based step index. */
  index: number
  name: string
  kind: string
  target: string
  status: CaseStatus
  durationMs: number
  reason?: string
}

export interface JsonManifest {
  path: string
  /** Server whose manifest this is, when the runner attributed it. */
  server?: string
  status: 'ok' | 'diff'
  summary?: string
  diff?: JsonValue
}

function iso(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function caseToJson(record: CaseRecord, rootDir: string): JsonCase {
  const { ref, outcome } = record
  const out: JsonCase = {
    id: ref.id,
    caseId: record.caseId,
    ...(record.run !== undefined ? { run: record.run } : {}),
    name: ref.name,
    file: displayPath(ref.file, rootDir),
    server: ref.server,
    ...(ref.tags.length > 0 ? { tags: [...ref.tags] } : {}),
    ...(ref.line !== undefined ? { line: ref.line } : {}),
    ...(ref.flaky ? { flaky: true as const } : {}),
    status: outcome.status,
    durationMs: outcome.durationMs,
  }
  if (outcome.errorKind !== undefined) out.errorKind = outcome.errorKind
  if (outcome.reason !== undefined) out.reason = outcome.reason
  if (outcome.mismatches && outcome.mismatches.length > 0) {
    out.mismatches = outcome.mismatches.map((m) => {
      const entry: JsonMismatch = { path: m.path, message: m.message }
      if (m.expected !== undefined) entry.expected = toJsonSafe(m.expected)
      if (m.actual !== undefined) entry.actual = toJsonSafe(m.actual)
      if (m.field !== undefined) entry.field = m.field
      if (m.pointer !== undefined) entry.pointer = m.pointer
      if (m.stepIndex !== undefined) entry.stepIndex = m.stepIndex
      return entry
    })
  }
  const notUpdated = updateSkippedReason(outcome)
  if (notUpdated !== undefined) out.updateSkipped = { reason: notUpdated }
  if (outcome.expected !== undefined) out.expected = toJsonSafe(outcome.expected)
  if (outcome.actual !== undefined) out.actual = toJsonSafe(outcome.actual)
  if (record.steps.length > 0) {
    out.steps = record.steps.map((s) => {
      const step: JsonStep = {
        index: s.step.index,
        name: s.step.name,
        kind: s.step.kind,
        target: s.step.target,
        status: s.status,
        durationMs: s.durationMs,
      }
      if (s.reason !== undefined) step.reason = s.reason
      return step
    })
  }
  if (outcome.budget) {
    out.budget = { budgetMs: outcome.budget.budgetMs, actualMs: outcome.budget.actualMs }
  }
  if (outcome.tracePath) out.tracePath = displayPath(outcome.tracePath, rootDir)
  if (outcome.stderrPath) out.stderrPath = displayPath(outcome.stderrPath, rootDir)
  return out
}

/** Build the results.json document from a collected run. Pure; exported for reuse/tests. */
export function buildJsonReport(run: RunCollector, rootDir: string): JsonReport {
  const summary = run.resolvedSummary()
  const flaky = run.flaky().map((r) => r.caseId)
  const startedAt = iso(run.startedAt)
  const finishedAt =
    run.startedAt !== undefined && run.ended ? iso(run.startedAt + summary.durationMs) : null
  const repeat = run.repeatInfo()
  const jsonSummary: JsonSummary = {
    total: repeat ? repeat.cases : summary.total,
    ...(repeat ? { runs: repeat.runs } : {}),
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    updated: summary.updated,
    durationMs: summary.durationMs,
    ...(summary.passRates ? { passRates: { ...summary.passRates } } : {}),
    ...(flaky.length > 0 ? { flaky } : {}),
    checks: run.checkCounts(),
    manifestDrift: run.manifestDrift().length,
    warnings: run.warnings.length,
  }
  const report: JsonReport = {
    version: 1,
    generator: 'vibrissa',
    ok: run.ok() && run.ended,
    complete: run.ended,
    startedAt,
    finishedAt,
    ...(run.repeat !== undefined && run.repeat > 1 ? { repeat: run.repeat } : {}),
    ...(run.shard ? { shard: { ...run.shard } } : {}),
    servers: run.servers.map((name) => {
      const session = run.sessions.get(name)
      const server: JsonServer = { name }
      if (session?.era) server.era = session.era
      if (session?.protocolVersion) server.protocolVersion = session.protocolVersion
      if (session?.serverInfo) server.serverInfo = { ...session.serverInfo }
      return server
    }),
    summary: jsonSummary,
    cases: [...run.cases].sort(compareCases).map((c) => caseToJson(c, rootDir)),
  }
  if (run.checks.length > 0) {
    report.checks = run.checks.map((c) => {
      const check: CheckOutcome = {
        id: c.id,
        ...(c.server !== undefined ? { server: c.server } : {}),
        title: c.title,
        status: c.status,
      }
      if (c.detail !== undefined) check.detail = c.detail
      return check
    })
  }
  if (run.manifests.length > 0) {
    report.manifests = run.manifests.map((m) => {
      const entry: JsonManifest = {
        path: displayPath(m.path, rootDir),
        ...(m.server !== undefined ? { server: m.server } : {}),
        status: m.status,
      }
      if (m.summary !== undefined) entry.summary = m.summary
      if (m.diff !== undefined) entry.diff = toJsonSafe(m.diff)
      return entry
    })
  }
  if (run.warnings.length > 0) report.warnings = [...run.warnings]
  return report
}

export class JsonReporter implements Reporter {
  readonly name = 'json'
  private readonly run = new RunCollector()
  /** Absolute path of the file written (or to be written). */
  readonly filePath: string

  constructor(private readonly ctx: ReporterContext) {
    this.filePath = path.join(resolveOutDir(ctx.rootDir, ctx.outDir), RESULTS_FILE)
  }

  onEvent(event: RunEvent): void {
    this.run.handle(event)
  }

  /** The document as it would be written right now. */
  report(): JsonReport {
    return buildJsonReport(this.run, this.ctx.rootDir)
  }

  async close(): Promise<void> {
    const doc = this.report()
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    this.ctx.stderr(`vibrissa: wrote ${displayPath(this.filePath, this.ctx.rootDir)}`)
  }
}

export function createJsonReporter(ctx: ReporterContext): JsonReporter {
  return new JsonReporter(ctx)
}
