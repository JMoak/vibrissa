/**
 * JUnit reporter: writes `<outDir>/junit.xml` in the common shape GitHub (test-reporter
 * actions), GitLab (`artifacts:reports:junit`) and Jenkins (junit plugin) accept:
 *
 *   <testsuites name tests failures errors skipped time>
 *     <testsuite name=<server> tests failures errors skipped time timestamp>
 *       <properties><property name value/></properties>
 *       <testcase classname=<case file> name=<case name> time file>
 *         <failure message type><![CDATA[reason, steps, mismatches, diff]]></failure>
 *         | <error message type>…</error>   (errorKind error / timeout / load)
 *         | <skipped message/>
 *         <system-out>…</system-out>
 *
 * One testsuite per server, plus `vibrissa:manifest` / `vibrissa:checks` suites when the
 * run produced manifest or check results, so CI dashboards show those failures too.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Reporter, ReporterContext, RunEvent } from '../events.js'
import { createColors } from './ansi.js'
import { driftDetail } from './manifest.js'
import {
  type CaseRecord,
  RunCollector,
  artifactLines,
  compareCases,
  displayPath,
  failureText,
  firstLine,
  isErrorOutcome,
  outcomeHeadline,
  resolveOutDir,
  truncate,
} from './shared.js'

export const JUNIT_FILE = 'junit.xml'

// Characters outside the XML 1.0 Char production (control chars, lone surrogates, FFFE/FFFF).
const INVALID_XML_CHARS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu

export function stripInvalidXml(text: string): string {
  return text.replace(INVALID_XML_CHARS, '')
}

export function escapeXmlAttr(value: string): string {
  return stripInvalidXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
}

export function escapeXmlText(value: string): string {
  return stripInvalidXml(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Wrap text in CDATA, splitting any `]]>` so the section cannot be terminated early. */
export function cdata(text: string): string {
  return `<![CDATA[${stripInvalidXml(text).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

function seconds(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  return (safe / 1000).toFixed(3)
}

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(String(v))}"`)
    .join('')
}

function timestampOf(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  // xs:dateTime without zone/fraction, the form the JUnit XSD and Jenkins expect.
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 19)
}

function failureType(record: CaseRecord): string {
  const { outcome } = record
  if (outcome.errorKind === 'timeout') return 'Timeout'
  if (outcome.errorKind === 'load') return 'LoadError'
  if (outcome.errorKind === 'error') return 'Error'
  if (outcome.errorKind === 'budget') return 'BudgetExceeded'
  if (outcome.mismatches && outcome.mismatches.length > 0) return 'ExpectationFailed'
  if (record.steps.some((s) => s.status === 'failed')) return 'StepFailed'
  if (outcome.budget) return 'BudgetExceeded'
  return 'CaseFailed'
}

interface Suite {
  name: string
  timestamp?: string
  properties: Array<[string, string]>
  /** Each testcase as structural lines; an element may hold multi-line CDATA. */
  testcases: string[][]
  tests: number
  failures: number
  errors: number
  skipped: number
  timeMs: number
}

function newSuite(name: string, timestamp?: string): Suite {
  return {
    name,
    timestamp,
    properties: [],
    testcases: [],
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    timeMs: 0,
  }
}

function renderSuite(suite: Suite, indent: string): string[] {
  const head = `${indent}<testsuite${attrs([
    ['name', suite.name],
    ['tests', suite.tests],
    ['failures', suite.failures],
    ['errors', suite.errors],
    ['skipped', suite.skipped],
    ['time', seconds(suite.timeMs)],
    ['timestamp', suite.timestamp],
  ])}`
  if (suite.properties.length === 0 && suite.testcases.length === 0) return [`${head}/>`]
  const lines = [`${head}>`]
  if (suite.properties.length > 0) {
    lines.push(`${indent}  <properties>`)
    for (const [name, value] of suite.properties) {
      lines.push(
        `${indent}    <property${attrs([
          ['name', name],
          ['value', value],
        ])}/>`,
      )
    }
    lines.push(`${indent}  </properties>`)
  }
  // Indent tag lines only: splitting would inject indentation into CDATA bodies.
  for (const tc of suite.testcases) lines.push(...tc.map((l) => `${indent}  ${l}`))
  lines.push(`${indent}</testsuite>`)
  return lines
}

function testcase(head: Array<[string, string | number | undefined]>, body: string[]): string[] {
  if (body.length === 0) return [`<testcase${attrs(head)}/>`]
  return [`<testcase${attrs(head)}>`, ...body.map((b) => `  ${b}`), '</testcase>']
}

/** Render junit.xml from a collected run. Pure; exported for reuse/tests. */
export function buildJunitXml(run: RunCollector, rootDir: string): string {
  const timestamp = timestampOf(run.startedAt)
  const suites = new Map<string, Suite>()
  for (const server of run.servers) {
    const suite = newSuite(server, timestamp)
    const session = run.sessions.get(server)
    if (session?.era) suite.properties.push(['era', session.era])
    if (session?.protocolVersion)
      suite.properties.push(['protocolVersion', session.protocolVersion])
    suites.set(server, suite)
  }

  for (const record of [...run.cases].sort(compareCases)) {
    const { ref, outcome } = record
    let suite = suites.get(ref.server)
    if (!suite) {
      suite = newSuite(ref.server, timestamp)
      suites.set(ref.server, suite)
    }
    const file = displayPath(ref.file, rootDir)
    const name = record.run !== undefined ? `${ref.name} (run ${record.run})` : ref.name
    const body: string[] = []
    suite.tests++
    suite.timeMs += outcome.durationMs || 0
    if (outcome.status === 'failed') {
      // JUnit distinguishes "the code under test errored" from "an assertion failed".
      const tag = isErrorOutcome(outcome) ? 'error' : 'failure'
      if (tag === 'error') suite.errors++
      else suite.failures++
      const message = truncate(outcomeHeadline(outcome), 500)
      const text = failureText(record, { rootDir }).join('\n')
      body.push(
        `<${tag}${attrs([
          ['message', message],
          ['type', failureType(record)],
        ])}>${cdata(text)}</${tag}>`,
      )
    } else if (outcome.status === 'skipped') {
      suite.skipped++
      body.push(
        `<skipped${attrs([['message', outcome.reason ? firstLine(outcome.reason) : undefined]])}/>`,
      )
    }
    const notes: string[] = []
    if (outcome.status === 'updated') notes.push('Golden updated from live output.')
    if (outcome.status !== 'failed' && outcome.budget) {
      notes.push(
        `Budget exceeded: took ${outcome.budget.actualMs}ms, budget ${outcome.budget.budgetMs}ms`,
      )
    }
    if (outcome.status !== 'failed') notes.push(...artifactLines(outcome, rootDir))
    if (notes.length > 0) body.push(`<system-out>${cdata(notes.join('\n'))}</system-out>`)
    suite.testcases.push(
      testcase(
        [
          ['classname', file],
          ['name', name],
          ['time', seconds(outcome.durationMs)],
          ['file', file],
          ['line', ref.line],
        ],
        body,
      ),
    )
  }

  if (run.manifests.length > 0) {
    const suite = newSuite('vibrissa:manifest', timestamp)
    for (const m of run.manifests) {
      const file = displayPath(m.path, rootDir)
      const body: string[] = []
      suite.tests++
      if (m.status === 'diff') {
        suite.failures++
        const detail = driftDetail(m.summary, m.diff, createColors(false), 200)
        const text = [
          m.summary ?? 'Manifest drift',
          ...(detail.length ? ['', ...detail] : []),
        ].join('\n')
        body.push(
          `<failure${attrs([
            ['message', truncate(firstLine(m.summary ?? 'Manifest drift'), 500)],
            ['type', 'ManifestDrift'],
          ])}>${cdata(text)}</failure>`,
        )
      }
      suite.testcases.push(
        testcase(
          [
            ['classname', file],
            ['name', m.server ? `manifest lock (${m.server})` : 'manifest lock'],
            ['time', '0.000'],
            ['file', file],
          ],
          body,
        ),
      )
    }
    suites.set(suite.name, suite)
  }

  if (run.checks.length > 0) {
    const suite = newSuite('vibrissa:checks', timestamp)
    for (const check of run.checks) {
      const body: string[] = []
      suite.tests++
      if (check.status === 'failed') {
        suite.failures++
        body.push(
          `<failure${attrs([
            ['message', truncate(firstLine(check.detail ?? check.title), 500)],
            ['type', 'CheckFailed'],
          ])}>${cdata(check.detail ?? check.title)}</failure>`,
        )
      } else if (check.status === 'warned') {
        body.push(`<system-out>${cdata(`WARNING: ${check.detail ?? check.title}`)}</system-out>`)
      }
      suite.testcases.push(
        testcase(
          [
            ['classname', `check.${check.id}`],
            ['name', check.server ? `${check.title} (${check.server})` : check.title],
            ['time', '0.000'],
          ],
          body,
        ),
      )
    }
    suites.set(suite.name, suite)
  }

  const all = [...suites.values()]
  const total = (key: 'tests' | 'failures' | 'errors' | 'skipped') =>
    all.reduce((n, s) => n + s[key], 0)
  const summary = run.resolvedSummary()
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attrs([
      ['name', 'vibrissa'],
      ['tests', total('tests')],
      ['failures', total('failures')],
      ['errors', total('errors')],
      ['skipped', total('skipped')],
      ['time', seconds(summary.durationMs)],
    ])}>`,
  ]
  for (const suite of all) lines.push(...renderSuite(suite, '  '))
  lines.push('</testsuites>')
  return `${lines.join('\n')}\n`
}

export class JunitReporter implements Reporter {
  readonly name = 'junit'
  private readonly run = new RunCollector()
  readonly filePath: string

  constructor(private readonly ctx: ReporterContext) {
    this.filePath = path.join(resolveOutDir(ctx.rootDir, ctx.outDir), JUNIT_FILE)
  }

  onEvent(event: RunEvent): void {
    this.run.handle(event)
  }

  xml(): string {
    return buildJunitXml(this.run, this.ctx.rootDir)
  }

  async close(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, this.xml(), 'utf8')
    this.ctx.stderr(`vibrissa: wrote ${displayPath(this.filePath, this.ctx.rootDir)}`)
  }
}

export function createJunitReporter(ctx: ReporterContext): JunitReporter {
  return new JunitReporter(ctx)
}
