/**
 * TAP 14 reporter (https://testanything.org/tap-version-14-specification.html).
 *
 * Streams one test point per case as it completes (plus manifest and check results),
 * with YAML diagnostics (`duration_ms`, failure message, mismatches, diff). Flows are
 * emitted as TAP 14 subtests, one point per step. The plan is trailing (`1..N`) because
 * points stream before the total is known; an aborted run ends with `Bail out!`.
 */
import type { CheckOutcome, Reporter, ReporterContext, RunEvent } from '../events.js'
import { createColors } from './ansi.js'
import { driftDetail, isDetailedSummary } from './manifest.js'
import {
  type CaseRecord,
  RunCollector,
  displayPath,
  firstLine,
  formatPassRate,
  neutralizeWorkflowCommand,
  outcomeHeadline,
  renderDiff,
  serverInfoLabel,
  splitLines,
  stepLabel,
  updateSkippedReason,
} from './shared.js'

const serverSuffix = (server?: string) => (server ? ` (${server})` : '')

type YamlEntry =
  | { kind: 'scalar'; key: string; value: string | number | boolean }
  | { kind: 'block'; key: string; lines: string[] }
  | { kind: 'list'; key: string; items: Array<Record<string, string | number | boolean>> }

/** Escape a test point description: backslash and `#` are significant in TAP 14. */
export function escapeDescription(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/#/g, '\\#').replace(/\r?\n/g, ' ')
}

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|null|y|n)$/i

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '.nan'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Simple words stay plain (`severity: fail`); anything else is a JSON (= YAML) string.
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && !YAML_RESERVED.test(value)) return value
  return JSON.stringify(value)
}

function renderYaml(entries: YamlEntry[], indent: string): string[] {
  if (entries.length === 0) return []
  const lines = [`${indent}---`]
  for (const entry of entries) {
    if (entry.kind === 'scalar') {
      lines.push(`${indent}${entry.key}: ${yamlScalar(entry.value)}`)
    } else if (entry.kind === 'block') {
      const firstContent = entry.lines.find((l) => l !== '') ?? ''
      // Explicit indentation indicator when the first line starts with a space.
      const header = firstContent.startsWith(' ') ? '|2-' : '|-'
      lines.push(`${indent}${entry.key}: ${header}`)
      for (const line of entry.lines) lines.push(line === '' ? '' : `${indent}  ${line}`)
    } else {
      lines.push(`${indent}${entry.key}:`)
      for (const item of entry.items) {
        let first = true
        for (const [k, v] of Object.entries(item)) {
          lines.push(`${indent}  ${first ? '- ' : '  '}${k}: ${yamlScalar(v)}`)
          first = false
        }
      }
    }
  }
  lines.push(`${indent}...`)
  return lines
}

export class TapReporter implements Reporter {
  readonly name = 'tap'
  private readonly run = new RunCollector()
  private started = false
  private finished = false
  private count = 0

  constructor(private readonly ctx: ReporterContext) {}

  private out(line: string): void {
    this.ctx.stdout(neutralizeWorkflowCommand(line))
  }

  private ensureHeader(): void {
    if (this.started) return
    this.started = true
    this.out('TAP version 14')
  }

  onEvent(event: RunEvent): void {
    const record = this.run.handle(event)
    this.ensureHeader()
    switch (event.type) {
      case 'run:start': {
        const on = event.servers.length > 0 ? ` on ${event.servers.join(', ')}` : ''
        const times =
          event.repeat !== undefined && event.repeat > 1 ? ` (repeat ${event.repeat})` : ''
        this.out(`# vibrissa: running ${event.totalCases} cases${on}${times}`)
        break
      }
      case 'session:start': {
        const info = serverInfoLabel(event.serverInfo)
        this.out(
          `# session ${event.server}: ${info ? `${info}, ` : ''}${event.era} protocol ${event.protocolVersion}`,
        )
        break
      }
      case 'manifest:ok':
        this.point(
          true,
          `manifest ${displayPath(event.path, this.ctx.rootDir)}${serverSuffix(event.server)}`,
        )
        break
      case 'manifest:diff': {
        // A multi-line summary already renders the drift; otherwise render it ourselves.
        const detail = isDetailedSummary(event.summary)
          ? splitLines(event.summary.trim()).slice(1)
          : driftDetail(event.summary, event.diff, createColors(false))
        this.point(
          false,
          `manifest drift ${displayPath(event.path, this.ctx.rootDir)}${serverSuffix(event.server)}`,
          '',
          [
            { kind: 'scalar', key: 'message', value: firstLine(event.summary) },
            { kind: 'scalar', key: 'severity', value: 'fail' },
            ...(detail.length > 0 ? [{ kind: 'block' as const, key: 'diff', lines: detail }] : []),
          ],
        )
        break
      }
      case 'check':
        this.checkPoint(event.outcome)
        break
      case 'case:end':
        if (record) this.casePoint(record)
        break
      case 'warning':
        for (const line of splitLines(event.message)) this.out(`# warning: ${line}`)
        break
      case 'run:end':
        this.finish()
        break
      default:
        break
    }
  }

  close(): void {
    this.ensureHeader()
    if (this.finished) return
    this.finished = true
    this.out(`1..${this.count}`)
    this.out('Bail out! Run ended before completion (no run:end received)')
  }

  private point(
    ok: boolean,
    description: string,
    directive = '',
    yaml: YamlEntry[] = [],
    indent = '',
    number?: number,
  ): void {
    const n = number ?? ++this.count
    this.out(
      `${indent}${ok ? 'ok' : 'not ok'} ${n} - ${escapeDescription(description)}${directive}`,
    )
    for (const line of renderYaml(yaml, `${indent}  `)) this.out(line)
  }

  private checkPoint(check: CheckOutcome): void {
    const yaml: YamlEntry[] = []
    if (check.status !== 'passed') {
      yaml.push({ kind: 'scalar', key: 'message', value: firstLine(check.detail ?? check.title) })
      yaml.push({
        kind: 'scalar',
        key: 'severity',
        value: check.status === 'failed' ? 'fail' : 'warn',
      })
      if (check.detail && splitLines(check.detail).length > 1) {
        yaml.push({ kind: 'block', key: 'detail', lines: splitLines(check.detail) })
      }
    }
    this.point(
      check.status !== 'failed',
      `check: ${check.title}${serverSuffix(check.server)}`,
      '',
      yaml,
    )
  }

  private casePoint(record: CaseRecord): void {
    const { ref, outcome } = record
    const title = `${this.run.multiServer ? `[${ref.server}] ` : ''}${ref.name}${record.run !== undefined ? ` (run ${record.run})` : ''}`

    if (record.steps.length > 0) {
      this.out(`# Subtest: ${escapeDescription(title)}`)
      record.steps.forEach((s, i) => {
        const yaml: YamlEntry[] = [{ kind: 'scalar', key: 'duration_ms', value: s.durationMs }]
        if (s.status === 'failed') {
          yaml.push({ kind: 'scalar', key: 'message', value: firstLine(s.reason ?? 'step failed') })
          yaml.push({ kind: 'scalar', key: 'severity', value: 'fail' })
        }
        const directive =
          s.status === 'skipped' ? ` # SKIP${s.reason ? ` ${firstLine(s.reason)}` : ''}` : ''
        this.point(s.status !== 'failed', stepLabel(s.step), directive, yaml, '    ', i + 1)
      })
      this.out(`    1..${record.steps.length}`)
    }

    if (outcome.status === 'skipped') {
      const reason = outcome.reason ? ` ${firstLine(outcome.reason)}` : ''
      this.point(true, title, ` # SKIP${reason}`)
      return
    }

    const yaml: YamlEntry[] = [{ kind: 'scalar', key: 'duration_ms', value: outcome.durationMs }]
    if (outcome.status === 'updated') yaml.push({ kind: 'scalar', key: 'status', value: 'updated' })
    const notUpdated = updateSkippedReason(outcome)
    if (outcome.status === 'failed') {
      yaml.push({ kind: 'scalar', key: 'message', value: outcomeHeadline(outcome) })
      yaml.push({ kind: 'scalar', key: 'severity', value: 'fail' })
      yaml.push({ kind: 'scalar', key: 'file', value: displayPath(ref.file, this.ctx.rootDir) })
      yaml.push({ kind: 'scalar', key: 'server', value: ref.server })
      if (ref.line !== undefined) yaml.push({ kind: 'scalar', key: 'line', value: ref.line })
      if (outcome.errorKind)
        yaml.push({ kind: 'scalar', key: 'error_kind', value: outcome.errorKind })
      if (notUpdated) yaml.push({ kind: 'scalar', key: 'not_updated', value: notUpdated })
      if (outcome.reason && splitLines(outcome.reason).length > 1) {
        yaml.push({ kind: 'block', key: 'reason', lines: splitLines(outcome.reason) })
      }
      const mismatches = outcome.mismatches ?? []
      if (mismatches.length > 0) {
        yaml.push({
          kind: 'list',
          key: 'mismatches',
          items: mismatches.map((m) => ({ path: m.path || '(root)', message: m.message })),
        })
      }
      const diff = renderDiff(outcome.expected, outcome.actual, createColors(false))
      if (diff) yaml.push({ kind: 'block', key: 'diff', lines: diff })
    }
    if (outcome.budget) {
      yaml.push({ kind: 'scalar', key: 'budget_ms', value: outcome.budget.budgetMs })
    }
    if (outcome.tracePath) {
      yaml.push({
        kind: 'scalar',
        key: 'trace',
        value: displayPath(outcome.tracePath, this.ctx.rootDir),
      })
    }
    if (outcome.stderrPath) {
      yaml.push({
        kind: 'scalar',
        key: 'stderr',
        value: displayPath(outcome.stderrPath, this.ctx.rootDir),
      })
    }
    if (ref.flaky) yaml.push({ kind: 'scalar', key: 'flaky', value: true })
    this.point(outcome.status !== 'failed', title, '', yaml)
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    const summary = this.run.resolvedSummary()
    this.out(`1..${this.count}`)
    this.out(`# tests ${summary.total}`)
    this.out(`# pass ${summary.passed}`)
    this.out(`# fail ${summary.failed}`)
    this.out(`# skip ${summary.skipped}`)
    this.out(`# updated ${summary.updated}`)
    if (this.run.checks.length > 0) {
      const cc = this.run.checkCounts()
      this.out(`# checks ${cc.passed} passed, ${cc.failed} failed, ${cc.warned} warned`)
    }
    if (this.run.manifests.length > 0) {
      this.out(
        `# manifest drift ${this.run.manifestDrift().length} of ${this.run.manifests.length}`,
      )
    }
    for (const r of this.run.flaky()) {
      this.out(
        `# flaky ${r.name}: ${formatPassRate(r)}${r.declaredFlaky ? ' [declared flaky]' : ''}`,
      )
    }
    this.out(`# duration_ms ${Math.round(summary.durationMs)}`)
  }
}

export function createTapReporter(ctx: ReporterContext): TapReporter {
  return new TapReporter(ctx)
}
