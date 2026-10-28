/**
 * GitHub Actions reporter.
 *
 * - Workflow commands on stdout: `::error file=…,title=…::message` for failed cases,
 *   failed checks and manifest drift; `::warning` for warnings, warned checks and budget
 *   breaches on non-failing cases; `::group::…::endgroup::` around each flow's step list.
 *   Emitted only inside Actions (GITHUB_ACTIONS=true) unless `annotations: 'always'`, so a
 *   `ci` profile run locally stays quiet.
 * - A markdown job summary appended to $GITHUB_STEP_SUMMARY, or written to
 *   `<outDir>/summary.md` when that variable is unset (local runs, other CI systems).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CaseStatus, CheckOutcome, Reporter, ReporterContext, RunEvent } from '../events.js'
import type { EnvLike } from './ansi.js'
import {
  type CaseRecord,
  DEFAULT_MAX_MISMATCHES,
  RunCollector,
  artifactLines,
  budgetNote,
  compareCases,
  displayPath,
  errorKindLabel,
  failureText,
  firstLine,
  formatDuration,
  formatPercent,
  mismatchLine,
  neutralizeWorkflowCommand,
  outcomeHeadline,
  plural,
  resolveOutDir,
  serverInfoLabel,
  stepLabel,
  stripUpdateHint,
  truncate,
  updateSkippedReason,
} from './shared.js'

export const SUMMARY_FILE = 'summary.md'

export interface GithubReporterOptions {
  /** Environment (GITHUB_ACTIONS, GITHUB_STEP_SUMMARY, GITHUB_WORKSPACE). Default: process.env. */
  env?: EnvLike
  /** 'auto' (default): workflow commands only when GITHUB_ACTIONS=true. */
  annotations?: 'auto' | 'always' | 'never'
  /** Mismatches included per annotation. Default 10. */
  maxMismatches?: number
  /** Failure detail blocks included in the summary. Default 25. */
  maxDetails?: number
  /** Rows in the collapsed "all cases" table. Default 500. */
  maxRows?: number
}

// ---------------------------------------------------------------------------
// Workflow command encoding (mirrors @actions/core escapeData / escapeProperty)
// ---------------------------------------------------------------------------

export function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

export function workflowCommand(
  command: string,
  properties: Record<string, string | number | undefined>,
  message: string,
): string {
  const props = Object.entries(properties)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${escapeProperty(String(v))}`)
    .join(',')
  return `::${command}${props ? ` ${props}` : ''}::${escapeData(message)}`
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

const ICON: Record<CaseStatus | 'warned', string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
  updated: '✏️',
  warned: '⚠️',
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape text for a GFM table cell. */
export function mdCell(text: string): string {
  return escapeHtml(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function mdCode(text: string): string {
  if (text.includes('`') || text.includes('\n')) return mdCell(text)
  return `\`${text.replace(/\|/g, '\\|')}\``
}

/** A fenced block whose fence cannot be closed by the content. */
function fence(lines: string[], lang = ''): string[] {
  const longest = Math.max(
    0,
    ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length))),
  )
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return [`${ticks}${lang}`, ...lines, ticks]
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class GithubReporter implements Reporter {
  readonly name = 'github'
  private readonly run = new RunCollector()
  private readonly env: EnvLike
  private readonly annotate: boolean
  private readonly maxMismatches: number
  private readonly maxDetails: number
  private readonly maxRows: number

  constructor(
    private readonly ctx: ReporterContext,
    options: GithubReporterOptions = {},
  ) {
    this.env = options.env ?? process.env
    const mode = options.annotations ?? 'auto'
    this.annotate = mode === 'always' || (mode === 'auto' && this.env.GITHUB_ACTIONS === 'true')
    this.maxMismatches = options.maxMismatches ?? DEFAULT_MAX_MISMATCHES
    this.maxDetails = options.maxDetails ?? 25
    this.maxRows = options.maxRows ?? 500
  }

  /** True when workflow commands are written to stdout. */
  get annotating(): boolean {
    return this.annotate
  }

  onEvent(event: RunEvent): void {
    const record = this.run.handle(event)
    if (!this.annotate) return
    switch (event.type) {
      case 'case:end':
        if (record) this.annotateCase(record)
        break
      case 'check':
        this.annotateCheck(event.outcome)
        break
      case 'manifest:diff':
        this.emit(
          workflowCommand(
            'error',
            {
              file: this.annotationPath(event.path),
              title: `Vibrissa: manifest drift${event.server ? ` (${event.server})` : ''}`,
            },
            `${event.summary}\nReview the change, then rerun with --update-manifest to accept it.`,
          ),
        )
        break
      case 'warning':
        this.emit(workflowCommand('warning', { title: 'Vibrissa' }, event.message))
        break
      default:
        break
    }
  }

  private emit(line: string): void {
    this.ctx.stdout(line)
  }

  /** Annotation paths must be relative to the repository root (GITHUB_WORKSPACE). */
  private annotationPath(file: string): string {
    const absolute = path.resolve(this.ctx.rootDir, file)
    const workspace = this.env.GITHUB_WORKSPACE
    if (workspace) {
      const rel = path.relative(workspace, absolute)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/')
    }
    return displayPath(absolute, this.ctx.rootDir)
  }

  private caseTitle(record: CaseRecord): string {
    const server = this.run.multiServer ? `[${record.ref.server}] ` : ''
    const run = record.run !== undefined ? ` #${record.run}` : ''
    return `${server}${record.ref.name}${run}`
  }

  private annotateCase(record: CaseRecord): void {
    const { outcome } = record
    if (record.steps.length > 0) {
      const glyph = outcome.status === 'failed' ? '✗' : outcome.status === 'skipped' ? '↓' : '✓'
      const meta = `${plural(record.steps.length, 'step')}, ${formatDuration(outcome.durationMs)}`
      this.emit(`::group::${escapeData(`${glyph} ${this.caseTitle(record)} (${meta})`)}`)
      for (const s of record.steps) {
        const g = s.status === 'failed' ? '✗' : s.status === 'skipped' ? '↓' : '✓'
        const reason = s.reason ? ` - ${firstLine(s.reason)}` : ''
        this.emit(
          neutralizeWorkflowCommand(
            `  ${g} ${stepLabel(s.step)} (${formatDuration(s.durationMs)})${reason}`,
          ),
        )
      }
      this.emit('::endgroup::')
    }
    const file = this.annotationPath(record.ref.file)
    if (outcome.status === 'failed') {
      // Annotations never suggest --update: the job log and summary carry that context.
      const lines = [stripUpdateHint(outcome.reason ? outcome.reason : outcomeHeadline(outcome))]
      const notUpdated = updateSkippedReason(outcome)
      if (notUpdated) lines.push(`Not updated: ${notUpdated}`)
      const failedStep = record.steps.find((s) => s.status === 'failed')
      if (failedStep && !outcome.reason) {
        lines.push(`Step ${stepLabel(failedStep.step)}: ${failedStep.reason ?? 'failed'}`)
      }
      const mismatches = outcome.mismatches ?? []
      for (const m of mismatches.slice(0, this.maxMismatches)) lines.push(`  ${mismatchLine(m)}`)
      if (mismatches.length > this.maxMismatches) {
        lines.push(`  ... and ${mismatches.length - this.maxMismatches} more`)
      }
      const budget = budgetNote(outcome)
      if (budget) lines.push(budget)
      lines.push(...artifactLines(outcome, this.ctx.rootDir))
      const kind = errorKindLabel(outcome)
      const verb =
        kind === 'timeout'
          ? 'timed out'
          : kind === 'load error'
            ? 'failed to load'
            : kind
              ? 'errored'
              : 'failed'
      this.emit(
        workflowCommand(
          'error',
          { file, line: record.ref.line, title: `Vibrissa: ${this.caseTitle(record)} ${verb}` },
          lines.join('\n'),
        ),
      )
    } else if (outcome.budget) {
      this.emit(
        workflowCommand(
          'warning',
          { file, line: record.ref.line, title: `Vibrissa: ${this.caseTitle(record)} over budget` },
          `Took ${formatDuration(outcome.budget.actualMs)}, budget ${formatDuration(outcome.budget.budgetMs)}`,
        ),
      )
    }
  }

  private annotateCheck(check: CheckOutcome): void {
    if (check.status === 'passed') return
    const command = check.status === 'failed' ? 'error' : 'warning'
    const verb = check.status === 'failed' ? 'failed' : 'warning'
    this.emit(
      workflowCommand(
        command,
        {
          title: `Vibrissa check ${verb}: ${check.title}${check.server ? ` (${check.server})` : ''}`,
        },
        check.detail ?? check.title,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Job summary
  // -------------------------------------------------------------------------

  /** Markdown job summary for the run so far. */
  markdown(): string {
    const run = this.run
    const summary = run.resolvedSummary()
    const ok = run.ok() && run.ended
    const reasons = run.verdictReasons()
    const verdict = !run.ended
      ? '⚠️ Incomplete'
      : ok
        ? '✅ Passed'
        : `❌ Failed${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`
    const out: string[] = []
    out.push(`## Vibrissa results: ${verdict}`, '')
    out.push('| Result | Total | Passed | Failed | Skipped | Updated | Duration |')
    out.push('| :-- | --: | --: | --: | --: | --: | --: |')
    out.push(
      `| ${verdict} | ${summary.total} | ${summary.passed} | ${summary.failed} | ${summary.skipped} | ${summary.updated} | ${formatDuration(summary.durationMs)} |`,
    )
    if (run.servers.length > 0) {
      const servers = run.servers.map((name) => {
        const s = run.sessions.get(name)
        if (!s) return mdCode(name)
        const info = serverInfoLabel(s.serverInfo)
        return `${mdCode(name)} (${info ? `${mdCell(info)}, ` : ''}${s.era} ${mdCell(s.protocolVersion ?? '')})`
      })
      const repeat = run.repeat !== undefined && run.repeat > 1 ? ` · repeat ${run.repeat}` : ''
      out.push('', `Servers: ${servers.join(', ')}${repeat}`)
    }

    const failed = [...run.casesWith('failed')].sort(compareCases)
    if (failed.length > 0) {
      out.push('', `### ❌ Failures (${failed.length})`, '')
      out.push('| Case | File | Server | Duration | Reason |')
      out.push('| :-- | :-- | :-- | --: | :-- |')
      for (const r of failed) {
        out.push(
          `| ${mdCell(this.caseTitle(r))} | ${mdCode(displayPath(r.ref.file, this.ctx.rootDir))} | ${mdCell(r.ref.server)} | ${formatDuration(r.outcome.durationMs)} | ${mdCell(truncate(stripUpdateHint(outcomeHeadline(r.outcome)), 200))} |`,
        )
      }
      for (const r of failed.slice(0, this.maxDetails)) {
        const text = failureText(r, { rootDir: this.ctx.rootDir, maxDiffLines: 60 })
        out.push('', `<details><summary>${escapeHtml(this.caseTitle(r))}</summary>`, '')
        out.push(...fence(text, 'diff'))
        out.push('', '</details>')
      }
      if (failed.length > this.maxDetails) {
        out.push(
          '',
          `_${failed.length - this.maxDetails} more failures not expanded; see results.json or the log._`,
        )
      }
    }

    const drift = run.manifestDrift()
    if (run.manifests.length > 0) {
      out.push('', `### Manifest${drift.length > 0 ? ' drift' : ''}`, '')
      out.push('| Status | Manifest | Summary |')
      out.push('| :-- | :-- | :-- |')
      for (const m of run.manifests) {
        const icon = m.status === 'diff' ? ICON.failed : ICON.passed
        const text = m.status === 'diff' ? (m.summary ?? 'drift') : 'matches lock'
        const server = m.server ? ` (${mdCell(m.server)})` : ''
        out.push(
          `| ${icon} | ${mdCode(displayPath(m.path, this.ctx.rootDir))}${server} | ${mdCell(text)} |`,
        )
      }
      if (drift.length > 0) {
        out.push('', 'Review the change, then rerun with `--update-manifest` to accept it.')
      }
    }

    if (run.checks.length > 0) {
      const cc = run.checkCounts()
      out.push('', `### Checks (${cc.passed} passed, ${cc.failed} failed, ${cc.warned} warned)`, '')
      out.push('| Status | Check | Detail |')
      out.push('| :-- | :-- | :-- |')
      for (const c of run.checks) {
        out.push(
          `| ${ICON[c.status]} | ${mdCell(c.server ? `${c.title} (${c.server})` : c.title)} | ${mdCell(truncate(c.detail ?? '', 300))} |`,
        )
      }
    }

    const rates = run.passRates()
    if (rates.length > 0) {
      const flaky = rates.filter((r) => r.rate > 0 && r.rate < 1)
      out.push(
        '',
        `### Pass rates (${plural(rates.length, 'repeated case')}, ${flaky.length} flaky)`,
        '',
      )
      out.push('| Case | Passed | Rate | Verdict |')
      out.push('| :-- | --: | --: | :-- |')
      for (const r of rates) {
        const base = r.rate >= 1 ? 'stable' : r.rate <= 0 ? 'failing' : 'flaky'
        const verdictText = r.declaredFlaky ? `${base} (declared flaky)` : base
        out.push(
          `| ${mdCell(r.name)} | ${r.runs > 0 ? `${r.passes}/${r.runs}` : '-'} | ${formatPercent(r.rate)} | ${verdictText} |`,
        )
      }
    }

    if (run.warnings.length > 0) {
      out.push('', `### ⚠️ Warnings (${run.warnings.length})`, '')
      for (const w of run.warnings) out.push(`- ${escapeHtml(w).replace(/\r?\n/g, ' ')}`)
    }

    const all = [...run.cases].sort(compareCases)
    if (all.length > 0) {
      out.push('', `<details><summary>All cases (${all.length})</summary>`, '')
      out.push('| Status | Case | Server | Duration |')
      out.push('| :-- | :-- | :-- | --: |')
      for (const r of all.slice(0, this.maxRows)) {
        out.push(
          `| ${ICON[r.outcome.status]} | ${mdCell(this.caseTitle(r))} | ${mdCell(r.ref.server)} | ${formatDuration(r.outcome.durationMs)} |`,
        )
      }
      if (all.length > this.maxRows)
        out.push('', `_${all.length - this.maxRows} more cases omitted._`)
      out.push('', '</details>')
    }
    return `${out.join('\n')}\n`
  }

  async close(): Promise<void> {
    const markdown = this.markdown()
    const stepSummary = this.env.GITHUB_STEP_SUMMARY
    if (stepSummary) {
      await fs.appendFile(stepSummary, `\n${markdown}`, 'utf8')
      return
    }
    const file = path.join(resolveOutDir(this.ctx.rootDir, this.ctx.outDir), SUMMARY_FILE)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, markdown, 'utf8')
    this.ctx.stderr(`vibrissa: wrote ${displayPath(file, this.ctx.rootDir)}`)
  }
}

export function createGithubReporter(
  ctx: ReporterContext,
  options?: GithubReporterOptions,
): GithubReporter {
  return new GithubReporter(ctx, options)
}
