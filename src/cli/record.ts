import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import { resolveCaseFilesSync } from '../cases.js'
import { escapeDirectives } from '../match.js'
import { normalizeResult } from '../normalize.js'
import { suggestRespond } from '../respond-hint.js'
import {
  type CallOptions,
  type InputResponder,
  type McpSession,
  type Outcome,
  type ToolError,
  fromJsonRpcError,
  isResourceNotFound,
  textFromContent,
} from '../session/index.js'
import { type TapCall, readTapFile, reconstructCalls, selectCalls } from '../tap/entries.js'
import type {
  AwaitOptions,
  ExpectError,
  JsonValue,
  NormalizeConfig,
  RunOptions,
  Step,
  TestCase,
  ToolSummary,
} from '../types.js'
import {
  UsageError,
  argsSummary,
  escapeRegex,
  hasFlag,
  parseArgValue,
  parseRespond,
  parseToolArgs,
  positionals,
  printJson,
  resolvePathFromCwd,
  schemaRefFor,
  slugify,
  stringifyArgs,
  suiteLayout,
  takeAllFlags,
  takeFlag,
  uniquePath,
  writeJsonFile,
} from './args.js'
import {
  type OpKind,
  type OpSpec,
  executeOp,
  opLabel,
  parseAwait,
  replayCommand,
  resolveTarget,
  validateStructured,
  validationSummary,
} from './call.js'
import {
  colors,
  firstLine,
  formatCallHeader,
  formatInputRequests,
  isObject,
  plural,
  preview,
} from './format.js'
import {
  caseServerName,
  mergeCliOptions,
  openSessionOptions,
  parseCommonFlags,
  startSession,
} from './resolve.js'
import { type Loosened, VOLATILE_DOCS, loosenVolatile, loosenedSummary } from './volatile.js'

/** Injectable I/O for tests (stdin lines for --flow and MRTR prompts). */
export interface RecordIo {
  stdin?: Readable
  /** Treat input as an interactive terminal (prompts, line syntax). Default: stdin.isTTY. */
  interactive?: boolean
}

// ---------------------------------------------------------------------------
// Line input
// ---------------------------------------------------------------------------

/** Sequential line reader over stdin; prompts go to stderr (stdout stays clean for --json). */
export class LineReader {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string | undefined) => void> = []
  private ended = false
  private readonly rl: readline.Interface

  constructor(
    input: Readable,
    readonly interactive: boolean,
  ) {
    this.rl = readline.createInterface({
      input,
      output: interactive ? process.stderr : undefined,
      terminal: interactive,
    })
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.lines.push(line)
    })
    this.rl.on('close', () => {
      this.ended = true
      for (const waiter of this.waiters.splice(0)) waiter(undefined)
    })
  }

  /** Next line (undefined at end of input). Shows `prompt` on interactive terminals. */
  next(prompt = ''): Promise<string | undefined> {
    if (this.interactive && prompt) process.stderr.write(prompt)
    const queued = this.lines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.ended) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.rl.close()
  }
}

// ---------------------------------------------------------------------------
// Turning observations into case fields
// ---------------------------------------------------------------------------

/** What happened, in a shape shared by live calls and tap captures. */
export interface Observed {
  kind: 'result' | 'error' | 'input_required'
  result?: JsonValue
  error?: ToolError
  requests?: JsonValue
  inputRequests?: JsonValue[]
  task?: JsonValue
}

export function observedFromOutcome(outcome: Outcome): Observed {
  return {
    kind: outcome.kind,
    ...(outcome.kind === 'result' ? { result: outcome.result } : {}),
    ...(outcome.kind === 'error' ? { error: outcome.error, result: outcome.result } : {}),
    ...(outcome.kind === 'input_required' ? { requests: outcome.requests } : {}),
    ...(outcome.inputRequests ? { inputRequests: outcome.inputRequests } : {}),
    ...(outcome.task !== undefined ? { task: outcome.task } : {}),
  }
}

/** `expectError` for an observed error: stable code name + message prefix as a $regex. */
export function expectErrorFrom(error: ToolError): ExpectError {
  const code = isResourceNotFound(error) ? 'ResourceNotFound' : (error.codeName ?? error.code)
  const message = firstLine(error.message).slice(0, 80)
  // Locally raised errors (timeouts, closed connections) carry our own long text.
  const useMessage = message !== '' && !error.local
  return {
    ...(code !== undefined ? { code } : {}),
    ...(useMessage ? { message: { $regex: escapeRegex(message) } } : {}),
  }
}

/** Golden value: normalized like the runner does, with matcher-like keys escaped. */
export function golden(value: JsonValue, normalize: NormalizeConfig): JsonValue {
  return escapeDirectives(normalizeResult(value, normalize))
}

/**
 * `expectInputRequired` in the runner's era-portable *method view*:
 * `{ "elicitation/create": <params> }` (a method asked several times → array of params).
 * 2025-era rounds are keyed by JSON-RPC ids, so the key view would not replay across eras.
 */
export function inputRequiredExpectation(
  rounds: JsonValue[],
  normalize: NormalizeConfig,
): JsonValue {
  const byMethod: Record<string, JsonValue> = {}
  const repeated = new Set<string>()
  for (const round of rounds) {
    if (!isObject(round)) continue
    for (const entry of Object.values(round)) {
      if (!isObject(entry) || typeof entry.method !== 'string') continue
      const params = entry.params ?? {}
      const method = entry.method
      if (!Object.hasOwn(byMethod, method)) byMethod[method] = params
      else if (repeated.has(method)) (byMethod[method] as JsonValue[]).push(params)
      else {
        byMethod[method] = [byMethod[method], params]
        repeated.add(method)
      }
    }
  }
  return golden(byMethod, normalize)
}

function withPartial(expect: JsonValue, notes: string[]): JsonValue {
  if (isObject(expect) && expect.$literal === undefined) return { $partial: true, ...expect }
  notes.push('--partial skipped: the recorded value is not a plain object.')
  return expect
}

export interface StepOptions {
  normalize: NormalizeConfig
  partial?: boolean
  respond?: Record<string, JsonValue>
  awaitOpt?: AwaitOptions | true
  /** Keep every value verbatim (no volatile loosening). */
  exact?: boolean
  /** Raw result of an identical second call (stable check). */
  second?: JsonValue
  /** Collects what was loosened. */
  loosened?: Loosened[]
}

/** Operation fields for a case/step. Prompt args are strings on the wire. */
export function opFields(op: OpSpec): Partial<Step> {
  switch (op.kind) {
    case 'tool':
      return { tool: op.target, args: op.args }
    case 'resource':
      return { resource: op.target }
    case 'resourceTemplate':
      return { resourceTemplate: op.target, args: op.args }
    case 'prompt':
      return { prompt: op.target, args: stringifyArgs(op.args) }
  }
}

/**
 * Build a step from an observation. `notes` collects warnings for the user. Returns
 * undefined when the observation cannot become a case (unanswered input_required).
 */
export function stepFromObserved(
  op: OpSpec,
  observed: Observed,
  opts: StepOptions,
  notes: string[],
): Step | undefined {
  if (observed.kind === 'input_required') return undefined
  const step: Step = { ...opFields(op) } as Step
  if (opts.respond && Object.keys(opts.respond).length > 0) step.respond = opts.respond
  if (observed.inputRequests && observed.inputRequests.length > 0) {
    step.expectInputRequired = inputRequiredExpectation(observed.inputRequests, opts.normalize)
  }
  const isTask =
    observed.task !== undefined &&
    observed.kind === 'result' &&
    isObject(observed.result) &&
    observed.result.resultType === 'task'
  if (opts.awaitOpt !== undefined) {
    if (observed.task !== undefined) step.await = opts.awaitOpt
    else notes.push('--await ignored: the server did not answer with a task.')
  }
  if (isTask) {
    // Not awaited: the CreateTaskResult has a fresh taskId and timestamps on every run.
    step.expectTask = { $partial: true, taskId: { $type: 'string' }, status: { $type: 'string' } }
    notes.push(
      'The server answered with a task; recorded expectTask only. Re-record with --await to capture the final result.',
    )
    return step
  }
  if (observed.kind === 'error' && observed.error) {
    step.expectError = expectErrorFrom(observed.error)
    return step
  }
  let expect = golden(observed.result ?? null, opts.normalize)
  if (!opts.exact) {
    const second = opts.second !== undefined ? golden(opts.second, opts.normalize) : undefined
    const loosened = loosenVolatile(expect, second)
    expect = loosened.value
    opts.loosened?.push(...loosened.loosened)
  }
  step.expect = opts.partial ? withPartial(expect, notes) : expect
  return step
}

// ---------------------------------------------------------------------------
// MRTR answers
// ---------------------------------------------------------------------------

/**
 * A per-call responder: scripted answers first; otherwise (interactive only) ask on the
 * terminal. Every answer used is collected into `used` (keyed by method).
 */
function makeResponder(
  scripted: Record<string, JsonValue> | undefined,
  reader: LineReader | undefined,
  used: Record<string, JsonValue>,
): InputResponder {
  return async (method, params) => {
    if (scripted && Object.hasOwn(scripted, method)) {
      used[method] = scripted[method]
      return scripted[method]
    }
    if (Object.hasOwn(used, method)) return used[method]
    if (!reader?.interactive) return undefined
    const c = colors()
    const suggestion = JSON.stringify(
      suggestRespond({ request: { method, params } })[method] ?? { action: 'accept' },
    )
    process.stderr.write(`${c.yellow('⏸ the server asks for input:')}\n`)
    for (const line of formatInputRequests({ request: { method, params } })) {
      process.stderr.write(`${line}\n`)
    }
    while (true) {
      const answer = await reader.next(
        `answer for ${method} as JSON [${suggestion}], "-" to leave unanswered: `,
      )
      if (answer === undefined || answer.trim() === '-') return undefined
      const text = answer.trim() === '' ? suggestion : answer
      try {
        const value = JSON.parse(text) as JsonValue
        used[method] = value
        return value
      } catch (err) {
        process.stderr.write(
          `${c.red(`not JSON: ${err instanceof Error ? err.message : String(err)}`)}; try again.\n`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Flow capture inference
// ---------------------------------------------------------------------------

type PathSeg = string | number

function walkStrings(
  value: JsonValue | undefined,
  visit: (text: string, at: PathSeg[]) => void,
  at: PathSeg[] = [],
): void {
  if (typeof value === 'string') visit(value, at)
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, [...at, i]))
  else if (isObject(value)) {
    if (value.$literal !== undefined && Object.keys(value).length === 1) return
    for (const [k, v] of Object.entries(value)) walkStrings(v, visit, [...at, k])
  }
}

function mapStrings(value: JsonValue, fn: (text: string) => JsonValue): JsonValue {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (isObject(value)) {
    if (value.$literal !== undefined && Object.keys(value).length === 1) return value
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
  }
  return value
}

/** Dotted capture path (`structuredContent.sessionId`, `content[0].text`). */
export function dottedPath(at: PathSeg[]): string {
  return at.reduce<string>(
    (out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${seg}` : seg),
    '',
  )
}

function captureName(at: PathSeg[], taken: Set<string>): string {
  const last = [...at].reverse().find((seg) => typeof seg === 'string') as string | undefined
  const base = (last ?? 'value').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'value'
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`
  taken.add(name)
  return name
}

const MIN_HANDLE_LENGTH = 6

/**
 * Detect server-minted handles: a string arg of a later step that equals a string leaf in
 * an earlier step's (normalized) result, and was not an input of that earlier step.
 * Adds `capture` to the producing step, replaces the value with `{{name}}` in later
 * steps' args and expectations, and loosens the producing step's own expectation
 * (`{"$type": "string"}`) since the handle differs on every run.
 */
export function inferCaptures(steps: Step[], results: Array<JsonValue | undefined>): string[] {
  const notes: string[] = []
  const taken = new Set<string>(steps.flatMap((s) => Object.keys(s.capture ?? {})))
  const inputs = steps.map((s) => {
    const set = new Set<string>()
    walkStrings(s.args as JsonValue, (text) => set.add(text))
    return set
  })
  const handles: Array<{ value: string; name: string; producer: number }> = []
  for (let j = 1; j < steps.length; j++) {
    walkStrings(steps[j].args as JsonValue, (text) => {
      if (text.length < MIN_HANDLE_LENGTH || text.includes('{{')) return
      if (handles.some((h) => h.value === text)) return
      for (let i = j - 1; i >= 0; i--) {
        if (inputs.slice(0, i + 1).some((set) => set.has(text))) return
        let found: PathSeg[] | undefined
        const prefer = (at: PathSeg[]) =>
          !found || (at[0] === 'structuredContent' && found[0] !== 'structuredContent')
        walkStrings(results[i], (leaf, at) => {
          if (leaf === text && prefer(at)) found = at
        })
        if (!found) continue
        const name = captureName(found, taken)
        steps[i].capture = { ...(steps[i].capture ?? {}), [name]: dottedPath(found) }
        handles.push({ value: text, name, producer: i })
        notes.push(
          `step ${i + 1} → step ${j + 1}: captured {{${name}}} from ${dottedPath(found)} (value ${preview(text, 40)})`,
        )
        return
      }
    })
  }
  for (const { value, name, producer } of handles) {
    const producerStep = steps[producer]
    if (producerStep.expect !== undefined) {
      producerStep.expect = mapStrings(producerStep.expect, (text): JsonValue => {
        if (text === value) return { $type: 'string' }
        if (!text.includes(value)) return text
        const parts = text.split(value)
        return parts.some((p) => /[*?]/.test(p))
          ? { $regex: `^${parts.map(escapeRegex).join('.+')}$`, flags: 's' }
          : { $wildcard: parts.join('*') }
      })
    }
    for (let k = producer + 1; k < steps.length; k++) {
      const swap = (text: string) =>
        text.includes(value) ? text.split(value).join(`{{${name}}}`) : text
      if (steps[k].args)
        steps[k].args = mapStrings(steps[k].args as JsonValue, swap) as Step['args']
      if (steps[k].expect !== undefined)
        steps[k].expect = mapStrings(steps[k].expect as JsonValue, swap)
    }
  }
  return notes
}

// ---------------------------------------------------------------------------
// Where cases go
// ---------------------------------------------------------------------------

export interface CaseTarget {
  rootDir: string
  outPath: string
  /** The path was derived (not --out), so it may be deduplicated. */
  derived: boolean
}

/** Default directory for new cases: the first positive config glob's base (+ `subdir`). */
export function suiteDir(options: Pick<RunOptions, 'globs' | 'rootDir'>, subdir = ''): string {
  const { dir } = suiteLayout(options.globs)
  return path.resolve(options.rootDir, dir, subdir)
}

/** `--out`, else `<suite dir>/<slug(name)><suffix>` (deduplicated). */
export function caseTarget(
  argv: string[],
  options: Pick<RunOptions, 'globs' | 'rootDir'>,
  name: string,
  subdir = '',
): CaseTarget {
  const out = takeFlag(argv, '--out')
  if (out) return { rootDir: options.rootDir, outPath: resolvePathFromCwd(out), derived: false }
  const { suffix } = suiteLayout(options.globs)
  const file = path.join(suiteDir(options, subdir), `${slugify(name) || 'case'}${suffix}`)
  return { rootDir: options.rootDir, outPath: uniquePath(file, suffix), derived: true }
}

/** Would `vib run` (config globs) pick this file up? */
export function inSuite(file: string, options: Pick<RunOptions, 'globs' | 'rootDir'>): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  const target = norm(file)
  try {
    return resolveCaseFilesSync(options.globs, options.rootDir).some((f) => norm(f) === target)
  } catch {
    return false
  }
}

export function outsideSuiteNote(file: string, options: Pick<RunOptions, 'globs'>): string {
  return `${shellPath(file)} is outside the suite globs (${options.globs.join(', ')}), so vib run will not pick it up. Move it under ${suiteLayout(options.globs).dir}/ or add a glob in vibrissa.json.`
}

function refuseOverwrite(target: CaseTarget, force: boolean): void {
  if (!target.derived && fs.existsSync(target.outPath) && !force) {
    throw new UsageError(`Refusing to overwrite ${target.outPath}: it already exists.`, {
      code: 'file-exists',
      hint: 'Pass --force to replace it, or a different --out.',
    })
  }
}

function caseHeader(target: CaseTarget, name: string, tags: string[], server?: string): TestCase {
  return {
    $schema: schemaRefFor(target.outPath, target.rootDir, 'case.schema.json'),
    name,
    ...(tags.length > 0 ? { tags } : {}),
    ...(server ? { server } : {}),
  }
}

/** A path for copy-paste hints: cwd-relative with forward slashes, double-quoted if needed. */
export function shellPath(file: string): string {
  const rel = path.relative(process.cwd(), file)
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  const shown = (inside ? rel : file).replace(/\\/g, '/')
  return /\s/.test(shown) ? `"${shown}"` : shown
}

/** `echo text=hello`, `read fixture://readme`, `prompt greet name=Jo`. */
export function defaultName(op: OpSpec): string {
  const verb: Record<OpKind, string> = {
    tool: '',
    resource: 'read ',
    resourceTemplate: 'read ',
    prompt: 'prompt ',
  }
  const summary = op.kind === 'resource' ? '' : argsSummary(op.args)
  return `${verb[op.kind]}${op.target}${summary ? ` ${summary}` : ''}`
}

interface WriteResult {
  path: string
  inSuite: boolean
  loosened: Loosened[]
  notes: string[]
}

function looseningNote(loosened: Loosened[]): string {
  return `${loosenedSummary(loosened)}; see ${VOLATILE_DOCS}. Pass --exact to keep values verbatim.`
}

function finishWrite(
  target: CaseTarget,
  testCase: TestCase,
  options: Pick<RunOptions, 'globs' | 'rootDir'>,
  loosened: Loosened[],
  notes: string[],
): WriteResult {
  writeJsonFile(target.outPath, testCase)
  const suite = inSuite(target.outPath, options)
  if (loosened.length > 0) notes.push(looseningNote(loosened))
  if (!suite) notes.push(outsideSuiteNote(target.outPath, options))
  return { path: target.outPath, inSuite: suite, loosened, notes }
}

function printWritten(result: WriteResult, testCase: TestCase, json: boolean): void {
  if (json) {
    printJson({
      ok: true,
      path: result.path,
      inSuite: result.inSuite,
      case: testCase,
      ...(result.loosened.length > 0 ? { loosened: result.loosened } : {}),
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
    })
    return
  }
  const c = colors()
  for (const note of result.notes) console.log(c.yellow(`note: ${note}`))
  console.log(`${c.green('wrote')} ${result.path}`)
  const shown = shellPath(result.path)
  console.log(c.dim(`Next: vib explain ${shown}   ·   vib run --cases ${shown}`))
}

function unansweredHint(requests: JsonValue, replay: string): string {
  const respond = JSON.stringify(suggestRespond(requests))
  return `The server asked for input and no answer was given. Re-run with --respond '${respond}' (e.g. ${replay} --respond '${respond}'), or run in a terminal to answer interactively.`
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function parseOp(argv: string[]): OpSpec {
  const resource = takeFlag(argv, '--resource')
  const template = takeFlag(argv, '--resource-template')
  const prompt = takeFlag(argv, '--prompt')
  const [tool] = positionals(argv)
  const chosen = [tool, resource, template, prompt].filter((v) => v !== undefined)
  if (chosen.length === 0) {
    throw new UsageError('Nothing to record.', {
      code: 'missing-argument',
      hint: 'Usage: vib record <tool> [--arg k=v] | --resource <uri> | --resource-template <tpl> --arg k=v | --prompt <name> | --flow | --from-tap <file>. Run vib tools to see tool names.',
      next: ['vib tools'],
    })
  }
  if (chosen.length > 1) {
    throw new UsageError('Record one operation at a time.', {
      code: 'invalid-argument',
      hint: 'Pass a tool name OR --resource OR --resource-template OR --prompt (use --flow for several).',
    })
  }
  const args = parseToolArgs(argv)
  if (resource !== undefined) return { kind: 'resource', target: resource, args: {} }
  if (template !== undefined) return { kind: 'resourceTemplate', target: template, args }
  if (prompt !== undefined) return { kind: 'prompt', target: prompt, args }
  return { kind: 'tool', target: tool as string, args }
}

/** Calls that may change server state are not repeated for the stable check. */
function mayHaveSideEffects(tool: ToolSummary | undefined): boolean {
  const ann = isObject(tool?.annotations) ? tool.annotations : {}
  return ann.destructiveHint === true && ann.idempotentHint !== true
}

/** Repeat the call for the stable check; the raw result, or undefined (with a note). */
async function secondCall(
  session: McpSession,
  op: OpSpec,
  first: Observed,
  callOpts: CallOptions,
  notes: string[],
): Promise<JsonValue | undefined> {
  if (first.kind !== 'result') return undefined
  const outcome = await executeOp(session, op, callOpts)
  if (outcome.kind !== 'result') {
    notes.push(
      `The repeated call (stable check) answered ${outcome.kind}; only pattern-based loosening was applied.`,
    )
    return undefined
  }
  return outcome.result
}

export async function recordCommand(argv: string[], io: RecordIo = {}): Promise<number> {
  if (takeFlag(argv, '--from-tap') !== undefined) return recordFromTap(argv)
  const stdin = io.stdin ?? process.stdin
  const interactive = io.interactive ?? Boolean((stdin as { isTTY?: boolean }).isTTY)
  if (hasFlag(argv, '--flow')) return recordFlow(argv, stdin, interactive)

  const op = parseOp(argv)
  const flags = parseCommonFlags(argv)
  const name = takeFlag(argv, '--name') ?? defaultName(op)
  const tags = takeAllFlags(argv, '--tag')
  const force = hasFlag(argv, '--force')
  const exact = hasFlag(argv, '--exact')
  const stableCheck = !exact && !hasFlag(argv, '--no-stable-check')
  const scripted = parseRespond(argv)
  const awaitOpt = parseAwait(argv)
  const resolved = openSessionOptions(flags)
  const target = caseTarget(argv, resolved.options, name)
  refuseOverwrite(target, force)
  const server = caseServerName(flags)
  const { session, options, timeoutMs } = await startSession(flags, {}, resolved)
  const reader = interactive ? new LineReader(stdin, true) : undefined
  try {
    let tool: ToolSummary | undefined
    if (!hasFlag(argv, '--expect-missing')) tool = (await resolveTarget(session, op)).tool
    if (!flags.json) console.log(formatCallHeader(opLabel(op), op.args))
    const used: Record<string, JsonValue> = {}
    const callOpts: CallOptions = {
      respond: makeResponder(scripted, reader, used),
      ...(awaitOpt !== undefined ? { await: awaitOpt } : {}),
      // A human answering in the terminal needs more than the per-request timeout.
      ...(reader ? { timeoutMs: Math.max(timeoutMs, 10 * 60_000) } : {}),
    }
    const outcome = await executeOp(session, op, callOpts)
    const observed = observedFromOutcome(outcome)
    if (observed.kind === 'input_required') {
      const replay = replayCommand(['vib', 'record', ...argv])
      const hint = unansweredHint(observed.requests ?? null, replay)
      if (flags.json) {
        printJson({ ok: false, kind: 'input_required', requests: observed.requests, hint })
      } else {
        console.error(
          colors().yellow('⏸ input required — nothing was written. The server asked for:'),
        )
        for (const line of formatInputRequests(observed.requests ?? null)) console.error(line)
        console.error(colors().dim(`hint: ${hint}`))
      }
      return 1
    }
    const validation = op.kind === 'tool' ? validateStructured(tool, outcome) : undefined
    if (
      validation?.checked &&
      validation.ok === false &&
      !hasFlag(argv, '--allow-invalid-output')
    ) {
      const message = `Not writing a golden that violates the outputSchema of "${op.target}": ${validationSummary(validation)}.`
      const hint =
        'Fix the tool so structuredContent matches its outputSchema, or pass --allow-invalid-output to record it anyway (vib run will still fail it unless the case sets "validateOutput": false).'
      if (flags.json) {
        printJson({
          ok: false,
          error: { type: 'OutputSchemaViolation', code: 'invalid-output', message, hint },
          validation,
        })
      } else {
        console.error(colors().red(`✗ ${message}`))
        console.error(colors().dim(`hint: ${hint}`))
      }
      return 1
    }
    const notes: string[] = []
    if (validation?.checked && validation.ok === false) {
      notes.push(`structuredContent violates the outputSchema: ${validationSummary(validation)}.`)
    }
    let second: JsonValue | undefined
    if (stableCheck && observed.kind === 'result') {
      if (mayHaveSideEffects(tool)) {
        notes.push(
          `Stable check skipped: "${op.target}" is annotated destructive, so it was called once. Loosen changing values by hand, or pass --no-stable-check to silence this.`,
        )
      } else {
        second = await secondCall(session, op, observed, { ...callOpts, respond: used }, notes)
      }
    }
    const respond = { ...(scripted ?? {}), ...used }
    const loosened: Loosened[] = []
    const step = stepFromObserved(
      op,
      observed,
      {
        normalize: options.normalize,
        partial: hasFlag(argv, '--partial'),
        respond: Object.keys(respond).length > 0 ? respond : undefined,
        awaitOpt,
        exact,
        second,
        loosened,
      },
      notes,
    ) as Step
    if (!flags.json) {
      const c = colors()
      if (step.expectError) {
        console.log(
          c.yellow(
            `Captured ${observed.error?.kind ?? ''} error into expectError${step.expectError.code !== undefined ? ` (${step.expectError.code})` : ''}`,
          ),
        )
      } else if (step.expect !== undefined) console.log(c.green('Captured result into expect'))
    }
    const testCase: TestCase = { ...caseHeader(target, name, tags, server), ...step }
    const written = finishWrite(target, testCase, options, loosened, notes)
    printWritten(written, testCase, Boolean(flags.json))
    return 0
  } finally {
    reader?.close()
    await session.close()
  }
}

// ---------------------------------------------------------------------------
// --flow
// ---------------------------------------------------------------------------

/** One flow input line: a JSON step object, or `<tool> [json | key=value ...]`. */
export function parseFlowLine(line: string): Step {
  const text = line.trim()
  if (text.startsWith('{')) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (err) {
      throw new UsageError(
        `Invalid flow line (JSON): ${err instanceof Error ? err.message : String(err)}.`,
        { code: 'invalid-argument', hint: 'Expected {"tool": "name", "args": {...}}.' },
      )
    }
    if (!isObject(value))
      throw new UsageError('Invalid flow line: expected a JSON object.', {
        code: 'invalid-argument',
        hint: 'Example: {"tool": "echo", "args": {"text": "hi"}}.',
      })
    const ops = ['tool', 'resource', 'resourceTemplate', 'prompt'].filter(
      (k) => value[k] !== undefined,
    )
    if (ops.length !== 1) {
      throw new UsageError(
        'Invalid flow line: give exactly one of "tool", "resource", "resourceTemplate", "prompt".',
        { code: 'invalid-argument', hint: 'Example: {"tool": "echo", "args": {"text": "hi"}}.' },
      )
    }
    return value as unknown as Step
  }
  const [tool, ...rest] = text.split(/\s+/)
  const remainder = text.slice(tool.length).trim()
  let args: Record<string, JsonValue> = {}
  if (remainder.startsWith('{')) {
    try {
      args = JSON.parse(remainder) as Record<string, JsonValue>
    } catch (err) {
      throw new UsageError(
        `Invalid args JSON for ${tool}: ${err instanceof Error ? err.message : String(err)}.`,
        { code: 'invalid-argument', hint: `Example: ${tool} {"text": "hi"}.` },
      )
    }
  } else {
    for (const pair of rest) {
      const eq = pair.indexOf('=')
      if (eq <= 0)
        throw new UsageError(`Invalid arg "${pair}" for ${tool}: expected key=value.`, {
          code: 'invalid-argument',
          hint: `Example: ${tool} text=hi.`,
        })
      args[pair.slice(0, eq)] = parseArgValue(pair.slice(eq + 1))
    }
  }
  return { tool, args }
}

function opFromStep(step: Step): OpSpec {
  const args = (step.args ?? {}) as Record<string, JsonValue>
  if (step.tool !== undefined) return { kind: 'tool', target: step.tool, args }
  if (step.resource !== undefined) return { kind: 'resource', target: step.resource, args: {} }
  if (step.resourceTemplate !== undefined)
    return { kind: 'resourceTemplate', target: step.resourceTemplate, args }
  return { kind: 'prompt', target: step.prompt as string, args }
}

async function recordFlow(argv: string[], stdin: Readable, interactive: boolean): Promise<number> {
  const flags = parseCommonFlags(argv)
  const name = takeFlag(argv, '--name') ?? 'recorded flow'
  const tags = takeAllFlags(argv, '--tag')
  const force = hasFlag(argv, '--force')
  const exact = hasFlag(argv, '--exact')
  const expectMissing = hasFlag(argv, '--expect-missing')
  const scripted = parseRespond(argv)
  const resolved = openSessionOptions(flags)
  const target = caseTarget(argv, resolved.options, name)
  refuseOverwrite(target, force)
  const server = caseServerName(flags)
  const { session, options, timeoutMs } = await startSession(flags, {}, resolved)
  const reader = new LineReader(stdin, interactive)
  const c = colors()
  const say = (text: string) => (flags.json ? console.error(text) : console.log(text))
  try {
    if (interactive) {
      say(c.bold('Recording a flow. One step per line; an empty line finishes.'))
      say(
        c.dim(
          '  <tool> {"json": "args"}   or   <tool> key=value ...   or   {"resource": "uri"} / {"prompt": "name", "args": {...}}',
        ),
      )
    }
    const steps: Step[] = []
    const results: Array<JsonValue | undefined> = []
    const notes: string[] = []
    const loosened: Loosened[] = []
    while (true) {
      const line = await reader.next(c.cyan(`step ${steps.length + 1}> `))
      if (line === undefined || line.trim() === '') break
      let input: Step
      let op: OpSpec
      try {
        input = parseFlowLine(line)
        op = opFromStep(input)
        if (!expectMissing) await resolveTarget(session, op)
      } catch (err) {
        if (!interactive) throw err
        say(c.red(err instanceof Error ? err.message : String(err)))
        continue
      }
      const used: Record<string, JsonValue> = {}
      const stepScripted = {
        ...(scripted ?? {}),
        ...((input.respond ?? {}) as Record<string, JsonValue>),
      }
      const awaitOpt =
        input.await === true || isObject(input.await)
          ? (input.await as AwaitOptions | true)
          : undefined
      const outcome = await executeOp(session, op, {
        respond: makeResponder(stepScripted, interactive ? reader : undefined, used),
        ...(awaitOpt !== undefined ? { await: awaitOpt } : {}),
        ...(interactive ? { timeoutMs: Math.max(timeoutMs, 10 * 60_000) } : {}),
      })
      const observed = observedFromOutcome(outcome)
      if (observed.kind === 'input_required') {
        const hint = `Step ${steps.length + 1} (${opLabel(op)}) needs input. Add "respond" to that line, e.g. ${JSON.stringify({ ...input, respond: suggestRespond(observed.requests ?? null) })}`
        if (!interactive) {
          if (flags.json)
            printJson({
              ok: false,
              kind: 'input_required',
              step: steps.length + 1,
              requests: observed.requests,
              hint,
            })
          else {
            console.error(
              c.yellow(`⏸ input required at step ${steps.length + 1} — nothing was written.`),
            )
            for (const l of formatInputRequests(observed.requests ?? null)) console.error(l)
            console.error(c.dim(`hint: ${hint}`))
          }
          return 1
        }
        say(c.yellow('Left unanswered; this step was not recorded. Enter it again to retry.'))
        continue
      }
      const respond = { ...((input.respond ?? {}) as Record<string, JsonValue>), ...used }
      // Flows are stateful: steps are never repeated, so only pattern loosening applies.
      const step = stepFromObserved(
        op,
        observed,
        {
          normalize: options.normalize,
          respond: Object.keys(respond).length > 0 ? respond : undefined,
          awaitOpt,
          exact,
          loosened,
        },
        notes,
      ) as Step
      const recorded: Step = {
        ...(input.name ? { name: input.name } : {}),
        ...step,
        ...(input.capture ? { capture: input.capture } : {}),
      }
      steps.push(recorded)
      results.push(
        observed.result !== undefined
          ? normalizeResult(observed.result, options.normalize)
          : undefined,
      )
      const status =
        observed.kind === 'error'
          ? c.yellow(`error (${observed.error?.codeName ?? observed.error?.kind}) → expectError`)
          : c.green('ok → expect')
      say(`  ${c.dim(`#${steps.length}`)} ${opLabel(op)}: ${status}`)
    }
    if (steps.length === 0) {
      throw new UsageError('No steps recorded: the input was empty.', {
        code: 'missing-argument',
        hint: 'Pipe NDJSON lines like {"tool": "echo", "args": {"text": "hi"}}, or run in a terminal.',
      })
    }
    if (!hasFlag(argv, '--no-capture')) notes.push(...inferCaptures(steps, results))
    const testCase: TestCase = { ...caseHeader(target, name, tags, server), steps }
    const written = finishWrite(target, testCase, options, loosened, notes)
    printWritten(written, testCase, Boolean(flags.json))
    return 0
  } finally {
    reader.close()
    await session.close()
  }
}

// ---------------------------------------------------------------------------
// --from-tap
// ---------------------------------------------------------------------------

function tapError(error: JsonValue): ToolError {
  return fromJsonRpcError(isObject(error) ? error : { message: String(error) })
}

/** Observation from a reconstructed tap call. */
export function observedFromTap(call: TapCall): Observed {
  const inputRequests = call.inputRequests.length > 0 ? { inputRequests: call.inputRequests } : {}
  if (call.error !== undefined) {
    return { kind: 'error', error: tapError(call.error), ...inputRequests }
  }
  const result = call.result ?? null
  if (call.method === 'tools/call' && isObject(result) && result.isError === true) {
    return {
      kind: 'error',
      error: { kind: 'tool', message: textFromContent(result.content) },
      result,
      ...inputRequests,
    }
  }
  return {
    kind: 'result',
    result,
    ...inputRequests,
    ...(call.task !== undefined && !call.taskAwaited ? { task: call.task } : {}),
  }
}

function opFromTap(call: TapCall): OpSpec {
  if (call.method === 'resources/read') return { kind: 'resource', target: call.target, args: {} }
  if (call.method === 'prompts/get') return { kind: 'prompt', target: call.target, args: call.args }
  return { kind: 'tool', target: call.target, args: call.args }
}

/** ok | error | no response, as `--from-tap` lists it (isError results count as errors). */
export function tapCallStatus(call: TapCall): 'ok' | 'error' | 'no response' {
  if (call.incomplete) return 'no response'
  if (call.error !== undefined) return 'error'
  if (isObject(call.result) && call.result.isError === true) return 'error'
  return 'ok'
}

function tapListing(calls: TapCall[]): string {
  const c = colors()
  if (calls.length === 0)
    return 'No tools/call, resources/read or prompts/get entries in this capture.'
  return calls
    .map((call) => {
      const status = tapCallStatus(call)
      const outcome =
        status === 'error'
          ? c.red('error')
          : status === 'no response'
            ? c.yellow(status)
            : c.green('ok')
      const extras = [
        Object.keys(call.respond).length > 0 ? 'answered input' : '',
        call.task !== undefined ? (call.taskAwaited ? 'task (completed)' : 'task') : '',
      ].filter(Boolean)
      return `  ${c.dim(`#${String(call.index).padEnd(3)}`)} ${call.method.padEnd(15)} ${c.bold(call.target)} ${c.gray(preview(call.args, 60))} ${outcome}${extras.length ? c.dim(` (${extras.join(', ')})`) : ''}`
    })
    .join('\n')
}

async function recordFromTap(argv: string[]): Promise<number> {
  const file = resolvePathFromCwd(takeFlag(argv, '--from-tap') as string)
  if (!fs.existsSync(file)) {
    throw new UsageError(`Tap capture not found: ${file}.`, {
      code: 'not-found',
      hint: 'Captures are written by vib tap (default reports/tap/*.ndjson).',
    })
  }
  const flags = parseCommonFlags(argv)
  const { entries, badLines } = readTapFile(file)
  const calls = reconstructCalls(entries)
  const selectors = takeAllFlags(argv, '--select')
  const c = colors()
  if (selectors.length === 0) {
    const hint = `Pick calls with --select <n|name|all> (repeatable, e.g. --select 1,3 or --select ${calls[0]?.target ?? 'echo'}).`
    if (flags.json) {
      printJson({
        ok: true,
        source: file,
        calls: calls.map(({ index, method, target, args }, i) => ({
          index,
          method,
          target,
          args,
          status: tapCallStatus(calls[i]),
        })),
        written: [],
        hint,
      })
    } else {
      console.log(c.bold(`${plural(calls.length, 'call')} in ${file}`))
      console.log(tapListing(calls))
      console.log(c.dim(hint))
    }
    return 0
  }
  const { picked, unmatched } = selectCalls(calls, selectors)
  if (unmatched.length > 0) {
    throw new UsageError(`--select matched nothing for: ${unmatched.join(', ')}.`, {
      code: 'invalid-argument',
      hint: `${calls.length} call(s) available; run vib record --from-tap ${shellPath(file)} to list them.`,
    })
  }
  // Normalization config comes from the project config (no server is started).
  const options = mergeCliOptions(flags)
  const rootDir = options.rootDir
  const force = hasFlag(argv, '--force')
  const exact = hasFlag(argv, '--exact')
  const tags = takeAllFlags(argv, '--tag')
  const server = caseServerName(flags)
  const outDirFlag = takeFlag(argv, '--out-dir')
  const outDir = outDirFlag ? resolvePathFromCwd(outDirFlag) : suiteDir(options, 'tap')
  const { suffix } = suiteLayout(options.globs)
  const single = picked.length === 1
  const written: Array<{ path: string; index: number; inSuite: boolean; case: TestCase }> = []
  const skipped: Array<{ index: number; reason: string }> = []
  const notes: string[] = []
  const loosened: Loosened[] = []
  for (const call of picked) {
    if (call.incomplete) {
      skipped.push({
        index: call.index,
        reason: 'no response in the capture (server exited first)',
      })
      continue
    }
    const op = opFromTap(call)
    const name =
      (single ? takeFlag(argv, '--name') : undefined) ?? `${defaultName(op)} (tap #${call.index})`
    const outPath =
      single && takeFlag(argv, '--out')
        ? resolvePathFromCwd(takeFlag(argv, '--out') as string)
        : path.join(outDir, `${slugify(call.target) || 'call'}-${call.index}${suffix}`)
    if (fs.existsSync(outPath) && !force) {
      skipped.push({ index: call.index, reason: `${outPath} exists (pass --force to replace)` })
      continue
    }
    const callLoosened: Loosened[] = []
    const step = stepFromObserved(
      op,
      observedFromTap(call),
      {
        normalize: options.normalize,
        partial: hasFlag(argv, '--partial'),
        respond: Object.keys(call.respond).length > 0 ? call.respond : undefined,
        awaitOpt: call.taskAwaited ? true : undefined,
        exact,
        loosened: callLoosened,
      },
      notes,
    ) as Step
    if (call.taskAwaited) step.await = true
    const target: CaseTarget = { rootDir, outPath, derived: false }
    const testCase: TestCase = {
      ...caseHeader(target, name, tags.length > 0 ? tags : ['tap'], server),
      ...step,
    }
    writeJsonFile(outPath, testCase)
    loosened.push(...callLoosened.map((l) => ({ ...l, path: `#${call.index} ${l.path}` })))
    written.push({
      path: outPath,
      index: call.index,
      inSuite: inSuite(outPath, options),
      case: testCase,
    })
  }
  if (badLines.length > 0)
    notes.push(
      `Skipped ${plural(badLines.length, 'unreadable line')} in the capture (lines ${badLines.slice(0, 5).join(', ')}).`,
    )
  if (loosened.length > 0) notes.push(looseningNote(loosened))
  const outside = written.filter((w) => !w.inSuite)
  if (outside.length > 0) notes.push(outsideSuiteNote(outside[0].path, options))
  if (flags.json) {
    printJson({
      ok: written.length > 0,
      source: file,
      written,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(loosened.length > 0 ? { loosened } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    })
  } else {
    for (const note of notes) console.log(c.yellow(`note: ${note}`))
    for (const w of written) console.log(`${c.green('wrote')} ${w.path} ${c.dim(`(#${w.index})`)}`)
    for (const s of skipped) console.log(`${c.yellow('skipped')} #${s.index}: ${s.reason}`)
    if (written.length > 0) {
      console.log(
        c.dim(
          'Next: review with vib explain <file>, then vib run. Recorded goldens are exact; loosen volatile fields with matchers.',
        ),
      )
    }
  }
  return written.length > 0 ? 0 : 1
}
