import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/cli/run'

const fixtureConfig = path.join(process.cwd(), 'tests/fixtures/echo-server/vibrissa.json')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run command', () => {
  it('runs the fixture suite and exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await runCommand(['--config', fixtureConfig])
    expect(code).toBe(0)
  })

  it('honors --cases overrides relative to the shell cwd', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--cases',
      'tests/fixtures/echo-server/cases/echo.basic.json',
    ])
    expect(code).toBe(0)
  })

  it('exits 1 when a case fails and prints the plain display with --no-pretty', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await runCommand([
      '--config',
      fixtureConfig,
      '--no-pretty',
      '--cases',
      'tests/fixtures/echo-server/cases/echo.fail.json',
    ])
    expect(code).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/Case failed:/))
  })

  it('exits 1 on empty globs unless --allow-empty', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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
})
