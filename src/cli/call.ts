import { normalizeResult } from '../normalize.js'
import { validate } from '../schema.js'
import {
  type CallOptions,
  type McpSession,
  type Outcome,
  type ToolError,
  expandUriTemplate,
} from '../session/index.js'
import type { AwaitOptions, JsonValue, NormalizeConfig, ToolSummary } from '../types.js'
import {
  UsageError,
  hasFlag,
  parseRespond,
  parseToolArgs,
  positionals,
  printJson,
  stringifyArgs,
  takeNumberFlag,
} from './args.js'
import {
  colors,
  formatCallHeader,
  formatInputRequests,
  isObject,
  preview,
  sampleRespond,
} from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'

export type OpKind = 'tool' | 'resource' | 'resourceTemplate' | 'prompt'

export interface OpSpec {
  kind: OpKind
  /** Tool name, resource URI, URI template, or prompt name. */
  target: string
  args: Record<string, JsonValue>
}

export const OP_METHOD: Record<OpKind, string> = {
  tool: 'tools/call',
  resource: 'resources/read',
  resourceTemplate: 'resources/read',
  prompt: 'prompts/get',
}

export function opLabel(op: OpSpec): string {
  return `${OP_METHOD[op.kind]} ${op.target}`
}

/** Run one operation on the session. Templates are expanded with `args`. */
export function executeOp(
  session: McpSession,
  op: OpSpec,
  opts: CallOptions = {},
): Promise<Outcome> {
  switch (op.kind) {
    case 'tool':
      return session.callTool(op.target, op.args, opts)
    case 'resource':
      return session.readResource(op.target, opts)
    case 'resourceTemplate':
      return session.readResourceTemplate(op.target, op.args, opts)
    case 'prompt':
      return session.getPrompt(op.target, stringifyArgs(op.args), opts)
  }
}

/** `--await` / `--await-timeout <ms>` → CallOptions.await. */
export function parseAwait(argv: string[]): AwaitOptions | true | undefined {
  const timeoutMs = takeNumberFlag(argv, '--await-timeout', { min: 1 })
  if (timeoutMs !== undefined) return { timeoutMs }
  return hasFlag(argv, '--await') ? true : undefined
}

export interface Validation {
  /** False when there was nothing to validate against (no outputSchema / not a result). */
  checked: boolean
  ok?: boolean
  errors?: Array<{ path: string; message: string }>
  reason?: string
}

/** Validate a tools/call result's structuredContent against the tool's outputSchema. */
export function validateStructured(tool: ToolSummary | undefined, outcome: Outcome): Validation {
  if (!tool) return { checked: false, reason: 'tool not found in tools/list' }
  if (tool.outputSchema === undefined) {
    return { checked: false, reason: `tool "${tool.name}" declares no outputSchema` }
  }
  if (outcome.kind !== 'result') {
    return { checked: false, reason: `no result to validate (${outcome.kind})` }
  }
  const result = outcome.result
  if (!isObject(result) || result.structuredContent === undefined) {
    return {
      ok: false,
      checked: true,
      errors: [
        {
          path: 'structuredContent',
          message: 'missing: a tool that declares outputSchema must return structuredContent',
        },
      ],
    }
  }
  const verdict = validate(tool.outputSchema, result.structuredContent)
  return verdict.ok
    ? { checked: true, ok: true }
    : {
        checked: true,
        ok: false,
        errors: verdict.errors.map((e) => ({
          path: e.path ? `structuredContent.${e.path}`.replace('.[', '[') : 'structuredContent',
          message: e.message,
        })),
      }
}

export interface OutcomeReport {
  ok: boolean
  operation: OpKind
  method: string
  target: string
  uri?: string
  args: Record<string, JsonValue>
  kind: Outcome['kind']
  durationMs: number
  /** Normalized with config `normalize`, unless `normalized` is false (--raw). */
  result?: JsonValue
  normalized: boolean
  error?: ToolError
  /** Unanswered InputRequests map (kind input_required). */
  requests?: JsonValue
  /** Every InputRequests map seen during the call (one per round). */
  inputRequests?: JsonValue[]
  task?: JsonValue
  validation?: Validation
  hint?: string
}

export function buildReport(
  op: OpSpec,
  outcome: Outcome,
  { raw, normalize }: { raw: boolean; normalize: NormalizeConfig },
  validation?: Validation,
  replay?: string,
): OutcomeReport {
  const norm = (value: JsonValue) => (raw ? value : normalizeResult(value, normalize))
  const report: OutcomeReport = {
    ok: outcome.kind === 'result' && (validation?.ok ?? true),
    operation: op.kind,
    method: OP_METHOD[op.kind],
    target: op.target,
    ...(op.kind === 'resourceTemplate' ? { uri: expandUriTemplate(op.target, op.args) } : {}),
    args: op.args,
    kind: outcome.kind,
    durationMs: outcome.durationMs,
    normalized: !raw,
  }
  if (outcome.kind === 'result') report.result = norm(outcome.result)
  if (outcome.kind === 'error') {
    report.error = outcome.error
    if (outcome.result !== undefined) report.result = norm(outcome.result)
  }
  if (outcome.kind === 'input_required') {
    report.requests = outcome.requests
    const respond = JSON.stringify(sampleRespond(outcome.requests))
    report.hint = `The server asked for input and nothing answered. Re-run with --respond '${respond}'${replay ? ` (e.g. ${replay} --respond '${respond}')` : ''}.`
  }
  if (outcome.inputRequests) report.inputRequests = outcome.inputRequests
  if (outcome.task !== undefined) {
    report.task = outcome.task
    if (
      outcome.kind === 'result' &&
      isObject(outcome.result) &&
      outcome.result.resultType === 'task'
    )
      report.hint =
        'The server answered with a task. Re-run with --await to poll tasks/get until it finishes.'
  }
  if (validation) report.validation = validation
  if (outcome.kind === 'error' && !report.hint) report.hint = errorHint(outcome.error, op)
  return report
}

function errorHint(error: ToolError, op: OpSpec): string {
  if (error.kind === 'timeout') return 'Raise --timeout if the server is legitimately slow.'
  if (error.kind === 'transport')
    return 'The connection failed; run the server command by hand to see why it exits.'
  if (error.kind === 'tool')
    return 'The tool ran and reported an error (isError: true). Use vib record to capture it as expectError.'
  if (error.code === -32602 && op.kind === 'tool')
    return `Check the arguments against the tool's inputSchema (vib tools shows it), or the tool name.`
  if (error.code === -32601) return 'The server does not implement this method.'
  return 'See the server logs for details.'
}

export function printReport(report: OutcomeReport): void {
  const c = colors()
  const time = c.dim(`(${report.durationMs}ms)`)
  if (report.kind === 'result') {
    console.log(`${c.green('✓ result')} ${time}`)
    console.log(JSON.stringify(report.result, null, 2))
  } else if (report.kind === 'error' && report.error) {
    const e = report.error
    const code = [e.codeName, e.code].filter((v) => v !== undefined).join(' ')
    console.error(
      `${c.red('✗ error')}${code ? ` [${code}]` : ''} ${c.dim(`(${e.kind}${e.local ? ', raised locally' : ''})`)} ${time}`,
    )
    console.error(`  ${e.message}`)
    if (e.data !== undefined) console.error(`  data: ${preview(e.data, 200)}`)
    if (report.result !== undefined) {
      console.log(JSON.stringify(report.result, null, 2))
    }
  } else if (report.kind === 'input_required') {
    console.error(`${c.yellow('⏸ input required')} ${time} — the server asked for:`)
    for (const line of formatInputRequests(report.requests ?? null)) console.error(line)
  }
  if (report.validation) {
    const v = report.validation
    if (!v.checked) console.log(c.dim(`validation skipped: ${v.reason}`))
    else if (v.ok) console.log(c.green('✓ structuredContent matches outputSchema'))
    else {
      console.log(c.red('✗ structuredContent does not match outputSchema:'))
      for (const e of v.errors ?? []) console.log(`  ${e.path}: ${e.message}`)
    }
  }
  if (report.hint && report.kind !== 'result') console.error(c.dim(`hint: ${report.hint}`))
  else if (report.hint) console.log(c.dim(`hint: ${report.hint}`))
}

/** Shell-ish rendering of a replay command (for hints). */
export function replayCommand(parts: string[]): string {
  return parts.map((p) => (/^[\w./:@=-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)).join(' ')
}

export interface OneShotSpec {
  command: 'call' | 'read' | 'get-prompt'
  usage: string
  build(positional: string, argv: string[]): OpSpec
}

/** Shared body of `call`, `read`, `get-prompt`. */
export async function runOneShot(spec: OneShotSpec, argv: string[]): Promise<number> {
  const [positional] = positionals(argv)
  if (!positional) throw new UsageError(`Missing argument. Usage: ${spec.usage}`)
  const op = spec.build(positional, argv)
  const flags = parseCommonFlags(argv)
  const raw = hasFlag(argv, '--raw')
  const wantValidate = hasFlag(argv, '--validate')
  if (wantValidate && op.kind !== 'tool') {
    throw new UsageError('--validate only applies to vib call (tools with an outputSchema).')
  }
  const respond = parseRespond(argv)
  const awaitOpt = parseAwait(argv)
  const { session, options } = await startSession(flags)
  try {
    let tool: ToolSummary | undefined
    if (wantValidate) {
      tool = (await session.listTools()).find((t) => t.name === op.target)
    }
    if (!flags.json) console.log(formatCallHeader(opLabel(op), op.args))
    const outcome = await executeOp(session, op, {
      ...(respond ? { respond } : {}),
      ...(awaitOpt !== undefined ? { await: awaitOpt } : {}),
    })
    const validation = wantValidate ? validateStructured(tool, outcome) : undefined
    const report = buildReport(
      op,
      outcome,
      { raw, normalize: options.normalize },
      validation,
      replayCommand(['vib', spec.command, positional, ...argv.filter((a) => a !== positional)]),
    )
    if (flags.json) printJson(report)
    else printReport(report)
    return report.ok ? 0 : 1
  } finally {
    await session.close()
  }
}

export const CALL_SPEC: OneShotSpec = {
  command: 'call',
  usage: `vib call <tool> [--args '{"key":"value"}'] [--arg key=value] [--respond '{...}'] [--await] [--validate] [--raw]`,
  build: (tool, argv) => ({ kind: 'tool', target: tool, args: parseToolArgs(argv) }),
}

export async function callCommand(argv: string[]): Promise<number> {
  return runOneShot(CALL_SPEC, argv)
}
