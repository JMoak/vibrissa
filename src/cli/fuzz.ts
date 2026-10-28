import path from 'node:path'
import {
  ALL_STRATEGIES,
  DEFAULT_STRATEGIES,
  type EvaluatedVerdict,
  type FuzzOutcome,
  type GeneratedCase,
  type InvariantLevel,
  type Strategy,
  canonicalJson,
  createDefaultInvariants,
  evaluate,
  findCase,
  generateArgs,
  schemaWarnings,
} from '../fuzz/index.js'
import { validate } from '../schema.js'
import type { McpSession, Outcome } from '../session/index.js'
import type { JsonValue, TestCase, ToolSummary } from '../types.js'
import {
  UsageError,
  hasFlag,
  positionals,
  printJson,
  resolvePathFromCwd,
  schemaRefFor,
  slugify,
  suiteLayout,
  takeAllFlags,
  takeFlag,
  takeNumberFlag,
  unknownNameError,
  writeJsonFile,
} from './args.js'
import { replayCommand } from './call.js'
import { colors, isObject, plural, preview, renderTable } from './format.js'
import { inSuite, outsideSuiteNote, suiteDir } from './record.js'
import { openSessionOptions, parseCommonFlags, startSession } from './resolve.js'

export const DEFAULT_FUZZ_RUNS = 100

export interface FuzzCaseReport {
  id: string
  strategy: Strategy
  expectation: GeneratedCase['expectation']
  reason: string
  target?: string
  args: Record<string, JsonValue>
  outcome: {
    kind: FuzzOutcome['kind']
    durationMs: number
    isError?: boolean
    error?: FuzzOutcome['error']
    structuredValid?: boolean
  }
  verdicts: EvaluatedVerdict[]
}

/** Map a session Outcome to the fuzz module's FuzzOutcome. */
export function toFuzzOutcome(
  outcome: Outcome,
  sessionClosed: boolean,
  outputSchema: JsonValue | undefined,
): FuzzOutcome {
  const base = { durationMs: outcome.durationMs }
  if (outcome.kind === 'error') {
    const error = {
      kind: outcome.error.kind,
      ...(outcome.error.code !== undefined ? { code: outcome.error.code } : {}),
      ...(outcome.error.codeName !== undefined ? { codeName: outcome.error.codeName } : {}),
      message: outcome.error.message,
    }
    if (sessionClosed) return { ...base, kind: 'crash', error }
    if (outcome.error.kind === 'timeout') return { ...base, kind: 'timeout', error }
    // A tool error (isError: true) is a result as far as the invariants are concerned.
    if (outcome.error.kind === 'tool' && outcome.result !== undefined) {
      return { ...base, kind: 'result', result: outcome.result }
    }
    return { ...base, kind: 'error', error }
  }
  if (outcome.kind === 'input_required') return { ...base, kind: 'input_required' }
  const result = outcome.result
  const out: FuzzOutcome = { ...base, kind: 'result', result }
  if (outputSchema !== undefined && !(isObject(result) && result.isError === true)) {
    out.structuredValid =
      isObject(result) && result.structuredContent !== undefined
        ? validate(outputSchema, result.structuredContent).ok
        : false
  }
  return out
}

function parseStrategies(argv: string[]): Strategy[] {
  const raw = takeAllFlags(argv, '--strategy')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  for (const s of raw) {
    if (!(ALL_STRATEGIES as readonly string[]).includes(s)) {
      throw new UsageError(`Unknown --strategy "${s}".`, {
        code: 'invalid-argument',
        hint: `Use one of ${ALL_STRATEGIES.join(', ')} (repeatable or comma-separated).`,
      })
    }
  }
  const strategies = raw.length > 0 ? (raw as Strategy[]) : [...DEFAULT_STRATEGIES]
  if (hasFlag(argv, '--inject') && !strategies.includes('inject')) strategies.push('inject')
  return strategies
}

function parseSeed(raw: string): number | string {
  return /^\d+$/.test(raw) && Number(raw) <= 0xffffffff ? Number(raw) : raw
}

/** The case file `--record-failures` writes (docs/FUZZ.md "Reproducing a failure"). */
export function fuzzCaseFile(
  tool: ToolSummary,
  c: GeneratedCase,
  failed: EvaluatedVerdict[],
  { timeoutMs, budgetMs }: { timeoutMs: number; budgetMs?: number },
): TestCase {
  const testCase: TestCase = {
    name: `fuzz ${c.id}: ${c.reason}`,
    tags: ['fuzz'],
    tool: tool.name,
    args: c.args,
  }
  const wantsError =
    c.expectation === 'invalid-params' ||
    (c.expectation === 'any' && !validate(tool.inputSchema, c.args).ok)
  if (wantsError) testCase.expectError = { code: 'InvalidParams' }
  else testCase.expect = { $partial: true }
  if (failed.some((v) => v.invariant === 'valid-args-no-timeout')) testCase.timeoutMs = timeoutMs
  if (budgetMs !== undefined && failed.some((v) => v.invariant === 'latency-under-budget')) {
    testCase.budgetMs = budgetMs
  }
  return testCase
}

interface InvariantRow {
  id: string
  title: string
  level: string
  passed: number
  failed: number
  skipped: number
}

function tally(
  cases: FuzzCaseReport[],
  invariantIds: Array<{ id: string; title: string; level: string }>,
): InvariantRow[] {
  return invariantIds.map(({ id, title, level }) => {
    const row = { id, title, level, passed: 0, failed: 0, skipped: 0 }
    for (const c of cases) {
      for (const v of c.verdicts) {
        if (v.invariant !== id) continue
        if (v.skipped) row.skipped++
        else if (v.ok) row.passed++
        else row.failed++
      }
    }
    return row
  })
}

/** A failure's root cause: the invariant plus its detail without case-specific parts. */
export function rootCauseKey(v: EvaluatedVerdict): string {
  let detail = v.detail ?? v.title
  for (let i = 0; i < 3; i++) detail = detail.replace(/\s*\([^()]*\)/g, '')
  detail = detail
    .replace(/"[^"]*"|'[^']*'/g, '…')
    .replace(/\d+ms/g, 'Nms')
    .replace(/\s+/g, ' ')
    .trim()
  return `${v.invariant}: ${detail}`
}

export interface RootCause {
  invariant: string
  level: InvariantLevel
  /** The shared detail (case-specific parts removed). */
  summary: string
  /** Case ids, in generation order. */
  cases: string[]
}

export function groupRootCauses(
  failures: Array<{ r: FuzzCaseReport; failed: EvaluatedVerdict[] }>,
): RootCause[] {
  const groups = new Map<string, RootCause>()
  for (const { r, failed } of failures) {
    for (const v of failed) {
      const key = rootCauseKey(v)
      const group = groups.get(key) ?? {
        invariant: v.invariant,
        level: v.level,
        summary: key.slice(v.invariant.length + 2),
        cases: [],
      }
      if (!group.cases.includes(r.id)) group.cases.push(r.id)
      groups.set(key, group)
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.level === b.level ? b.cases.length - a.cases.length : a.level === 'error' ? -1 : 1,
  )
}

export async function fuzzCommand(argv: string[]): Promise<number> {
  const [toolName] = positionals(argv)
  if (!toolName) {
    throw new UsageError('Missing tool name.', {
      code: 'missing-argument',
      hint: 'Usage: vib fuzz <tool> [--runs 100] [--seed S] [--inject] [--record-failures]. Run vib tools to list tools.',
      next: ['vib tools'],
    })
  }
  const flags = parseCommonFlags(argv)
  const runs = takeNumberFlag(argv, '--runs', { min: 1, integer: true }) ?? DEFAULT_FUZZ_RUNS
  const seedRaw = takeFlag(argv, '--seed') ?? toolName
  const seed = parseSeed(seedRaw)
  const strategies = parseStrategies(argv)
  const budgetMs = takeNumberFlag(argv, '--budget', { min: 1 })
  const onlyId = takeFlag(argv, '--id')
  const recordFailures = hasFlag(argv, '--record-failures')
  const brief = hasFlag(argv, '--brief')
  const acceptToolError = !hasFlag(argv, '--strict-invalid')
  const resolved = openSessionOptions(flags)
  const { timeoutMs, rootDir, options } = resolved
  const c = colors()
  const progress = !flags.json && Boolean(process.stderr.isTTY)

  let started = await startSession(flags, {}, resolved)
  let session: McpSession = started.session
  let restarts = 0
  const t0 = performance.now()
  try {
    const toolsBefore = await session.listTools()
    const tool = toolsBefore.find((t) => t.name === toolName)
    if (!tool) {
      throw unknownNameError(
        'tool',
        toolName,
        toolsBefore.map((t) => t.name),
        'vib tools',
      )
    }
    const genOpts = { seed, count: runs, strategies, selfCheck: true }
    let cases: GeneratedCase[]
    if (onlyId) {
      const found = findCase(tool.inputSchema, { ...genOpts, id: onlyId })
      if (!found) {
        throw new UsageError(
          `Case ${onlyId} not found for seed ${JSON.stringify(seedRaw)} with --runs ${runs}.`,
          {
            code: 'not-found',
            hint: 'Use the same --seed, --runs (at least as large) and --strategy/--inject flags as the run that reported it.',
          },
        )
      }
      cases = [found]
    } else {
      cases = generateArgs(tool.inputSchema, genOpts)
    }
    const warnings = schemaWarnings(tool.inputSchema)
    const invariants = createDefaultInvariants({
      acceptToolError,
      ...(budgetMs !== undefined ? { budgetMs } : {}),
    })
    const byStrategy = strategies
      .map((s) => `${s} ${cases.filter((x) => x.strategy === s).length}`)
      .join(' · ')
    const expectations: Array<[GeneratedCase['expectation'], string]> = [
      ['success', 'should succeed'],
      ['invalid-params', 'should be rejected'],
      ['any', 'must not crash'],
    ]
    const byExpectation = expectations
      .map(([e, label]) => [cases.filter((x) => x.expectation === e).length, label] as const)
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(' · ')
    const reproduceBase = [
      'vib',
      'fuzz',
      toolName,
      '--seed',
      String(seedRaw),
      '--runs',
      String(runs),
    ]
    const base = strategies.filter((s) => s !== 'inject')
    const isDefault =
      base.length === DEFAULT_STRATEGIES.length &&
      DEFAULT_STRATEGIES.every((s) => (base as string[]).includes(s))
    if (base.length === 0) reproduceBase.push('--strategy', 'inject')
    else {
      if (!isDefault) reproduceBase.push('--strategy', base.join(','))
      if (strategies.includes('inject')) reproduceBase.push('--inject')
    }
    if (!flags.json) {
      console.log(
        c.bold(`vib fuzz ${toolName}`) +
          c.dim(
            ` · seed ${JSON.stringify(seedRaw)} · ${plural(cases.length, 'case')}: ${byStrategy}`,
          ),
      )
      if (!brief) console.log(c.dim(`  by expectation: ${byExpectation}`))
      for (const w of warnings) console.log(c.yellow(`schema: ${w}`))
    }

    const reports: FuzzCaseReport[] = []
    let failing = 0
    for (const [i, gc] of cases.entries()) {
      if (progress) {
        process.stderr.write(
          `\r\x1b[2K${c.dim(`[fuzz] ${i + 1}/${cases.length} · ${failing} failing · ${gc.id}`)}`,
        )
      }
      const outcome = await session.callTool(tool.name, gc.args, { timeoutMs })
      const fuzzOutcome = toFuzzOutcome(outcome, session.closed, tool.outputSchema)
      const verdicts = evaluate(gc, fuzzOutcome, invariants)
      if (verdicts.some((v) => !v.ok && v.level === 'error')) failing++
      reports.push({
        id: gc.id,
        strategy: gc.strategy,
        expectation: gc.expectation,
        reason: gc.reason,
        ...(gc.target !== undefined ? { target: gc.target } : {}),
        args: gc.args,
        outcome: {
          kind: fuzzOutcome.kind,
          durationMs: fuzzOutcome.durationMs,
          ...(isObject(fuzzOutcome.result) && fuzzOutcome.result.isError === true
            ? { isError: true }
            : {}),
          ...(fuzzOutcome.error ? { error: fuzzOutcome.error } : {}),
          ...(fuzzOutcome.structuredValid !== undefined
            ? { structuredValid: fuzzOutcome.structuredValid }
            : {}),
        },
        verdicts,
      })
      if (session.closed) {
        await session.close()
        restarts++
        started = await startSession(flags, {}, resolved)
        session = started.session
      }
    }
    if (progress) process.stderr.write('\r\x1b[2K')

    // Run-level checks: the server is still alive and its tool surface did not change.
    const alive = await session.ping()
    let toolsAfter: ToolSummary[] | undefined
    try {
      toolsAfter = alive ? await session.listTools() : undefined
    } catch {
      toolsAfter = undefined
    }
    const unchanged =
      toolsAfter !== undefined &&
      canonicalJson(toolsAfter as unknown as JsonValue) ===
        canonicalJson(toolsBefore as unknown as JsonValue)
    const runChecks = [
      {
        id: 'server-alive',
        level: 'error' as const,
        ok: alive,
        ...(alive ? {} : { detail: 'the server did not answer a liveness request after the run' }),
      },
      {
        id: 'tools-list-unchanged',
        level: 'error' as const,
        ok: unchanged,
        ...(unchanged
          ? {}
          : {
              detail: toolsAfter
                ? 'tools/list differs from before the run (tool definitions changed under fuzzing)'
                : 'tools/list could not be fetched after the run',
            }),
      },
    ]

    const notApplicable = (id: string): string | undefined => {
      if (id === 'output-matches-output-schema' && tool.outputSchema === undefined)
        return 'the tool declares no outputSchema'
      if (id === 'no-echo-of-injection-payload-in-error-message' && !strategies.includes('inject'))
        return 'only with --inject'
      return undefined
    }
    const rows = tally(
      reports,
      invariants.map(({ id, title, level }) => ({ id, title, level })),
    ).map((row) => {
      const na = notApplicable(row.id)
      return { ...row, applicable: row.passed + row.failed + row.skipped, ...(na ? { na } : {}) }
    })
    const failures = reports
      .map((r) => ({ r, failed: r.verdicts.filter((v) => !v.ok) }))
      .filter((x) => x.failed.length > 0)
    const errorFailures = failures.filter((x) => x.failed.some((v) => v.level === 'error'))
    const warnFailures = failures.filter((x) => !errorFailures.includes(x))
    const causes = groupRootCauses(failures)
    const ok = errorFailures.length === 0 && runChecks.every((check) => check.ok)

    const recorded: Array<{ path: string; inSuite: boolean }> = []
    if (recordFailures) {
      const outDirFlag = takeFlag(argv, '--out-dir')
      const outDir = outDirFlag ? resolvePathFromCwd(outDirFlag) : suiteDir(options, 'fuzz')
      const { suffix } = suiteLayout(options.globs)
      for (const { r, failed } of errorFailures) {
        const gc = cases.find((x) => x.id === r.id) as GeneratedCase
        const file = path.join(outDir, `${slugify(tool.name) || 'tool'}-${r.id}${suffix}`)
        const body = fuzzCaseFile(
          tool,
          gc,
          failed.filter((v) => v.level === 'error'),
          { timeoutMs, budgetMs },
        )
        writeJsonFile(file, { $schema: schemaRefFor(file, rootDir, 'case.schema.json'), ...body })
        recorded.push({ path: file, inSuite: inSuite(file, options) })
      }
    }
    const outside = recorded.filter((r) => !r.inSuite)

    const reproduce = (id?: string) =>
      replayCommand([...reproduceBase, ...(id ? ['--id', id] : [])])
    const durationMs = Math.round(performance.now() - t0)
    if (flags.json) {
      printJson({
        ok,
        tool: tool.name,
        server: started.serverName,
        seed: seedRaw,
        runs,
        strategies,
        generated: cases.length,
        durationMs,
        restarts,
        schemaWarnings: warnings,
        invariants: rows,
        runChecks,
        rootCauses: causes.map((cause) => ({ ...cause, reproduce: reproduce(cause.cases[0]) })),
        failures: failures.map(({ r, failed }) => ({
          id: r.id,
          strategy: r.strategy,
          expectation: r.expectation,
          reason: r.reason,
          args: r.args,
          outcome: r.outcome,
          failed,
          reproduce: reproduce(r.id),
        })),
        ...(brief ? {} : { cases: reports }),
        recorded,
        ...(outside.length > 0 ? { notes: [outsideSuiteNote(outside[0].path, options)] } : {}),
        reproduce: reproduce(),
      })
      return ok ? 0 : 1
    }

    if (!brief) {
      console.log('')
      console.log(
        renderTable(
          [
            { header: 'INVARIANT' },
            { header: 'LEVEL' },
            { header: 'CASES' },
            { header: 'PASS' },
            { header: 'FAIL', paint: (t) => (/^[1-9]/.test(t.trim()) ? c.red(t) : t) },
            { header: 'SKIP', paint: (t) => c.dim(t) },
          ],
          rows
            .filter((row) => row.id !== 'no-echo-of-injection-payload-in-error-message' || !row.na)
            .map((row) =>
              row.na
                ? [row.id, row.level, 'n/a', '-', '-', c.dim(`(${row.na})`)]
                : [
                    row.id,
                    row.level,
                    String(row.applicable),
                    String(row.passed),
                    String(row.failed),
                    String(row.skipped),
                  ],
            ),
        ),
      )
      console.log('')
    }
    const failedChecks = runChecks.filter((check) => !check.ok)
    if (!brief || failedChecks.length > 0) {
      console.log(
        (brief ? failedChecks : runChecks)
          .map(
            (check) =>
              `${check.ok ? c.green('✓') : c.red('✗')} ${check.id}${check.detail ? c.dim(` (${check.detail})`) : ''}`,
          )
          .join('   '),
      )
    }
    if (restarts > 0)
      console.log(c.yellow(`The server crashed and was restarted ${plural(restarts, 'time')}.`))
    const show = (
      title: string,
      list: RootCause[],
      glyph: string,
      paint: (t: string) => string,
    ) => {
      if (list.length === 0) return
      const total = new Set(list.flatMap((cause) => cause.cases)).size
      console.log('')
      console.log(
        paint(c.bold(`${title} (${plural(list.length, 'root cause')}, ${plural(total, 'case')})`)),
      )
      for (const cause of list.slice(0, 8)) {
        const example = reports.find((r) => r.id === cause.cases[0]) as FuzzCaseReport
        const verdict = example.verdicts.find((v) => !v.ok && v.invariant === cause.invariant)
        console.log(
          `  ${paint(glyph)} ${c.bold(cause.invariant)} · ${plural(cause.cases.length, 'case')}`,
        )
        console.log(`      ${verdict?.detail ?? cause.summary}`)
        console.log(c.dim(`      e.g. ${example.id}: ${example.reason}`))
        console.log(c.dim(`           args: ${preview(example.args, 140)}`))
        console.log(c.dim(`           reproduce: ${reproduce(example.id)}`))
        if (cause.cases.length > 1) {
          const others = cause.cases.slice(1, 6)
          const more = cause.cases.length - 1 - others.length
          console.log(c.dim(`      also: ${others.join(', ')}${more > 0 ? `, +${more} more` : ''}`))
        }
      }
      if (list.length > 8) console.log(c.dim(`  … ${list.length - 8} more (use --json for all)`))
    }
    show(
      'Failures',
      causes.filter((cause) => cause.level === 'error'),
      '✗',
      c.red,
    )
    show(
      'Warnings',
      causes.filter((cause) => cause.level !== 'error'),
      '!',
      c.yellow,
    )
    for (const file of recorded) console.log(`${c.green('wrote')} ${file.path}`)
    if (outside.length > 0)
      console.log(c.yellow(`note: ${outsideSuiteNote(outside[0].path, options)}`))
    console.log('')
    const parts = [
      `${plural(cases.length, 'case')} in ${durationMs}ms`,
      plural(errorFailures.length, 'failing case'),
      ...(warnFailures.length > 0 ? [plural(warnFailures.length, 'warning')] : []),
    ]
    console.log(ok ? c.green(parts.join(' · ')) : c.red(parts.join(' · ')))
    if (!ok && !recordFailures) {
      console.log(
        c.dim(
          'Next: fix the server, or keep the counterexamples as regression cases with --record-failures.',
        ),
      )
    }
    return ok ? 0 : 1
  } finally {
    if (progress) process.stderr.write('\r\x1b[2K')
    await session.close()
  }
}
