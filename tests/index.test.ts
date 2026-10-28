import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index'
import { defaultRunCasesOptions, defaultRunOptions, runCases } from '../src/index'

const FIXTURE = path.join(process.cwd(), 'tests/fixtures/echo-server')

describe('index exports', () => {
  it('exposes the public API', () => {
    for (const name of [
      'runCases',
      'Runner',
      'executeCase',
      'loadCases',
      'loadCasesSync',
      'interpolate',
      'buildManifest',
      'captureManifest',
      'diffManifest',
      'summarizeDiff',
      'formatDiff',
      'McpSession',
      'errorMatchesCode',
      'matchValue',
      'matches',
      'resolveRefs',
      'lintExpectation',
      'escapeDirectives',
      'normalizeResult',
      'validate',
      'createReporters',
      'registerReporter',
      'fanout',
      'runChecks',
      'listChecks',
      'generateArgs',
      'evaluate',
      'loadConfig',
      'resolveOptions',
    ] as const) {
      expect(typeof api[name], name).toBe('function')
    }
    expect(api.BUILTIN_REPORTERS).toEqual(['console', 'json', 'junit', 'github', 'tap'])
    expect(api.DEFAULT_MANIFEST_IGNORE).toEqual(['server.version', 'protocolVersion', 'listMeta'])
    for (const name of ['suggestRespond', 'toPointer', 'wordDiff', 'isMatcherObject'] as const) {
      expect(typeof api[name], name).toBe('function')
    }
    expect(api.toPointer(['steps', 1, 'expect', 'a/b'])).toBe('/steps/1/expect/a~1b')
    expect(api.matcherPathSegments('_meta["io.x/y"].content[0].text')).toEqual([
      '_meta',
      'io.x/y',
      'content',
      '0',
      'text',
    ])
  })

  it('exposes sensible defaults (v1 alias kept)', () => {
    expect(defaultRunCasesOptions).toBe(defaultRunOptions)
    expect(defaultRunOptions.defaultServer).toBe('default')
    expect(defaultRunOptions.servers.default).toMatchObject({ cmd: 'node', cwd: '.' })
    expect(defaultRunOptions.globs).toEqual(['tests/integration/**/*.json'])
    expect(defaultRunOptions.reporters).toEqual(['console'])
    expect(defaultRunOptions.failFast).toBe(false)
    expect(defaultRunOptions.allowEmpty).toBe(false)
  })

  it('runCases fails loud (exit 1) when defaults match no cases', async () => {
    const lines: string[] = []
    const code = await runCases({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-index-empty-')),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(
      /No test cases matched globs: tests\/integration\/\*\*\/\*\.json/,
    )
  })

  it('runCases accepts custom options (v1 server shape, env)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-index-'))
    fs.writeFileSync(
      path.join(tmp, 'pass.json'),
      JSON.stringify({
        name: 'pass',
        tool: 'echo',
        args: { text: 'x' },
        expect: { content: [{ type: 'text', text: 'x' }] },
      }),
      'utf8',
    )
    const code = await runCases({
      server: { cmd: 'node', args: ['server/index.js'], cwd: FIXTURE, env: { FOO: 'BAR' } },
      globs: [path.join(tmp, '**/*.json').replace(/\\/g, '/')],
      timeoutMs: 10000,
      failFast: true,
      rootDir: FIXTURE,
      manifest: 'tests/__manifest__.json',
      stdout: () => {},
      stderr: () => {},
    })
    expect(code).toBe(0)
  })

  it('Runner.execute returns the structured result', async () => {
    const { options } = api.loadConfig(FIXTURE, { configPath: path.join(FIXTURE, 'vibrissa.json') })
    const result = await new api.Runner({
      ...options,
      grep: 'echo basic',
      outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-index-out-')),
      stdout: () => {},
      stderr: () => {},
    }).execute()
    expect(result).toMatchObject({ exitCode: 0, ok: true, summary: { total: 1, passed: 1 } })
    expect(result.cases[0].ref.id).toBe('cases/echo.basic.json')
    expect(result.manifests).toEqual([expect.objectContaining({ server: 'echo', status: 'ok' })])
  })
})
