/**
 * `vib explain <case...>`: a plain-English paraphrase of what a case does and asserts,
 * for reviewing agent-authored suites in PRs. Matcher wording follows docs/MATCHERS.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { type LoadedCase, loadCaseFile, loadCasesSync, resolveCaseFilesSync } from '../cases.js'
import { defaultRunOptions } from '../defaults.js'
import { appendIndex, appendKey } from '../schema.js'
import type { JsonValue, RunOptions } from '../types.js'
import { UsageError, closest, hasFlag, positionals, printJson, pruneEmpty } from './args.js'
import { colors, isObject, plural, preview } from './format.js'
import { mergeCliOptions, parseCommonFlags } from './resolve.js'

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

export interface WeakAssertion {
  /** `any-error` | `bare-partial` | `no-expectation` | `no-output-validation` | `ignore-errors` | `skipped` */
  code: string
  /** `case`, `step 2`, `setup 1`, `teardown 1`. */
  at: string
  message: string
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
  /** Assertions weaker than they look (expectError {}, bare $partial, ...). */
  flags: WeakAssertion[]
  /** Load problems, exactly as vib run reports them (the case was not explained). */
  errors: string[]
  /** Load warnings (unknown keys, ...). */
  warnings?: string[]
  /** `$ref` fragments the case pulls in (already inlined in the prose). */
  refs?: Array<{ path: string; ref: string }>
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
    return { file, kind: 'single', tags: [], steps: [], errors: ['not a JSON object'], flags: [] }
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
    flags: weakAssertions(value),
    errors: [],
  }
}

function stepLabel(phase: StepExplanation['phase'], index: number, flow: boolean): string {
  if (phase === 'setup') return `setup ${index}`
  if (phase === 'teardown') return `teardown ${index}`
  return flow ? `step ${index}` : 'case'
}

/** Assertions that pass more than the author probably meant (for PR review). */
export function weakAssertions(testCase: Record<string, JsonValue>): WeakAssertion[] {
  const flags: WeakAssertion[] = []
  if (testCase.skip !== undefined && testCase.skip !== false) {
    flags.push({
      code: 'skipped',
      at: 'case',
      message: `skipped${typeof testCase.skip === 'string' ? `: ${testCase.skip}` : ''} (never runs)`,
    })
  }
  const flow = Array.isArray(testCase.steps)
  const phases: Array<[StepExplanation['phase'], JsonValue[]]> = [
    ['setup', Array.isArray(testCase.setup) ? testCase.setup : []],
    ['main', flow ? (testCase.steps as JsonValue[]) : [testCase]],
    ['teardown', Array.isArray(testCase.teardown) ? testCase.teardown : []],
  ]
  for (const [phase, steps] of phases) {
    steps.forEach((raw, i) => {
      if (!isObject(raw)) return
      const at = stepLabel(phase, i + 1, flow)
      const isOp = ['tool', 'resource', 'resourceTemplate', 'prompt'].some(
        (k) => raw[k] !== undefined,
      )
      if (isObject(raw.expectError) && Object.keys(raw.expectError).length === 0) {
        flags.push({
          code: 'any-error',
          at,
          message: 'expectError {} accepts any error (add a code or message)',
        })
      }
      if (
        isObject(raw.expect) &&
        Object.keys(raw.expect).length === 1 &&
        raw.expect.$partial === true
      ) {
        flags.push({
          code: 'bare-partial',
          at,
          message: 'expect {"$partial": true} accepts any object result',
        })
      }
      const asserts = ['expect', 'expectError', 'expectTask', 'expectInputRequired'].some(
        (k) => raw[k] !== undefined,
      )
      if (
        isOp &&
        !asserts &&
        !(phase === 'teardown' && raw.ignoreErrors === true) &&
        phase !== 'setup'
      ) {
        flags.push({
          code: 'no-expectation',
          at,
          message: 'no expectation: only checks that the call succeeds',
        })
      }
      if (raw.validateOutput === false) {
        flags.push({
          code: 'no-output-validation',
          at,
          message:
            'validateOutput: false: structuredContent is not checked against the outputSchema',
        })
      }
      if (raw.ignoreErrors === true && phase !== 'teardown') {
        flags.push({
          code: 'ignore-errors',
          at,
          message: 'ignoreErrors outside teardown: failures of this step are hidden',
        })
      }
    })
  }
  return flags
}

/** `$ref`s in the case as written: where they sit and which fragment they pull in. */
function refsIn(value: JsonValue, at = ''): Array<{ path: string; ref: string }> {
  const out: Array<{ path: string; ref: string }> = []
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...refsIn(v, appendIndex(at, i))))
  else if (isObject(value)) {
    if (typeof value.$ref === 'string' && Object.keys(value).length === 1) {
      out.push({ path: at === '' ? '(root)' : at, ref: value.$ref })
    } else if (!(Object.keys(value).length === 1 && value.$literal !== undefined)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$schema' && isObject(child)) continue
        out.push(...refsIn(child, appendKey(at, key)))
      }
    }
  }
  return out
}

export function formatExplanation(
  ex: CaseExplanation,
  { full = false, brief = false, maxLines = 40 } = {},
): string {
  const c = colors()
  const out: string[] = []
  out.push(`${c.bold(ex.name ?? '(unnamed case)')}  ${c.dim(ex.file)}`)
  for (const error of ex.errors) out.push(c.red(`  ✗ ${error}`))
  for (const warning of ex.warnings ?? []) out.push(c.yellow(`  ! ${warning}`))
  for (const flag of ex.flags) out.push(c.yellow(`  ! ${flag.at}: ${flag.message}`))
  if (ex.errors.length > 0 || brief) return out.join('\n')
  const meta: string[] = []
  if (ex.kind === 'flow')
    meta.push(`flow of ${ex.steps.filter((s) => s.phase === 'main').length} steps`)
  if (ex.tags.length) meta.push(`tags: ${ex.tags.join(', ')}`)
  if (ex.server) meta.push(`server: ${ex.server}`)
  if (ex.flaky) meta.push('flaky (pass-rate floor under --repeat)')
  if (meta.length) out.push(`  ${c.dim(meta.join(' · '))}`)
  for (const ref of ex.refs ?? []) {
    out.push(`  ${c.dim(`${ref.path} is inlined from the fragment ${ref.ref}`)}`)
  }
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

interface Suite {
  options: RunOptions
  /** Every case file the config's globs match. */
  files(): string[]
  /** Ids of `$ref` fragment files the globs match (same detection as vib run). */
  fragments(): Set<string>
}

function loadSuite(flags: ReturnType<typeof parseCommonFlags>): Suite {
  let options: RunOptions
  try {
    options = mergeCliOptions(flags, {}, { quiet: true })
  } catch (err) {
    if (flags.configPath) throw err
    options = { ...defaultRunOptions, rootDir: process.cwd() }
  }
  let fragments: Set<string> | undefined
  return {
    options,
    files: () => resolveCaseFilesSync(options.globs, options.rootDir),
    fragments: () => {
      fragments ??= new Set(
        loadCasesSync({
          rootDir: options.rootDir,
          globs: options.globs,
          defaultServer: options.defaultServer,
          servers: Object.keys(options.servers),
          hooks: options.hooks,
          manifest: options.manifest,
        }).fragments ?? [],
      )
      return fragments
    },
  }
}

function loadOne(file: string, suite: Suite): LoadedCase & { warnings: string[] } {
  const warnings: string[] = []
  const loaded = loadCaseFile(
    file,
    {
      rootDir: suite.options.rootDir,
      defaultServer: suite.options.defaultServer,
      servers: Object.keys(suite.options.servers),
      hooks: suite.options.hooks,
    },
    warnings,
  )
  return { ...loaded, warnings }
}

function explainLoaded(loaded: LoadedCase & { warnings: string[] }): CaseExplanation {
  const shown = path.relative(process.cwd(), loaded.path).replace(/\\/g, '/') || loaded.path
  if (loaded.error || !loaded.data) {
    return {
      file: shown,
      ...(loaded.ref.name ? { name: loaded.ref.name } : {}),
      kind: 'single',
      tags: loaded.ref.tags,
      steps: [],
      flags: [],
      errors: [loaded.error ?? 'not a case file'],
      warnings: loaded.warnings,
    }
  }
  const ex = explainCase(loaded.data, shown)
  const refs = loaded.source ? refsIn(loaded.source as unknown as JsonValue) : []
  return { ...ex, warnings: loaded.warnings, ...(refs.length > 0 ? { refs } : {}) }
}

/** Files for the inputs: paths, globs, or case names (matched against the suite). */
function resolveInputs(inputs: string[], suite: Suite): string[] {
  const files: string[] = []
  let suiteCases: Array<{ file: string; name: string; id: string }> | undefined
  const byName = () => {
    suiteCases ??= suite
      .files()
      .map((file) => loadOne(file, suite))
      .filter((loaded) => !loaded.notACase && !suite.fragments().has(loaded.ref.id))
      .map((loaded) => ({ file: loaded.path, name: loaded.ref.name, id: loaded.ref.id }))
    return suiteCases
  }
  for (const input of inputs) {
    if (/[*?[\]{}]/.test(input)) {
      const hits = fg.sync(input.replace(/\\/g, '/'), { absolute: true, onlyFiles: true })
      if (hits.length === 0)
        throw new UsageError(`No case files match ${input}.`, {
          code: 'not-found',
          hint: 'Check the glob (quote it so the shell does not expand it).',
        })
      files.push(...hits.map((f) => path.resolve(f)).sort())
      continue
    }
    const asPath = path.resolve(input)
    if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
      files.push(asPath)
      continue
    }
    const cases = byName()
    const lower = input.toLowerCase()
    let hits = cases.filter((c) => c.name.toLowerCase() === lower || c.id === input)
    if (hits.length === 0) hits = cases.filter((c) => c.name.toLowerCase().includes(lower))
    if (hits.length === 0) {
      const suggestion = closest(
        input,
        cases.map((c) => c.name),
      )
      const looksLikePath = /[\\/]|\.jsonc?$/i.test(input)
      throw new UsageError(
        looksLikePath
          ? `Case file not found: ${asPath}.`
          : `No case named "${input}" in the suite.`,
        {
          code: looksLikePath ? 'not-found' : 'unknown-case',
          hint: `${suggestion ? `Did you mean "${suggestion}"? ` : ''}Pass a case file path, a glob, or a case name (${cases.length} cases in the suite; vib explain lists them all).`,
          next: ['vib explain --brief'],
        },
      )
    }
    files.push(...hits.map((h) => h.file))
  }
  return [...new Set(files)]
}

export async function explainCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const inputs = positionals(argv)
  const brief = hasFlag(argv, '--brief')
  const suite = loadSuite(flags)
  const files = inputs.length === 0 ? suite.files() : resolveInputs(inputs, suite)
  if (files.length === 0) {
    throw new UsageError(
      `No case files match the suite globs (${suite.options.globs.join(', ')}).`,
      {
        code: 'not-found',
        hint: 'Record one with vib record <tool>, or pass a case file path.',
        next: ['vib record <tool>'],
      },
    )
  }
  const explanations: CaseExplanation[] = []
  const fragments: string[] = []
  for (const file of files) {
    const loaded = loadOne(file, suite)
    // Like vib run: manifest locks and `$ref` fragments under the globs are not cases.
    if (suite.fragments().has(loaded.ref.id)) {
      fragments.push(loaded.ref.id)
      continue
    }
    if (loaded.notACase && inputs.length === 0) continue
    explanations.push(explainLoaded(loaded))
  }
  const ok = explanations.every((e) => e.errors.length === 0)
  const shown = brief
    ? explanations.filter(
        (e) => e.errors.length > 0 || e.flags.length > 0 || (e.warnings ?? []).length > 0,
      )
    : explanations
  const summary = {
    cases: explanations.length,
    errors: explanations.filter((e) => e.errors.length > 0).length,
    flagged: explanations.filter((e) => e.flags.length > 0).length,
  }
  if (flags.json) {
    printJson(pruneEmpty({ ok, summary, cases: shown, fragments }))
    return ok ? 0 : 1
  }
  const c = colors()
  if (shown.length > 0) {
    console.log(
      shown.map((e) => formatExplanation(e, { full: hasFlag(argv, '--full'), brief })).join('\n\n'),
    )
  }
  if (fragments.length > 0) {
    const shownIds = fragments.slice(0, 5).join(', ')
    const more = fragments.length > 5 ? `, +${fragments.length - 5} more` : ''
    console.log(
      c.dim(
        `${shown.length > 0 ? '\n' : ''}info: skipped ${plural(fragments.length, '$ref fragment file')} (not cases): ${shownIds}${more}`,
      ),
    )
  }
  if (explanations.length > 1 || brief) {
    console.log('')
    const line = `${plural(summary.cases, 'case')} · ${plural(summary.errors, 'load error')} · ${summary.flagged} with weak assertions`
    console.log(ok ? c.green(line) : c.red(line))
  }
  return ok ? 0 : 1
}
