import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveOptions } from '../src/config'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-test-'))
}

describe('config resolution', () => {
  it('loads vibrissa.json and merges with defaults', () => {
    const tmp = mkTmpDir()
    const json = JSON.stringify({
      server: { cmd: 'node', args: ['custom.js'], env: { FOO: 'bar' } },
      globs: ['tests/**/*.json'],
      timeoutMs: 12345,
      failFast: true,
    })
    fs.writeFileSync(path.join(tmp, 'vibrissa.json'), json, 'utf8')

    const resolved = resolveOptions(tmp)

    expect(resolved.rootDir).toBe(tmp)
    expect(resolved.server.cmd).toBe('node')
    expect(resolved.server.args).toEqual(['custom.js'])
    expect(resolved.server.cwd).toBe('.')
    expect(resolved.server.env?.FOO).toBe('bar')
    expect(resolved.globs).toEqual(['tests/**/*.json'])
    expect(resolved.timeoutMs).toBe(12345)
    expect(resolved.failFast).toBe(true)
  })

  it('sets rootDir to the config file directory for explicit paths', () => {
    const tmp = mkTmpDir()
    const nested = path.join(tmp, 'nested')
    fs.mkdirSync(nested)
    fs.writeFileSync(
      path.join(nested, 'vibrissa.json'),
      JSON.stringify({
        server: { cmd: 'node', args: ['server.js'] },
        globs: ['cases/**/*.json'],
      }),
      'utf8',
    )

    const resolved = resolveOptions(tmp, path.join(nested, 'vibrissa.json'))
    expect(resolved.rootDir).toBe(nested)
    expect(resolved.globs).toEqual(['cases/**/*.json'])
  })

  it('falls back to package.json vibrissa field when file missing', () => {
    const tmp = mkTmpDir()
    const pkg = {
      name: 'tmp',
      version: '0.0.0',
      vibrissa: {
        server: { cmd: 'node', args: ['pkg.js'] },
        globs: ['pkg/**/*.json'],
      },
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg), 'utf8')

    const resolved = resolveOptions(tmp)
    expect(resolved.rootDir).toBe(tmp)
    expect(resolved.server.args).toEqual(['pkg.js'])
    expect(resolved.globs).toEqual(['pkg/**/*.json'])
  })
})
