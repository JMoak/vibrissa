import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type { RunCasesOptions, TestCase } from './types.js'
import { deepEqual } from './utils.js'

async function resolveCaseFiles(globs: string[], cwd: string): Promise<string[]> {
  const patterns = globs.map((g) =>
    (path.isAbsolute(g) ? g : path.join(cwd, g)).replace(/\\/g, '/'),
  )
  return await fg(patterns, { dot: false, onlyFiles: true, unique: true })
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
): Promise<{ ok: boolean; error?: string }> {
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
  }
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('Case timeout exceeded')), timeoutMs)
  })
  try {
    return await Promise.race([fn(), timeoutPromise])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function gracefulKill(proc: ChildProcess, waitMs: number): Promise<void> {
  try {
    proc.kill('SIGTERM')
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  if (proc.exitCode == null) {
    try {
      proc.kill('SIGKILL')
    } catch {}
  }
}

export class Runner {
  private readonly options: RunCasesOptions

  constructor(options: RunCasesOptions) {
    this.options = options
  }

  async run(): Promise<number> {
    const casesBaseDir = process.cwd()
    const files = await resolveCaseFiles(this.options.globs, casesBaseDir)
    if (files.length === 0) return 0
    const { cmd, args = [], env = {}, cwd = '.' } = this.options.server
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
        const { ok, error } = await runWithTimeout(
          () => executeCase(proc, data),
          this.options.timeoutMs,
        )
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
      await gracefulKill(proc, 500)
    }
  }
}
