/**
 * Case loading: globs → files → parsed, validated, `$ref`-expanded cases, plus the
 * filters `vib run` applies (tags, grep, shard, skip) and the `{{name}}` interpolation
 * engine flows use at run time.
 *
 * Loading never throws for a bad case file: the problem is attached to the LoadedCase
 * (`error`) so the runner reports it as a failed case (errorKind `load`) and keeps going.
 */
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { stripJsonComments, stripTrailingCommas } from './config.js'
import type { CaseRef } from './events.js'
import { manifestPathFor } from './manifest.js'
import { RefResolutionError, lintExpectation, resolveRefs } from './match.js'
import { canonicalCodeName, knownCodeNames } from './session/errors.js'
import type { JsonObject, JsonValue, ShardSpec, Step, SuiteHooks, TestCase } from './types.js'

export type OpKind = 'tool' | 'resource' | 'resourceTemplate' | 'prompt'

export const OP_KINDS: readonly OpKind[] = ['tool', 'resource', 'resourceTemplate', 'prompt']

export const STEP_KEYS = [
  'name',
  'tool',
  'resource',
  'resourceTemplate',
  'prompt',
  'args',
  'expect',
  'expectError',
  'respond',
  'expectInputRequired',
  'expectTask',
  'await',
  'capture',
  'budgetMs',
  'timeoutMs',
  'ignoreErrors',
  'validateOutput',
  'normalize',
] as const

export const CASE_KEYS = [
  '$schema',
  ...STEP_KEYS,
  'tags',
  'server',
  'steps',
  'setup',
  'teardown',
  'flaky',
  'skip',
] as const

/** Expectation-bearing step fields: `$ref`-expanded at load, linted, interpolated at run. */
export const EXPECTATION_KEYS = ['expect', 'expectInputRequired', 'expectTask'] as const

export interface LoadedCase {
  /** Stable reference (id = root-relative posix path; `line` 1). */
  ref: CaseRef
  /** Absolute path of the case file. */
  path: string
  /** The case with `$ref`s expanded. Undefined when the file failed to load. */
  data?: TestCase
  /** The case exactly as parsed (no `$ref` expansion): the basis for `--update` rewrites. */
  source?: TestCase
  /** Raw file text. */
  text?: string
  /** Load / validation problem: the case is reported failed with errorKind `load`. */
  error?: string
  /** Set when the case declares `skip: true | "reason"`. */
  skip?: string
  /**
   * The file is not a case, and loadCases drops it: a manifest lock, or a `$ref` fragment (no
   * operation / `steps`, and referenced by another matched file or kept in `shared/` /
   * `fragments/`).
   */
  notACase?: 'manifest' | 'fragment'
}

export interface CaseFilters {
  /** Keep cases carrying at least one of these tags. */
  tags?: string[]
  /** Drop cases carrying any of these tags. */
  excludeTags?: string[]
  /** Keep cases whose name or id matches (case-insensitive regex, else substring). */
  grep?: string
  /** Keep every `total`-th case (1-based `index`) of the id-sorted selection. */
  shard?: ShardSpec
}

export interface LoadCasesOptions extends CaseFilters {
  rootDir: string
  globs: string[]
  /** Server for cases without `server`. Default `"default"`. */
  defaultServer?: string
  /** Known server names; a case naming another server fails to load. */
  servers?: string[]
  /** Suite hooks: their captures are valid `{{names}}` in every case. */
  hooks?: SuiteHooks
  /** Environment for `{{env.X}}` checks. Default process.env. */
  env?: Record<string, string | undefined>
  /**
   * Config `manifest` path (default tests/integration/__manifest__.json). The lock files (this
   * path for the default server and the `<name>.<server>.json` siblings for `servers`) are
   * never loaded as cases, even when the globs match them. Files shaped like a manifest
   * (`"vibrissa": 2` + a `tools` array) are skipped too.
   */
  manifest?: string
  /** Extra files (absolute, or relative to rootDir) that are never cases. */
  exclude?: string[]
}

export interface LoadCasesResult {
  /** Selected cases, sorted by id. */
  cases: LoadedCase[]
  /** Number of case files the globs matched (before filters). */
  matched: number
  /** Non-fatal loader notes (ignored top-level op fields, ...). */
  warnings: string[]
  /** Ids of `$ref` fragment files the globs matched and that were skipped (not cases). */
  fragments?: string[]
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function toPatterns(globs: string[]): string[] {
  return globs.map((glob) => glob.replace(/\\/g, '/'))
}

/** Resolve case globs (relative to rootDir; `!` negates) to absolute, sorted file paths. */
export async function resolveCaseFiles(globs: string[], rootDir: string): Promise<string[]> {
  const files = await fg(toPatterns(globs), {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
  })
  return files.map((file) => path.resolve(file)).sort()
}

export function resolveCaseFilesSync(globs: string[], rootDir: string): string[] {
  const files = fg.sync(toPatterns(globs), {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
  })
  return files.map((file) => path.resolve(file)).sort()
}

/** Root-relative posix path when the file is inside rootDir, else the absolute posix path. */
export function caseIdFor(file: string, rootDir: string): string {
  const rel = path.relative(rootDir, file)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/')
  return path.resolve(file).replace(/\\/g, '/')
}

function hasComments(text: string): boolean {
  return stripJsonComments(text) !== text
}

/** Parse JSONC (comments and trailing commas allowed). Throws "<where>: invalid JSON ...". */
export function parseCaseText(text: string, where: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text.replace(/^﻿/, ''))))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${where}: invalid JSON (${reason}). Fix the syntax; comments and trailing commas are allowed.`,
    )
  }
}

/** True when the file contains comments (an --update rewrite would drop them). */
export function caseFileHasComments(text: string): boolean {
  return hasComments(text)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  const text = JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

function suggest(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase()
  return known
    .map((name) => ({ name, d: editDistance(lower, name.toLowerCase()) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d)[0]?.name
}

function isCommentKey(key: string): boolean {
  return key === '$comment' || key.startsWith('//')
}

function joinAt(at: string, key: string | number): string {
  if (typeof key === 'number') return `${at}[${key}]`
  return at ? `${at}.${key}` : key
}

function prefix(at: string): string {
  return at ? `${at}: ` : ''
}

/** Operation kind of a step, or undefined when it names none. */
export function opKindOf(step: Step): OpKind | undefined {
  return OP_KINDS.find((kind) => step[kind] !== undefined)
}

class ShapeChecker {
  readonly problems: string[] = []
  readonly warnings: string[] = []

  problem(at: string, text: string): void {
    this.problems.push(`${prefix(at)}${text}`)
  }

  nonNegative(value: unknown, at: string, key: string): void {
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      this.problem(at, `"${key}" must be a number of milliseconds >= 0, got ${describe(value)}`)
    }
  }

  boolean(value: unknown, at: string, key: string): void {
    if (value !== undefined && typeof value !== 'boolean') {
      this.problem(at, `"${key}" must be true or false, got ${describe(value)}`)
    }
  }

  keys(raw: Record<string, unknown>, at: string, known: readonly string[], what: string): void {
    for (const key of Object.keys(raw)) {
      if (known.includes(key) || isCommentKey(key)) continue
      const near = suggest(key, known)
      const hint = near
        ? ` Did you mean "${near}"?`
        : ` Allowed keys: ${known.filter((k) => k !== '$schema').join(', ')}.`
      if ((CASE_KEYS as readonly string[]).includes(key)) {
        this.problem(at, `"${key}" is not allowed in a ${what}; it only works at the case level.`)
      } else {
        this.problem(at, `"${key}" is not a ${what} key.${hint}`)
      }
    }
  }

  step(raw: Record<string, unknown>, at: string, what: string, requireOp: boolean): void {
    const ops = OP_KINDS.filter((kind) => raw[kind] !== undefined)
    if (requireOp && ops.length === 0) {
      this.problem(
        at,
        `no operation. Add one of "tool", "resource", "resourceTemplate" or "prompt"${what === 'case' ? ' (or "steps" for a flow)' : ''}`,
      )
    }
    if (ops.length > 1) {
      this.problem(
        at,
        `${ops.map((o) => `"${o}"`).join(' and ')} are all set; a ${what} runs exactly one operation. ${what === 'case' ? 'Split it into "steps".' : 'Use one step per operation.'}`,
      )
    }
    for (const kind of ops) {
      if (typeof raw[kind] !== 'string' || (raw[kind] as string).length === 0) {
        this.problem(at, `"${kind}" must be a non-empty string, got ${describe(raw[kind])}`)
      }
    }
    if (raw.name !== undefined && typeof raw.name !== 'string') {
      this.problem(at, `"name" must be a string, got ${describe(raw.name)}`)
    }
    if (raw.args !== undefined && !isPlainObject(raw.args)) {
      this.problem(at, `"args" must be an object of arguments, got ${describe(raw.args)}`)
    }
    if (raw.expect !== undefined && raw.expectError !== undefined) {
      this.problem(
        at,
        '"expect" and "expectError" are both set; a step either succeeds or fails. Keep one.',
      )
    }
    if (raw.expectError !== undefined) this.expectError(raw.expectError, joinAt(at, 'expectError'))
    if (raw.respond !== undefined && !isPlainObject(raw.respond)) {
      this.problem(
        at,
        `"respond" must be an object keyed by request method (e.g. {"elicitation/create": {...}}), got ${describe(raw.respond)}`,
      )
    }
    if (raw.capture !== undefined) {
      if (!isPlainObject(raw.capture)) {
        this.problem(
          at,
          `"capture" must map names to dotted paths (e.g. {"sid": "structuredContent.sessionId"}), got ${describe(raw.capture)}`,
        )
      } else {
        for (const [name, value] of Object.entries(raw.capture)) {
          if (!/^[A-Za-z_][\w-]*$/.test(name) || name === 'env') {
            this.problem(
              at,
              `capture name "${name}" is not usable in {{...}}. Use letters, digits, _ or - (not "env")`,
            )
          }
          if (typeof value !== 'string' || value.length === 0) {
            this.problem(
              joinAt(at, 'capture'),
              `"${name}" must be a dotted path string, got ${describe(value)}`,
            )
          }
        }
      }
    }
    if (raw.await !== undefined) {
      const value = raw.await
      if (typeof value !== 'boolean' && !isPlainObject(value)) {
        this.problem(
          at,
          `"await" must be true or { "pollMs", "timeoutMs" }, got ${describe(value)}`,
        )
      } else if (isPlainObject(value)) {
        this.keys(value, joinAt(at, 'await'), ['pollMs', 'timeoutMs'], 'await option')
        this.nonNegative(value.pollMs, joinAt(at, 'await'), 'pollMs')
        this.nonNegative(value.timeoutMs, joinAt(at, 'await'), 'timeoutMs')
      }
    }
    this.nonNegative(raw.budgetMs, at, 'budgetMs')
    this.nonNegative(raw.timeoutMs, at, 'timeoutMs')
    this.boolean(raw.ignoreErrors, at, 'ignoreErrors')
    this.boolean(raw.validateOutput, at, 'validateOutput')
    if (raw.normalize !== undefined) this.normalize(raw.normalize, joinAt(at, 'normalize'))
  }

  expectError(value: unknown, at: string): void {
    if (!isPlainObject(value)) {
      this.problem(at, `must be an object like {"code": "InvalidParams"}, got ${describe(value)}`)
      return
    }
    this.keys(value, at, ['code', 'message'], 'expectError')
    if (
      value.code !== undefined &&
      typeof value.code !== 'string' &&
      typeof value.code !== 'number'
    )
      this.problem(at, `"code" must be a code name or number, got ${describe(value.code)}`)
    if (typeof value.code === 'string') {
      const known = knownCodeNames()
      if (!known.includes(canonicalCodeName(value.code))) {
        const near = suggest(value.code, known)
        this.problem(
          at,
          `"code" ${JSON.stringify(value.code)} is not a known error code;${near ? ` did you mean "${near}"?` : ` known names: ${known.join(', ')}.`} Use the numeric JSON-RPC code for anything else (e.g. -32000)`,
        )
      }
    }
    const message = value.message
    if (
      message !== undefined &&
      typeof message !== 'string' &&
      !(isPlainObject(message) && typeof message.$regex === 'string')
    ) {
      this.problem(at, `"message" must be a string or {"$regex": "..."}, got ${describe(message)}`)
    }
  }

  normalize(value: unknown, at: string): void {
    if (value === false) return
    if (!isPlainObject(value)) {
      this.problem(at, `must be false or { stripMeta, dropKeys, ttlMs }, got ${describe(value)}`)
      return
    }
    this.keys(value, at, ['stripMeta', 'dropKeys', 'ttlMs'], 'normalize option')
    for (const key of ['stripMeta', 'dropKeys']) {
      const list = value[key]
      if (list !== undefined && (!Array.isArray(list) || list.some((v) => typeof v !== 'string')))
        this.problem(at, `"${key}" must be an array of strings, got ${describe(list)}`)
    }
    if (value.ttlMs !== undefined && value.ttlMs !== 'keep' && value.ttlMs !== 'ignore')
      this.problem(at, `"ttlMs" must be "keep" or "ignore", got ${describe(value.ttlMs)}`)
  }

  steps(value: unknown, key: 'steps' | 'setup' | 'teardown'): void {
    if (!Array.isArray(value)) {
      this.problem('', `"${key}" must be an array of step objects, got ${describe(value)}`)
      return
    }
    if (key === 'steps' && value.length === 0) {
      this.problem('', '"steps" is empty. Add at least one step, or remove "steps".')
    }
    value.forEach((step, i) => {
      const at = joinAt(key, i)
      if (!isPlainObject(step)) {
        this.problem(at, `must be a step object, got ${describe(step)}`)
        return
      }
      this.keys(step, at, STEP_KEYS, 'step')
      this.step(step, at, 'step', true)
    })
  }
}

/** Shape problems for a parsed case ("<where>: <problem>. <hint>" without the file). */
export function validateCaseShape(raw: unknown): { problems: string[]; warnings: string[] } {
  const check = new ShapeChecker()
  if (!isPlainObject(raw)) {
    check.problem('', `a case must be a JSON object, got ${describe(raw)}`)
    return { problems: check.problems, warnings: check.warnings }
  }
  check.keys(raw, '', CASE_KEYS, 'case')
  const isFlow = raw.steps !== undefined
  if (isFlow) {
    check.steps(raw.steps, 'steps')
    for (const kind of OP_KINDS) {
      if (raw[kind] !== undefined) {
        check.warnings.push(
          `top-level "${kind}" is ignored because "steps" is present; move it into a step`,
        )
      }
    }
    for (const key of ['expect', 'expectError', 'expectInputRequired', 'expectTask', 'respond']) {
      if (raw[key] !== undefined) {
        check.warnings.push(
          `top-level "${key}" is ignored because "steps" is present; move it into the step it belongs to`,
        )
      }
    }
    check.nonNegative(raw.budgetMs, '', 'budgetMs')
    check.nonNegative(raw.timeoutMs, '', 'timeoutMs')
    check.boolean(raw.validateOutput, '', 'validateOutput')
    if (raw.normalize !== undefined) check.normalize(raw.normalize, 'normalize')
  } else {
    check.step(raw, '', 'case', true)
  }
  if (raw.setup !== undefined) check.steps(raw.setup, 'setup')
  if (raw.teardown !== undefined) check.steps(raw.teardown, 'teardown')
  if (
    raw.tags !== undefined &&
    (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string'))
  ) {
    check.problem('', `"tags" must be an array of strings, got ${describe(raw.tags)}`)
  }
  if (raw.server !== undefined && (typeof raw.server !== 'string' || raw.server === '')) {
    check.problem(
      '',
      `"server" must be a server name from vibrissa.json, got ${describe(raw.server)}`,
    )
  }
  check.boolean(raw.flaky, '', 'flaky')
  if (raw.skip !== undefined && typeof raw.skip !== 'boolean' && typeof raw.skip !== 'string') {
    check.problem('', `"skip" must be true or a reason string, got ${describe(raw.skip)}`)
  }
  return { problems: check.problems, warnings: check.warnings }
}

// ---------------------------------------------------------------------------
// Steps & plan helpers
// ---------------------------------------------------------------------------

export type StepPhase = 'setup' | 'main' | 'teardown'

export interface PlannedStep {
  phase: StepPhase
  step: Step
  /** Where the step lives in the case file (e.g. `["steps", 1]`, `[]` = the case itself). */
  source: Array<string | number>
  /** Matcher-path label of the step: `steps[1]`, `setup[0]`, or `` for a single-op case. */
  at: string
}

const CASE_ONLY = new Set([
  '$schema',
  'tags',
  'server',
  'steps',
  'setup',
  'teardown',
  'flaky',
  'skip',
])

/** The single operation of a non-flow case, as a step (case-only keys and budgetMs removed). */
export function caseAsStep(data: TestCase): Step {
  const step: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (CASE_ONLY.has(key) || key === 'budgetMs') continue
    step[key] = value
  }
  return step as Step
}

/** setup → steps (or the case's own op) → teardown, in run order. */
export function planSteps(data: TestCase): PlannedStep[] {
  const plan: PlannedStep[] = []
  data.setup?.forEach((step, i) =>
    plan.push({ phase: 'setup', step, source: ['setup', i], at: `setup[${i}]` }),
  )
  if (data.steps) {
    data.steps.forEach((step, i) =>
      plan.push({ phase: 'main', step, source: ['steps', i], at: `steps[${i}]` }),
    )
  } else {
    plan.push({ phase: 'main', step: caseAsStep(data), source: [], at: '' })
  }
  data.teardown?.forEach((step, i) =>
    plan.push({ phase: 'teardown', step, source: ['teardown', i], at: `teardown[${i}]` }),
  )
  return plan
}

/** True when the case reports per-step results (a flow, or a case with setup/teardown). */
export function isMultiStep(data: TestCase): boolean {
  return (
    data.steps !== undefined || (data.setup?.length ?? 0) > 0 || (data.teardown?.length ?? 0) > 0
  )
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

export interface InterpolationScope {
  vars: Record<string, JsonValue>
  env?: Record<string, string | undefined>
}

export class InterpolationError extends Error {
  constructor(
    message: string,
    /** The placeholder name (`sid`, `env.TOKEN`). */
    readonly placeholder: string,
    readonly at: string,
  ) {
    super(message)
    this.name = 'InterpolationError'
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g
const EXACT_PLACEHOLDER = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/

function lookup(name: string, scope: InterpolationScope, at: string): JsonValue {
  if (name.startsWith('env.')) {
    const key = name.slice(4)
    const value = (scope.env ?? process.env)[key]
    if (value === undefined) {
      throw new InterpolationError(
        `Interpolation failed at ${at || '(root)'}: {{${name}}} refers to environment variable ${key}, which is not set. Export it, or remove the reference.`,
        name,
        at,
      )
    }
    return value
  }
  if (!Object.hasOwn(scope.vars, name)) {
    const have = Object.keys(scope.vars)
    throw new InterpolationError(
      `Interpolation failed at ${at || '(root)'}: {{${name}}} has no captured value (captured so far: ${have.length ? have.join(', ') : 'none'}). Capture it in an earlier step with "capture": { "${name}": "<path>" }.`,
      name,
      at,
    )
  }
  return scope.vars[name]
}

/**
 * Replace `{{name}}` / `{{env.X}}` in every string of `value` (keys untouched). A string that
 * is exactly one placeholder becomes the raw captured JSON value; otherwise values are
 * inlined (strings as-is, everything else as JSON). Unknown names throw InterpolationError.
 */
export function interpolate(value: JsonValue, scope: InterpolationScope, at = ''): JsonValue {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value
    const exact = EXACT_PLACEHOLDER.exec(value)
    if (exact) return lookup(exact[1], scope, at)
    return value.replace(PLACEHOLDER, (_match, name: string) => {
      const resolved = lookup(name, scope, at)
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((item, i) => interpolate(item, scope, joinAt(at, i)))
  if (isPlainObject(value)) {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolate(item as JsonValue, scope, joinAt(at, key))
    }
    return out
  }
  return value
}

/** Every `{{name}}` used in `value`, with where it was found. */
export function placeholdersIn(value: unknown, at = ''): Array<{ name: string; at: string }> {
  const out: Array<{ name: string; at: string }> = []
  const walk = (node: unknown, where: string) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(PLACEHOLDER)) out.push({ name: match[1], at: where })
    } else if (Array.isArray(node)) node.forEach((item, i) => walk(item, joinAt(where, i)))
    else if (isPlainObject(node)) {
      for (const [key, item] of Object.entries(node)) walk(item, joinAt(where, key))
    }
  }
  walk(value, at)
  return out
}

/** Step fields that are interpolated before the operation runs. */
export const INTERPOLATED_KEYS = [
  'tool',
  'resource',
  'resourceTemplate',
  'prompt',
  'args',
  'expect',
  'expectError',
  'respond',
  'expectInputRequired',
  'expectTask',
] as const

/** Interpolate a step's interpolated fields. */
export function interpolateStep(step: Step, scope: InterpolationScope, at: string): Step {
  const out: Record<string, unknown> = { ...step }
  for (const key of INTERPOLATED_KEYS) {
    const value = (step as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = interpolate(value as JsonValue, scope, joinAt(at, key))
  }
  return out as Step
}

/** Static check: every `{{name}}` refers to something captured earlier (or env / suite). */
function checkPlaceholders(
  data: TestCase,
  globalNames: Set<string>,
  env: Record<string, string | undefined>,
): string[] {
  const problems: string[] = []
  const known = new Set(globalNames)
  const everCaptured = new Set(globalNames)
  for (const planned of planSteps(data)) {
    for (const name of Object.keys(planned.step.capture ?? {})) everCaptured.add(name)
  }
  for (const planned of planSteps(data)) {
    const visible = planned.phase === 'teardown' ? everCaptured : known
    for (const key of INTERPOLATED_KEYS) {
      const value = (planned.step as Record<string, unknown>)[key]
      for (const use of placeholdersIn(value, joinAt(planned.at, key))) {
        if (use.name.startsWith('env.')) {
          if (env[use.name.slice(4)] === undefined) {
            problems.push(
              `${use.at}: {{${use.name}}} refers to environment variable ${use.name.slice(4)}, which is not set. Export it, or remove the reference`,
            )
          }
        } else if (!visible.has(use.name)) {
          problems.push(
            `${use.at}: {{${use.name}}} is never captured before this step. Add "capture": { "${use.name}": "<dotted.path>" } to an earlier step`,
          )
        }
      }
    }
    for (const name of Object.keys(planned.step.capture ?? {})) known.add(name)
  }
  return problems
}

// ---------------------------------------------------------------------------
// $ref expansion & lint
// ---------------------------------------------------------------------------

function refLoader(caseFile: string): (relPath: string) => JsonValue {
  const dir = path.dirname(caseFile)
  return (relPath: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(relPath)) {
      throw new Error('remote $ref URLs are not supported; vendor the fragment into the repo')
    }
    const file = path.isAbsolute(relPath) ? relPath : path.resolve(dir, relPath)
    return parseCaseText(fs.readFileSync(file, 'utf8'), relPath) as JsonValue
  }
}

function expandStep(step: Step, at: string, load: (relPath: string) => JsonValue): Step {
  const out: Record<string, unknown> = { ...step }
  for (const key of EXPECTATION_KEYS) {
    const value = step[key]
    if (value === undefined) continue
    try {
      out[key] = resolveRefs(value, load)
    } catch (err) {
      if (err instanceof RefResolutionError) {
        throw new Error(`${joinAt(at, key)}: ${err.message}`)
      }
      throw err
    }
  }
  return out as Step
}

function expandCase(data: TestCase, file: string): TestCase {
  const load = refLoader(file)
  const out: TestCase = { ...expandStep(data, '', load) } as TestCase
  for (const key of ['steps', 'setup', 'teardown'] as const) {
    const list = data[key]
    if (list) out[key] = list.map((step, i) => expandStep(step, `${key}[${i}]`, load))
  }
  return out
}

function lintCase(data: TestCase): string[] {
  const problems: string[] = []
  for (const planned of planSteps(data)) {
    for (const key of EXPECTATION_KEYS) {
      const value = planned.step[key]
      if (value === undefined) continue
      for (const m of lintExpectation(value)) {
        problems.push(`${joinAt(planned.at, key)} at ${m.path}: ${m.message}`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function summarizeProblems(problems: string[]): string {
  const shown = problems.slice(0, 3).map((p) => p.replace(/\.$/, ''))
  const more = problems.length > shown.length ? ` (+${problems.length - shown.length} more)` : ''
  const text = `${shown.join('; ')}${more}`
  return /[?!]$/.test(text) ? text : `${text}.`
}

function baseName(file: string): string {
  return path.basename(file).replace(/\.jsonc?$/i, '')
}

export interface LoadCaseFileOptions {
  rootDir: string
  defaultServer?: string
  servers?: string[]
  hooks?: SuiteHooks
  env?: Record<string, string | undefined>
}

function hookCaptureNames(hooks: SuiteHooks | undefined): Set<string> {
  const names = new Set<string>()
  for (const step of hooks?.setup ?? []) {
    for (const name of Object.keys(step.capture ?? {})) names.add(name)
  }
  return names
}

/** A manifest lock (`vib manifest record` output), not a case. */
export function looksLikeManifest(raw: unknown): boolean {
  return isPlainObject(raw) && raw.vibrissa === 2 && Array.isArray(raw.tools)
}

/** Lock files for `manifest` (default server + per-server siblings), absolute. */
export function manifestFiles(options: LoadCasesOptions): string[] {
  const defaultServer = options.defaultServer ?? 'default'
  const servers = [...new Set([defaultServer, ...(options.servers ?? [])])]
  return servers.map((server) =>
    manifestPathFor(
      { manifest: options.manifest, rootDir: options.rootDir, defaultServer },
      server,
    ),
  )
}

/**
 * Load one case file. Never throws: problems land in `error` (and `warnings`). A file shaped
 * like a manifest lock comes back with `notACase: 'manifest'` (and no data).
 */
export function loadCaseFile(
  file: string,
  opts: LoadCaseFileOptions,
  warnings: string[] = [],
): LoadedCase {
  const id = caseIdFor(file, opts.rootDir)
  const defaultServer = opts.defaultServer ?? 'default'
  const ref: CaseRef = {
    id,
    name: baseName(file),
    file: id,
    tags: [],
    server: defaultServer,
    line: 1,
  }
  const loaded: LoadedCase = { ref, path: path.resolve(file) }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    loaded.error = `${id}: cannot read the case file (${err instanceof Error ? err.message : String(err)}). Check the path and permissions.`
    return loaded
  }
  loaded.text = text
  let raw: unknown
  try {
    raw = parseCaseText(text, id)
  } catch (err) {
    loaded.error = err instanceof Error ? err.message : String(err)
    return loaded
  }

  if (looksLikeManifest(raw)) {
    loaded.notACase = 'manifest'
    return loaded
  }

  if (isPlainObject(raw)) {
    if (typeof raw.name === 'string' && raw.name) ref.name = raw.name
    if (Array.isArray(raw.tags))
      ref.tags = raw.tags.filter((t): t is string => typeof t === 'string')
    if (typeof raw.server === 'string' && raw.server) ref.server = raw.server
    if (raw.flaky === true) ref.flaky = true
  }

  const shape = validateCaseShape(raw)
  for (const warning of shape.warnings) warnings.push(`${id}: ${warning}.`)
  if (shape.problems.length > 0) {
    loaded.error = `${id}: ${summarizeProblems(shape.problems)}`
    return loaded
  }
  const source = raw as TestCase
  loaded.source = source

  if (opts.servers && source.server !== undefined && !opts.servers.includes(source.server)) {
    loaded.error = `${id}: unknown server "${source.server}" (have: ${opts.servers.join(', ') || 'none'}). Add it to "servers" in vibrissa.json, or fix "server".`
    return loaded
  }

  let data: TestCase
  try {
    data = expandCase(source, loaded.path)
  } catch (err) {
    loaded.error = `${id}: ${err instanceof Error ? err.message : String(err)}`
    return loaded
  }

  const problems = [
    ...lintCase(data),
    ...checkPlaceholders(data, hookCaptureNames(opts.hooks), opts.env ?? process.env),
  ]
  if (problems.length > 0) {
    loaded.error = `${id}: ${summarizeProblems(problems)}`
    return loaded
  }
  loaded.data = data
  if (source.skip !== undefined && source.skip !== false) {
    loaded.skip = typeof source.skip === 'string' && source.skip ? source.skip : 'skip: true'
  }
  return loaded
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function grepMatcher(grep: string): (text: string) => boolean {
  try {
    const re = new RegExp(grep, 'i')
    return (text) => re.test(text)
  } catch {
    const needle = grep.toLowerCase()
    return (text) => text.toLowerCase().includes(needle)
  }
}

/** Apply tag / exclude-tag / grep filters, then the shard, to id-sorted cases. */
export function filterCases(cases: LoadedCase[], filters: CaseFilters): LoadedCase[] {
  const tags = (filters.tags ?? []).filter(Boolean)
  const exclude = (filters.excludeTags ?? []).filter(Boolean)
  const grep = filters.grep ? grepMatcher(filters.grep) : undefined
  const selected = [...cases]
    .sort((a, b) => (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0))
    .filter((c) => {
      // Broken files carry no trustworthy tags; keep them so they are never silently dropped.
      const broken = c.error !== undefined && c.source === undefined
      if (!broken && tags.length > 0 && !c.ref.tags.some((t) => tags.includes(t))) return false
      if (!broken && exclude.length > 0 && c.ref.tags.some((t) => exclude.includes(t))) return false
      if (grep && !grep(c.ref.name) && !grep(c.ref.id)) return false
      return true
    })
  return shardCases(selected, filters.shard)
}

/** Keep every `total`-th case of the (already sorted) list, starting at `index` (1-based). */
export function shardCases<T>(cases: T[], shard: ShardSpec | undefined): T[] {
  if (!shard || shard.total <= 1) return cases
  return cases.filter((_, i) => i % shard.total === shard.index - 1)
}

function pathKey(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Directory names whose JSON files are `$ref` fragments, not cases. */
export const FRAGMENT_DIRS: readonly string[] = ['shared', 'fragments']

const URL_REF = /^[a-z][a-z0-9+.-]*:\/\//i

/** Absolute files referenced by `$ref`s anywhere in `doc` (pointers and URLs ignored). */
function refTargets(doc: unknown, file: string, out: Set<string>): void {
  if (Array.isArray(doc)) {
    for (const item of doc) refTargets(item, file, out)
    return
  }
  if (!isPlainObject(doc)) return
  for (const [key, value] of Object.entries(doc)) {
    if (key === '$ref' && typeof value === 'string') {
      const target = value.split('#')[0]
      if (target && !URL_REF.test(target)) {
        out.add(pathKey(path.resolve(path.dirname(file), target.replace(/\\/g, '/'))))
      }
    } else refTargets(value, file, out)
  }
}

/** A JSON document that cannot be a case: no operation key and no `steps`. */
function hasNoOperation(raw: unknown): boolean {
  if (!isPlainObject(raw)) return true
  return raw.steps === undefined && OP_KINDS.every((kind) => raw[kind] === undefined)
}

function inFragmentDir(file: string, rootDir: string): boolean {
  const rel = path.relative(rootDir, file)
  const parts = (rel && !rel.startsWith('..') ? rel : file).split(/[\\/]/).slice(0, -1)
  return parts.some((part) => FRAGMENT_DIRS.includes(part.toLowerCase()))
}

function loadAll(files: string[], options: LoadCasesOptions): LoadCasesResult {
  const warnings: string[] = []
  const excluded = new Set(
    [
      ...manifestFiles(options),
      ...(options.exclude ?? []).map((file) => path.resolve(options.rootDir, file)),
    ].map(pathKey),
  )
  const loaded = files
    .filter((file) => !excluded.has(pathKey(file)))
    .map((file) => {
      const notes: string[] = []
      return { file, loaded: loadCaseFile(file, options, notes), notes }
    })
    .filter(({ loaded: l }) => l.notACase === undefined)

  // `$ref` fragments matched by the globs: no operation, and either referenced by a `$ref`
  // from another matched file or kept in a `shared/` / `fragments/` directory.
  const docs = new Map<string, unknown>()
  for (const { file, loaded: l } of loaded) {
    if (l.text === undefined) continue
    try {
      docs.set(file, parseCaseText(l.text, l.ref.id))
    } catch {
      // unparseable: stays a load error
    }
  }
  const referenced = new Set<string>()
  for (const [file, doc] of docs) refTargets(doc, file, referenced)
  const fragments: string[] = []
  const all: LoadedCase[] = []
  for (const { file, loaded: l, notes } of loaded) {
    const doc = docs.get(file)
    const fragment =
      docs.has(file) &&
      hasNoOperation(doc) &&
      (referenced.has(pathKey(file)) || inFragmentDir(file, options.rootDir))
    if (fragment) {
      l.notACase = 'fragment'
      fragments.push(l.ref.id)
    } else {
      all.push(l)
      warnings.push(...notes)
    }
  }
  return {
    cases: filterCases(all, options),
    matched: all.length,
    warnings,
    ...(fragments.length ? { fragments: fragments.sort() } : {}),
  }
}

/** Resolve globs, load every case, apply filters. Never throws for bad case files. */
export async function loadCases(options: LoadCasesOptions): Promise<LoadCasesResult> {
  return loadAll(await resolveCaseFiles(options.globs, options.rootDir), options)
}

/** Synchronous loadCases (for test-runner bridges that register tests at import time). */
export function loadCasesSync(options: LoadCasesOptions): LoadCasesResult {
  return loadAll(resolveCaseFilesSync(options.globs, options.rootDir), options)
}

// ---------------------------------------------------------------------------
// Dotted paths
// ---------------------------------------------------------------------------

/** Split `a.b[0].c` / `a.b.0.c` into segments. */
export function parsePath(dotted: string): string[] {
  const segments: string[] = []
  for (const part of dotted.split('.')) {
    if (part === '') continue
    const re = /([^[\]]+)|\[(\d+)\]/g
    for (const match of part.matchAll(re)) segments.push(match[1] ?? match[2])
  }
  return segments
}

/** Read a dotted path (`structuredContent.items[0].id`) from a JSON value. */
export function getPath(value: JsonValue | undefined, dotted: string): JsonValue | undefined {
  let node: JsonValue | undefined = value
  for (const segment of parsePath(dotted)) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(segment)) return undefined
      node = node[Number(segment)]
    } else if (isPlainObject(node) && Object.hasOwn(node, segment)) {
      node = (node as JsonObject)[segment]
    } else return undefined
  }
  return node
}

/** Set `value` at `source` path segments inside `root` (mutates). */
export function setIn(
  root: Record<string, unknown>,
  source: Array<string | number>,
  value: unknown,
): void {
  let node: Record<string | number, unknown> = root
  for (let i = 0; i < source.length - 1; i++) node = node[source[i]] as Record<string, unknown>
  node[source[source.length - 1]] = value
}
