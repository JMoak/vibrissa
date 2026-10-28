import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CaseOutcome,
  CaseRef,
  Reporter,
  ReporterContext,
  RunEvent,
  StepRef,
} from '../src/events.js'
import { stripAnsi } from '../src/reporters/ansi.js'
import { escapeData, escapeProperty, workflowCommand } from '../src/reporters/github.js'
import {
  ConsoleReporter,
  GithubReporter,
  type JsonReport,
  JsonReporter,
  JunitReporter,
  TapReporter,
  UnknownReporterError,
  createReporters,
  fanout,
  listReporters,
  registerReporter,
  resetReporters,
  resolveStyle,
  unregisterReporter,
} from '../src/reporters/index.js'
import { cdata, escapeXmlAttr } from '../src/reporters/junit.js'
import {
  formatDuration,
  formatPassRate,
  projectForDiff,
  toJsonSafe,
} from '../src/reporters/shared.js'
import { escapeDescription } from '../src/reporters/tap.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/reporters', import.meta.url))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  ctx: ReporterContext
  stdout: string[]
  stderr: string[]
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vib-reporters-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  resetReporters()
  vi.restoreAllMocks()
})

function capture(overrides: Partial<ReporterContext> = {}): Captured {
  const stdout: string[] = []
  const stderr: string[] = []
  const ctx: ReporterContext = {
    rootDir: tmpDir,
    outDir: 'reports',
    pretty: false,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...overrides,
  }
  return { ctx, stdout, stderr }
}

async function drive(reporter: Reporter, events: RunEvent[], close = true): Promise<void> {
  for (const event of events) await reporter.onEvent(event)
  if (close) await reporter.close?.()
}

// ---------------------------------------------------------------------------
// Scripted runs
// ---------------------------------------------------------------------------

const STARTED_AT = Date.UTC(2026, 9, 28, 12, 0, 0)

function ref(name: string, file: string, extra: Partial<CaseRef> = {}): CaseRef {
  return { id: file, name, file, tags: [], server: 'local', ...extra }
}

function step(index: number, name: string, target: string): StepRef {
  return { index, name, kind: 'tool', target }
}

function caseEvents(c: CaseRef, outcome: CaseOutcome): RunEvent[] {
  return [
    { type: 'case:start', case: c },
    { type: 'case:end', case: c, outcome },
  ]
}

const echo = ref('echo returns input', 'cases/echo.json', { tags: ['smoke'] })
const upper = ref('upper mismatch', 'cases/upper.json', { line: 3 })
const flow = ref('create then fetch', 'cases/flow.json')
const skippedCase = ref('not ready yet', 'cases/skip.json')
const updatedCase = ref('record greeting', 'cases/greet.json')
const slow = ref('slow call', 'cases/slow.json')

const createStep = step(0, 'create', 'session.create')
const getStep = step(1, 'get', 'session.get')
const closeStep = step(2, 'session.close', 'session.close')

function successEvents(): RunEvent[] {
  return [
    { type: 'run:start', totalCases: 2, servers: ['local'], startedAt: STARTED_AT },
    { type: 'session:start', server: 'local', era: 'modern', protocolVersion: '2026-07-28' },
    { type: 'manifest:ok', path: 'tests/integration/__manifest__.json' },
    ...caseEvents(echo, { status: 'passed', durationMs: 12 }),
    { type: 'case:start', case: flow },
    { type: 'step:start', case: flow, step: createStep },
    { type: 'step:end', case: flow, step: createStep, durationMs: 5, status: 'passed' },
    { type: 'step:start', case: flow, step: getStep },
    { type: 'step:end', case: flow, step: getStep, durationMs: 7, status: 'passed' },
    { type: 'case:end', case: flow, outcome: { status: 'passed', durationMs: 14 } },
    { type: 'session:end', server: 'local' },
    {
      type: 'run:end',
      summary: { total: 2, passed: 2, failed: 0, skipped: 0, updated: 0, durationMs: 345 },
    },
  ]
}

function mixedEvents(rootDir: string): RunEvent[] {
  return [
    { type: 'run:start', totalCases: 6, servers: ['local'], startedAt: STARTED_AT },
    {
      type: 'session:start',
      server: 'local',
      era: 'modern',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'echo-server', version: '1.2.0' },
    },
    {
      type: 'manifest:diff',
      server: 'local',
      path: 'tests/integration/__manifest__.json',
      summary: '1 tool changed: echo (description)',
      diff: {
        tools: {
          changed: [
            { name: 'echo', field: 'description', before: 'Echo', after: 'Echo <IMPORTANT>' },
          ],
        },
      },
    },
    {
      type: 'check',
      outcome: { id: 'list-stable', title: 'tools/list is stable', status: 'passed' },
    },
    {
      type: 'check',
      outcome: {
        id: 'ttl',
        title: 'list results carry ttlMs',
        status: 'warned',
        detail: 'tools/list has no ttlMs',
      },
    },
    {
      type: 'check',
      outcome: {
        id: 'desc-lint',
        server: 'local',
        title: 'description lint',
        status: 'failed',
        detail: 'echo: hidden instruction "<IMPORTANT>"',
      },
    },
    ...caseEvents(echo, { status: 'passed', durationMs: 12 }),
    // Flow whose steps arrive only via step:end (outcome.steps omitted).
    { type: 'case:start', case: flow },
    { type: 'step:start', case: flow, step: createStep },
    { type: 'step:end', case: flow, step: createStep, durationMs: 5, status: 'passed' },
    { type: 'step:start', case: flow, step: getStep },
    {
      type: 'step:end',
      case: flow,
      step: getStep,
      durationMs: 9,
      status: 'failed',
      reason: 'Expectation failed at structuredContent.user: expected "jordan", got "jo"',
    },
    { type: 'step:end', case: flow, step: closeStep, durationMs: 0, status: 'skipped' },
    {
      type: 'case:end',
      case: flow,
      outcome: {
        status: 'failed',
        durationMs: 14,
        reason: 'Step 2 (get) failed: expected "jordan", got "jo"',
        mismatches: [
          {
            path: 'structuredContent.user',
            message: 'expected "jordan", got "jo"',
            expected: 'jordan',
            actual: 'jo',
          },
        ],
        expected: { $partial: true, structuredContent: { user: 'jordan' } },
        actual: {
          content: [{ type: 'text', text: '{"user":"jo"}' }],
          structuredContent: { user: 'jo', sessionId: 's-1' },
        },
      },
    },
    ...caseEvents(upper, {
      status: 'failed',
      durationMs: 8,
      reason: 'Expectation failed at content[0].text: expected "HELLO", got "hello"',
      mismatches: [
        { path: 'content[0].text', message: 'expected "HELLO", got "hello"' },
        {
          path: '(root)',
          message: 'unexpected key "isError" (use "$partial": true to allow extra fields)',
        },
      ],
      expected: { content: [{ type: 'text', text: 'HELLO' }] },
      actual: { content: [{ type: 'text', text: 'hello' }], isError: false },
      tracePath: path.join(rootDir, 'reports', 'traces', 'upper.ndjson'),
      stderrPath: path.join(rootDir, 'reports', 'traces', 'upper.stderr.log'),
      errorKind: 'assertion',
    }),
    ...caseEvents(skippedCase, {
      status: 'skipped',
      durationMs: 0,
      reason: 'waiting on server fix',
    }),
    ...caseEvents(updatedCase, {
      status: 'updated',
      durationMs: 4,
      expected: { content: [{ type: 'text', text: 'hi' }] },
      actual: { content: [{ type: 'text', text: 'hello there' }] },
    }),
    ...caseEvents(slow, {
      status: 'failed',
      durationMs: 812,
      reason: 'Budget exceeded: took 812ms, budget 800ms',
      budget: { budgetMs: 800, actualMs: 812 },
      errorKind: 'budget',
    }),
    { type: 'warning', message: 'cases/legacy.json uses the v1 "error" key; run vib migrate' },
    { type: 'session:end', server: 'local' },
    {
      type: 'run:end',
      summary: { total: 6, passed: 1, failed: 3, skipped: 1, updated: 1, durationMs: 1234 },
      ok: false,
    },
  ]
}

function timeoutEvents(): RunEvent[] {
  const hung = ref('hangs forever', 'cases/hang.json', { line: 2 })
  const broken = ref('bad json', 'cases/broken.json')
  return [
    { type: 'run:start', totalCases: 3, servers: ['local'], startedAt: STARTED_AT },
    ...caseEvents(hung, {
      status: 'failed',
      durationMs: 15000,
      errorKind: 'timeout',
      reason: 'Case timeout exceeded (15000ms)',
    }),
    ...caseEvents(broken, {
      status: 'failed',
      durationMs: 0,
      errorKind: 'load',
      reason: 'Failed to load case file: Unexpected token',
    }),
    ...caseEvents(upper, {
      status: 'failed',
      durationMs: 8,
      errorKind: 'assertion',
      reason: 'Expectation failed at content[0].text',
    }),
    {
      type: 'run:end',
      summary: { total: 3, passed: 0, failed: 3, skipped: 0, updated: 0, durationMs: 15008 },
      ok: false,
    },
  ]
}

/** Repeat 3 runs: one stable case, one declared-flaky case that fails once (runner: ok). */
function repeatEvents(): RunEvent[] {
  const events: RunEvent[] = [
    { type: 'run:start', totalCases: 6, servers: ['local'], startedAt: STARTED_AT, repeat: 3 },
  ]
  const statuses: Array<'passed' | 'failed'> = ['passed', 'failed', 'passed']
  for (let i = 1; i <= 3; i++) {
    const stable = ref('stable echo', 'cases/a.json', { id: `cases/a.json#${i}` })
    const flaky = ref('flaky clock', 'cases/b.json', { id: `cases/b.json#${i}`, flaky: true })
    events.push(...caseEvents(stable, { status: 'passed', durationMs: 10 + i }))
    events.push(
      ...caseEvents(flaky, {
        status: statuses[i - 1],
        durationMs: 20 + i,
        ...(statuses[i - 1] === 'failed'
          ? {
              reason: 'Expectation failed at structuredContent.tick: expected 1, got 2',
              mismatches: [{ path: 'structuredContent.tick', message: 'expected 1, got 2' }],
            }
          : {}),
      }),
    )
  }
  events.push({
    type: 'run:end',
    summary: {
      total: 6,
      passed: 5,
      failed: 1,
      skipped: 0,
      updated: 0,
      durationMs: 99,
      passRates: { 'cases/a.json': 1, 'cases/b.json': 2 / 3 },
    },
    // The flaky case met its pass-rate floor, so the runner calls the run green.
    ok: true,
  })
  return events
}

// ---------------------------------------------------------------------------
// Registry & fanout
// ---------------------------------------------------------------------------

describe('reporter registry', () => {
  it('registers the built-in reporters', () => {
    expect(listReporters()).toEqual(['console', 'github', 'json', 'junit', 'tap'])
  })

  it('creates reporters by name: case-insensitive, comma-separated, de-duplicated', () => {
    const { ctx, stderr } = capture()
    const reporters = createReporters(['console', 'JSON', 'junit,github', ' tap ', 'console'], ctx)
    expect(reporters.map((r) => r.name)).toEqual(['console', 'json', 'junit', 'github', 'tap'])
    expect(reporters[0]).toBeInstanceOf(ConsoleReporter)
    expect(reporters[1]).toBeInstanceOf(JsonReporter)
    expect(reporters[2]).toBeInstanceOf(JunitReporter)
    expect(reporters[3]).toBeInstanceOf(GithubReporter)
    expect(reporters[4]).toBeInstanceOf(TapReporter)
    // console + tap both stream to stdout: warn once.
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('"console" and "tap" both write to stdout')
  })

  it('returns an empty list for no names', () => {
    expect(createReporters([], capture().ctx)).toEqual([])
  })

  it('rejects unknown names, listing the known ones and suggesting a fix', () => {
    const factory = vi.fn(() => ({ name: 'spy', onEvent() {} }))
    registerReporter('spy', factory)
    let error: unknown
    try {
      createReporters(['spy', 'jsno'], capture().ctx)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(UnknownReporterError)
    const e = error as UnknownReporterError
    expect(e.message).toContain('Unknown reporter "jsno"')
    expect(e.message).toContain('expected one of console, github, json, junit, spy, tap')
    expect(e.message).toContain('Did you mean "json"?')
    expect(e.known).toEqual(['console', 'github', 'json', 'junit', 'spy', 'tap'])
    expect(e.suggestion).toBe('json')
    // Validation happens before construction: no half-built reporter set.
    expect(factory).not.toHaveBeenCalled()
  })

  it('omits the suggestion when nothing is close', () => {
    expect(() => createReporters(['xunit-html-fancy'], capture().ctx)).toThrow(
      /expected one of console, github, json, junit, tap\. Set "reporters"/,
    )
  })

  it('lets plugins register reporters, and guards against accidental overrides', async () => {
    const seen: string[] = []
    registerReporter('Recorder', (ctx) => ({
      name: 'recorder',
      onEvent(event) {
        seen.push(event.type)
        ctx.stdout(`saw ${event.type}`)
      },
    }))
    const { ctx, stdout } = capture()
    const [recorder] = createReporters(['recorder'], ctx)
    await drive(recorder, successEvents())
    expect(seen[0]).toBe('run:start')
    expect(seen.at(-1)).toBe('run:end')
    expect(stdout[0]).toBe('saw run:start')

    expect(() => registerReporter('recorder', () => recorder)).toThrow(/already registered/)
    expect(() => registerReporter('console', () => recorder)).toThrow(/override: true/)
    registerReporter('console', () => recorder, { override: true })
    expect(createReporters(['console'], ctx)[0]).toBe(recorder)
    expect(() => registerReporter('has space', () => recorder)).toThrow(/Invalid reporter name/)
    expect(unregisterReporter('recorder')).toBe(true)
    expect(listReporters()).not.toContain('recorder')
  })
})

describe('fanout', () => {
  it('forwards every event to every reporter in order and stays sync for sync reporters', () => {
    const a: string[] = []
    const b: string[] = []
    const fan = fanout([
      { name: 'a', onEvent: (e) => void a.push(e.type) },
      { name: 'b', onEvent: (e) => void b.push(e.type) },
    ])
    expect(fan.name).toBe('fanout(a,b)')
    const result = fan.onEvent({ type: 'warning', message: 'x' })
    expect(result).toBeUndefined()
    fan.onEvent({ type: 'session:end', server: 'local' })
    expect(a).toEqual(['warning', 'session:end'])
    expect(b).toEqual(['warning', 'session:end'])
  })

  it('awaits async reporters and their closes', async () => {
    const log: string[] = []
    const slow: Reporter = {
      name: 'slow',
      async onEvent(e) {
        await new Promise((r) => setTimeout(r, 5))
        log.push(`slow:${e.type}`)
      },
      async close() {
        await new Promise((r) => setTimeout(r, 5))
        log.push('slow:close')
      },
    }
    const fast: Reporter = {
      name: 'fast',
      onEvent: (e) => void log.push(`fast:${e.type}`),
      close: () => void log.push('fast:close'),
    }
    const fan = fanout([slow, fast])
    const pending = fan.onEvent({ type: 'warning', message: 'x' })
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(log).toEqual(['fast:warning', 'slow:warning'])
    await fan.close?.()
    expect(log).toContain('slow:close')
    expect(log).toContain('fast:close')
  })

  it('preserves per-reporter order even when the caller does not await', async () => {
    const order: number[] = []
    let n = 0
    const reporter: Reporter = {
      name: 'async',
      async onEvent() {
        const mine = n++
        await new Promise((r) => setTimeout(r, mine === 0 ? 15 : 1))
        order.push(mine)
      },
    }
    const fan = fanout([reporter])
    void fan.onEvent({ type: 'warning', message: '1' })
    void fan.onEvent({ type: 'warning', message: '2' })
    void fan.onEvent({ type: 'warning', message: '3' })
    await fan.close?.()
    expect(order).toEqual([0, 1, 2])
  })

  it('keeps delivering when one reporter throws, then surfaces the error', async () => {
    const got: string[] = []
    const fan = fanout([
      {
        name: 'broken',
        onEvent() {
          throw new Error('kaboom')
        },
      },
      { name: 'ok', onEvent: (e) => void got.push(e.type) },
    ])
    expect(() => fan.onEvent({ type: 'warning', message: 'x' })).toThrow(
      'Reporter "broken" failed during warning: kaboom',
    )
    expect(got).toEqual(['warning'])
  })

  it('aggregates failures from several reporters, including async closes', async () => {
    const fan = fanout([
      {
        name: 'one',
        onEvent() {},
        async close() {
          throw new Error('disk full')
        },
      },
      {
        name: 'two',
        onEvent() {},
        close() {
          throw new Error('no perms')
        },
      },
    ])
    const err = await Promise.resolve(fan.close?.()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
    expect((err as Error).message).toContain('Reporter "one" failed during close: disk full')
    expect((err as Error).message).toContain('Reporter "two" failed during close: no perms')
  })
})

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

describe('console reporter', () => {
  it('resolves pretty vs plain from ctx.pretty, NO_COLOR, TERM, FORCE_COLOR and TTY', () => {
    expect(resolveStyle(true, {}, true)).toBe('pretty')
    expect(resolveStyle(false, {}, true)).toBe('plain')
    expect(resolveStyle(true, { NO_COLOR: '1' }, true)).toBe('plain')
    expect(resolveStyle(true, { NO_COLOR: '' }, true)).toBe('pretty')
    expect(resolveStyle(true, { TERM: 'dumb' }, true)).toBe('plain')
    expect(resolveStyle(true, {}, false)).toBe('plain')
    expect(resolveStyle(true, { FORCE_COLOR: '1' }, false)).toBe('pretty')
    expect(resolveStyle(true, { FORCE_COLOR: '0' }, false)).toBe('plain')
    const { ctx } = capture({ pretty: true })
    expect(new ConsoleReporter(ctx, { env: { NO_COLOR: '1' }, isTTY: true }).style).toBe('plain')
    expect(new ConsoleReporter(ctx, { env: {}, isTTY: false }).style).toBe('plain')
    expect(new ConsoleReporter(ctx, { env: {}, isTTY: true }).style).toBe('pretty')
  })

  it('is quiet on success: header, one line per case, summary', async () => {
    const { ctx, stdout, stderr } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), successEvents())
    expect(stdout).toEqual([
      'vibrissa: running 2 cases on local',
      '  > local: modern protocol 2026-07-28',
      'PASS manifest tests/integration/__manifest__.json',
      'PASS echo returns input (12ms)',
      'PASS create then fetch (2 steps, 14ms)',
      '',
      'Manifest: ok (1)',
      'Result: PASSED - 2 cases: 2 passed, 0 failed, 0 skipped, 0 updated in 345ms',
    ])
    expect(stderr).toEqual([])
  })

  it('plain mode renders failures loudly and stays ASCII (snapshot)', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), mixedEvents(tmpDir))
    const text = `${stdout.join('\n')}\n`
    // Printable ASCII only: no ANSI escapes, no unicode glyphs.
    expect(text).toMatch(/^[ -~\n]*$/)
    await expect(text).toMatchFileSnapshot(path.join(FIXTURES, 'console-plain-mixed.txt'))
  })

  it('plain mode shows per-case lines, flow steps, diff, mismatches, budget and trace', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), mixedEvents(tmpDir))
    expect(stdout).toContain('FAIL create then fetch (14ms)')
    expect(stdout).toContain('    PASS 1. create [tool session.create] (5ms)')
    expect(stdout).toContain('    FAIL 2. get [tool session.get] (9ms)')
    expect(stdout).toContain('    SKIP 3. tool session.close (skipped)')
    expect(stdout).toContain('SKIP not ready yet (skipped: waiting on server fix)')
    expect(stdout).toContain('UPD  record greeting (golden updated, 4ms)')
    expect(stdout).toContain('FAIL slow call (812ms) over 800ms budget')
    expect(stdout).toContain('WARN check: list results carry ttlMs')
    expect(stdout).toContain('FAIL check: description lint')
    expect(stdout).toContain('    - content[0].text: expected "HELLO", got "hello"')
    expect(stdout).toContain('  Trace: reports/traces/upper.ndjson')
    expect(stdout).toContain('  Budget exceeded: took 812ms, budget 800ms')
    expect(stdout.some((l) => l.includes('- expected'))).toBe(true)
    expect(stdout.some((l) => l.includes('+ actual'))).toBe(true)
    expect(stdout.at(-1)).toBe(
      'Result: FAILED - 6 cases: 1 passed, 3 failed, 1 skipped, 1 updated in 1.23s',
    )
  })

  it('omits keys a $partial expectation does not mention from the diff', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), mixedEvents(tmpDir))
    const start = stdout.findIndex((l) => l.startsWith('FAIL create then fetch cases/flow.json'))
    const end = stdout.findIndex((l, i) => i > start && l.startsWith('FAIL upper mismatch'))
    const block = stdout.slice(start, end).join('\n')
    expect(block).toContain('-     "user": "jordan"')
    expect(block).toContain('+     "user": "jo"')
    expect(block).not.toContain('sessionId')
    expect(block).not.toContain('$partial')
  })

  it('caps the mismatch list', async () => {
    const mismatches = Array.from({ length: 15 }, (_, i) => ({
      path: `items[${i}]`,
      message: `expected ${i}, got ${i + 1}`,
    }))
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), [
      { type: 'run:start', totalCases: 1, servers: ['local'], startedAt: STARTED_AT },
      ...caseEvents(echo, { status: 'failed', durationMs: 1, mismatches }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 1 },
      },
    ])
    expect(stdout).toContain('  Mismatches (15):')
    expect(stdout).toContain('    - items[9]: expected 9, got 10')
    expect(stdout).not.toContain('    - items[10]: expected 10, got 11')
    expect(stdout).toContain('    ... and 5 more')
    // Without a reason, the headline is synthesized from the first mismatch.
    expect(stdout).toContain('  Expectation failed at items[0]: expected 0, got 1 (+14 more)')
  })

  it('reports pass rates and lists flaky cases when repeating', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), repeatEvents())
    expect(stdout).toContain('PASS stable echo #1 (11ms)')
    expect(stdout).toContain('FAIL flaky clock #2 (22ms)')
    expect(stdout[0]).toBe('vibrissa: running 6 cases on local (repeat 3)')
    expect(stdout).toContain('Pass rates: 2 repeated cases, 1 flaky')
    expect(stdout).toContain('  ~ flaky clock: 2/3 passed (67%) [declared flaky]')
    // run:end.ok wins over our own derivation (a failure is tolerated by the flaky floor).
    expect(stdout.at(-1)).toBe(
      'Result: PASSED - 6 cases: 5 passed, 1 failed, 0 skipped, 0 updated in 99ms',
    )
  })

  it('shows server identity, error kinds and captured stderr', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), [
      ...mixedEvents(tmpDir).slice(0, 2),
      ...caseEvents(echo, {
        status: 'failed',
        durationMs: 15000,
        errorKind: 'timeout',
        reason: 'Case timeout exceeded (15000ms)',
        stderrPath: path.join(tmpDir, 'reports', 'traces', 'echo.stderr.log'),
      }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 15000 },
      },
    ])
    expect(stdout[1]).toBe('  > local: echo-server 1.2.0, modern protocol 2026-07-28')
    expect(stdout).toContain('FAIL echo returns input (timeout, 15.00s)')
    expect(stdout).toContain('FAIL echo returns input cases/echo.json [timeout]')
    expect(stdout).toContain('  Stderr: reports/traces/echo.stderr.log')
  })

  it('pretty mode uses colors, glyphs and the v1-style summary box', async () => {
    const { ctx, stdout } = capture({ pretty: true })
    await drive(new ConsoleReporter(ctx, { style: 'pretty' }), mixedEvents(tmpDir))
    expect(stdout.some((l) => l.includes('\x1b['))).toBe(true)
    const plain = stdout.map(stripAnsi)
    expect(plain).toContain('✓ echo returns input (12ms)')
    expect(plain).toContain('✗ create then fetch (14ms)')
    expect(plain).toContain('    ✓ 1. create [tool session.create] (5ms)')
    expect(plain).toContain('↓ not ready yet (skipped: waiting on server fix)')
    expect(plain).toContain('✎ record greeting (golden updated, 4ms)')
    expect(plain).toContain('⚠ check: list results carry ttlMs')
    expect(plain.some((l) => l.startsWith(' FAIL  upper mismatch'))).toBe(true)
    const box = plain.filter((l) => l.startsWith('+') || l.startsWith('|'))
    expect(box.length).toBeGreaterThan(4)
    for (const line of box) expect(line).toHaveLength(64)
    expect(box.some((l) => l.includes('vibrissa results'))).toBe(true)
    expect(
      box.some((l) => l.includes('Total: 6 | Passed: 1 | Failed: 3 | Skipped: 1 | Updated: 1')),
    ).toBe(true)
    expect(box.some((l) => l.includes('Duration: 1.23s'))).toBe(true)
    expect(box.some((l) => l.includes('Checks: 1 passed, 1 failed, 1 warned'))).toBe(true)
    expect(box.some((l) => l.includes('Manifest: drift in 1 of 1'))).toBe(true)
  })

  it('labels cases with their server when the run spans several servers', async () => {
    const staging = ref('echo returns input', 'cases/echo.json', {
      server: 'staging',
      id: 'cases/echo.json@staging',
    })
    const events: RunEvent[] = [
      { type: 'run:start', totalCases: 2, servers: ['local', 'staging'], startedAt: STARTED_AT },
      { type: 'manifest:ok', path: 'tests/staging.manifest.json', server: 'staging' },
      {
        type: 'check',
        outcome: {
          id: 'list-stable',
          server: 'staging',
          title: 'tools/list is stable',
          status: 'passed',
        },
      },
      ...caseEvents(echo, { status: 'passed', durationMs: 1 }),
      ...caseEvents(staging, { status: 'failed', durationMs: 2, reason: 'boom' }),
      {
        type: 'run:end',
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, updated: 0, durationMs: 3 },
      },
    ]
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), events)
    expect(stdout).toContain('vibrissa: running 2 cases on local, staging')
    expect(stdout).toContain('PASS [local] echo returns input (1ms)')
    expect(stdout).toContain('FAIL [staging] echo returns input (2ms)')
    expect(stdout).toContain('PASS manifest [staging] tests/staging.manifest.json')
    expect(stdout).toContain('PASS check: [staging] tools/list is stable')

    const junit = capture()
    await drive(new JunitReporter(junit.ctx), events)
    const suites = readJunit(tmpDir).children
    expect(suites.map((x) => [x.attrs.name, x.attrs.tests, x.attrs.failures])).toEqual([
      ['local', '1', '0'],
      ['staging', '1', '1'],
      ['vibrissa:manifest', '1', '0'],
      ['vibrissa:checks', '1', '0'],
    ])
    expect(suites[3].children[0].attrs.name).toBe('tools/list is stable (staging)')

    const json = capture()
    await drive(new JsonReporter(json.ctx), events)
    expect(readJson(tmpDir).manifests).toEqual([
      { path: 'tests/staging.manifest.json', server: 'staging', status: 'ok' },
    ])
  })

  it('wraps the box counts row when numbers are large', async () => {
    const { ctx, stdout } = capture({ pretty: true })
    await drive(new ConsoleReporter(ctx, { style: 'pretty' }), [
      {
        type: 'run:end',
        summary: {
          total: 123456,
          passed: 123000,
          failed: 400,
          skipped: 50,
          updated: 6,
          durationMs: 1,
        },
      },
    ])
    const box = stdout.map(stripAnsi).filter((l) => l.startsWith('|'))
    for (const line of box) expect(line).toHaveLength(64)
    expect(box.some((l) => l.includes('Updated: 6'))).toBe(true)
  })

  it('still prints a summary when closed without run:end', async () => {
    const { ctx, stdout } = capture()
    const reporter = new ConsoleReporter(ctx, { style: 'plain' })
    await drive(reporter, mixedEvents(tmpDir).slice(0, 8))
    expect(stdout).toContain('Run ended before completion (no run:end received)')
    expect(stdout.at(-1)).toMatch(/^Result: INCOMPLETE - 1 case: 1 passed/)
  })

  it('neutralizes GitHub workflow commands smuggled through server output', async () => {
    const { ctx, stdout } = capture()
    await drive(new ConsoleReporter(ctx, { style: 'plain' }), [
      ...caseEvents(echo, {
        status: 'failed',
        durationMs: 1,
        reason: '::error::fake',
        expected: 'line one\nline two',
        actual: 'line one\n::set-output name=x::pwned',
      }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 1 },
      },
    ])
    for (const line of stdout) expect(line.trimStart().startsWith('::')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function readJson(dir: string): JsonReport {
  return JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'results.json'), 'utf8'))
}

describe('json reporter', () => {
  it('writes a stable results.json document', async () => {
    const { ctx, stderr } = capture()
    await drive(new JsonReporter(ctx), mixedEvents(tmpDir))
    const doc = readJson(tmpDir)
    expect(stderr).toEqual(['vibrissa: wrote reports/results.json'])
    expect(doc.version).toBe(1)
    expect(doc.generator).toBe('vibrissa')
    expect(doc.ok).toBe(false)
    expect(doc.complete).toBe(true)
    expect(doc.startedAt).toBe('2026-10-28T12:00:00.000Z')
    expect(doc.finishedAt).toBe('2026-10-28T12:00:01.234Z')
    expect(doc.servers).toEqual([
      {
        name: 'local',
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'echo-server', version: '1.2.0' },
      },
    ])
    expect(doc.summary).toEqual({
      total: 6,
      passed: 1,
      failed: 3,
      skipped: 1,
      updated: 1,
      durationMs: 1234,
      flaky: [],
      checks: { passed: 1, failed: 1, warned: 1 },
      manifestDrift: 1,
      warnings: 1,
    })
    // Sorted by caseId for stable diffs / baseline comparison.
    expect(doc.cases.map((c) => c.id)).toEqual([
      'cases/echo.json',
      'cases/flow.json',
      'cases/greet.json',
      'cases/skip.json',
      'cases/slow.json',
      'cases/upper.json',
    ])
    for (const c of doc.cases) {
      expect(typeof c.caseId).toBe('string')
      expect(typeof c.status).toBe('string')
      expect(typeof c.durationMs).toBe('number')
    }
    const byId = Object.fromEntries(doc.cases.map((c) => [c.id, c]))
    expect(byId['cases/echo.json']).toEqual({
      id: 'cases/echo.json',
      caseId: 'cases/echo.json',
      name: 'echo returns input',
      file: 'cases/echo.json',
      server: 'local',
      tags: ['smoke'],
      status: 'passed',
      durationMs: 12,
    })
    const upperCase = byId['cases/upper.json']
    expect(upperCase.status).toBe('failed')
    expect(upperCase.mismatches).toHaveLength(2)
    expect(upperCase.expected).toEqual({ content: [{ type: 'text', text: 'HELLO' }] })
    expect(upperCase.tracePath).toBe('reports/traces/upper.ndjson')
    expect(upperCase.stderrPath).toBe('reports/traces/upper.stderr.log')
    expect(upperCase.errorKind).toBe('assertion')
    expect(upperCase.line).toBe(3)
    expect(byId['cases/slow.json'].errorKind).toBe('budget')
    // Steps gathered from step:end when the outcome omits them.
    expect(byId['cases/flow.json'].steps).toEqual([
      {
        index: 0,
        name: 'create',
        kind: 'tool',
        target: 'session.create',
        status: 'passed',
        durationMs: 5,
      },
      {
        index: 1,
        name: 'get',
        kind: 'tool',
        target: 'session.get',
        status: 'failed',
        durationMs: 9,
        reason: 'Expectation failed at structuredContent.user: expected "jordan", got "jo"',
      },
      {
        index: 2,
        name: 'session.close',
        kind: 'tool',
        target: 'session.close',
        status: 'skipped',
        durationMs: 0,
      },
    ])
    expect(byId['cases/slow.json'].budget).toEqual({ budgetMs: 800, actualMs: 812 })
    expect(byId['cases/skip.json'].reason).toBe('waiting on server fix')
    expect(doc.checks.map((c) => c.status)).toEqual(['passed', 'warned', 'failed'])
    expect(doc.checks[2]).toEqual({
      id: 'desc-lint',
      server: 'local',
      title: 'description lint',
      status: 'failed',
      detail: 'echo: hidden instruction "<IMPORTANT>"',
    })
    expect(doc.manifests).toEqual([
      {
        path: 'tests/integration/__manifest__.json',
        server: 'local',
        status: 'diff',
        summary: '1 tool changed: echo (description)',
        diff: {
          tools: {
            changed: [
              { name: 'echo', field: 'description', before: 'Echo', after: 'Echo <IMPORTANT>' },
            ],
          },
        },
      },
    ])
    expect(doc.warnings).toEqual(['cases/legacy.json uses the v1 "error" key; run vib migrate'])
  })

  it('is ok:true for a clean run', async () => {
    const { ctx } = capture()
    await drive(new JsonReporter(ctx), successEvents())
    const doc = readJson(tmpDir)
    expect(doc.ok).toBe(true)
    expect(doc.manifests).toEqual([{ path: 'tests/integration/__manifest__.json', status: 'ok' }])
  })

  it('records repeat runs with caseId/run, pass rates and flaky ids', async () => {
    const { ctx } = capture()
    await drive(new JsonReporter(ctx), repeatEvents())
    const doc = readJson(tmpDir)
    expect(doc.cases.map((c) => [c.id, c.caseId, c.run, c.status])).toEqual([
      ['cases/a.json#1', 'cases/a.json', 1, 'passed'],
      ['cases/a.json#2', 'cases/a.json', 2, 'passed'],
      ['cases/a.json#3', 'cases/a.json', 3, 'passed'],
      ['cases/b.json#1', 'cases/b.json', 1, 'passed'],
      ['cases/b.json#2', 'cases/b.json', 2, 'failed'],
      ['cases/b.json#3', 'cases/b.json', 3, 'passed'],
    ])
    expect(doc.summary.passRates).toEqual({ 'cases/a.json': 1, 'cases/b.json': 2 / 3 })
    expect(doc.summary.flaky).toEqual(['cases/b.json'])
    expect(doc.summary.repeat).toBe(3)
    expect(doc.cases.filter((c) => c.flaky).map((c) => c.id)).toEqual([
      'cases/b.json#1',
      'cases/b.json#2',
      'cases/b.json#3',
    ])
    // run:end.ok is authoritative even though one run failed.
    expect(doc.ok).toBe(true)
  })

  it('derives ok itself when run:end carries no verdict', async () => {
    const { ctx } = capture()
    const events = repeatEvents()
    const end = events.at(-1) as Extract<RunEvent, { type: 'run:end' }>
    events[events.length - 1] = { type: 'run:end', summary: end.summary }
    await drive(new JsonReporter(ctx), events)
    expect(readJson(tmpDir).ok).toBe(false)
  })

  it('serializes non-JSON values safely', async () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const { ctx } = capture()
    await drive(new JsonReporter(ctx), [
      ...caseEvents(echo, {
        status: 'failed',
        durationMs: 1,
        mismatches: [
          { path: 'a', message: 'big', expected: 10n, actual: undefined },
          { path: 'b', message: 'cycle', actual: circular },
        ],
      }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 1 },
      },
    ])
    const doc = readJson(tmpDir)
    expect(doc.cases[0].mismatches).toEqual([
      { path: 'a', message: 'big', expected: '10' },
      { path: 'b', message: 'cycle', actual: { a: 1, self: '[Circular]' } },
    ])
  })

  it('marks the document incomplete when closed without run:end', async () => {
    const { ctx } = capture()
    await drive(new JsonReporter(ctx), mixedEvents(tmpDir).slice(0, 8))
    const doc = readJson(tmpDir)
    expect(doc.complete).toBe(false)
    expect(doc.ok).toBe(false)
    expect(doc.finishedAt).toBeNull()
    expect(doc.summary.total).toBe(1)
    expect(doc.summary.passed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

/** Minimal strict XML parser: well-formedness, quoting, entities, CDATA, nesting. */
function parseXml(xml: string): XmlNode {
  let i = 0
  const fail = (msg: string): never => {
    throw new Error(`${msg} at offset ${i}: ${JSON.stringify(xml.slice(i, i + 40))}`)
  }
  const decode = (raw: string): string => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) fail('bad entity')
    return raw
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }
  const skipWs = () => {
    while (i < xml.length && /\s/.test(xml[i])) i++
  }
  const decl = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.exec(xml)
  if (!decl) fail('missing XML declaration')
  i = (decl as RegExpExecArray)[0].length

  const element = (): XmlNode => {
    if (xml[i] !== '<') fail('expected <')
    i++
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(xml.slice(i))
    if (!nameMatch) fail('bad element name')
    const name = (nameMatch as RegExpExecArray)[0]
    i += name.length
    const node: XmlNode = { name, attrs: {}, children: [], text: '' }
    for (;;) {
      skipWs()
      if (xml.startsWith('/>', i)) {
        i += 2
        return node
      }
      if (xml[i] === '>') {
        i++
        break
      }
      const attr = /^([A-Za-z_][\w:.-]*)="([^"<]*)"/.exec(xml.slice(i))
      if (!attr) fail('bad attribute')
      const [whole, key, value] = attr as RegExpExecArray
      if (key in node.attrs) fail(`duplicate attribute ${key}`)
      node.attrs[key] = decode(value)
      i += whole.length
    }
    for (;;) {
      if (i >= xml.length) fail(`unclosed <${name}>`)
      if (xml.startsWith('<![CDATA[', i)) {
        const end = xml.indexOf(']]>', i)
        if (end === -1) fail('unterminated CDATA')
        node.text += xml.slice(i + 9, end)
        i = end + 3
      } else if (xml.startsWith('</', i)) {
        const close = `</${name}>`
        if (!xml.startsWith(close, i)) fail(`mismatched close for <${name}>`)
        i += close.length
        return node
      } else if (xml[i] === '<') {
        node.children.push(element())
      } else {
        const next = xml.indexOf('<', i)
        const raw = xml.slice(i, next === -1 ? xml.length : next)
        if (raw.includes(']]>')) fail('raw ]]> in text')
        node.text += decode(raw)
        i += raw.length
      }
    }
  }
  const root = element()
  skipWs()
  if (i !== xml.length) fail('trailing content')
  return root
}

function readJunit(dir: string): XmlNode {
  return parseXml(fs.readFileSync(path.join(dir, 'reports', 'junit.xml'), 'utf8'))
}

describe('junit reporter', () => {
  it('writes well-formed JUnit XML in the common testsuites/testsuite/testcase shape', async () => {
    const { ctx, stderr } = capture()
    await drive(new JunitReporter(ctx), mixedEvents(tmpDir))
    expect(stderr).toEqual(['vibrissa: wrote reports/junit.xml'])
    const root = readJunit(tmpDir)
    expect(root.name).toBe('testsuites')
    expect(root.attrs).toEqual({
      name: 'vibrissa',
      tests: '10',
      failures: '5',
      errors: '0',
      skipped: '1',
      time: '1.234',
    })
    expect(root.children.map((s) => s.attrs.name)).toEqual([
      'local',
      'vibrissa:manifest',
      'vibrissa:checks',
    ])
    for (const suite of root.children) {
      expect(suite.name).toBe('testsuite')
      for (const key of ['name', 'tests', 'failures', 'errors', 'skipped', 'time', 'timestamp']) {
        expect(suite.attrs[key], `${suite.attrs.name}.${key}`).toBeDefined()
      }
      expect(suite.attrs.timestamp).toBe('2026-10-28T12:00:00')
      const cases = suite.children.filter((c) => c.name === 'testcase')
      expect(Number(suite.attrs.tests)).toBe(cases.length)
      expect(Number(suite.attrs.failures)).toBe(
        cases.filter((c) => c.children.some((x) => x.name === 'failure')).length,
      )
      expect(Number(suite.attrs.skipped)).toBe(
        cases.filter((c) => c.children.some((x) => x.name === 'skipped')).length,
      )
      for (const tc of cases) {
        expect(tc.attrs.classname).toBeTruthy()
        expect(tc.attrs.name).toBeTruthy()
        expect(tc.attrs.time).toMatch(/^\d+\.\d{3}$/)
      }
    }

    const local = root.children[0]
    expect(local.attrs).toMatchObject({ tests: '6', failures: '3', skipped: '1', time: '0.850' })
    expect(local.children[0]).toEqual({
      name: 'properties',
      attrs: {},
      text: expect.any(String),
      children: [
        { name: 'property', attrs: { name: 'era', value: 'modern' }, children: [], text: '' },
        {
          name: 'property',
          attrs: { name: 'protocolVersion', value: '2026-07-28' },
          children: [],
          text: '',
        },
      ],
    })
    const tcs = Object.fromEntries(
      local.children.filter((c) => c.name === 'testcase').map((c) => [c.attrs.name, c]),
    )
    expect(tcs['echo returns input'].attrs).toEqual({
      classname: 'cases/echo.json',
      name: 'echo returns input',
      time: '0.012',
      file: 'cases/echo.json',
    })
    const failure = tcs['upper mismatch'].children[0]
    expect(failure.name).toBe('failure')
    expect(failure.attrs.message).toBe(
      'Expectation failed at content[0].text: expected "HELLO", got "hello"',
    )
    expect(failure.attrs.type).toBe('ExpectationFailed')
    expect(failure.text).toContain('Mismatches (2):')
    expect(failure.text).toContain('-       "text": "HELLO"')
    expect(failure.text).toContain('+       "text": "hello"')
    expect(failure.text).toContain('Trace: reports/traces/upper.ndjson')
    expect(failure.text).toContain('Stderr: reports/traces/upper.stderr.log')
    expect(tcs['upper mismatch'].attrs.line).toBe('3')
    expect(tcs['create then fetch'].children[0].text).toContain(
      '[failed] 2. get [tool session.get] (9ms)',
    )
    expect(tcs['slow call'].children[0].attrs.type).toBe('BudgetExceeded')
    expect(tcs['not ready yet'].children[0]).toEqual({
      name: 'skipped',
      attrs: { message: 'waiting on server fix' },
      children: [],
      text: '',
    })
    expect(tcs['record greeting'].children[0].name).toBe('system-out')
    expect(tcs['record greeting'].children[0].text).toContain('Golden updated')

    const manifest = root.children[1]
    expect(manifest.children[0].attrs.classname).toBe('tests/integration/__manifest__.json')
    expect(manifest.children[0].attrs.name).toBe('manifest lock (local)')
    expect(manifest.children[0].children[0].attrs).toEqual({
      message: '1 tool changed: echo (description)',
      type: 'ManifestDrift',
    })
    expect(manifest.children[0].children[0].text).toContain('Echo <IMPORTANT>')

    const checks = root.children[2]
    expect(checks.attrs).toMatchObject({ tests: '3', failures: '1' })
    expect(checks.children.map((c) => c.children[0]?.name ?? 'pass')).toEqual([
      'pass',
      'system-out',
      'failure',
    ])
  })

  it('escapes attributes and keeps CDATA from being terminated early', async () => {
    const nasty = ref('a <b> & "c" \'d\'\nnext', 'cases/x&y.json')
    const { ctx } = capture()
    await drive(new JunitReporter(ctx), [
      ...caseEvents(nasty, {
        status: 'failed',
        durationMs: 3,
        reason: 'boom ]]> <not-a-tag> & \u0007bell',
      }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 3 },
      },
    ])
    const raw = fs.readFileSync(path.join(tmpDir, 'reports', 'junit.xml'), 'utf8')
    expect(raw).not.toContain('\u0007')
    const tc = readJunit(tmpDir).children[0].children[0]
    expect(tc.attrs.name).toBe('a <b> & "c" \'d\'\nnext')
    expect(tc.attrs.classname).toBe('cases/x&y.json')
    expect(tc.children[0].attrs.message).toBe('boom ]]> <not-a-tag> & bell')
    expect(tc.children[0].text).toContain('boom ]]> <not-a-tag> & bell')
  })

  it('suffixes repeated runs so testcase names stay unique', async () => {
    const { ctx } = capture()
    await drive(new JunitReporter(ctx), repeatEvents())
    const names = readJunit(tmpDir)
      .children[0].children.filter((c) => c.name === 'testcase')
      .map((c) => c.attrs.name)
    expect(names).toEqual([
      'stable echo (run 1)',
      'stable echo (run 2)',
      'stable echo (run 3)',
      'flaky clock (run 1)',
      'flaky clock (run 2)',
      'flaky clock (run 3)',
    ])
  })

  it('reports errors, timeouts and load failures as <error>, assertions as <failure>', async () => {
    const { ctx } = capture()
    await drive(new JunitReporter(ctx), timeoutEvents())
    const root = readJunit(tmpDir)
    expect(root.attrs).toMatchObject({ tests: '3', failures: '1', errors: '2' })
    const suite = root.children[0]
    expect(suite.attrs).toMatchObject({ tests: '3', failures: '1', errors: '2' })
    const byName = Object.fromEntries(suite.children.map((c) => [c.attrs.name, c]))
    expect(byName['hangs forever'].attrs.line).toBe('2')
    expect(byName['hangs forever'].children[0].name).toBe('error')
    expect(byName['hangs forever'].children[0].attrs).toEqual({
      message: 'Case timeout exceeded (15000ms)',
      type: 'Timeout',
    })
    expect(byName['bad json'].children[0].name).toBe('error')
    expect(byName['bad json'].children[0].attrs.type).toBe('LoadError')
    expect(byName['upper mismatch'].children[0].name).toBe('failure')
  })

  it('escape helpers', () => {
    expect(escapeXmlAttr('<a href="x">&\'\n')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&#10;')
    expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>')
  })
})

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe('github reporter', () => {
  function actionsEnv(summaryFile: string) {
    return { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile, GITHUB_WORKSPACE: tmpDir }
  }

  it('emits annotations, groups flows, and appends the job summary in Actions', async () => {
    const summaryFile = path.join(tmpDir, 'step-summary.md')
    fs.writeFileSync(summaryFile, '# Earlier step\n')
    const { ctx, stdout, stderr } = capture({ rootDir: path.join(tmpDir, 'pkg') })
    const reporter = new GithubReporter(ctx, { env: actionsEnv(summaryFile) })
    expect(reporter.annotating).toBe(true)
    await drive(reporter, mixedEvents(path.join(tmpDir, 'pkg')))
    expect(stderr).toEqual([])

    // Paths are relative to the repo root (GITHUB_WORKSPACE), not the vibrissa root.
    expect(stdout).toContain(
      '::error file=pkg/cases/upper.json,line=3,title=Vibrissa%3A upper mismatch failed::Expectation failed at content[0].text: expected "HELLO", got "hello"%0A  content[0].text: expected "HELLO", got "hello"%0A  (root): unexpected key "isError" (use "$partial": true to allow extra fields)%0ATrace: reports/traces/upper.ndjson%0AStderr: reports/traces/upper.stderr.log',
    )
    expect(stdout).toContain(
      '::error file=pkg/tests/integration/__manifest__.json,title=Vibrissa%3A manifest drift (local)::1 tool changed: echo (description)%0AReview the change, then rerun with --update-manifest to accept it.',
    )
    expect(stdout).toContain(
      '::warning title=Vibrissa check warning%3A list results carry ttlMs::tools/list has no ttlMs',
    )
    expect(stdout).toContain(
      '::error title=Vibrissa check failed%3A description lint (local)::echo: hidden instruction "<IMPORTANT>"',
    )
    expect(stdout).toContain(
      '::warning title=Vibrissa::cases/legacy.json uses the v1 "error" key; run vib migrate',
    )
    const groupStart = stdout.indexOf('::group::✗ create then fetch (3 steps, 14ms)')
    expect(groupStart).toBeGreaterThan(-1)
    expect(stdout.slice(groupStart + 1, groupStart + 5)).toEqual([
      '  ✓ 1. create [tool session.create] (5ms)',
      '  ✗ 2. get [tool session.get] (9ms) - Expectation failed at structuredContent.user: expected "jordan", got "jo"',
      '  ↓ 3. tool session.close (0ms)',
      '::endgroup::',
    ])
    // Passing single-call cases produce no output: the console reporter covers those.
    expect(stdout.some((l) => l.includes('echo returns input'))).toBe(false)

    const md = fs.readFileSync(summaryFile, 'utf8')
    expect(md.startsWith('# Earlier step\n')).toBe(true)
    expect(md).toContain('## Vibrissa results: ❌ Failed')
    expect(md).toContain('| Result | Total | Passed | Failed | Skipped | Updated | Duration |')
    expect(md).toContain('| ❌ Failed | 6 | 1 | 3 | 1 | 1 | 1.23s |')
    expect(md).toContain('### ❌ Failures (3)')
    expect(md).toContain(
      '| upper mismatch | `cases/upper.json` | local | 8ms | Expectation failed at content[0].text: expected "HELLO", got "hello" |',
    )
    expect(md).toContain('<details><summary>upper mismatch</summary>')
    expect(md).toContain('```diff')
    expect(md).toContain('| ⚠️ | list results carry ttlMs | tools/list has no ttlMs |')
    expect(md).toContain(
      '| ❌ | description lint (local) | echo: hidden instruction "&lt;IMPORTANT&gt;" |',
    )
    expect(md).toContain('Servers: `local` (echo-server 1.2.0, modern 2026-07-28)')
    expect(md).toContain(
      '| ❌ | `tests/integration/__manifest__.json` (local) | 1 tool changed: echo (description) |',
    )
    expect(md).toContain('<details><summary>All cases (6)</summary>')
    expect(fs.existsSync(path.join(tmpDir, 'pkg', 'reports', 'summary.md'))).toBe(false)
  })

  it('lists pass rates in the summary when repeating', async () => {
    const summaryFile = path.join(tmpDir, 'step-summary.md')
    const { ctx } = capture()
    await drive(new GithubReporter(ctx, { env: actionsEnv(summaryFile) }), repeatEvents())
    const md = fs.readFileSync(summaryFile, 'utf8')
    expect(md).toContain('### Pass rates (2 repeated cases, 1 flaky)')
    expect(md).toContain('## Vibrissa results: ✅ Passed')
    expect(md).toContain('| flaky clock | 2/3 | 67% | flaky (declared flaky) |')
    expect(md).toContain('| stable echo | 3/3 | 100% | stable |')
  })

  it('is quiet outside Actions and writes <outDir>/summary.md instead', async () => {
    const { ctx, stdout, stderr } = capture()
    const reporter = new GithubReporter(ctx, { env: {} })
    expect(reporter.annotating).toBe(false)
    await drive(reporter, successEvents())
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['vibrissa: wrote reports/summary.md'])
    const md = fs.readFileSync(path.join(tmpDir, 'reports', 'summary.md'), 'utf8')
    expect(md).toContain('## Vibrissa results: ✅ Passed')
    expect(md).toContain('| ✅ Passed | 2 | 2 | 0 | 0 | 0 | 345ms |')
    expect(md).not.toContain('Failures')
  })

  it('escapes workflow command data and properties so messages cannot inject commands', () => {
    expect(escapeData('50%\r\n::warning::x')).toBe('50%25%0D%0A::warning::x')
    expect(escapeProperty('a:b,c\n')).toBe('a%3Ab%2Cc%0A')
    expect(workflowCommand('error', { file: 'a,b.json', title: undefined }, 'x\n::y')).toBe(
      '::error file=a%2Cb.json::x%0A::y',
    )
  })

  it('words annotations by error kind and points at the case line', async () => {
    const { ctx, stdout } = capture()
    await drive(
      new GithubReporter(ctx, { env: { GITHUB_ACTIONS: 'true' }, annotations: 'always' }),
      [...timeoutEvents()],
    )
    expect(stdout).toContain(
      '::error file=cases/hang.json,line=2,title=Vibrissa%3A hangs forever timed out::Case timeout exceeded (15000ms)',
    )
    expect(stdout).toContain(
      '::error file=cases/broken.json,title=Vibrissa%3A bad json failed to load::Failed to load case file: Unexpected token',
    )
    expect(stdout.some((l) => l.includes('upper mismatch failed::'))).toBe(true)
  })

  it('escapes markdown table cells', async () => {
    const pipe = ref('a | b <c>', 'cases/p.json')
    const summaryFile = path.join(tmpDir, 'step-summary.md')
    const { ctx } = capture()
    await drive(new GithubReporter(ctx, { env: actionsEnv(summaryFile) }), [
      ...caseEvents(pipe, { status: 'failed', durationMs: 1, reason: 'line1\nline2 | x' }),
      {
        type: 'run:end',
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, updated: 0, durationMs: 1 },
      },
    ])
    const md = fs.readFileSync(summaryFile, 'utf8')
    expect(md).toContain('| a \\| b &lt;c&gt; | `cases/p.json` | local | 1ms | line1 |')
  })
})

// ---------------------------------------------------------------------------
// TAP
// ---------------------------------------------------------------------------

describe('tap reporter', () => {
  it('emits TAP 14 with a trailing plan, YAML diagnostics and flow subtests (snapshot)', async () => {
    const { ctx, stdout } = capture()
    await drive(new TapReporter(ctx), mixedEvents(tmpDir))
    expect(stdout[0]).toBe('TAP version 14')
    // Top-level points are numbered 1..N and the plan matches.
    const points = stdout.filter((l) => /^(not )?ok \d+/.test(l))
    const numbers = points.map((l) => Number(/^(?:not )?ok (\d+)/.exec(l)?.[1]))
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    expect(stdout).toContain(`1..${points.length}`)
    expect(points.length).toBe(10) // 1 manifest + 3 checks + 6 cases
    expect(stdout).toContain('# session local: echo-server 1.2.0, modern protocol 2026-07-28')
    expect(stdout).toContain(
      'not ok 1 - manifest drift tests/integration/__manifest__.json (local)',
    )
    expect(stdout).toContain('ok 3 - check: list results carry ttlMs')
    expect(stdout).toContain('not ok 4 - check: description lint (local)')
    expect(stdout).toContain('ok 8 - not ready yet # SKIP waiting on server fix')
    // Flow subtest, indented 4 spaces with its own plan, before the parent point.
    const sub = stdout.indexOf('# Subtest: create then fetch')
    expect(sub).toBeGreaterThan(-1)
    expect(stdout.slice(sub + 1)).toContain('    ok 1 - 1. create [tool session.create]')
    expect(stdout).toContain('    not ok 2 - 2. get [tool session.get]')
    expect(stdout).toContain('    ok 3 - 3. tool session.close # SKIP')
    expect(stdout.indexOf('    1..3')).toBeLessThan(stdout.indexOf('not ok 6 - create then fetch'))
    // YAML block for a failure.
    const fail = stdout.indexOf('not ok 7 - upper mismatch')
    expect(stdout.slice(fail + 1, fail + 10)).toEqual([
      '  ---',
      '  duration_ms: 8',
      '  message: "Expectation failed at content[0].text: expected \\"HELLO\\", got \\"hello\\""',
      '  severity: fail',
      '  file: "cases/upper.json"',
      '  server: local',
      '  line: 3',
      '  error_kind: assertion',
      '  mismatches:',
    ])
    expect(stdout).toContain('  stderr: "reports/traces/upper.stderr.log"')
    expect(stdout).toContain('    - path: "content[0].text"')
    expect(stdout).toContain('      message: "expected \\"HELLO\\", got \\"hello\\""')
    expect(stdout).toContain('  diff: |-')
    expect(stdout).toContain('  status: updated')
    expect(stdout).toContain(
      '# warning: cases/legacy.json uses the v1 "error" key; run vib migrate',
    )
    expect(stdout).toContain('# fail 3')
    await expect(`${stdout.join('\n')}\n`).toMatchFileSnapshot(path.join(FIXTURES, 'tap-mixed.tap'))
  })

  it('escapes # and backslashes in descriptions', () => {
    expect(escapeDescription('a # b \\ c\nd')).toBe('a \\# b \\\\ c d')
  })

  it('bails out when closed without run:end', async () => {
    const { ctx, stdout } = capture()
    await drive(new TapReporter(ctx), successEvents().slice(0, 5))
    expect(stdout.slice(-2)).toEqual([
      '1..2',
      'Bail out! Run ended before completion (no run:end received)',
    ])
  })

  it('lists flaky cases in trailing comments', async () => {
    const { ctx, stdout } = capture()
    await drive(new TapReporter(ctx), repeatEvents())
    expect(stdout).toContain('ok 1 - stable echo (run 1)')
    expect(stdout).toContain('not ok 4 - flaky clock (run 2)')
    expect(stdout[1]).toBe('# vibrissa: running 6 cases on local (repeat 3)')
    expect(stdout).toContain('# flaky flaky clock: 2/3 passed (67%) [declared flaky]')
    expect(stdout).toContain('  flaky: true')
  })
})

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe('shared helpers', () => {
  it('formats pass rates, falling back to the bare rate when counts disagree', () => {
    expect(formatPassRate({ rate: 2 / 3, runs: 3, passes: 2 })).toBe('2/3 passed (67%)')
    expect(formatPassRate({ rate: 0.6, runs: 1, passes: 1 })).toBe('60% pass rate')
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(12.4)).toBe('12ms')
    expect(formatDuration(999.6)).toBe('1.00s')
    expect(formatDuration(2500)).toBe('2.50s')
    expect(formatDuration(125_000)).toBe('2m05s')
    expect(formatDuration(Number.NaN)).toBe('0ms')
  })

  it('projects $partial expectations for display', () => {
    expect(
      projectForDiff(
        { $partial: true, a: 1, list: [{ x: 1 }] },
        { a: 2, b: 3, list: [{ x: 1, y: 2 }, { x: 9 }] },
      ),
    ).toEqual({ expected: { a: 1, list: [{ x: 1 }] }, actual: { a: 2, list: [{ x: 1 }] } })
    // Without $partial, extra keys stay visible.
    expect(projectForDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({
      expected: { a: 1 },
      actual: { a: 1, b: 2 },
    })
    // Matcher directives are left as written.
    expect(projectForDiff({ $regex: '^h' }, 'x')).toEqual({
      expected: { $regex: '^h' },
      actual: 'x',
    })
  })

  it('converts arbitrary values to JSON-safe values', () => {
    expect(
      toJsonSafe({ a: undefined, b: [undefined, 1n, Number.NaN], c: new Map([['k', 1]]) }),
    ).toEqual({ b: [null, '1', null], c: { k: 1 } })
  })
})
