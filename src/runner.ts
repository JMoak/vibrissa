import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import type { ResultsDisplay } from './display.js'
import { ConsoleResultsDisplay } from './display.js'
import { type Mismatch, matchValue } from './match.js'
import { McpSession, type ToolError } from './mcp-session.js'
import { resolveRootDir, resolveServerConfig } from './paths.js'
import type { JsonValue, RunCasesOptions, TestCase } from './types.js'

interface CaseResult {
  ok: boolean
  error?: string
  expected?: unknown
  actual?: unknown
}

async function resolveCaseFiles(globs: string[], cwd: string): Promise<string[]> {
  const patterns = globs.map((g) => {
    const isNegative = g.startsWith('!')
    const body = isNegative ? g.slice(1) : g
    const resolved = (path.isAbsolute(body) ? body : path.join(cwd, body)).replace(/\\/g, '/')
    return isNegative ? `!${resolved}` : resolved
  })
  return await fg(patterns, { dot: false, onlyFiles: true, unique: true })
}

function summarizeMismatches(mismatches: Mismatch[], label: string): string {
  const first = mismatches[0]
  const suffix = mismatches.length > 1 ? ` (+${mismatches.length - 1} more)` : ''
  return `${label} at ${first.path}: ${first.message}${suffix}`
}

function matchExpectedError(
  expected: NonNullable<TestCase['expectError']>,
  actual: ToolError,
): CaseResult {
  const observed = {
    code: actual.codeName ?? (actual.code !== undefined ? String(actual.code) : undefined),
    message: actual.message,
  }
  if (expected.code !== undefined) {
    const codeMatches =
      expected.code === actual.codeName || expected.code === String(actual.code ?? '')
    if (!codeMatches) {
      return {
        ok: false,
        error: `Error code mismatch: expected ${JSON.stringify(expected.code)}, got ${JSON.stringify(observed.code)}`,
        expected: expected as JsonValue,
        actual: observed,
      }
    }
  }
  if (expected.message !== undefined) {
    const mismatches = matchValue(expected.message as JsonValue, actual.message)
    if (mismatches.length > 0) {
      return {
        ok: false,
        error: summarizeMismatches(mismatches, 'Error message mismatch'),
        expected: expected as JsonValue,
        actual: observed,
      }
    }
  }
  return { ok: true }
}

async function executeCase(
  session: McpSession,
  testCase: TestCase,
  timeoutMs: number,
): Promise<CaseResult> {
  if (!testCase.tool) {
    return { ok: false, error: 'Case is missing required "tool" field' }
  }
  const outcome = await session.callTool(testCase.tool, testCase.args ?? {}, timeoutMs)

  if (testCase.expectError !== undefined) {
    if (outcome.kind === 'result') {
      return {
        ok: false,
        error: 'Expected an error but tool call succeeded',
        expected: testCase.expectError as JsonValue,
        actual: outcome.result,
      }
    }
    return matchExpectedError(testCase.expectError, outcome.error)
  }

  if (outcome.kind === 'error') {
    const label = outcome.error.codeName ? ` [${outcome.error.codeName}]` : ''
    return { ok: false, error: `Tool call failed${label}: ${outcome.error.message}` }
  }

  if (testCase.expect !== undefined) {
    const mismatches = matchValue(testCase.expect, outcome.result)
    if (mismatches.length > 0) {
      return {
        ok: false,
        error: summarizeMismatches(mismatches, 'Expectation failed'),
        expected: testCase.expect,
        actual: outcome.result,
      }
    }
  }
  return { ok: true }
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

export class Runner {
  private readonly options: RunCasesOptions
  private readonly display: ResultsDisplay

  constructor(options: RunCasesOptions, display: ResultsDisplay = new ConsoleResultsDisplay()) {
    this.options = options
    this.display = display
  }

  async run(): Promise<number> {
    const rootDir = resolveRootDir(this.options)
    const files = await resolveCaseFiles(this.options.globs, rootDir)
    if (files.length === 0) {
      const pattern = this.options.globs.join(', ')
      const message = `No test cases matched globs: ${pattern} (from ${rootDir})`
      if (this.options.allowEmpty) {
        console.warn(message)
        return 0
      }
      console.error(message)
      return 1
    }
    this.display.onStart(files.length)
    const spawnTimeoutMs = Math.max(2000, Math.min(10000, this.options.timeoutMs))
    const server = resolveServerConfig(this.options)
    const session = await McpSession.start(server, spawnTimeoutMs)
    try {
      let failures = 0
      const startedAt = Date.now()
      let processed = 0
      for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8')
        const data = JSON.parse(raw) as TestCase
        const { ok, error, expected, actual } = await runWithTimeout(
          () => executeCase(session, data, this.options.timeoutMs),
          this.options.timeoutMs,
        )
        if (!ok) {
          failures++
          const caseName = data.name ?? path.basename(file)
          const details =
            expected !== undefined ? ` :: ${JSON.stringify({ expected, actual })}` : ''
          this.display.onCaseFail(caseName, `${error ?? 'Error'}${details}`)
          if (this.options.failFast) break
        } else {
          const caseName = data.name ?? path.basename(file)
          this.display.onCasePass(caseName)
        }
        processed++
      }
      this.display.onComplete({
        total: processed,
        passed: processed - failures,
        failed: failures,
        durationMs: Date.now() - startedAt,
      })
      return failures === 0 ? 0 : 1
    } finally {
      await session.close()
    }
  }
}
