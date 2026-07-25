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
    const options = resolveOptions(path.dirname(configPath), configPath)
    const code = await runCases(options)
    expect(code).toBe(0)
  })

  it('resolves globs and server.cwd relative to config rootDir', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(process.cwd(), configPath)
    expect(options.rootDir).toBe(path.dirname(configPath))
    expect(options.globs[0]).toBe('cases/**/*.json')
    const code = await runCases(options)
    expect(code).toBe(0)
  })

  it('returns 1 when no cases match', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        server: { cmd: 'node', args: ['server/index.js'] },
        globs: ['does-not-exist/**/*.json'],
        timeoutMs: 1000,
        failFast: true,
        rootDir: path.join(process.cwd(), 'tests/fixtures/echo-server'),
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/No test cases matched globs/))
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 0 with allowEmpty when no cases match', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const code = await runCases({
        server: { cmd: 'node', args: ['server/index.js'] },
        globs: ['does-not-exist/**/*.json'],
        timeoutMs: 1000,
        failFast: true,
        allowEmpty: true,
        rootDir: path.join(process.cwd(), 'tests/fixtures/echo-server'),
      })
      expect(code).toBe(0)
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/No test cases matched globs/))
    } finally {
      spy.mockRestore()
    }
  })

  it('respects failFast by stopping after first failure and logs once', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(path.dirname(configPath), configPath)

    const tmp = mkTmpDir()
    writeCase(tmp, 'fail-1', {
      name: 'fail 1',
      tool: 'echo',
      args: { text: 'hello' },
      expect: { content: [{ type: 'text', text: 'nope' }] },
    })
    writeCase(tmp, 'fail-2', {
      name: 'fail 2',
      tool: 'echo',
      args: { text: 'world' },
      expect: { content: [{ type: 'text', text: 'nope' }] },
    })

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        ...options,
        globs: [path.join(tmp, '**/*.json').replace(/\\/g, '/')],
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
    const options = resolveOptions(path.dirname(configPath), configPath)

    const tmp = mkTmpDir()
    writeCase(tmp, 'fail-1', {
      name: 'fail 1',
      tool: 'echo',
      args: { text: 'a' },
      expect: { content: [{ type: 'text', text: 'x' }] },
    })
    writeCase(tmp, 'fail-2', {
      name: 'fail 2',
      tool: 'echo',
      args: { text: 'b' },
      expect: { content: [{ type: 'text', text: 'y' }] },
    })

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        ...options,
        globs: [path.join(tmp, '**/*.json').replace(/\\/g, '/')],
        failFast: false,
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a malformed case file as a failure and keeps running', async () => {
    const configPath = resolveFixtureConfig()
    const { resolveOptions } = await import('../src/config')
    const options = resolveOptions(path.dirname(configPath), configPath)

    const tmp = mkTmpDir()
    fs.writeFileSync(path.join(tmp, 'a-broken.json'), '{ not valid json', 'utf8')
    writeCase(tmp, 'b-pass', {
      name: 'pass after broken',
      tool: 'echo',
      args: { text: 'ok' },
      expect: { content: [{ type: 'text', text: 'ok' }] },
    })

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await runCases({
        ...options,
        globs: [path.join(tmp, '**/*.json').replace(/\\/g, '/')],
        failFast: false,
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/Failed to load case file/))
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
        rootDir: process.cwd(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/ENOENT|Server spawn timeout|Server exited early/i),
    })
  })
})
