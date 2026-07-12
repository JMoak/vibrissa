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
    expect(defaultRunCasesOptions.allowEmpty).toBe(false)
  })

  it('runCases fails loud when defaults match no cases', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases(defaultRunCasesOptions)
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/No test cases matched globs/))
    } finally {
      spy.mockRestore()
    }
  })

  it('runCases accepts custom options', async () => {
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
      server: {
        cmd: 'node',
        args: ['server/index.js'],
        cwd: '.',
        env: { FOO: 'BAR' },
      },
      globs: [path.join(tmp, '**/*.json').replace(/\\/g, '/')],
      concurrency: 1,
      timeoutMs: 10000,
      failFast: true,
      rootDir: path.join(process.cwd(), 'tests/fixtures/echo-server'),
    })
    expect(code).toBe(0)
  })
})
