import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import { escapeDirectives } from '../match.js'
import { normalizeResult } from '../normalize.js'
import {
  type CallOptions,
  type InputResponder,
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
  Step,
  TestCase,
} from '../types.js'
import {
  UsageError,
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
  takeAllFlags,
  takeFlag,
  writeJsonFile,
} from './args.js'
import { type OpKind, type OpSpec, executeOp, opLabel, parseAwait, replayCommand } from './call.js'
import {
  colors,
  firstLine,
  formatCallHeader,
  formatInputRequests,
  isObject,
  plural,
  preview,
  sampleRespond,
} from './format.js'
import { mergeCliOptions, openSessionOptions, parseCommonFlags, startSession } from './resolve.js'

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
  const expect = golden(observed.result ?? null, opts.normalize)
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
      sampleRespond({ request: { method, params } })[method] ?? { action: 'accept' },
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
// Command
// ---------------------------------------------------------------------------

function parseOp(argv: string[]): OpSpec {
  const resource = takeFlag(argv, '--resource')
  const template = takeFlag(argv, '--resource-template')
  const prompt = takeFlag(argv, '--prompt')
  const [tool] = positionals(argv)
  const chosen = [tool, resource, template, prompt].filter((v) => v !== undefined)
  if (chosen.length === 0) {
    throw new UsageError(
      'Nothing to record. Usage: vib record <tool> [--arg k=v] | --resource <uri> | --resource-template <tpl> --arg k=v | --prompt <name> | --flow | --from-tap <file>. Run vib tools to see tool names.',
    )
  }
  if (chosen.length > 1) {
    throw new UsageError(
      'Record one operation at a time: pass a tool name OR --resource OR --resource-template OR --prompt (use --flow for several).',
    )
  }
  const args = parseToolArgs(argv)
  if (resource !== undefined) return { kind: 'resource', target: resource, args: {} }
  if (template !== undefined) return { kind: 'resourceTemplate', target: template, args }
  if (prompt !== undefined) return { kind: 'prompt', target: prompt, args }
  return { kind: 'tool', target: tool as string, args }
}

function defaultName(op: OpSpec): string {
  const verb: Record<OpKind, string> = {
    tool: '',
    resource: 'read ',
    resourceTemplate: 'read ',
    prompt: 'prompt ',
  }
  return `${verb[op.kind]}${op.target} recorded`
}

interface Target {
  rootDir: string
  outPath: string
}

function outPathFor(argv: string[], rootDir: string, name: string, subdir = ''): string {
  const out = takeFlag(argv, '--out')
  if (out) return resolvePathFromCwd(out)
  return path.join(rootDir, 'tests', 'integration', subdir, `${slugify(name) || 'case'}.json`)
}

function refuseOverwrite(file: string, force: boolean): void {
  if (fs.existsSync(file) && !force) {
    throw new UsageError(
      `Refusing to overwrite ${file}: it already exists. Pass --force to replace it, or --out <path>.`,
    )
  }
}

function caseHeader(target: Target, name: string, tags: string[]): TestCase {
  return {
    $schema: schemaRefFor(target.outPath, target.rootDir, 'case.schema.json'),
    name,
    ...(tags.length > 0 ? { tags } : {}),
  }
}

function printNotes(notes: string[], json: boolean): void {
  if (json) return
  const c = colors()
  for (const note of notes) console.log(c.yellow(`note: ${note}`))
}

function printWritten(file: string, testCase: TestCase, json: boolean, notes: string[]): void {
  if (json) {
    printJson({ ok: true, path: file, case: testCase, notes })
    return
  }
  const c = colors()
  printNotes(notes, false)
  console.log(`${c.green('wrote')} ${file}`)
  const shown = shellPath(file)
  console.log(c.dim(`Next: vib explain ${shown}   ·   vib run --cases ${shown}`))
}

/** A path for copy-paste hints: cwd-relative with forward slashes, double-quoted if needed. */
export function shellPath(file: string): string {
  const rel = path.relative(process.cwd(), file)
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  const shown = (inside ? rel : file).replace(/\\/g, '/')
  return /\s/.test(shown) ? `"${shown}"` : shown
}

function unansweredHint(requests: JsonValue, replay: string): string {
  const respond = JSON.stringify(sampleRespond(requests))
  return `The server asked for input and no answer was given. Re-run with --respond '${respond}' (e.g. ${replay} --respond '${respond}'), or run in a terminal to answer interactively.`
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
  const scripted = parseRespond(argv)
  const awaitOpt = parseAwait(argv)
  const resolved = openSessionOptions(flags)
  const target = { rootDir: resolved.rootDir, outPath: outPathFor(argv, resolved.rootDir, name) }
  refuseOverwrite(target.outPath, force)
  const { session, options, timeoutMs } = await startSession(flags, {}, resolved)
  const reader = interactive ? new LineReader(stdin, true) : undefined
  try {
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
    const notes: string[] = []
    const respond = { ...(scripted ?? {}), ...used }
    const step = stepFromObserved(
      op,
      observed,
      {
        normalize: options.normalize,
        partial: hasFlag(argv, '--partial'),
        respond: Object.keys(respond).length > 0 ? respond : undefined,
        awaitOpt,
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
    const testCase: TestCase = { ...caseHeader(target, name, tags), ...step }
    writeJsonFile(target.outPath, testCase)
    printWritten(target.outPath, testCase, Boolean(flags.json), notes)
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
        `Invalid flow line (JSON): ${err instanceof Error ? err.message : String(err)}. Expected {"tool": "name", "args": {...}}.`,
      )
    }
    if (!isObject(value)) throw new UsageError('Invalid flow line: expected a JSON object.')
    const ops = ['tool', 'resource', 'resourceTemplate', 'prompt'].filter(
      (k) => value[k] !== undefined,
    )
    if (ops.length !== 1) {
      throw new UsageError(
        'Invalid flow line: give exactly one of "tool", "resource", "resourceTemplate", "prompt". Example: {"tool": "echo", "args": {"text": "hi"}}.',
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
      )
    }
  } else {
    for (const pair of rest) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new UsageError(`Invalid arg "${pair}" for ${tool}: expected key=value.`)
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
  const scripted = parseRespond(argv)
  const resolved = openSessionOptions(flags)
  const target = { rootDir: resolved.rootDir, outPath: outPathFor(argv, resolved.rootDir, name) }
  refuseOverwrite(target.outPath, force)
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
    while (true) {
      const line = await reader.next(c.cyan(`step ${steps.length + 1}> `))
      if (line === undefined || line.trim() === '') break
      let input: Step
      try {
        input = parseFlowLine(line)
      } catch (err) {
        if (!interactive) throw err
        say(c.red(err instanceof Error ? err.message : String(err)))
        continue
      }
      const op = opFromStep(input)
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
        const hint = `Step ${steps.length + 1} (${opLabel(op)}) needs input. Add "respond" to that line, e.g. ${JSON.stringify({ ...input, respond: sampleRespond(observed.requests ?? null) })}`
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
      const step = stepFromObserved(
        op,
        observed,
        {
          normalize: options.normalize,
          respond: Object.keys(respond).length > 0 ? respond : undefined,
          awaitOpt,
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
      throw new UsageError(
        'No steps recorded: the input was empty. Pipe NDJSON lines like {"tool": "echo", "args": {"text": "hi"}}, or run in a terminal.',
      )
    }
    if (!hasFlag(argv, '--no-capture')) notes.push(...inferCaptures(steps, results))
    const testCase: TestCase = { ...caseHeader(target, name, tags), steps }
    writeJsonFile(target.outPath, testCase)
    printWritten(target.outPath, testCase, Boolean(flags.json), notes)
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

function tapListing(calls: TapCall[]): string {
  const c = colors()
  if (calls.length === 0)
    return 'No tools/call, resources/read or prompts/get entries in this capture.'
  return calls
    .map((call) => {
      const outcome =
        call.error !== undefined
          ? c.red('error')
          : call.incomplete
            ? c.yellow('no response')
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
    throw new UsageError(
      `Tap capture not found: ${file}. Captures are written by vib tap (default reports/tap/*.ndjson).`,
    )
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
        calls: calls.map(({ index, method, target, args }) => ({ index, method, target, args })),
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
    throw new UsageError(
      `--select matched nothing for: ${unmatched.join(', ')}. ${calls.length} call(s) available; run vib record --from-tap ${file} to list them.`,
    )
  }
  // Normalization config comes from the project config (no server is started).
  const options = mergeCliOptions(flags)
  const rootDir = options.rootDir
  const force = hasFlag(argv, '--force')
  const tags = takeAllFlags(argv, '--tag')
  const outDirFlag = takeFlag(argv, '--out-dir')
  const outDir = outDirFlag
    ? resolvePathFromCwd(outDirFlag)
    : path.join(rootDir, 'tests', 'integration', 'tap')
  const single = picked.length === 1
  const written: Array<{ path: string; index: number; case: TestCase }> = []
  const skipped: Array<{ index: number; reason: string }> = []
  const notes: string[] = []
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
      (single ? takeFlag(argv, '--name') : undefined) ?? `${call.target} (tap #${call.index})`
    const outPath =
      single && takeFlag(argv, '--out')
        ? resolvePathFromCwd(takeFlag(argv, '--out') as string)
        : path.join(outDir, `${slugify(call.target) || 'call'}-${call.index}.json`)
    if (fs.existsSync(outPath) && !force) {
      skipped.push({ index: call.index, reason: `${outPath} exists (pass --force to replace)` })
      continue
    }
    const step = stepFromObserved(
      op,
      observedFromTap(call),
      {
        normalize: options.normalize,
        partial: hasFlag(argv, '--partial'),
        respond: Object.keys(call.respond).length > 0 ? call.respond : undefined,
        awaitOpt: call.taskAwaited ? true : undefined,
      },
      notes,
    ) as Step
    if (call.taskAwaited) step.await = true
    const testCase: TestCase = {
      ...caseHeader({ rootDir, outPath }, name, tags.length > 0 ? tags : ['tap']),
      ...step,
    }
    writeJsonFile(outPath, testCase)
    written.push({ path: outPath, index: call.index, case: testCase })
  }
  if (badLines.length > 0)
    notes.push(
      `Skipped ${plural(badLines.length, 'unreadable line')} in the capture (lines ${badLines.slice(0, 5).join(', ')}).`,
    )
  if (flags.json) {
    printJson({ ok: written.length > 0, source: file, written, skipped, notes })
  } else {
    printNotes(notes, false)
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
