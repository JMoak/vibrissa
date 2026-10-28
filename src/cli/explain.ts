/**
 * `vib explain <case...>`: a plain-English paraphrase of what a case does and asserts,
 * for reviewing agent-authored suites in PRs. Matcher wording follows docs/MATCHERS.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { parseCaseText } from '../cases.js'
import { appendIndex, appendKey } from '../schema.js'
import type { JsonValue } from '../types.js'
import { UsageError, hasFlag, positionals, printJson } from './args.js'
import { colors, isObject, preview } from './format.js'

export interface Assertion {
  /** Where in the result (matcher path format; `(root)` for the whole value). */
  path: string
  text: string
  depth: number
}

export interface StepExplanation {
  phase: 'main' | 'setup' | 'teardown'
  /** 1-based within its phase. */
  index: number
  name?: string
  operation?: { kind: string; method: string; target: string; args?: JsonValue }
  summary: string
  uses: string[]
  expect: Assertion[]
  expectError?: string
  expectInputRequired: Assertion[]
  expectTask: Assertion[]
  respond: string[]
  captures: string[]
  notes: string[]
}

export interface CaseExplanation {
  file: string
  name?: string
  kind: 'single' | 'flow'
  tags: string[]
  server?: string
  skip?: string
  flaky?: boolean
  steps: StepExplanation[]
  /** Load problem (the file was not explained). */
  error?: string
}

const MATCHERS = new Set([
  '$regex',
  '$wildcard',
  '$unordered',
  '$any',
  '$type',
  '$schema',
  '$oneOf',
  '$contains',
  '$length',
  '$number',
  '$ignore',
  '$ref',
  '$literal',
])

function isDirective(node: Record<string, JsonValue>): boolean {
  return Object.keys(node).some(
    (key) => MATCHERS.has(key) && !(key === '$schema' && typeof node[key] === 'string'),
  )
}

const COMPACT_WIDTH = 72

/** No matcher keys anywhere inside (a `$partial` flag is allowed at the top). */
function isPlainData(node: JsonValue, top = true): boolean {
  if (Array.isArray(node)) return node.every((item) => isPlainData(item, false))
  if (!isObject(node)) return true
  return Object.entries(node).every(([key, value]) =>
    key === '$partial'
      ? top && typeof value === 'boolean'
      : !key.startsWith('$') && isPlainData(value, false),
  )
}

function root(path: string): string {
  return path === '' ? '(root)' : path
}

const BOUND_WORDS: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=' }

function boundsText(spec: JsonValue): string {
  if (!isObject(spec)) return preview(spec)
  return Object.entries(spec)
    .map(([k, v]) => `${BOUND_WORDS[k] ?? k} ${v}`)
    .join(' and ')
}

function lengthText(spec: JsonValue): string {
  if (typeof spec === 'number') return `has length ${spec}`
  if (!isObject(spec)) return `has length ${preview(spec)}`
  const { min, max } = spec
  if (min !== undefined && max !== undefined) return `has length between ${min} and ${max}`
  if (min !== undefined) return `has length at least ${min}`
  if (max !== undefined) return `has length at most ${max}`
  return 'has any length'
}

function countText(count: JsonValue | undefined): string {
  if (count === undefined) return 'at least one item'
  if (typeof count === 'number')
    return count === 0 ? 'no item' : `exactly ${count} item${count === 1 ? '' : 's'}`
  if (isObject(count)) {
    const { min, max } = count
    if (min !== undefined && max !== undefined) return `between ${min} and ${max} items`
    if (min !== undefined) return `at least ${min} items`
    if (max !== undefined) return max === 0 ? 'no item' : `at most ${max} items`
  }
  return `${preview(count)} items`
}

function schemaText(schema: JsonValue): string {
  if (schema === true) return 'validates against the JSON Schema `true` (anything)'
  if (schema === false) return 'validates against the JSON Schema `false` (nothing passes)'
  if (!isObject(schema)) return 'validates against an inline JSON Schema'
  const parts: string[] = []
  if (schema.type !== undefined)
    parts.push(`type ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`)
  if (Array.isArray(schema.required) && schema.required.length > 0)
    parts.push(`required: ${schema.required.join(', ')}`)
  if (typeof schema.format === 'string') parts.push(`format ${schema.format}`)
  if (isObject(schema.properties))
    parts.push(`properties: ${Object.keys(schema.properties).join(', ')}`)
  return `validates against an inline JSON Schema${parts.length ? ` (${parts.join('; ')})` : ''}`
}

/** Walk an expectation tree into human assertions (docs/MATCHERS.md semantics). */
export function describeExpectation(
  node: JsonValue,
  at = '',
  partial = false,
  depth = 0,
  out: Assertion[] = [],
): Assertion[] {
  const push = (text: string, where = at) => out.push({ path: root(where), text, depth })
  // Short plain-data subtrees read better as one line.
  if (depth > 0 && (Array.isArray(node) || isObject(node)) && isPlainData(node)) {
    const isPartial = isObject(node) && typeof node.$partial === 'boolean' ? node.$partial : partial
    const data = isObject(node)
      ? Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$partial'))
      : node
    const text = JSON.stringify(data)
    const empty = Array.isArray(data) ? data.length === 0 : Object.keys(data).length === 0
    if (text.length <= COMPACT_WIDTH && !empty) {
      if (!isPartial) push(`equals ${text}`)
      else if (Array.isArray(data)) push(`starts with ${text} (extra trailing items allowed)`)
      else push(`includes ${text} (extra keys allowed)`)
      return out
    }
  }
  if (Array.isArray(node)) {
    if (node.length === 0) push(partial ? 'is an array (partial: any items)' : 'is an empty array')
    else
      push(
        partial
          ? `starts with ${node.length === 1 ? 'this item' : `these ${node.length} items in order`} (extra trailing items allowed)`
          : `has exactly ${node.length} item${node.length === 1 ? '' : 's'}, in this order`,
      )
    node.forEach((item, i) =>
      describeExpectation(item, appendIndex(at, i), partial, depth + 1, out),
    )
    return out
  }
  if (!isObject(node)) {
    push(`equals ${JSON.stringify(node)}`)
    return out
  }
  if (isDirective(node)) {
    const parts: string[] = []
    const nested: Array<() => void> = []
    const childPartial = typeof node.$partial === 'boolean' ? node.$partial : partial
    if (node.$any !== undefined) parts.push('is present (any value, null included)')
    if (node.$type !== undefined) {
      const types = Array.isArray(node.$type) ? node.$type.map(String) : [String(node.$type)]
      parts.push(`is of type ${types.join(' or ')}`)
    }
    if (node.$number !== undefined) parts.push(`is a number ${boundsText(node.$number)}`)
    if (node.$length !== undefined) parts.push(lengthText(node.$length))
    if (node.$regex !== undefined)
      parts.push(`matches /${node.$regex}/${typeof node.flags === 'string' ? node.flags : ''}`)
    if (node.$wildcard !== undefined)
      parts.push(
        `matches the pattern ${JSON.stringify(node.$wildcard)} (* = anything, ? = one character)`,
      )
    if (node.$schema !== undefined && typeof node.$schema !== 'string')
      parts.push(schemaText(node.$schema))
    if (node.$contains !== undefined) {
      const containsPartial = typeof node.$partial === 'boolean' ? node.$partial : true
      parts.push(`contains ${countText(node.count)} matching${containsPartial ? '' : ' exactly'}:`)
      nested.push(() =>
        describeExpectation(node.$contains, `${root(at)}[*]`, containsPartial, depth + 1, out),
      )
    }
    if (node.$unordered !== undefined) {
      const items = Array.isArray(node.value) ? node.value : []
      parts.push(
        `${items.length === 1 ? 'has this item (any position)' : `has these ${items.length} items in any order`}${childPartial ? ' (other items allowed)' : ' (and nothing else)'}:`,
      )
      nested.push(() =>
        items.forEach((item, i) =>
          describeExpectation(item, `${root(at)}[any #${i + 1}]`, childPartial, depth + 1, out),
        ),
      )
    }
    if (node.$oneOf !== undefined) {
      const alternatives = Array.isArray(node.$oneOf) ? node.$oneOf : []
      parts.push(`matches any one of ${alternatives.length} alternatives:`)
      nested.push(() =>
        alternatives.forEach((alt, i) => {
          if (isObject(alt) && alt.$ignore === true) {
            out.push({
              path: `${root(at)} #${i + 1}`,
              text: 'is missing (or anything)',
              depth: depth + 1,
            })
          } else describeExpectation(alt, `${root(at)} #${i + 1}`, childPartial, depth + 1, out)
        }),
      )
    }
    if (node.$ignore !== undefined) parts.push('is ignored (may be missing)')
    if (node.$ref !== undefined)
      parts.push(`matches the shared fragment ${JSON.stringify(node.$ref)}`)
    if (node.$literal !== undefined)
      parts.push(`equals exactly ${preview(node.$literal, 100)} (as plain data)`)
    push(parts.join(' and '))
    for (const run of nested) run()
    return out
  }
  const isPartial = typeof node.$partial === 'boolean' ? node.$partial : partial
  const keys = Object.keys(node).filter((key) => key !== '$partial')
  if (keys.length === 0) push(isPartial ? 'is any object' : 'is an empty object')
  else
    push(
      isPartial
        ? `is an object with at least: ${keys.join(', ')} (extra keys allowed)`
        : `is an object with exactly: ${keys.join(', ')}`,
    )
  for (const key of keys)
    describeExpectation(node[key], appendKey(at, key), isPartial, depth + 1, out)
  return out
}

const METHODS: Record<string, string> = {
  tool: 'tools/call',
  resource: 'resources/read',
  resourceTemplate: 'resources/read',
  prompt: 'prompts/get',
}

function placeholders(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(m[1])
  } else if (Array.isArray(value)) for (const v of value) placeholders(v, found)
  else if (isObject(value)) for (const v of Object.values(value)) placeholders(v, found)
  return found
}

function errorText(expectError: JsonValue): string {
  if (!isObject(expectError)) return 'fails with an error'
  const parts: string[] = []
  if (expectError.code !== undefined) parts.push(`code ${expectError.code}`)
  const message = expectError.message
  if (typeof message === 'string') parts.push(`message exactly ${JSON.stringify(message)}`)
  else if (isObject(message) && typeof message.$regex === 'string')
    parts.push(
      `message matching /${message.$regex}/${typeof message.flags === 'string' ? message.flags : ''}`,
    )
  return parts.length > 0
    ? `fails with an error (${parts.join(', ')}); a tool isError result counts`
    : 'fails with any error (protocol error or tool isError result)'
}

export function explainStep(
  step: Record<string, JsonValue>,
  phase: StepExplanation['phase'],
  index: number,
): StepExplanation {
  const kind = ['tool', 'resource', 'resourceTemplate', 'prompt'].find((k) => step[k] !== undefined)
  const target = kind ? String(step[kind]) : ''
  const args = step.args
  const hasArgs = isObject(args) && Object.keys(args).length > 0
  const argText = hasArgs ? ` with ${preview(args, 160)}` : ''
  const summary =
    kind === 'tool'
      ? `Calls tool "${target}"${argText || ' with no arguments'}`
      : kind === 'resource'
        ? `Reads resource ${target}`
        : kind === 'resourceTemplate'
          ? `Reads resource template ${target}${hasArgs ? ` expanded with ${preview(args, 160)}` : ''}`
          : kind === 'prompt'
            ? `Gets prompt "${target}"${argText}`
            : 'No operation (missing tool / resource / resourceTemplate / prompt)'
  const notes: string[] = []
  if (typeof step.budgetMs === 'number')
    notes.push(`must finish within ${step.budgetMs}ms (budget)`)
  if (typeof step.timeoutMs === 'number') notes.push(`times out after ${step.timeoutMs}ms`)
  if (step.validateOutput === false)
    notes.push('does not validate structuredContent against outputSchema')
  if (step.normalize === false) notes.push('compares the raw result (normalization off)')
  else if (isObject(step.normalize)) notes.push(`custom normalization ${preview(step.normalize)}`)
  if (step.ignoreErrors === true) notes.push('never fails the case (ignoreErrors)')
  if (step.await === true)
    notes.push('polls the task (tasks/get) until it finishes, then checks the final result')
  else if (isObject(step.await))
    notes.push(`polls the task until it finishes (${preview(step.await)})`)
  if (
    kind === 'tool' &&
    step.expect === undefined &&
    step.expectError === undefined &&
    step.expectTask === undefined &&
    step.expectInputRequired === undefined
  ) {
    notes.push('asserts only that the call succeeds')
  }
  return {
    phase,
    index,
    ...(typeof step.name === 'string' ? { name: step.name } : {}),
    ...(kind
      ? {
          operation: {
            kind,
            method: METHODS[kind],
            target,
            ...(args !== undefined ? { args } : {}),
          },
        }
      : {}),
    summary,
    uses: [...placeholders(args)],
    expect: step.expect !== undefined ? describeExpectation(step.expect) : [],
    ...(step.expectError !== undefined ? { expectError: errorText(step.expectError) } : {}),
    expectInputRequired:
      step.expectInputRequired !== undefined ? describeExpectation(step.expectInputRequired) : [],
    expectTask: step.expectTask !== undefined ? describeExpectation(step.expectTask) : [],
    respond: isObject(step.respond)
      ? Object.entries(step.respond).map(
          ([method, answer]) => `answers ${method} with ${preview(answer, 120)}`,
        )
      : [],
    captures: isObject(step.capture)
      ? Object.entries(step.capture).map(([name, from]) => `captures {{${name}}} = ${String(from)}`)
      : [],
    notes,
  }
}

export function explainCase(value: unknown, file: string): CaseExplanation {
  if (!isObject(value))
    return { file, kind: 'single', tags: [], steps: [], error: 'not a JSON object' }
  const steps: StepExplanation[] = []
  const list = (key: 'setup' | 'steps' | 'teardown', phase: StepExplanation['phase']) => {
    const items = value[key]
    if (Array.isArray(items))
      items.forEach((s, i) => isObject(s) && steps.push(explainStep(s, phase, i + 1)))
  }
  list('setup', 'setup')
  const flow = Array.isArray(value.steps)
  if (flow) list('steps', 'main')
  else steps.push(explainStep(value, 'main', 1))
  list('teardown', 'teardown')
  return {
    file,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    kind: flow ? 'flow' : 'single',
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    ...(typeof value.server === 'string' ? { server: value.server } : {}),
    ...(value.skip !== undefined && value.skip !== false
      ? { skip: typeof value.skip === 'string' ? value.skip : 'yes' }
      : {}),
    ...(value.flaky === true ? { flaky: true } : {}),
    steps,
  }
}

export function formatExplanation(
  ex: CaseExplanation,
  { full = false, maxLines = 40 } = {},
): string {
  const c = colors()
  const out: string[] = []
  out.push(`${c.bold(ex.name ?? '(unnamed case)')}  ${c.dim(ex.file)}`)
  if (ex.error) {
    out.push(c.red(`  cannot explain: ${ex.error}`))
    return out.join('\n')
  }
  const meta: string[] = []
  if (ex.kind === 'flow')
    meta.push(`flow of ${ex.steps.filter((s) => s.phase === 'main').length} steps`)
  if (ex.tags.length) meta.push(`tags: ${ex.tags.join(', ')}`)
  if (ex.server) meta.push(`server: ${ex.server}`)
  if (ex.flaky) meta.push('flaky (pass-rate floor under --repeat)')
  if (meta.length) out.push(`  ${c.dim(meta.join(' · '))}`)
  if (ex.skip) out.push(`  ${c.yellow(`skipped: ${ex.skip}`)}`)
  const assertionLines = (list: Assertion[], indent: string) => {
    const shown = full ? list : list.slice(0, maxLines)
    for (const a of shown)
      out.push(`${indent}${'  '.repeat(Math.min(a.depth, 8))}${c.cyan(a.path)} ${a.text}`)
    if (shown.length < list.length)
      out.push(`${indent}${c.dim(`… ${list.length - shown.length} more (use --full)`)}`)
  }
  for (const step of ex.steps) {
    const label =
      ex.kind === 'flow' || step.phase !== 'main'
        ? `${step.phase === 'main' ? 'Step' : step.phase === 'setup' ? 'Setup' : 'Teardown'} ${step.index}${step.name ? ` "${step.name}"` : ''}: `
        : ''
    out.push('', `  ${c.bold(label)}${step.summary}`)
    const indent = '    '
    if (step.uses.length)
      out.push(`${indent}uses captured ${step.uses.map((u) => `{{${u}}}`).join(', ')}`)
    for (const r of step.respond) out.push(`${indent}if the server asks for input: ${r}`)
    if (step.expectInputRequired.length) {
      out.push(`${indent}expects the server to ask for input:`)
      assertionLines(step.expectInputRequired, `${indent}  `)
    }
    if (step.expectTask.length) {
      out.push(`${indent}expects a task:`)
      assertionLines(step.expectTask, `${indent}  `)
    }
    if (step.expectError) out.push(`${indent}expects it ${step.expectError}`)
    if (step.expect.length) {
      out.push(`${indent}expects the result (after normalization):`)
      assertionLines(step.expect, `${indent}  `)
    }
    for (const capture of step.captures) out.push(`${indent}then ${capture}`)
    for (const note of step.notes) out.push(`${indent}${c.dim(note)}`)
  }
  return out.join('\n')
}

function expandInputs(inputs: string[]): string[] {
  const files: string[] = []
  for (const input of inputs) {
    if (/[*?[\]{}]/.test(input)) {
      const hits = fg.sync(input.replace(/\\/g, '/'), { absolute: true, onlyFiles: true })
      if (hits.length === 0)
        throw new UsageError(
          `No case files match ${input}. Check the glob (quote it so the shell does not expand it).`,
        )
      files.push(...hits.sort())
    } else files.push(path.resolve(input))
  }
  return files
}

export async function explainCommand(argv: string[]): Promise<number> {
  const inputs = positionals(argv)
  if (inputs.length === 0) {
    throw new UsageError(
      'Missing case file. Usage: vib explain <case.json> [more files or "globs/**/*.json"] [--json] [--full]',
    )
  }
  const files = expandInputs(inputs)
  const explanations: CaseExplanation[] = []
  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new UsageError(`Case file not found: ${file}. Pass a path to a case .json file.`)
    }
    const shown = path.relative(process.cwd(), file).replace(/\\/g, '/') || file
    try {
      explanations.push(explainCase(parseCaseText(fs.readFileSync(file, 'utf8'), shown), shown))
    } catch (err) {
      explanations.push({
        file: shown,
        kind: 'single',
        tags: [],
        steps: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const ok = explanations.every((e) => !e.error)
  if (hasFlag(argv, '--json')) printJson({ ok, cases: explanations })
  else
    console.log(
      explanations.map((e) => formatExplanation(e, { full: hasFlag(argv, '--full') })).join('\n\n'),
    )
  return ok ? 0 : 1
}
