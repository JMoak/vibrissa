import { UriTemplate } from '@modelcontextprotocol/client'
import { normalizeResult } from '../normalize.js'
import { suggestRespond } from '../respond-hint.js'
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
  unknownNameError,
} from './args.js'
import { colors, formatCallHeader, formatInputRequests, isObject, preview } from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'
import { listOptional } from './resources.js'

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

/**
 * Check that the operation's target is something the server lists: a tool, a prompt, a
 * listed resource URI (or one matching a listed template), or a listed template. Throws a
 * did-you-mean UsageError otherwise. Returns the tool definition for tool operations.
 * Lists the server does not support are not checked.
 */
export async function resolveTarget(
  session: McpSession,
  op: OpSpec,
): Promise<{ tool?: ToolSummary }> {
  if (op.kind === 'tool') {
    const tools = await session.listTools()
    const tool = tools.find((t) => t.name === op.target)
    if (!tool)
      throw unknownNameError(
        'tool',
        op.target,
        tools.map((t) => t.name),
        'vib tools',
      )
    return { tool }
  }
  const info = await session.discover()
  if (op.kind === 'prompt') {
    const prompts = await listOptional(info.capabilities, 'prompts', 'prompts/list', () =>
      session.listPromptsResult(),
    )
    if (prompts.meta.unsupported) return {}
    if (!prompts.items.some((p) => p.name === op.target)) {
      throw unknownNameError(
        'prompt',
        op.target,
        prompts.items.map((p) => p.name),
        'vib prompts',
      )
    }
    return {}
  }
  const templates = await listOptional(
    info.capabilities,
    'resources',
    'resources/templates/list',
    () => session.listResourceTemplatesResult(),
  )
  if (op.kind === 'resourceTemplate') {
    if (templates.meta.unsupported) return {}
    if (!templates.items.some((t) => t.uriTemplate === op.target)) {
      throw unknownNameError(
        'resource template',
        op.target,
        templates.items.map((t) => t.uriTemplate),
        'vib resources',
      )
    }
    return {}
  }
  const resources = await listOptional(info.capabilities, 'resources', 'resources/list', () =>
    session.listResourcesResult(),
  )
  if (resources.meta.unsupported) return {}
  const listed = resources.items.some((r) => r.uri === op.target)
  const matchesTemplate = templates.items.some((t) => {
    try {
      return new UriTemplate(t.uriTemplate).match(op.target) !== null
    } catch {
      return false
    }
  })
  if (!listed && !matchesTemplate) {
    throw unknownNameError(
      'resource',
      op.target,
      [...resources.items.map((r) => r.uri), ...templates.items.map((t) => t.uriTemplate)],
      'vib resources',
    )
  }
  return {}
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
  if (isObject(result) && result.resultType === 'task') {
    return { checked: false, reason: 'the server answered with a task (use --await)' }
  }
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

/** One-line summary of a failed validation: `structuredContent.sum: must be number, got string`. */
export function validationSummary(validation: Validation): string {
  return (validation.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ')
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
  /** The failure, with a next step in `hint`. */
  error?: ToolError & { type: 'ToolError'; hint: string }
  /** The unanswered InputRequests map (kind input_required). */
  requests?: JsonValue
  /** Every InputRequests map answered during the call (one per round). */
  inputRequests?: JsonValue[]
  task?: JsonValue
  validation?: Validation
  warnings?: string[]
  hint?: string
}

export function buildReport(
  op: OpSpec,
  outcome: Outcome,
  {
    raw,
    normalize,
    strict = false,
  }: { raw: boolean; normalize: NormalizeConfig; strict?: boolean },
  validation?: Validation,
  replay?: string,
): OutcomeReport {
  const norm = (value: JsonValue) => (raw ? value : normalizeResult(value, normalize))
  const invalidOutput = validation?.checked === true && validation.ok === false
  const report: OutcomeReport = {
    ok: outcome.kind === 'result' && !(strict && invalidOutput),
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
    report.error = { type: 'ToolError', ...outcome.error, hint: errorHint(outcome.error, op) }
    if (outcome.result !== undefined) report.result = norm(outcome.result)
  }
  if (outcome.kind === 'input_required') {
    report.requests = outcome.requests
    const respond = JSON.stringify(suggestRespond(outcome.requests))
    report.hint = `The server asked for input and nothing answered. Re-run with --respond '${respond}'${replay ? ` (e.g. ${replay} --respond '${respond}')` : ''}.`
  } else if (outcome.inputRequests) report.inputRequests = outcome.inputRequests
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
  if (invalidOutput) {
    const text = `structuredContent does not match the outputSchema of "${op.target}": ${validationSummary(validation as Validation)}`
    if (strict) report.hint ??= 'Fix the tool so its structuredContent matches its outputSchema.'
    else report.warnings = [`${text}. vib run would fail this; re-run with --validate for details.`]
  }
  return report
}

function errorHint(error: ToolError, op: OpSpec): string {
  if (error.kind === 'timeout') return 'Raise --timeout if the server is legitimately slow.'
  if (error.kind === 'transport')
    return 'The connection failed; run the server command by hand to see why it exits.'
  if (error.kind === 'tool')
    return 'The tool ran and reported an error (isError: true). Use vib record to capture it as expectError.'
  if (error.code === -32602 && op.kind === 'tool')
    return `Check the arguments against the tool's inputSchema (vib tools ${op.target} shows it).`
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
    if (report.result !== undefined) console.log(JSON.stringify(report.result, null, 2))
    console.error(c.dim(`hint: ${e.hint}`))
  } else if (report.kind === 'input_required') {
    console.error(`${c.yellow('⏸ input required')} ${time} — the server asked for:`)
    for (const line of formatInputRequests(report.requests ?? null)) console.error(line)
  }
  const v = report.validation
  if (v?.checked && v.ok === false) {
    const paint = report.ok ? c.yellow : c.red
    console.log(
      paint(`${report.ok ? '!' : '✗'} structuredContent does not match the outputSchema:`),
    )
    for (const e of v.errors ?? []) console.log(`  ${e.path}: ${e.message}`)
    if (report.ok)
      console.log(c.dim('  vib run would fail this; --validate makes it fail here too.'))
  } else if (v?.checked && v.ok) console.log(c.green('✓ structuredContent matches outputSchema'))
  else if (v && !v.checked) console.log(c.dim(`validation skipped: ${v.reason}`))
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
  if (!positional) {
    throw new UsageError('Missing argument.', {
      code: 'missing-argument',
      hint: `Usage: ${spec.usage}`,
    })
  }
  const op = spec.build(positional, argv)
  const flags = parseCommonFlags(argv)
  const raw = hasFlag(argv, '--raw')
  const strict = hasFlag(argv, '--validate')
  if (strict && op.kind !== 'tool') {
    throw new UsageError('--validate only applies to vib call (tools with an outputSchema).', {
      code: 'invalid-argument',
      hint: 'Drop --validate.',
    })
  }
  const respond = parseRespond(argv)
  const awaitOpt = parseAwait(argv)
  const { session, options } = await startSession(flags)
  try {
    let tool: ToolSummary | undefined
    if (!hasFlag(argv, '--expect-missing')) tool = (await resolveTarget(session, op)).tool
    else if (op.kind === 'tool')
      tool = (await session.listTools()).find((t) => t.name === op.target)
    if (!flags.json) console.log(formatCallHeader(opLabel(op), op.args))
    const outcome = await executeOp(session, op, {
      ...(respond ? { respond } : {}),
      ...(awaitOpt !== undefined ? { await: awaitOpt } : {}),
    })
    const validation = op.kind === 'tool' ? validateStructured(tool, outcome) : undefined
    const report = buildReport(
      op,
      outcome,
      { raw, normalize: options.normalize, strict },
      validation?.checked || strict ? validation : undefined,
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
