import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import type { CaseOutcome, Reporter, RunEvent } from '../src/events'
import { runCases } from '../src/index'
import { readManifest } from '../src/manifest'
import { Runner, type RunnerOptions, inputRequestView, traceName } from '../src/runner'
import type { RunOptions } from '../src/types'

const FIXTURE = path.join(process.cwd(), 'tests/fixtures/echo-server')
const CONFIG = path.join(FIXTURE, 'vibrissa.json')
const SERVER = path.join(FIXTURE, 'server/index.js')

function mkTmpDir(prefix = 'vibrissa-runner-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(file: string, data: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`,
    'utf8',
  )
  return file
}

function fixtureOptions(profile?: string): RunOptions {
  return loadConfig(FIXTURE, { configPath: CONFIG, ...(profile ? { profile } : {}) }).options
}

/** A temp suite against the fixture server: `cases` maps file names (under cases/) to JSON. */
function suite(cases: Record<string, unknown>, extra: Partial<RunnerOptions> = {}): RunnerOptions {
  const dir = mkTmpDir()
  for (const [name, data] of Object.entries(cases)) writeJson(path.join(dir, 'cases', name), data)
  return {
    ...fixtureOptions(),
    servers: { echo: { cmd: 'node', args: [SERVER], cwd: FIXTURE } },
    defaultServer: 'echo',
    globs: ['cases/**/*.json'],
    rootDir: dir,
    lockManifest: false,
    ...extra,
  }
}

interface Ran {
  result: Awaited<ReturnType<Runner['execute']>>
  events: RunEvent[]
  out: string[]
  outDir: string
}

async function run(options: RunnerOptions): Promise<Ran> {
  const events: RunEvent[] = []
  const out: string[] = []
  const collector: Reporter = { name: 'collect', onEvent: (e) => void events.push(e) }
  // Config fills outDir ("reports"); keep test artifacts out of the fixture unless a test
  // asks for a specific (absolute) directory.
  const outDir =
    options.outDir && path.isAbsolute(options.outDir) ? options.outDir : mkTmpDir('vibrissa-out-')
  const runner = new Runner({
    ...options,
    outDir,
    pretty: false,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    extraReporters: [collector],
  })
  const result = await runner.execute()
  return { result, events, out, outDir }
}

function outcomeOf(events: RunEvent[], idPart: string): CaseOutcome {
  const end = events.find(
    (e): e is Extract<RunEvent, { type: 'case:end' }> =>
      e.type === 'case:end' && e.case.id.includes(idPart),
  )
  if (!end) throw new Error(`no case:end for ${idPart}`)
  return end.outcome
}

function ofType<T extends RunEvent['type']>(events: RunEvent[], type: T) {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type)
}

const echoCase = (text: string, expected = text) => ({
  tool: 'echo',
  args: { text },
  expect: { content: [{ type: 'text', text: expected }] },
})

const firstTaskCase = (extra: Record<string, unknown> = {}) => ({
  tool: 'slow',
  args: { ms: 5 },
  await: { pollMs: 5 },
  expectTask: { $partial: true, taskId: 'task-1' },
  ...extra,
})

describe('Runner: fixture suite', () => {
  it('passes on the modern era with the manifest lock and --check', async () => {
    const { result, events } = await run({ ...fixtureOptions(), check: true })
    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    expect(events[0]).toMatchObject({ type: 'run:start', servers: ['echo'] })
    expect(ofType(events, 'session:start')).toEqual([
      expect.objectContaining({
        server: 'echo',
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'vibrissa-echo-fixture', version: '2.0.0' },
      }),
    ])
    expect(ofType(events, 'manifest:ok')).toEqual([
      { type: 'manifest:ok', path: path.join(FIXTURE, 'tests/__manifest__.json'), server: 'echo' },
    ])
    const checks = ofType(events, 'check').map((e) => e.outcome)
    expect(checks.length).toBeGreaterThan(10)
    expect(checks.every((c) => c.server === 'echo' && c.status === 'passed')).toBe(true)
    expect(result.summary).toMatchObject({ failed: 0, skipped: 1, updated: 0 })
    expect(result.summary.total).toBe(ofType(events, 'case:end').length)
    expect(events.at(-1)).toMatchObject({ type: 'run:end', ok: true })
    expect(outcomeOf(events, 'flow.capture').steps?.map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
    ])
    expect(
      ofType(events, 'step:end').filter((e) => e.case.id.includes('flow.capture')),
    ).toHaveLength(5)
  })

  it('passes on the legacy era (protocol: legacy via the "legacy" profile)', async () => {
    const { result, events } = await run(fixtureOptions('legacy'))
    expect(result.exitCode).toBe(0)
    expect(ofType(events, 'session:start')[0]).toMatchObject({ era: 'legacy' })
    expect(ofType(events, 'manifest:ok')[0].path).toBe(
      path.join(FIXTURE, 'tests/__manifest__.legacy.json'),
    )
    expect(ofType(events, 'case:end').some((e) => e.case.id.includes('task.'))).toBe(false)
    expect(outcomeOf(events, 'mrtr.confirm-accept').status).toBe('passed')
  })

  it('reports the deliberately failing cases with kinds, mismatches and traces', async () => {
    const { result, events } = await run({ ...fixtureOptions(), globs: ['cases/*.fail.json'] })
    expect(result.exitCode).toBe(1)

    const golden = outcomeOf(events, 'echo.fail.json')
    expect(golden).toMatchObject({
      status: 'failed',
      errorKind: 'assertion',
      reason:
        'Expectation failed at content[0].text: expected "HELLO", got "hello". Use --update to accept the new output.',
      expected: { content: [{ type: 'text', text: 'HELLO' }] },
      actual: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(golden.mismatches?.[0]).toMatchObject({ path: 'content[0].text' })
    expect(golden.tracePath).toBeDefined()
    const lines = fs
      .readFileSync(golden.tracePath as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { dir: string; message?: { method?: string } })
    expect(lines.some((l) => l.dir === 'out' && l.message?.method === 'tools/call')).toBe(true)
    expect(lines.some((l) => l.dir === 'in')).toBe(true)

    const schema = outcomeOf(events, 'typed.output-schema-violation')
    expect(schema.errorKind).toBe('assertion')
    expect(schema.mismatches?.[0]).toMatchObject({
      path: 'structuredContent.sum',
      message: expect.stringMatching(/outputSchema: must be number/),
    })
    expect(schema.reason).toMatch(/set "validateOutput": false/)

    const budget = outcomeOf(events, 'budget.sleep.fail')
    expect(budget.errorKind).toBe('budget')
    expect(budget.budget?.budgetMs).toBe(20)
    expect(budget.budget?.actualMs).toBeGreaterThanOrEqual(100)
  })

  it('selects cases with tags, exclude-tags, grep and shards', async () => {
    const ids = async (extra: Partial<RunnerOptions>) =>
      ofType((await run({ ...fixtureOptions(), lockManifest: false, ...extra })).events, 'case:end')
        .map((e) => e.case.id)
        .sort()
    expect(await ids({ tags: ['mrtr'] })).toEqual([
      'cases/mrtr.confirm-accept.json',
      'cases/mrtr.confirm-decline.json',
      'cases/mrtr.confirm-request-only.json',
    ])
    expect(await ids({ tags: ['mrtr'], excludeTags: ['mrtr'] })).toEqual([])
    expect(await ids({ grep: 'decline' })).toEqual(['cases/mrtr.confirm-decline.json'])
    const all = await ids({})
    const first = await ids({ shard: { index: 1, total: 2 } })
    const second = await ids({ shard: { index: 2, total: 2 } })
    expect([...first, ...second].sort()).toEqual(all)
    expect(first.filter((id) => second.includes(id))).toEqual([])
  })
})

describe('Runner: concurrency, repeat and flake', () => {
  it('gives every worker its own session (concurrency 2)', async () => {
    const cases = { 'a-task.json': firstTaskCase(), 'b-task.json': firstTaskCase() }
    // Each fixture server process numbers its tasks from 1: only separate sessions see task-1 twice.
    const parallel = await run(suite(cases, { concurrency: 2 }))
    expect(parallel.result.exitCode).toBe(0)
    const serial = await run(suite(cases, { concurrency: 1 }))
    expect(serial.result.exitCode).toBe(1)
    expect(outcomeOf(serial.events, 'b-task').reason).toMatch(/Task mismatch at taskId/)
  })

  it('--repeat computes pass rates; flaky cases pass above the floor', async () => {
    const flaky = await run(suite({ 'task.json': firstTaskCase({ flaky: true }) }, { repeat: 2 }))
    expect(ofType(flaky.events, 'run:start')[0]).toMatchObject({ totalCases: 2, repeat: 2 })
    expect(ofType(flaky.events, 'case:end').map((e) => e.case.id)).toEqual([
      'cases/task.json#1',
      'cases/task.json#2',
    ])
    expect(flaky.result.summary.passRates).toEqual({ 'cases/task.json': 0.5 })
    expect(flaky.result.summary).toMatchObject({ passed: 1, failed: 1 })
    expect(flaky.result.ok).toBe(true)
    expect(flaky.events.at(-1)).toMatchObject({ type: 'run:end', ok: true })

    const strictFloor = await run(
      suite({ 'task.json': firstTaskCase({ flaky: true }) }, { repeat: 2, flakyFloor: 0.75 }),
    )
    expect(strictFloor.result.exitCode).toBe(1)
    const hard = await run(suite({ 'task.json': firstTaskCase() }, { repeat: 2 }))
    expect(hard.result.exitCode).toBe(1)
    expect(hard.events.at(-1)).toMatchObject({ type: 'run:end', ok: false })
  })

  it('failFast stops after the first failing case', async () => {
    const { result, events } = await run(
      suite(
        { 'a.json': echoCase('a', 'x'), 'b.json': echoCase('b', 'y'), 'c.json': echoCase('c') },
        { failFast: true },
      ),
    )
    expect(result.exitCode).toBe(1)
    expect(ofType(events, 'case:end')).toHaveLength(1)
  })
})

describe('Runner: flows, MRTR, tasks and errors', () => {
  it('stops a flow at the failing step, still runs teardown, and names the step', async () => {
    const { result, events } = await run(
      suite({
        'flow.json': {
          name: 'broken flow',
          steps: [
            {
              name: 'first',
              tool: 'echo',
              args: { text: 'one' },
              capture: { v: 'content[0].text' },
            },
            {
              name: 'second',
              tool: 'echo',
              args: { text: '{{v}}!' },
              expect: { content: [{ type: 'text', text: 'two' }] },
            },
            { name: 'third', tool: 'echo', args: { text: 'three' } },
          ],
          teardown: [{ tool: 'echo', args: { text: 'cleanup {{v}}' } }],
        },
      }),
    )
    expect(result.exitCode).toBe(1)
    const outcome = outcomeOf(events, 'flow.json')
    expect(outcome.reason).toBe(
      'Step 2 "second" (tool echo): Expectation failed at content[0].text: expected "two", got "one!". Use --update to accept the new output.',
    )
    expect(outcome.steps?.map((s) => [s.step.name, s.status])).toEqual([
      ['first', 'passed'],
      ['second', 'failed'],
      ['third', 'skipped'],
      ['teardown: echo', 'passed'],
    ])
    expect(ofType(events, 'step:start')).toHaveLength(3)
  })

  it('ignoreErrors on any step: recorded as failed, the flow continues, the case passes', async () => {
    const { result, events } = await run(
      suite({
        'flow.json': {
          setup: [
            {
              name: 'best-effort reset',
              tool: 'fail',
              args: { message: 'no reset' },
              ignoreErrors: true,
            },
          ],
          steps: [
            { name: 'flaky probe', tool: 'echo', args: {}, ignoreErrors: true },
            { name: 'real work', ...echoCase('work') },
          ],
          teardown: [{ tool: 'fail', ignoreErrors: true }],
        },
        'single.json': { ...echoCase('x', 'y'), ignoreErrors: true },
      }),
    )
    expect(result.exitCode).toBe(0)
    const flow = outcomeOf(events, 'flow.json')
    expect(flow.status).toBe('passed')
    expect(flow.reason).toBeUndefined()
    expect(flow.steps?.map((s) => [s.step.name, s.status])).toEqual([
      ['setup: best-effort reset', 'failed'],
      ['flaky probe', 'failed'],
      ['real work', 'passed'],
      ['teardown: fail', 'failed'],
    ])
    expect(flow.steps?.[1].reason).toMatch(
      /^ignored \(ignoreErrors\): Call failed at tool "echo": \[InvalidParams -32602\]/,
    )
    expect(ofType(events, 'step:end').find((e) => e.step.name === 'flaky probe')?.status).toBe(
      'failed',
    )
    expect(outcomeOf(events, 'single.json').status).toBe('passed')
    expect(result.warnings.join('\n')).toMatch(
      /cases\/single\.json: failure ignored because of "ignoreErrors": Expectation failed at content\[0\]\.text/,
    )
  })

  it('MRTR: an unanswered request fails with a respond hint; the by-key view matches', async () => {
    const { events } = await run(
      suite({
        'unanswered.json': {
          tool: 'confirm',
          args: { action: 'ship' },
          expect: { content: [{ type: 'text', text: 'confirmed: ship' }] },
        },
        'by-key.json': {
          tool: 'confirm',
          args: { action: 'ship' },
          respond: { 'elicitation/create': { action: 'accept', content: { confirm: true } } },
          expectInputRequired: {
            confirm: {
              method: 'elicitation/create',
              params: { $partial: true, message: 'Proceed with ship?' },
            },
          },
          expect: { content: [{ type: 'text', text: 'confirmed: ship' }] },
        },
        'not-asked.json': {
          tool: 'echo',
          args: { text: 'x' },
          expectInputRequired: { $any: true },
        },
      }),
    )
    const unanswered = outcomeOf(events, 'unanswered')
    expect(unanswered.errorKind).toBe('error')
    expect(unanswered.reason).toMatch(
      /^Unanswered input request at tool "confirm": the server asked for elicitation\/create "Proceed with ship\?"\. Add "respond": \{ "elicitation\/create": \{ "action": "accept"/,
    )
    expect(unanswered.actual).toMatchObject({ confirm: { method: 'elicitation/create' } })
    expect(outcomeOf(events, 'by-key').status).toBe('passed')
    expect(outcomeOf(events, 'not-asked').reason).toMatch(
      /^Expected an input request at tool "echo"/,
    )
  })

  it('matches expectError by code name and reports mismatches, unexpected errors and timeouts', async () => {
    const { events } = await run(
      suite({
        'wrong-code.json': { tool: 'echo', args: {}, expectError: { code: 'MethodNotFound' } },
        'numeric.json': {
          tool: 'echo',
          args: {},
          expectError: { code: -32602, message: { $regex: 'must be a string' } },
        },
        'unexpected.json': { tool: 'echo', args: {} },
        'succeeded.json': {
          tool: 'echo',
          args: { text: 'ok' },
          expectError: { code: 'InvalidParams' },
        },
        'timeout.json': { tool: 'sleep', args: { ms: 1000 }, timeoutMs: 100 },
      }),
    )
    expect(outcomeOf(events, 'wrong-code').reason).toMatch(
      /^Error code mismatch at tool "echo": expected "MethodNotFound", got "InvalidParams" \(-32602\)/,
    )
    expect(outcomeOf(events, 'numeric').status).toBe('passed')
    expect(outcomeOf(events, 'unexpected')).toMatchObject({
      errorKind: 'error',
      reason: expect.stringMatching(
        /Call failed at tool "echo": \[InvalidParams -32602\] .*Add "expectError": \{ "code": "InvalidParams" \}/,
      ),
    })
    expect(outcomeOf(events, 'succeeded').reason).toMatch(
      /^Expected an error at tool "echo", but the call succeeded/,
    )
    expect(outcomeOf(events, 'timeout').errorKind).toBe('timeout')
  })

  it('expectTask fails clearly when the server answers directly (legacy era)', async () => {
    const options = suite({ 'task.json': firstTaskCase() })
    options.servers = { echo: { cmd: 'node', args: [SERVER], cwd: FIXTURE, protocol: 'legacy' } }
    const { events } = await run(options)
    expect(outcomeOf(events, 'task.json').reason).toMatch(
      /^Expected a task at tool "slow", but the server answered directly/,
    )
  })

  it('suite hooks: setup captures are visible to every case', async () => {
    const { result } = await run(
      suite(
        { 'uses-token.json': echoCase('{{token}}', 'tok-1') },
        {
          hooks: {
            setup: [
              { tool: 'echo', args: { text: 'tok-1' }, capture: { token: 'content[0].text' } },
            ],
            teardown: [{ tool: 'echo', args: { text: 'bye' } }],
          },
        },
      ),
    )
    expect(result.exitCode).toBe(0)
  })

  it('treats unloadable cases as failures and keeps running', async () => {
    const options = suite({ 'b-pass.json': echoCase('ok') })
    fs.writeFileSync(path.join(options.rootDir, 'cases/a-broken.json'), '{ not valid json', 'utf8')
    const { result, events } = await run(options)
    expect(result.exitCode).toBe(1)
    expect(outcomeOf(events, 'a-broken')).toMatchObject({ status: 'failed', errorKind: 'load' })
    expect(outcomeOf(events, 'b-pass').status).toBe('passed')
  })

  it('fails the cases of a server that cannot start (exit 1, no throw)', async () => {
    const options = suite({ 'a.json': echoCase('a') })
    options.servers = { echo: { cmd: 'vibrissa-no-such-binary-xyz' } }
    const { result, events } = await run(options)
    expect(result.exitCode).toBe(1)
    expect(outcomeOf(events, 'a.json')).toMatchObject({
      errorKind: 'error',
      reason: expect.stringMatching(/command not found|ENOENT|exited/i),
    })
    expect(result.warnings[0]).toMatch(/^Server "echo" could not start/)
  })

  it('exits 1 on an empty selection unless allowEmpty', async () => {
    const empty = await run(suite({}, { globs: ['nothing/**/*.json'] }))
    expect(empty.result.exitCode).toBe(1)
    expect(empty.result.warnings[0]).toMatch(
      /^No test cases matched globs: nothing\/\*\*\/\*\.json/,
    )
    expect(empty.out.some((line) => line.includes('No test cases matched globs'))).toBe(true)
    const allowed = await run(suite({}, { globs: ['nothing/**/*.json'], allowEmpty: true }))
    expect(allowed.result.exitCode).toBe(0)
    const filtered = await run(suite({ 'a.json': echoCase('a') }, { tags: ['none'] }))
    expect(filtered.result.warnings[0]).toMatch(/^No test cases left after filters \(--tag none\)/)
  })
})

describe('Runner: --update', () => {
  it('rewrites failing plain goldens and leaves matcher goldens alone', async () => {
    const options = suite({
      'golden.json': {
        name: 'golden',
        tool: 'echo',
        args: { text: 'hello' },
        expect: { content: [{ type: 'text', text: 'HELLO' }] },
      },
      'matcher.json': {
        tool: 'echo',
        args: { text: 'hello' },
        expect: { content: [{ type: 'text', text: { $regex: '^bye' } }] },
      },
      'flow.json': {
        steps: [
          { tool: 'echo', args: { text: 'a' } },
          { tool: 'echo', args: { text: 'b' }, expect: { content: [] } },
        ],
      },
    })
    fs.writeFileSync(
      path.join(options.rootDir, 'cases/commented.json'),
      '// keep me\n{ "tool": "echo", "args": { "text": "c" }, "expect": { "content": [] } }\n',
    )
    const updated = await run({ ...options, update: true })
    expect(outcomeOf(updated.events, 'golden').status).toBe('updated')
    expect(outcomeOf(updated.events, 'golden')).toMatchObject({
      expected: { content: [{ type: 'text', text: 'HELLO' }] },
      actual: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(outcomeOf(updated.events, 'flow.json').steps?.map((s) => s.status)).toEqual([
      'passed',
      'updated',
    ])
    expect(outcomeOf(updated.events, 'matcher').status).toBe('failed')
    expect(outcomeOf(updated.events, 'commented').status).toBe('failed')
    expect(updated.result.warnings.join('\n')).toMatch(
      /Not updating cases\/matcher\.json: "expect" contains matchers/,
    )
    expect(updated.result.warnings.join('\n')).toMatch(
      /Not updating cases\/commented\.json: the file has comments/,
    )

    const text = fs.readFileSync(path.join(options.rootDir, 'cases/golden.json'), 'utf8')
    expect(text).toBe(
      `${JSON.stringify({ name: 'golden', tool: 'echo', args: { text: 'hello' }, expect: { content: [{ type: 'text', text: 'hello' }] } }, null, 2)}\n`,
    )
    const flow = JSON.parse(fs.readFileSync(path.join(options.rootDir, 'cases/flow.json'), 'utf8'))
    expect(flow.steps[1].expect).toEqual({ content: [{ type: 'text', text: 'b' }] })

    const rerun = await run({ ...options, grep: 'golden|flow' })
    expect(rerun.result.exitCode).toBe(0)

    const all = await run({ ...options, update: true, updateAll: true, grep: 'matcher' })
    expect(outcomeOf(all.events, 'matcher').status).toBe('updated')
    const matcher = JSON.parse(
      fs.readFileSync(path.join(options.rootDir, 'cases/matcher.json'), 'utf8'),
    )
    expect(matcher.expect).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })
})

describe('Runner: --baseline delta gating', () => {
  it('fails only on new failures and latency regressions', async () => {
    const options = suite({
      'pass.json': echoCase('a'),
      'known.json': echoCase('b', 'never'),
      'sleepy.json': { tool: 'sleep', args: { ms: 60 } },
    })
    const outDir = mkTmpDir('vibrissa-baseline-')
    const first = await run({ ...options, reporters: ['json'], outDir })
    expect(first.result.exitCode).toBe(1)
    const baseline = path.join(outDir, 'results.json')
    expect(fs.existsSync(baseline)).toBe(true)

    const same = await run({ ...options, baseline })
    expect(same.result.exitCode).toBe(0)
    expect(same.result.warnings.join('\n')).toMatch(
      /Baseline: 1 case\(s\) still failing.*cases\/known\.json/,
    )
    expect(ofType(same.events, 'check').map((e) => e.outcome)).toEqual([
      expect.objectContaining({ id: 'baseline/regressions', status: 'passed' }),
    ])

    writeJson(path.join(options.rootDir, 'cases/pass.json'), echoCase('a', 'changed'))
    const regressed = await run({ ...options, baseline })
    expect(regressed.result.exitCode).toBe(1)
    const check = ofType(regressed.events, 'check')[0].outcome
    expect(check).toMatchObject({ status: 'failed', title: expect.stringMatching(/1 regression/) })
    expect(check.detail).toBe('cases/pass.json: newly failing')

    writeJson(path.join(options.rootDir, 'cases/pass.json'), echoCase('a'))
    const report = JSON.parse(fs.readFileSync(baseline, 'utf8'))
    for (const c of report.cases) if (c.caseId === 'cases/sleepy.json') c.durationMs = 1
    const fastBaseline = writeJson(path.join(outDir, 'fast.json'), report)
    const slower = await run({ ...options, baseline: fastBaseline })
    expect(slower.result.exitCode).toBe(1)
    expect(ofType(slower.events, 'check')[0].outcome.detail).toMatch(
      /^cases\/sleepy\.json: slower, \d+ms vs 1ms in the baseline/,
    )
  })
})

describe('Runner: manifest lock and traces', () => {
  it('fails on drift, accepts it with updateManifest, warns when the lock is missing', async () => {
    const options = suite({ 'a.json': echoCase('a') }, { lockManifest: true })
    const lock = path.join(options.rootDir, 'lock.json')
    const drifted = readManifest(path.join(FIXTURE, 'tests/__manifest__.json'))
    const echo = drifted.tools.find((t) => t.name === 'echo')
    if (echo) echo.description = 'Echo text back (old description)'
    writeJson(lock, drifted)

    const drift = await run({ ...options, manifest: lock })
    expect(drift.result.exitCode).toBe(1)
    expect(ofType(drift.events, 'manifest:diff')[0]).toMatchObject({
      path: lock,
      server: 'echo',
      summary: '1 tool changed (echo: description)',
    })
    expect(drift.result.manifests[0].status).toBe('diff')

    const accepted = await run({ ...options, manifest: lock, updateManifest: true })
    expect(accepted.result.exitCode).toBe(0)
    expect(accepted.result.warnings[0]).toMatch(
      /^Manifest lock updated at lock\.json: 1 tool changed/,
    )
    expect(readManifest(lock).tools.find((t) => t.name === 'echo')?.description).toBe(
      'Echo text back, optionally uppercased',
    )

    const missing = await run({ ...options, manifest: 'nope/__manifest__.json' })
    expect(missing.result.exitCode).toBe(0)
    expect(missing.result.warnings[0]).toMatch(
      /^No manifest lock at nope\/__manifest__\.json\. Run "vib manifest record"/,
    )
  })

  it('does not run a lock file that sits under the case globs', async () => {
    const options = suite(
      { 'a.json': echoCase('a') },
      { lockManifest: true, manifest: 'cases/__manifest__.json', updateManifest: true },
    )
    const created = await run(options)
    expect(created.result.manifests[0].status).toBe('created')
    expect(fs.existsSync(path.join(options.rootDir, 'cases/__manifest__.json'))).toBe(true)
    const again = await run({ ...options, updateManifest: false })
    expect(again.result).toMatchObject({ exitCode: 0, summary: { total: 1, passed: 1 } })
    expect(ofType(again.events, 'manifest:ok')).toHaveLength(1)
  })

  it('--trace writes the JSON-RPC transcript and the server stderr of each case', async () => {
    const dir = mkTmpDir()
    const noisy = path.join(dir, 'noisy-server.mjs')
    fs.writeFileSync(
      noisy,
      [
        "import readline from 'node:readline'",
        'const rl = readline.createInterface({ input: process.stdin })',
        "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
        "rl.on('line', (line) => {",
        '  let m',
        '  try { m = JSON.parse(line) } catch { return }',
        '  if (m.id === undefined) return',
        "  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'noisy', version: '1.0.0' } } })",
        "  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [{ name: 'noisy', description: 'Writes to stderr', inputSchema: { type: 'object' } }] } })",
        "  if (m.method === 'tools/call') {",
        "    process.stderr.write('noisy: handling call\\n')",
        "    setTimeout(() => send({ id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }), 50)",
        '    return',
        '  }',
        "  send({ id: m.id, error: { code: -32601, message: 'Method not found' } })",
        '})',
      ].join('\n'),
    )
    writeJson(path.join(dir, 'cases/noisy.json'), {
      tool: 'noisy',
      expect: { content: [{ type: 'text', text: 'ok' }] },
    })
    const { result, events, outDir } = await run({
      ...fixtureOptions(),
      servers: { noisy: { cmd: 'node', args: [noisy], cwd: dir, protocol: 'legacy' } },
      defaultServer: 'noisy',
      globs: ['cases/*.json'],
      rootDir: dir,
      lockManifest: false,
      trace: true,
    })
    expect(result.exitCode).toBe(0)
    const outcome = outcomeOf(events, 'noisy.json')
    expect(outcome.tracePath).toBe(path.join(outDir, 'traces', 'cases', 'noisy.ndjson'))
    expect(outcome.stderrPath).toBe(path.join(outDir, 'traces', 'cases', 'noisy.stderr.txt'))
    expect(fs.readFileSync(outcome.stderrPath as string, 'utf8')).toBe('noisy: handling call\n')
    const trace = fs
      .readFileSync(outcome.tracePath as string, 'utf8')
      .trim()
      .split('\n')
    expect(trace).toHaveLength(2)
    expect(JSON.parse(trace[0])).toMatchObject({ dir: 'out', message: { method: 'tools/call' } })
  })
})

describe('runner helpers', () => {
  it('builds key and method views of input requests', () => {
    const rounds = [
      { a: { method: 'elicitation/create', params: { message: 'one' } } },
      {
        b: { method: 'elicitation/create', params: { message: 'two' } },
        c: { method: 'roots/list', params: {} },
      },
    ]
    expect(inputRequestView({ a: { $any: true } }, rounds)).toEqual({ ...rounds[0], ...rounds[1] })
    expect(
      inputRequestView({ $partial: true, 'elicitation/create': { $any: true } }, rounds),
    ).toEqual({
      'elicitation/create': [{ message: 'one' }, { message: 'two' }],
      'roots/list': {},
    })
  })

  it('maps case ids to safe trace names', () => {
    expect(traceName('cases/echo.basic.json')).toBe('cases/echo.basic')
    expect(traceName('cases/echo.basic.json#3')).toBe('cases/echo.basic.run3')
    expect(traceName('C:/tmp/x/a.json')).toBe('tmp/x/a')
    expect(traceName('../up/a.json')).toBe('_up/up/a')
  })

  it('runCases accepts v1-style options (server singular)', async () => {
    const dir = mkTmpDir()
    writeJson(path.join(dir, 'pass.json'), echoCase('x'))
    const lines: string[] = []
    const code = await runCases({
      server: { cmd: 'node', args: ['server/index.js'], cwd: FIXTURE },
      globs: ['*.json'],
      rootDir: dir,
      timeoutMs: 5000,
      lockManifest: false,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/PASS|✓/)
  })
})
