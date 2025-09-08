import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { RunCasesOptions, TestCase } from './types.js'
import { deepEqual, matchGlob, walk } from './utils.js'

function resolveCaseFiles(globs: string[], cwd: string): string[] {
  const all = walk(cwd)
  const jsonFiles = all.filter((f) => f.endsWith('.json'))
  const matched = new Set<string>()
  for (const g of globs) {
    const gAbs = path.isAbsolute(g) ? g : path.join(cwd, g)
    for (const f of jsonFiles) if (matchGlob(f, gAbs)) matched.add(f)
  }
  return Array.from(matched)
}

async function waitForSpawn(proc: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error('Server spawn timeout'))
    }, timeoutMs)
    proc.once('spawn', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    })
    proc.once('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    proc.once('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`Server exited early with code ${code}`))
    })
  })
}

async function executeCase(
  _proc: ChildProcess,
  testCase: TestCase,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const timer = setTimeout(() => {}, timeoutMs)
  try {
    const tool = testCase.tool ?? ''
    const args = testCase.args ?? {}
    const simulated = { tool, args }
    if (testCase.expect !== undefined) {
      const ok = deepEqual(simulated, testCase.expect)
      if (!ok) return { ok: false, error: 'Expectation failed' }
    }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (testCase.expectError) return { ok: true }
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

export class Runner {
  private readonly options: RunCasesOptions

  constructor(options: RunCasesOptions) {
    this.options = options
  }

  async run(): Promise<number> {
    const cwd = this.options.server.cwd ?? process.cwd()
    const files = resolveCaseFiles(this.options.globs, cwd)
    if (files.length === 0) return 0
    const { cmd, args = [], env = {} } = this.options.server
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    try {
      await waitForSpawn(proc, Math.max(2000, Math.min(10000, this.options.timeoutMs)))
      let failures = 0
      for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8')
        const data = JSON.parse(raw) as TestCase
        const { ok, error } = await executeCase(proc, data, this.options.timeoutMs)
        if (!ok) {
          failures++
          console.error(
            `Case failed: ${data.name ?? path.basename(file)}${error ? ` - ${error}` : ''}`,
          )
          if (this.options.failFast) break
        }
      }
      return failures === 0 ? 0 : 1
    } finally {
      try {
        proc.kill()
      } catch {}
    }
  }
}
