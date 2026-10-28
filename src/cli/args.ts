import fs from 'node:fs'
import path from 'node:path'
import type { JsonValue } from '../types.js'

export interface CliErrorDetails {
  /** Stable machine code: `unknown-option`, `unknown-command`, `unknown-tool`, `invalid-argument`, ... */
  code?: string
  /** What to do next (one sentence). Appended to the human message. */
  hint?: string
  /** Suggested next commands, for agents. */
  next?: string[]
}

/**
 * A command-line mistake (bad flag, missing argument, unknown tool). The dispatcher maps
 * it to exit code 2. `message` is the full human text (detail + hint); `detail` and `hint`
 * are kept apart for the `--json` error envelope.
 */
export class UsageError extends Error {
  readonly code: string
  readonly detail: string
  readonly hint?: string
  readonly next?: string[]

  constructor(message: string, details: CliErrorDetails = {}) {
    super(details.hint ? `${message} ${details.hint}` : message)
    this.name = 'UsageError'
    this.code = details.code ?? 'usage'
    this.detail = message
    if (details.hint) this.hint = details.hint
    if (details.next) this.next = details.next
  }
}

/**
 * Flags that take a value, across every command. Used to find positional arguments
 * (`vib call --config x echo` → `echo`) and to split `--flag=value`.
 */
export const VALUE_FLAGS = new Set([
  '--config',
  '--server',
  '--server-cwd',
  '--timeout',
  '--env',
  '--profile',
  '--protocol',
  '--args',
  '--arg',
  '--respond',
  '--respond-key',
  '--await-timeout',
  '--out',
  '--out-dir',
  '--name',
  '--tag',
  '--resource',
  '--resource-template',
  '--prompt',
  '--from-tap',
  '--select',
  '--runs',
  '--seed',
  '--strategy',
  '--budget',
  '--id',
  '--allow',
  '--dir',
  '--cases',
  '--from-claude-config',
  '--reporter',
  '--display',
  '--url',
  // vib run / diff (parsed by their own modules; listed so positionals are found correctly)
  '--exclude-tag',
  '--grep',
  '--shard',
  '--repeat',
  '--concurrency',
  '--baseline',
  '--against',
])

export function takeFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

export function takeAllFlags(argv: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) {
      values.push(argv[i + 1])
      i++
    }
  }
  return values
}

/** Like takeFlag, but the flag's value may be omitted (`--from-claude-config` alone → ''). */
export function takeOptionalFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) return ''
  return next
}

/** A numeric flag value; throws a UsageError when it is not a number. */
export function takeNumberFlag(
  argv: string[],
  name: string,
  { min = 0, integer = false }: { min?: number; integer?: boolean } = {},
): number | undefined {
  const raw = takeFlag(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new UsageError(
      `Invalid ${name} value "${raw}": expected ${integer ? 'an integer' : 'a number'} >= ${min}. Example: ${name} ${Math.max(min, integer ? 10 : 1000)}.`,
    )
  }
  return value
}

/** Split argv at a bare `--`: [own args, passthrough args]. */
export function splitAtDoubleDash(argv: string[]): [string[], string[]] {
  const dash = argv.indexOf('--')
  if (dash === -1) return [argv, []]
  return [argv.slice(0, dash), argv.slice(dash + 1)]
}

/**
 * Non-flag arguments, in order. Tokens following a value-taking flag are skipped; any
 * other token starting with `--` is treated as a boolean flag. Stops at a bare `--`.
 */
export function positionals(
  argv: string[],
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') break
    if (token.startsWith('--')) {
      if (valueFlags.has(token)) i++
      continue
    }
    if (token === '-h') continue
    out.push(token)
  }
  return out
}

/** `--runs=5` → `--runs 5` for known value flags. Everything after `--` is left alone. */
export function normalizeArgv(
  argv: string[],
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      out.push(...argv.slice(i))
      break
    }
    const eq = token.indexOf('=')
    if (token.startsWith('--') && eq > 2 && valueFlags.has(token.slice(0, eq))) {
      out.push(token.slice(0, eq), token.slice(eq + 1))
      continue
    }
    out.push(token)
  }
  return out
}

/** Every `--flag` token before a bare `--` (values of value flags are skipped). */
export function flagTokens(
  argv: string[],
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') break
    if (!token.startsWith('--')) continue
    out.push(token)
    if (valueFlags.has(token)) i++
  }
  return out
}

/**
 * Throw a UsageError (code `unknown-option`, with a did-you-mean) for the first `--flag`
 * in `argv` (before a bare `--`) that is not in `accepted`. `--help`, `--json` and
 * `--compact` are always accepted.
 */
export function assertKnownFlags(
  argv: string[],
  accepted: Iterable<string>,
  command: string,
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): void {
  const known = new Set([...accepted, '--help', '--json', '--compact'])
  for (const flag of flagTokens(argv, valueFlags)) {
    if (known.has(flag)) continue
    throw unknownOptionError(flag, known, command)
  }
}

export function unknownOptionError(
  flag: string,
  accepted: Iterable<string>,
  command: string,
): UsageError {
  const suggestion = closest(flag, [...accepted])
  return new UsageError(`Unknown option ${flag} for vib ${command}.`, {
    code: 'unknown-option',
    hint: `${suggestion ? `Did you mean ${suggestion}? ` : ''}Run vib ${command} --help for its options.`,
    next: [`vib ${command} --help`],
  })
}

/**
 * A UsageError for a name the server does not list (tool, prompt, resource): did-you-mean
 * plus the available names.
 */
export function unknownNameError(
  kind: string,
  name: string,
  available: string[],
  listCommand?: string,
): UsageError {
  const suggestion = closest(name, available)
  const shown = available.slice(0, 12)
  const more =
    available.length > shown.length ? `, … (${available.length - shown.length} more)` : ''
  const have = available.length
    ? `Available: ${shown.join(', ')}${more}.`
    : `The server lists no ${kind}s.`
  return new UsageError(`Unknown ${kind} "${name}" on this server.`, {
    code: `unknown-${kind.replace(/\s+/g, '-')}`,
    hint: `${suggestion ? `Did you mean "${suggestion}"? ` : ''}${have} Pass --expect-missing to send it anyway.`,
    ...(listCommand ? { next: [listCommand] } : {}),
  })
}

/** Closest candidate by edit distance (for "did you mean" hints), or undefined. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const score = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best === undefined) return undefined
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

export function splitCommandLine(input: string): { cmd: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  if (tokens.length === 0) throw new Error('Empty --server command')
  return { cmd: tokens[0], args: tokens.slice(1) }
}

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0)
      throw new UsageError(`Invalid --env value "${pair}" (expected KEY=VALUE).`, {
        code: 'invalid-argument',
        hint: 'Example: --env API_TOKEN=abc123.',
      })
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

export function parseArgValue(raw: string): JsonValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']')) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw) as JsonValue
    } catch {
      return raw
    }
  }
  return raw
}

export function parseToolArgs(argv: string[]): Record<string, JsonValue> {
  const json = takeFlag(argv, '--args')
  const pairs = takeAllFlags(argv, '--arg')
  let args: Record<string, JsonValue> = {}
  if (json !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new UsageError(
        `Invalid --args JSON: ${err instanceof Error ? err.message : String(err)}.`,
        {
          code: 'invalid-argument',
          hint: `Quote the object in single quotes: --args '{"text": "hi"}'.`,
        },
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UsageError('--args must be a JSON object.', {
        code: 'invalid-argument',
        hint: `Example: --args '{"text": "hi"}'.`,
      })
    }
    args = { ...(parsed as Record<string, JsonValue>) }
  }
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0)
      throw new UsageError(`Invalid --arg value "${pair}" (expected key=value).`, {
        code: 'invalid-argument',
        hint: 'Example: --arg text=hello (true, 3, null and JSON values are parsed).',
      })
    args[pair.slice(0, eq)] = parseArgValue(pair.slice(eq + 1))
  }
  return args
}

/** Prompt arguments are strings on the wire: stringify anything --arg parsed as JSON. */
export function stringifyArgs(args: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}

function parseJsonObject(raw: string, flag: string, example: string): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new UsageError(
      `Invalid ${flag} JSON: ${err instanceof Error ? err.message : String(err)}. Example: ${flag} '${example}'.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`Invalid ${flag}: expected a JSON object. Example: ${flag} '${example}'.`)
  }
  return parsed as Record<string, JsonValue>
}

const RESPOND_EXAMPLE = '{"elicitation/create": {"action": "accept", "content": {"confirm": true}}}'

/**
 * Scripted MRTR answers from `--respond '{"method": result}'` (repeatable, merged) and
 * `--respond-key method=<json>` (repeatable). Undefined when neither was given.
 */
export function parseRespond(argv: string[]): Record<string, JsonValue> | undefined {
  const maps = takeAllFlags(argv, '--respond')
  const pairs = takeAllFlags(argv, '--respond-key')
  if (maps.length === 0 && pairs.length === 0) return undefined
  const out: Record<string, JsonValue> = {}
  for (const raw of maps) Object.assign(out, parseJsonObject(raw, '--respond', RESPOND_EXAMPLE))
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new UsageError(
        `Invalid --respond-key value "${pair}": expected method=<json>. Example: --respond-key 'elicitation/create={"action":"accept"}'.`,
      )
    }
    const raw = pair.slice(eq + 1)
    let value: JsonValue
    try {
      value = JSON.parse(raw) as JsonValue
    } catch (err) {
      throw new UsageError(
        `Invalid --respond-key JSON for ${pair.slice(0, eq)}: ${err instanceof Error ? err.message : String(err)}. Quote the JSON in single quotes.`,
      )
    }
    out[pair.slice(0, eq)] = value
  }
  return out
}

export function resolvePathFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

let jsonStyle: 'auto' | 'compact' | 'pretty' = 'auto'

/** `--compact` forces single-line JSON; `auto` = pretty on a TTY, compact otherwise. */
export function setJsonStyle(style: 'auto' | 'compact' | 'pretty'): void {
  jsonStyle = style
}

/** Print one JSON document on stdout (compact when piped or --compact, pretty on a TTY). */
export function printJson(value: unknown): void {
  const compact = jsonStyle === 'compact' || (jsonStyle === 'auto' && !process.stdout.isTTY)
  console.log(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2))
}

/** Drop empty arrays and undefined values (recursively) for terse --json payloads. */
export function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => pruneEmpty(v)) as T
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || (Array.isArray(child) && child.length === 0)) continue
    out[key] = pruneEmpty(child)
  }
  return out as T
}

/** Short `k=v` rendering of arguments for case names: `text=hello uppercase=true`. */
export function argsSummary(args: Record<string, JsonValue> | undefined, max = 48): string {
  const parts = Object.entries(args ?? {}).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}=${text.length > 24 ? `${text.slice(0, 23)}…` : text}`
  })
  const joined = parts.join(' ')
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined
}

/**
 * Where new case files go: the static directory of the first positive glob
 * (`cases/**` + `/*.json` → `cases`) and the file suffix it expects (`.json`, `.case.json`).
 */
export function suiteLayout(globs: string[]): { dir: string; suffix: string } {
  const glob = (globs.find((g) => !g.startsWith('!')) ?? 'tests/integration/**/*.json').replace(
    /\\/g,
    '/',
  )
  const segments = glob.split('/')
  const dir: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}()!]/.test(segment)) break
    dir.push(segment)
  }
  const last = segments[segments.length - 1]
  const star = last.lastIndexOf('*')
  const tail = star === -1 ? '' : last.slice(star + 1)
  const suffix = /^\.[\w.-]+$/.test(tail) ? tail : '.json'
  return { dir: dir.join('/') || '.', suffix }
}

/** `file` itself, or `name-2.json`, `name-3.json`, ... when it already exists. */
export function uniquePath(file: string, suffix = path.extname(file)): string {
  if (!fs.existsSync(file)) return file
  const base = file.endsWith(suffix) ? file.slice(0, -suffix.length) : file
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${suffix}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

export function slugify(input: string, max = 48): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

/**
 * `$schema` value for a file written under `rootDir`: a relative path to the installed
 * `@jmoak/vibrissa` schema when it exists, else the published unpkg URL.
 */
export function schemaRefFor(
  fromFile: string,
  rootDir: string,
  schemaName: 'case.schema.json' | 'vibrissa.schema.json',
): string {
  const local = path.join(rootDir, 'node_modules', '@jmoak', 'vibrissa', 'schema', schemaName)
  if (fs.existsSync(local)) {
    return path.relative(path.dirname(fromFile), local).replace(/\\/g, '/')
  }
  return `https://unpkg.com/@jmoak/vibrissa/schema/${schemaName}`
}

/** Write `value` as pretty JSON with a trailing newline, creating parent directories. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
