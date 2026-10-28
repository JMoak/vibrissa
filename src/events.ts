/**
 * Shared run-event model. Reporters consume these; the runner emits them.
 * This file is the contract between runner and reporters — change with care.
 */
import type { JsonValue } from './types.js'

export interface CaseRef {
  /** Stable id: relative case file path, plus `#<index>` for repeated runs. */
  id: string
  name: string
  file: string
  tags: string[]
  server: string
  /** Case declared `flaky: true` (pass-rate floor applies under --repeat). */
  flaky?: boolean
  /** 1-based line of the case in its file when known (for annotations). */
  line?: number
}

export interface StepRef {
  index: number
  name: string
  /** 'tool' | 'resource' | 'resourceTemplate' | 'prompt' */
  kind: string
  target: string
}

export interface Mismatch {
  path: string
  message: string
  expected?: unknown
  actual?: unknown
  /** Which case field the mismatch belongs to (machine-patchable failures). */
  field?: 'expect' | 'expectError' | 'expectInputRequired' | 'expectTask' | 'structuredContent'
  /** RFC 6901 JSON Pointer into the case file (e.g. "/steps/1/expect/content/0/text"). */
  pointer?: string
  /** 0-based step index for flows. */
  stepIndex?: number
}

export type CaseStatus = 'passed' | 'failed' | 'skipped' | 'updated'

export interface CaseOutcome {
  status: CaseStatus
  durationMs: number
  /** Human-readable one-line reason for failure / skip. */
  reason?: string
  /** Distinguishes an assertion failure from an error/timeout (JUnit <failure> vs <error>). */
  errorKind?: 'assertion' | 'error' | 'timeout' | 'budget' | 'load'
  /** Path to captured server stderr for this case, if any. */
  stderrPath?: string
  mismatches?: Mismatch[]
  expected?: JsonValue
  actual?: JsonValue
  /** Path to a transcript written for this case, if any. */
  tracePath?: string
  /** Per-step timings (flows). */
  steps?: Array<{ step: StepRef; durationMs: number; status: CaseStatus; reason?: string }>
  /** Budget breach, if `budgetMs` was set and exceeded. */
  budget?: { budgetMs: number; actualMs: number }
  /** Under --update: why this failing case was not rewritten (matchers, expectError, ...). */
  updateSkipped?: { reason: string }
}

export interface CheckOutcome {
  id: string
  server?: string
  title: string
  status: 'passed' | 'failed' | 'warned'
  detail?: string
}

export interface RunSummary {
  /** Case executions (cases × repeat). Distinct cases = distinct case ids (without `#<n>`). */
  total: number
  /** Status counts are per execution and sum to `total`; per-case verdicts: passRates / ok. */
  passed: number
  failed: number
  skipped: number
  updated: number
  durationMs: number
  /** Present when --repeat > 1: executions (= total; cases × repeat, fewer on failFast). */
  runs?: number
  /** Present when --repeat > 1: pass rate per case id. */
  passRates?: Record<string, number>
}

export type RunEvent =
  | {
      type: 'run:start'
      /** Case runs announced (cases × repeat). */
      totalCases: number
      servers: string[]
      startedAt: number
      repeat?: number
      /** Present when the run is one shard of a suite (`--shard i/n`). */
      shard?: { index: number; total: number }
    }
  | {
      type: 'session:start'
      server: string
      era: 'legacy' | 'modern'
      protocolVersion: string
      serverInfo?: { name?: string; version?: string }
    }
  | { type: 'session:end'; server: string }
  | { type: 'manifest:ok'; path: string; server?: string }
  | { type: 'manifest:diff'; path: string; summary: string; diff: JsonValue; server?: string }
  | { type: 'check'; outcome: CheckOutcome }
  | { type: 'case:start'; case: CaseRef }
  | { type: 'step:start'; case: CaseRef; step: StepRef }
  | {
      type: 'step:end'
      case: CaseRef
      step: StepRef
      durationMs: number
      status: CaseStatus
      reason?: string
    }
  | { type: 'case:end'; case: CaseRef; outcome: CaseOutcome }
  | { type: 'warning'; message: string }
  /** `ok` mirrors the runner's exit decision so every reporter agrees with it. */
  | { type: 'run:end'; summary: RunSummary; ok?: boolean }

export interface Reporter {
  readonly name: string
  onEvent(event: RunEvent): void | Promise<void>
  /** Called once after run:end; flush files here. */
  close?(): void | Promise<void>
}

export interface ReporterContext {
  rootDir: string
  /** Directory for reporter artifacts (junit.xml, results.json, traces/...). Default: reports/ */
  outDir: string
  pretty: boolean
  /** Write to stdout; injectable for tests. */
  stdout: (line: string) => void
  stderr: (line: string) => void
}
