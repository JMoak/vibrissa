import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callCommand } from '../src/cli/call'
import { initCommand } from '../src/cli/init'
import { recordCommand } from '../src/cli/record'
import { toolsCommand } from '../src/cli/tools'

const fixtureConfig = path.join(process.cwd(), 'tests/fixtures/echo-server/vibrissa.json')

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-cli-'))
}

describe('dev-loop CLI commands', () => {
  it('tools lists echo and fail', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const code = await toolsCommand(['--config', fixtureConfig, '--json'])
      expect(code).toBe(0)
      const payload = JSON.parse(String(log.mock.calls[0][0])) as { name: string }[]
      expect(payload.map((t) => t.name).sort()).toEqual(['echo', 'fail'])
    } finally {
      log.mockRestore()
    }
  })

  it('call returns the tool result', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const code = await callCommand([
        'echo',
        '--config',
        fixtureConfig,
        '--args',
        '{"text":"hi","uppercase":true}',
        '--json',
      ])
      expect(code).toBe(0)
      const payload = JSON.parse(String(log.mock.calls[0][0])) as {
        ok: boolean
        result: { content: { text: string }[] }
      }
      expect(payload.ok).toBe(true)
      expect(payload.result.content[0].text).toBe('HI')
    } finally {
      log.mockRestore()
    }
  })

  it('record writes a case file from a live call', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'echo.recorded.json')
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const code = await recordCommand([
        'echo',
        '--config',
        fixtureConfig,
        '--arg',
        'text=hello',
        '--name',
        'echo recorded',
        '--out',
        out,
        '--json',
      ])
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(out, 'utf8')) as {
        tool: string
        expect: { content: { text: string }[] }
      }
      expect(written.tool).toBe('echo')
      expect(written.expect.content[0].text).toBe('hello')
    } finally {
      log.mockRestore()
    }
  })

  it('record refuses to overwrite without --force', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'exists.json')
    fs.writeFileSync(out, '{}\n', 'utf8')
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await recordCommand([
        'echo',
        '--config',
        fixtureConfig,
        '--arg',
        'text=x',
        '--out',
        out,
      ])
      expect(code).toBe(1)
      expect(err).toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
  })

  it('init scaffolds config and sample case', async () => {
    const tmp = mkTmpDir()
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.0.0', scripts: {} }),
      'utf8',
    )
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const code = await initCommand(['--dir', tmp, '--server', 'node server/index.js'])
      expect(code).toBe(0)
      expect(fs.existsSync(path.join(tmp, 'vibrissa.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmp, 'tests/integration/echo.basic.json'))).toBe(true)
      const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
      expect(pkg.scripts['test:integration']).toBe('vib-test run')
      const config = JSON.parse(fs.readFileSync(path.join(tmp, 'vibrissa.json'), 'utf8')) as {
        server: { cmd: string; args: string[] }
      }
      expect(config.server).toEqual({ cmd: 'node', args: ['server/index.js'], cwd: '.' })
    } finally {
      log.mockRestore()
    }
  })
})
