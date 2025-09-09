import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultRunCasesOptions, runCases } from '../src/index'

describe('index exports', () => {
  it('exposes sensible defaults', () => {
    expect(defaultRunCasesOptions.server.cmd).toBe('node')
    expect(defaultRunCasesOptions.server.cwd).toBe('.')
    expect(Array.isArray(defaultRunCasesOptions.globs)).toBe(true)
    expect(defaultRunCasesOptions.globs[0]).toBe('tests/integration/**/*.json')
    expect(defaultRunCasesOptions.concurrency).toBeGreaterThan(0)
    expect(defaultRunCasesOptions.timeoutMs).toBeGreaterThanOrEqual(0)
    expect(defaultRunCasesOptions.failFast).toBe(false)
  })

  it('runCases resolves to 0 with defaults', async () => {
    const code = await runCases(defaultRunCasesOptions)
    expect(code).toBe(0)
  })

  it('runCases accepts custom options', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-index-'))
    const file = path.join(tmp, 'pass.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: 'pass',
        tool: 'echo',
        args: { text: 'x' },
        expect: { tool: 'echo', args: { text: 'x' } },
      }),
      'utf8',
    )

    const code = await runCases({
      server: { cmd: 'node', args: ['dist/index.js'], cwd: '.', env: { FOO: 'BAR' } },
      globs: [path.join(tmp, '**/*.json')],
      concurrency: 1,
      timeoutMs: 1000,
      failFast: true,
      reportPath: undefined,
      hooks: undefined,
    })
    expect(code).toBe(0)
  })
})
