import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diffCommand, help as diffHelpText } from '../src/cli/diff'
import { manifestCommand, help as manifestHelpText } from '../src/cli/manifest'
import { resolveRunOptions, runCommand, help as runHelpText } from '../src/cli/run'
import { readManifest } from '../src/manifest'

const fixtureConfig = path.join(process.cwd(), 'tests/fixtures/echo-server/vibrissa.json')

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-cli-run-'))
}

/** Capture console output for the duration of a command. */
function capture() {
  const lines: string[] = []
  const push = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  vi.spyOn(console, 'log').mockImplementation(push)
  vi.spyOn(console, 'error').mockImplementation(push)
  vi.spyOn(console, 'warn').mockImplementation(push)
  return { lines, text: () => lines.join('\n') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('vib run', () => {
  it('runs the fixture suite and exits 0', async () => {
    const out = capture()
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--no-pretty',
      '--out-dir',
      mkTmpDir(),
    ])
    expect(code).toBe(0)
    expect(out.text()).toMatch(/PASS manifest tests\/__manifest__\.json/)
    expect(out.text()).toMatch(/Result: PASSED/)
  })

  it('honors --cases overrides relative to the shell cwd', async () => {
    const out = capture()
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--no-pretty',
      '--cases',
      'tests/fixtures/echo-server/cases/echo.basic.json',
    ])
    expect(code).toBe(0)
    expect(out.text()).toMatch(/running 1 case on echo/)
  })

  it('exits 1 when a case fails and prints the failure in plain mode', async () => {
    const out = capture()
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--no-pretty',
      '--out-dir',
      mkTmpDir(),
      '--cases',
      'tests/fixtures/echo-server/cases/echo.fail.json',
    ])
    expect(code).toBe(1)
    expect(out.text()).toMatch(/FAIL echo mismatch/)
    expect(out.text()).toMatch(
      /Expectation failed at content\[0\]\.text: expected "HELLO", got "hello"/,
    )
  })

  it('exits 1 on empty globs unless --allow-empty', async () => {
    capture()
    const failing = await runCommand(['--config', fixtureConfig, '--cases', 'no/such/dir/**.json'])
    expect(failing).toBe(1)
    const allowed = await runCommand([
      '--config',
      fixtureConfig,
      '--cases',
      'no/such/dir/**.json',
      '--allow-empty',
    ])
    expect(allowed).toBe(0)
  })

  it('exits 2 on usage errors with an actionable message', async () => {
    const out = capture()
    expect(await runCommand(['--config', fixtureConfig, '--shard', '3/2'])).toBe(2)
    expect(out.text()).toMatch(/Invalid --shard value "3\/2": expected <index>\/<total>/)
    expect(await runCommand(['--config', fixtureConfig, '--repeat', '0'])).toBe(2)
    expect(out.text()).toMatch(/Invalid --repeat value "0": expected an integer >= 1/)
    expect(await runCommand(['--config', fixtureConfig, '--reporter', 'junitt'])).toBe(2)
    expect(out.text()).toMatch(/Unknown reporter "junitt".*Did you mean "junit"\?/)
  })

  it('--json prints exactly one JsonReport on stdout (and writes results.json); logs go to stderr', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => void stderr.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...args) => void stderr.push(args.join(' ')))
    const outDir = mkTmpDir()
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--json',
      '--reporter',
      'json,console',
      '--tag',
      'mrtr',
      '--out-dir',
      outDir,
    ])
    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    const printed = JSON.parse(stdout[0])
    expect(printed).toMatchObject({
      version: 1,
      generator: 'vibrissa',
      ok: true,
      complete: true,
      summary: { total: 3, passed: 3 },
      manifests: [expect.objectContaining({ status: 'ok' })],
    })
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'))).toEqual(printed)
    expect(stderr.join('\n')).toMatch(/^PASS MRTR/m)
    expect(stderr.join('\n')).toMatch(/vibrissa: wrote .*results\.json/)

    stdout.length = 0
    expect(await runCommand(['--config', fixtureConfig, '--json', '--shard', 'x'])).toBe(2)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/^Invalid --shard value "x"/) },
    })
  })

  it('prints the full help for run, manifest and diff', async () => {
    const out = capture()
    expect(await runCommand(['--help'])).toBe(0)
    expect(await manifestCommand(['--help'])).toBe(0)
    expect(await diffCommand(['--help'])).toBe(0)
    expect(out.lines).toEqual([runHelpText, manifestHelpText, diffHelpText])
    for (const [text, needles] of [
      [runHelpText, ['--update[=all]', '--baseline <file>', '--json', 'docs/CLI.md']],
      [
        manifestHelpText,
        [
          'vib manifest record',
          'vib manifest diff',
          'vib manifest show',
          '--out <path>',
          'docs/CLI.md',
        ],
      ],
      [diffHelpText, ['--against <target>', '--cases <glob>', '--manifest-only', 'docs/CLI.md']],
    ] as const) {
      for (const needle of needles) expect(text).toContain(needle)
      expect(text).not.toMatch(/README/)
    }
  })

  it('parses filters, repeat, update modes and --flag=value forms', () => {
    capture()
    const options = resolveRunOptions([
      '--config',
      fixtureConfig,
      '--tag=smoke,flow',
      '--tag',
      'mrtr',
      '--exclude-tag',
      'tasks',
      '--grep',
      'echo',
      '--shard=2/3',
      '--repeat',
      '3',
      '--concurrency=2',
      '--update=all',
      '--update-manifest',
      '--trace',
      '--check',
      '--fail-fast',
      '--reporter=json,junit',
      '--baseline',
      'reports/last-green.json',
    ])
    expect(options).toMatchObject({
      tags: ['smoke', 'flow', 'mrtr'],
      excludeTags: ['tasks'],
      grep: 'echo',
      shard: { index: 2, total: 3 },
      repeat: 3,
      concurrency: 2,
      update: true,
      updateAll: true,
      updateManifest: true,
      trace: true,
      check: true,
      failFast: true,
      reporters: ['json', 'junit'],
      baseline: path.resolve('reports/last-green.json'),
      manifestIgnore: ['server.version'],
    })
  })

  it('runs --check and the legacy profile', async () => {
    const out = capture()
    expect(
      await runCommand([
        '--config',
        fixtureConfig,
        '--no-pretty',
        '--check',
        '--out-dir',
        mkTmpDir(),
      ]),
    ).toBe(0)
    expect(out.text()).toMatch(/PASS check: tools\/list is deterministic across calls/)
    expect(
      await runCommand(['--config', fixtureConfig, '--profile', 'legacy', '--out-dir', mkTmpDir()]),
    ).toBe(0)
    expect(out.text()).toMatch(/legacy protocol 2025-11-25/)
  })
})

describe('vib manifest', () => {
  it('records, diffs and shows the lock', async () => {
    const dir = mkTmpDir()
    const lock = path.join(dir, '__manifest__.json')
    const out = capture()
    expect(await manifestCommand(['record', '--config', fixtureConfig, '--out', lock])).toBe(0)
    expect(out.text()).toMatch(
      /wrote .*__manifest__\.json \(6 tools, 1 resource, 1 template, 1 prompt\)/,
    )
    expect(readManifest(lock).tools).toHaveLength(6)

    expect(await manifestCommand(['diff', '--config', fixtureConfig, '--out', lock])).toBe(0)
    expect(out.text()).toMatch(/no drift/)

    const drifted = readManifest(lock)
    drifted.tools = drifted.tools.filter((t) => t.name !== 'sleep')
    fs.writeFileSync(lock, JSON.stringify(drifted))
    out.lines.length = 0
    expect(
      await manifestCommand(['diff', '--config', fixtureConfig, '--out', lock, '--json']),
    ).toBe(1)
    const payload = JSON.parse(out.lines[0])
    expect(payload).toMatchObject({ ok: false, identical: false, summary: '1 tool added (sleep)' })

    out.lines.length = 0
    expect(await manifestCommand(['show', '--config', fixtureConfig, '--json'])).toBe(0)
    expect(JSON.parse(out.lines[0])).toMatchObject({
      vibrissa: 2,
      server: { name: 'vibrissa-echo-fixture' },
    })
    expect(await manifestCommand(['show', '--config', fixtureConfig])).toBe(0)
    expect(out.text()).toMatch(/vibrissa-echo-fixture 2\.0\.0 · protocol 2026-07-28/)
  })

  it('rejects unknown actions and a missing lock with exit 2', async () => {
    const out = capture()
    expect(await manifestCommand(['bogus'])).toBe(2)
    expect(out.text()).toMatch(/Unknown manifest action "bogus": expected record, diff or show/)
    expect(
      await manifestCommand([
        'diff',
        '--config',
        fixtureConfig,
        '--out',
        path.join(mkTmpDir(), 'none.json'),
      ]),
    ).toBe(2)
    expect(out.text()).toMatch(
      /No manifest lock at .*none\.json\. Create it with "vib manifest record"/,
    )
  })
})

describe('vib diff', () => {
  it('reports no differences against the same server', async () => {
    const out = capture()
    const code = await diffCommand([
      '--config',
      fixtureConfig,
      '--against',
      'node server/index.js',
      '--cases',
      'tests/fixtures/echo-server/cases/{echo.basic,mrtr.confirm-accept,task.slow}.json',
      '--json',
    ])
    expect(code).toBe(0)
    const payload = JSON.parse(out.lines[0])
    expect(payload).toMatchObject({
      identical: true,
      manifest: { identical: true },
      summary: { cases: 3, different: 0 },
    })
  })

  it('reports manifest and per-case differences against another server', async () => {
    const out = capture()
    const code = await diffCommand([
      '--config',
      fixtureConfig,
      '--against',
      'node server/legacy-strict.js',
      '--cases',
      'tests/fixtures/echo-server/cases/echo.basic.json',
    ])
    expect(code).toBe(1)
    const text = out.text()
    expect(text).toMatch(/Manifest drift: .*tools? removed/)
    expect(text).toMatch(/DIFF {2}echo basic \(cases\/echo\.basic\.json\)/)
    expect(text).toMatch(/1 of 1 case differ; manifest differs\./)

    out.lines.length = 0
    expect(
      await diffCommand([
        '--config',
        fixtureConfig,
        '--against',
        'node server/legacy-strict.js',
        '--manifest-only',
      ]),
    ).toBe(1)
    expect(out.text()).not.toMatch(/case differ/)
  })

  it('requires --against', async () => {
    const out = capture()
    expect(await diffCommand(['--config', fixtureConfig])).toBe(2)
    expect(out.text()).toMatch(/^Missing --against/)
  })
})
