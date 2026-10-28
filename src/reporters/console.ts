/**
 * Console reporter (default). Replaces v1's display.ts.
 *
 * - Quiet on success: one line per case, a header, and the summary banner.
 * - Loud on failure: a Failures section with the reason, flow steps, the mismatch list
 *   (capped), budget breaches, a Jest-style expected/actual diff, and the trace path.
 * - Pretty mode: ANSI colors and unicode glyphs, v1-style summary box.
 * - Plain mode (non-TTY, NO_COLOR, TERM=dumb, or ctx.pretty=false): same information,
 *   ASCII only, line-oriented, stable for CI logs.
 *
 * Output order is stable under concurrency: a case (and its steps) prints only at
 * case:end, so interleaved events from parallel workers never interleave lines.
 */
import type { CaseStatus, CheckOutcome, Reporter, ReporterContext, RunEvent } from '../events.js'
import { type Colors, type EnvLike, createColors, resolveStyle, visibleLength } from './ansi.js'
import { driftDetail, driftSummary } from './manifest.js'
import {
  type CaseRecord,
  DEFAULT_MAX_MISMATCHES,
  RunCollector,
  artifactLines,
  budgetNote,
  displayPath,
  errorKindLabel,
  firstLine,
  formatDuration,
  formatPassRate,
  isNoCasesMessage,
  mismatchLine,
  neutralizeWorkflowCommand,
  outcomeHeadline,
  plural,
  renderDiff,
  serverInfoLabel,
  splitLines,
  stepLabel,
  truncate,
  updateSkippedReason,
} from './shared.js'

export interface ConsoleReporterOptions {
  /** Force a style. Default: derived from ctx.pretty, NO_COLOR, FORCE_COLOR and TTY. */
  style?: 'pretty' | 'plain'
  /** Environment used for style detection. Default: process.env. */
  env?: EnvLike
  /** Whether stdout is a terminal. Default: process.stdout.isTTY. */
  isTTY?: boolean
  /** Max mismatches listed per failed case. Default 10. */
  maxMismatches?: number
  /** Max diff lines per failed case. Default 80. */
  maxDiffLines?: number
  /** Width of the pretty summary box. Default 64 (v1). */
  width?: number
}

type GlyphKey = CaseStatus | 'warned'
type Tone = 'ok' | 'warn' | 'bad'

interface Glyphs {
  status: Record<GlyphKey, string>
  bullet: string
  ellipsis: string
  rule: string
  arrow: string
  flaky: string
}

const PRETTY_GLYPHS: Glyphs = {
  status: { passed: '✓', failed: '✗', skipped: '↓', updated: '✎', warned: '⚠' },
  bullet: '•',
  ellipsis: '…',
  rule: '─',
  arrow: '›',
  flaky: '~',
}

const PLAIN_GLYPHS: Glyphs = {
  status: { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP', updated: 'UPD ', warned: 'WARN' },
  bullet: '-',
  ellipsis: '...',
  rule: '-',
  arrow: '>',
  flaky: '~',
}

export class ConsoleReporter implements Reporter {
  readonly name = 'console'
  readonly style: 'pretty' | 'plain'
  private readonly c: Colors
  private readonly g: Glyphs
  private readonly run = new RunCollector()
  private readonly maxMismatches: number
  private readonly maxDiffLines: number
  private readonly width: number
  private finished = false
  /** Passing checks, folded into one "Checks: N passed" line per server. */
  private readonly passedChecks = new Map<string, number>()
  /** The runner's "no cases matched" warning, printed as an error line at the end. */
  private noCasesMessage?: string

  constructor(
    private readonly ctx: ReporterContext,
    options: ConsoleReporterOptions = {},
  ) {
    this.style =
      options.style ??
      resolveStyle(ctx.pretty, options.env ?? process.env, options.isTTY ?? !!process.stdout.isTTY)
    const pretty = this.style === 'pretty'
    this.c = createColors(pretty)
    this.g = pretty ? PRETTY_GLYPHS : PLAIN_GLYPHS
    this.maxMismatches = options.maxMismatches ?? DEFAULT_MAX_MISMATCHES
    this.maxDiffLines = options.maxDiffLines ?? 80
    this.width = Math.max(40, options.width ?? 64)
  }

  onEvent(event: RunEvent): void {
    const record = this.run.handle(event)
    if (event.type !== 'check') this.flushPassedChecks()
    switch (event.type) {
      case 'run:start':
        this.printHeader(event.totalCases, event.servers, event.repeat)
        break
      case 'session:start': {
        const info = serverInfoLabel(event.serverInfo)
        const protocol = `${event.era} protocol ${event.protocolVersion}`
        this.out(
          this.c.dim(`  ${this.g.arrow} ${event.server}: ${info ? `${info}, ` : ''}${protocol}`),
        )
        break
      }
      case 'manifest:ok':
        this.out(
          `${this.badge('passed')} manifest ${this.serverTag(event.server)}${this.path(event.path)}`,
        )
        break
      case 'manifest:diff':
        this.out(
          `${this.badge('failed')} ${this.c.red('manifest drift')} ${this.serverTag(event.server)}${this.path(event.path)}: ${firstLine(event.summary)}`,
        )
        break
      case 'check':
        this.printCheck(event.outcome)
        break
      case 'case:end':
        if (record) this.printCase(record)
        break
      case 'warning':
        this.printWarning(event.message)
        break
      case 'run:end':
        this.finish()
        break
      default:
        break
    }
  }

  close(): void {
    if (!this.finished) this.finish()
  }

  // -------------------------------------------------------------------------
  // Streaming lines
  // -------------------------------------------------------------------------

  private out(text = ''): void {
    for (const line of splitLines(text)) this.ctx.stdout(neutralizeWorkflowCommand(line))
  }

  private path(p: string): string {
    return this.c.gray(displayPath(p, this.ctx.rootDir))
  }

  private badge(status: GlyphKey): string {
    const glyph = this.g.status[status]
    switch (status) {
      case 'passed':
        return this.c.green(glyph)
      case 'failed':
        return this.c.red(glyph)
      case 'skipped':
        return this.c.yellow(glyph)
      case 'updated':
        return this.c.cyan(glyph)
      default:
        return this.c.yellow(glyph)
    }
  }

  /** `[server] ` prefix for manifest/check lines, only when the run spans several servers. */
  private serverTag(server: string | undefined): string {
    return server && this.run.multiServer ? `${this.c.gray(`[${server}]`)} ` : ''
  }

  private printHeader(totalCases: number, servers: string[], repeat?: number): void {
    const on = servers.length > 0 ? ` on ${servers.join(', ')}` : ''
    const notes: string[] = []
    if (this.run.shard) notes.push(`shard ${this.run.shard.index}/${this.run.shard.total}`)
    if (repeat !== undefined && repeat > 1) notes.push(`repeat ${repeat}`)
    const times = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    const label = `running ${plural(totalCases, 'case')}${on}${times}`
    if (this.style === 'pretty') this.out(`${this.c.bold(this.c.cyan('vibrissa'))} ${label}`)
    else this.out(`vibrissa: ${label}`)
  }

  private caseTitle(record: CaseRecord): string {
    const parts: string[] = []
    if (this.run.multiServer) parts.push(this.c.gray(`[${record.ref.server}]`))
    parts.push(record.outcome.status === 'skipped' ? this.c.dim(record.ref.name) : record.ref.name)
    if (record.run !== undefined) parts.push(this.c.gray(`#${record.run}`))
    return parts.join(' ')
  }

  private caseMeta(record: CaseRecord): string {
    const { outcome } = record
    if (outcome.status === 'skipped') {
      return this.c.dim(`(skipped${outcome.reason ? `: ${firstLine(outcome.reason)}` : ''})`)
    }
    const bits: string[] = []
    if (outcome.status === 'updated') bits.push('golden updated')
    const kind = outcome.status === 'failed' ? errorKindLabel(outcome) : undefined
    if (kind) bits.push(kind)
    if (record.steps.length > 0 && outcome.status !== 'failed') {
      bits.push(plural(record.steps.length, 'step'))
    }
    bits.push(formatDuration(outcome.durationMs))
    const meta = this.c.dim(`(${bits.join(', ')})`)
    if (!outcome.budget) return meta
    const budget = `over ${formatDuration(outcome.budget.budgetMs)} budget`
    return `${meta} ${this.c.yellow(budget)}`
  }

  private printCase(record: CaseRecord): void {
    const { outcome } = record
    this.out(`${this.badge(outcome.status)} ${this.caseTitle(record)} ${this.caseMeta(record)}`)
    if (outcome.status === 'failed' && record.steps.length > 0) {
      for (const line of this.stepLines(record, '    ', false)) this.out(line)
    }
  }

  private stepLines(record: CaseRecord, indent: string, withReasons = true): string[] {
    const lines: string[] = []
    for (const s of record.steps) {
      const label = s.status === 'skipped' ? this.c.dim(stepLabel(s.step)) : stepLabel(s.step)
      const meta =
        s.status === 'skipped'
          ? this.c.dim('(skipped)')
          : this.c.dim(`(${formatDuration(s.durationMs)})`)
      lines.push(`${indent}${this.badge(s.status)} ${label} ${meta}`)
      if (withReasons && s.reason && s.status === 'failed') {
        for (const line of splitLines(s.reason)) lines.push(`${indent}    ${this.c.red(line)}`)
      }
    }
    return lines
  }

  /**
   * Like `vib check`: passing checks fold into one line; failed/warned checks print their
   * id, title and detail, plus the allow-list entry that would accept them after review.
   */
  private printCheck(check: CheckOutcome): void {
    if (check.status === 'passed') {
      const key = check.server ?? ''
      this.passedChecks.set(key, (this.passedChecks.get(key) ?? 0) + 1)
      return
    }
    const paint = check.status === 'failed' ? this.c.red : this.c.yellow
    this.out(
      `${this.badge(check.status)} ${this.serverTag(check.server)}${paint(this.c.bold(check.id))}  ${check.title}`,
    )
    if (check.detail) {
      for (const line of splitLines(check.detail)) this.out(`    ${this.c.dim(line)}`)
    }
    this.out(`    ${this.c.dim(`Accept after review: checks.allow: ["${check.id}"]`)}`)
  }

  private flushPassedChecks(): void {
    for (const [server, count] of this.passedChecks) {
      const where = server && this.run.multiServer ? ` [${server}]` : ''
      this.out(`${this.badge('passed')} Checks${where}: ${count} passed`)
    }
    this.passedChecks.clear()
  }

  private printWarning(message: string): void {
    if (isNoCasesMessage(message)) {
      this.noCasesMessage = message
      return
    }
    const [first, ...rest] = splitLines(message)
    this.out(`${this.badge('warned')} ${this.c.yellow(first)}`)
    for (const line of rest) this.out(`    ${this.c.yellow(line)}`)
  }

  /** "No cases matched" is an error unless the runner accepted it (allowEmpty). */
  private printNoCases(): void {
    if (!this.noCasesMessage) return
    const accepted = this.run.ended && this.run.ok()
    const [first, ...rest] = splitLines(this.noCasesMessage)
    const glyph = accepted
      ? this.badge('warned')
      : this.c.red(this.style === 'pretty' ? '✗' : 'ERROR')
    const paint = accepted ? this.c.yellow : this.c.red
    this.out(`${glyph} ${paint(first)}`)
    for (const line of rest) this.out(`    ${paint(line)}`)
  }

  // -------------------------------------------------------------------------
  // End of run
  // -------------------------------------------------------------------------

  private finish(): void {
    this.finished = true
    this.flushPassedChecks()
    this.printNoCases()
    this.printFailures()
    this.printManifestDrift()
    if (this.style === 'pretty') this.printBox()
    else this.printPlainSummary()
  }

  private rule(title: string, paint: (s: string) => string): void {
    const head = `${this.g.rule.repeat(2)} ${title} `
    const fill = Math.max(4, this.width - head.length)
    this.out('')
    this.out(paint(`${head}${this.g.rule.repeat(fill)}`))
  }

  private printFailures(): void {
    const failed = this.run.casesWith('failed')
    if (failed.length === 0) return
    this.rule(`Failures (${failed.length})`, (s) => this.c.bold(this.c.red(s)))
    // An --update run already decided what to rewrite; never suggest --update again.
    const updateRun = this.run.cases.some(
      (c) => c.outcome.status === 'updated' || updateSkippedReason(c.outcome) !== undefined,
    )
    let goldenMismatch = false
    for (const record of failed) {
      this.out('')
      this.printFailure(record)
      const { outcome } = record
      if (
        outcome.expected !== undefined &&
        outcome.actual !== undefined &&
        updateSkippedReason(outcome) === undefined &&
        !outcome.reason?.includes('--update')
      ) {
        goldenMismatch = true
      }
    }
    if (goldenMismatch && !updateRun) {
      this.out('')
      this.out(this.c.dim('Tip: if the new output is correct, rerun with --update to accept it.'))
    }
  }

  private printFailure(record: CaseRecord): void {
    const { outcome, ref } = record
    const c = this.c
    const head = this.style === 'pretty' ? c.bgRed(c.bold(' FAIL ')) : this.g.status.failed
    const kind = errorKindLabel(outcome)
    const kindTag = kind ? ` ${c.yellow(`[${kind}]`)}` : ''
    this.out(`${head} ${c.bold(this.caseTitle(record))} ${this.path(ref.file)}${kindTag}`)

    const reason = outcome.reason ?? outcomeHeadline(outcome)
    for (const line of splitLines(reason)) this.out(`  ${c.red(line)}`)
    const notUpdated = updateSkippedReason(outcome)
    if (notUpdated) this.out(`  ${c.yellow(`not updated: ${notUpdated}`)}`)

    if (record.steps.length > 0) {
      this.out('')
      this.out(`  ${c.bold('Steps:')}`)
      for (const line of this.stepLines(record, '    ')) this.out(line)
    }

    const mismatches = outcome.mismatches ?? []
    if (mismatches.length > 0) {
      this.out('')
      this.out(`  ${c.bold(`Mismatches (${mismatches.length}):`)}`)
      for (const m of mismatches.slice(0, this.maxMismatches)) {
        const text = mismatchLine(m)
        const colon = text.indexOf(': ')
        const shown = colon === -1 ? text : `${c.cyan(text.slice(0, colon))}${text.slice(colon)}`
        this.out(`    ${this.g.bullet} ${shown}`)
      }
      if (mismatches.length > this.maxMismatches) {
        const more = mismatches.length - this.maxMismatches
        this.out(`    ${c.dim(`${this.g.ellipsis} and ${more} more`)}`)
      }
    }

    const budget = budgetNote(outcome)
    if (budget) {
      this.out('')
      this.out(`  ${c.yellow(budget)}`)
    }

    const diff = renderDiff(outcome.expected, outcome.actual, c, {
      maxLines: this.maxDiffLines,
      ellipsis: this.g.ellipsis,
    })
    if (diff) {
      this.out('')
      for (const line of diff) this.out(line === '' ? '' : `    ${line}`)
    }

    const artifacts = artifactLines(outcome, this.ctx.rootDir)
    if (artifacts.length > 0) {
      this.out('')
      for (const line of artifacts) {
        const colon = line.indexOf(': ')
        this.out(`  ${c.dim(line.slice(0, colon + 1))}${line.slice(colon + 1)}`)
      }
    }
  }

  private printManifestDrift(): void {
    const drift = this.run.manifestDrift()
    if (drift.length === 0) return
    this.rule(`Manifest drift (${drift.length})`, (s) => this.c.bold(this.c.red(s)))
    for (const m of drift) {
      this.out('')
      this.out(
        `${this.badge('failed')} ${this.serverTag(m.server)}${this.c.bold(displayPath(m.path, this.ctx.rootDir))}`,
      )
      // The runner's summary may already be the full rendering (drift lines + tip).
      splitLines(m.summary ?? '').forEach((line, i) => {
        if (line) this.out(`  ${i === 0 ? this.c.red(line) : line}`)
      })
      const lines = driftDetail(m.summary, m.diff, this.c)
      if (lines.length > 0) {
        this.out('')
        for (const line of lines) this.out(line === '' ? '' : `  ${line}`)
      }
    }
    if (!drift.every((m) => m.summary?.includes('--update-manifest'))) {
      this.out('')
      this.out(
        this.c.dim('Tip: review the change, then rerun with --update-manifest to accept it.'),
      )
    }
  }

  // Summary -----------------------------------------------------------------

  private summaryParts(): {
    counts: Array<[string, number]>
    duration: string
    extras: Array<{ text: string; tone: Tone }>
    flakyLines: string[]
    ok: boolean
    verdict: string
  } {
    const summary = this.run.resolvedSummary()
    const counts: Array<[string, number]> = [
      ['Passed', summary.passed],
      ['Failed', summary.failed],
      ['Skipped', summary.skipped],
      ['Updated', summary.updated],
    ]
    const extras: Array<{ text: string; tone: Tone }> = []
    if (this.run.checks.length > 0) {
      const cc = this.run.checkCounts()
      extras.push({
        text: `Checks: ${cc.passed} passed, ${cc.failed} failed, ${cc.warned} warned`,
        tone: cc.failed > 0 ? 'bad' : cc.warned > 0 ? 'warn' : 'ok',
      })
    }
    for (const m of this.run.manifests) {
      const where = m.server && this.run.multiServer ? ` [${m.server}]` : ''
      const file = displayPath(m.path, this.ctx.rootDir)
      if (m.status === 'ok') {
        extras.push({ text: `Manifest lock${where}: ok (${file})`, tone: 'ok' })
      } else {
        const what = driftSummary(m.diff) ?? firstLine(m.summary ?? 'changed')
        extras.push({ text: `Manifest lock${where}: DRIFT in ${file} (${what})`, tone: 'bad' })
      }
    }
    const warnings = this.run.warnings.filter((w) => !isNoCasesMessage(w)).length
    if (warnings > 0) extras.push({ text: `Warnings: ${warnings}`, tone: 'warn' })
    const updated = this.run.casesWith('updated').length
    if (updated > 0) extras.push({ text: `Goldens updated: ${updated}`, tone: 'ok' })
    if (!this.run.ended) {
      extras.push({ text: 'Run ended before completion (no run:end received)', tone: 'bad' })
    }

    const flakyLines: string[] = []
    const rates = this.run.passRates()
    if (rates.length > 0) {
      const flaky = rates.filter((r) => r.rate > 0 && r.rate < 1)
      flakyLines.push(`Pass rates: ${plural(rates.length, 'repeated case')}, ${flaky.length} flaky`)
      for (const r of flaky) {
        const declared = r.declaredFlaky ? ' [declared flaky]' : ''
        flakyLines.push(`  ${this.g.flaky} ${r.name}: ${formatPassRate(r)}${declared}`)
      }
    }
    const ok = this.run.ok() && this.run.ended
    const reasons = this.run.verdictReasons()
    const verdict = !this.run.ended
      ? 'INCOMPLETE'
      : ok
        ? 'PASSED'
        : `FAILED${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`
    return {
      counts,
      duration: formatDuration(summary.durationMs),
      extras,
      flakyLines,
      ok,
      verdict,
    }
  }

  /** `6 cases` or, when repeated, `2 cases, 6 runs`. */
  private sizeLabel(): string {
    const repeat = this.run.repeatInfo()
    if (repeat) return `${plural(repeat.cases, 'case')}, ${plural(repeat.runs, 'run')}`
    return plural(this.run.resolvedSummary().total, 'case')
  }

  private printPlainSummary(): void {
    const parts = this.summaryParts()
    this.out('')
    for (const extra of parts.extras) this.out(extra.text)
    for (const line of parts.flakyLines) this.out(line)
    const counts = parts.counts.map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ')
    this.out(`Result: ${parts.verdict} - ${this.sizeLabel()}: ${counts} in ${parts.duration}`)
  }

  /** v1-style ASCII banner box. */
  private printBox(): void {
    const c = this.c
    const summary = this.run.resolvedSummary()
    const parts = this.summaryParts()
    const width = this.width
    const inner = width - 2
    const top = `+${'='.repeat(inner)}+`
    const mid = `+${'-'.repeat(inner)}+`
    const line = (content: string) => {
      const pad = Math.max(0, inner - visibleLength(content))
      return `|${content}${' '.repeat(pad)}|`
    }
    const fit = (text: string) => truncate(text, inner - 1, '...')
    const titleText = 'vibrissa results'
    const left = Math.floor((inner - titleText.length) / 2)
    const titleColor = !this.run.ended ? c.yellow : parts.ok ? c.green : c.red
    const title = `${' '.repeat(left)}${c.bold(titleColor(titleText))}`

    const paintCount = (label: string, n: number) => {
      const value = String(n)
      if (label === 'Failed' && n > 0) return c.red(value)
      if (label === 'Passed') return c.green(value)
      if (label === 'Skipped' && n > 0) return c.yellow(value)
      if (label === 'Updated' && n > 0) return c.cyan(value)
      return value
    }
    const repeat = this.run.repeatInfo()
    const sizes = repeat
      ? [
          { plain: `Cases: ${repeat.cases}`, painted: `Cases: ${c.cyan(String(repeat.cases))}` },
          { plain: `Runs: ${repeat.runs}`, painted: `Runs: ${c.cyan(String(repeat.runs))}` },
        ]
      : [{ plain: `Total: ${summary.total}`, painted: `Total: ${c.cyan(String(summary.total))}` }]
    const segments = [
      ...sizes,
      ...parts.counts.map(([label, n]) => ({
        plain: `${label}: ${n}`,
        painted: `${label}: ${paintCount(label, n)}`,
      })),
    ]
    const rows: string[] = []
    let current = ''
    let currentPlain = ''
    for (const seg of segments) {
      const candidate = currentPlain ? `${currentPlain} | ${seg.plain}` : seg.plain
      if (currentPlain && candidate.length + 1 > inner) {
        rows.push(current)
        current = seg.painted
        currentPlain = seg.plain
      } else {
        current = currentPlain ? `${current} | ${seg.painted}` : seg.painted
        currentPlain = candidate
      }
    }
    if (current) rows.push(current)

    this.out('')
    this.out(top)
    this.out(line(title))
    this.out(mid)
    for (const row of rows) this.out(line(` ${row}`))
    this.out(line(` Duration: ${c.gray(parts.duration)}`))
    if (parts.verdict.includes('(')) this.out(line(` ${c.red(fit(`Result: ${parts.verdict}`))}`))
    if (parts.extras.length > 0) {
      this.out(mid)
      for (const extra of parts.extras) {
        const text = fit(extra.text)
        const paint = extra.tone === 'bad' ? c.red : extra.tone === 'warn' ? c.yellow : c.green
        this.out(line(` ${paint(text)}`))
      }
    }
    if (parts.flakyLines.length > 0) {
      this.out(mid)
      parts.flakyLines.forEach((text, i) => {
        const shown = fit(text)
        this.out(line(` ${i === 0 ? shown : c.yellow(shown)}`))
      })
    }
    this.out(top)
  }
}

export function createConsoleReporter(
  ctx: ReporterContext,
  options?: ConsoleReporterOptions,
): ConsoleReporter {
  return new ConsoleReporter(ctx, options)
}
