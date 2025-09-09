import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCases } from '../src'

function resolveFixtureConfig(): string {
  return path.join(process.cwd(), 'tests/fixtures/echo-server/vibrissa.json')
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-runner-'))
}

function writeCase(dir: string, name: string, data: unknown): string {
  const file = path.join(dir, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  return file
}

describe('Runner', () => {
  it('returns 0 when all cases pass (echo server)', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(path.dirname(configPath))
    const code = await runCases(options)
    expect(code).toBe(0)
  })

  it('respects failFast by stopping after first failure and logs once', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(path.dirname(configPath))

    const tmp = mkTmpDir()
    writeCase(tmp, 'fail-1', {
      name: 'fail 1',
      tool: 'echo',
      args: { text: 'hello' },
      expect: { tool: 'echo', args: { text: 'nope' } },
    })
    writeCase(tmp, 'fail-2', {
      name: 'fail 2',
      tool: 'echo',
      args: { text: 'world' },
      expect: { tool: 'echo', args: { text: 'nope' } },
    })

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        ...options,
        globs: [path.join(tmp, '**/*.json')],
        failFast: true,
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('processes all cases when failFast=false and logs for each failure', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(path.dirname(configPath))

    const tmp = mkTmpDir()
    writeCase(tmp, 'fail-1', {
      name: 'fail 1',
      tool: 'echo',
      args: { text: 'a' },
      expect: { tool: 'echo', args: { text: 'x' } },
    })
    writeCase(tmp, 'fail-2', {
      name: 'fail 2',
      tool: 'echo',
      args: { text: 'b' },
      expect: { tool: 'echo', args: { text: 'y' } },
    })

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        ...options,
        globs: [path.join(tmp, '**/*.json')],
        failFast: false,
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects when server cannot spawn', async () => {
    const { defaultRunCasesOptions } = await import('../src')
    await expect(
      runCases({
        ...defaultRunCasesOptions,
        server: { cmd: 'non-existent-binary' },
        globs: ['tests/fixtures/echo-server/cases/echo.basic.json'],
        failFast: true,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/ENOENT|Server spawn timeout|Server exited early/i),
    })
  })
})
