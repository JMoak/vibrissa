/**
 * Config loading (v2).
 *
 * Sources, lowest to highest precedence: built-in defaults → config file → profile → CLI.
 * Config file: vibrissa.json / vibrissa.jsonc (JSONC: comments + trailing commas) or
 * package.json#vibrissa. `server` (singular, v1) is sugar for `servers.default`.
 * `${ENV_VAR}` (and `${ENV_VAR:-fallback}`) are interpolated in every string of the file;
 * `$${...}` escapes a literal `${...}`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { splitCommandLine } from './cli/args.js'
import { DEFAULT_NORMALIZE, DEFAULT_SERVER_NAME, defaultRunOptions } from './defaults.js'
import type {
  NormalizeConfig,
  ProtocolMode,
  RunOptions,
  ServerConfig,
  ShardSpec,
  Step,
  SuiteHooks,
} from './types.js'
import { isHttpServerConfig, isStdioServerConfig } from './types.js'

/** The on-disk config shape. Every key is optional; v1 files are valid. */
export interface ConfigFile {
  $schema?: string
  /** v1 sugar for `servers.default`. */
  server?: ServerConfig
  servers?: Record<string, ServerConfig>
  defaultServer?: string
  globs?: string[] | string
  manifest?: string
  normalize?: NormalizeConfig
  timeoutMs?: number
  budgetMs?: number
  failFast?: boolean
  allowEmpty?: boolean
  reporters?: string[] | string
  tags?: string[]
  excludeTags?: string[]
  grep?: string
  repeat?: number
  shard?: ShardSpec | string
  concurrency?: number
  update?: boolean
  trace?: boolean
  check?: boolean
  baseline?: string
  hooks?: SuiteHooks
  checks?: ChecksOptions
  manifestIgnore?: string[] | string
  outDir?: string
  profiles?: Record<string, ConfigFile>
}

/** `checks` config: skipped check ids and per-check severity overrides. */
export type ChecksOptions = NonNullable<RunOptions['checks']>

/** Programmatic / CLI overrides: the top layer. */
export interface ConfigOverrides
  extends Partial<Omit<RunOptions, 'servers' | 'rootDir' | 'normalize' | 'defaultServer'>> {
  servers?: Record<string, ServerConfig>
  defaultServer?: string
  normalize?: NormalizeConfig
  /**
   * CLI `--server`: a name from `servers` (selects it), an http(s) URL, or a command line
   * (`"node dist/index.js"`) replacing the selected server's command.
   */
  server?: string
  /** CLI `--server-cwd` (absolute) for the selected stdio server. */
  serverCwd?: string
  /** CLI `--env KEY=VALUE`: merged into every stdio server's env. */
  env?: Record<string, string>
  /** CLI `--protocol`: applied to every server. */
  protocol?: ProtocolMode
}

export interface ResolveOptionsInput {
  /** Explicit config file (absolute or relative to cwd). */
  configPath?: string
  /** Name under `profiles` to merge over the base config. */
  profile?: string
  overrides?: ConfigOverrides
  /** Environment for `${VAR}` interpolation. Default `process.env`. */
  env?: Record<string, string | undefined>
}

export interface ResolvedConfig {
  options: RunOptions
  /** Non-fatal problems (unknown keys, unset env vars). Print them; do not ignore them. */
  warnings: string[]
  configPath?: string
  profile?: string
}

export interface LoadedConfig {
  config: ConfigFile
  rootDir: string
  configPath?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

export function stripJsonComments(input: string): string {
  let result = ''
  let inString = false
  let stringQuote: string | null = null
  let escaped = false
  let inBlockComment = false
  let inLineComment = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ''

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (!inString && char === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (!inString && char === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }

    if (inString) {
      result += char
      if (!escaped && char === stringQuote) {
        inString = false
        stringQuote = null
      }
      escaped = !escaped && char === '\\'
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true
      stringQuote = char
      result += char
      escaped = false
      continue
    }

    result += char
  }

  return result
}

/** Remove trailing commas before `}` / `]` (outside strings). Run after stripJsonComments. */
export function stripTrailingCommas(input: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (inString) {
      result += char
      if (!escaped && char === '"') inString = false
      escaped = !escaped && char === '\\'
      continue
    }
    if (char === '"') {
      inString = true
      escaped = false
      result += char
      continue
    }
    if (char === ',') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j++
      if (input[j] === '}' || input[j] === ']') continue
    }
    result += char
  }
  return result
}

export function parseJsonc(raw: string, where: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw)))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ConfigError(
      `Invalid JSON at ${where}: ${reason}. Fix the syntax (comments and trailing commas are allowed).`,
    )
  }
}

// ---------------------------------------------------------------------------
// File discovery (v1-compatible API)
// ---------------------------------------------------------------------------

export function loadConfigObjectFromPath(configPath: string): ConfigFile {
  const raw = fs.readFileSync(configPath, 'utf8')
  const json = parseJsonc(raw, configPath)
  if (path.basename(configPath) === 'package.json') {
    const section = (json as { vibrissa?: unknown })?.vibrissa
    return (isPlainObject(section) ? section : {}) as ConfigFile
  }
  if (!isPlainObject(json)) {
    throw new ConfigError(
      `Invalid config at ${configPath}: expected a JSON object, got ${describe(json)}.`,
    )
  }
  return json as ConfigFile
}

export function loadConfigFile(cwd: string, explicitPath?: string): LoadedConfig | undefined {
  if (explicitPath) {
    const abs = path.isAbsolute(explicitPath) ? explicitPath : path.join(cwd, explicitPath)
    if (!fs.existsSync(abs)) {
      throw new ConfigError(
        `Config not found: ${abs}. Check --config, or run "vib init" to create vibrissa.json.`,
      )
    }
    return { config: loadConfigObjectFromPath(abs), rootDir: path.dirname(abs), configPath: abs }
  }

  for (const name of ['vibrissa.json', 'vibrissa.jsonc']) {
    const file = path.join(cwd, name)
    if (fs.existsSync(file)) {
      return {
        config: loadConfigObjectFromPath(file),
        rootDir: path.dirname(file),
        configPath: file,
      }
    }
  }

  const pkgPath = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = parseJsonc(fs.readFileSync(pkgPath, 'utf8'), pkgPath) as { vibrissa?: unknown }
    if (isPlainObject(pkg?.vibrissa)) {
      return {
        config: pkg.vibrissa as ConfigFile,
        rootDir: path.dirname(pkgPath),
        configPath: pkgPath,
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// ${ENV} interpolation
// ---------------------------------------------------------------------------

const ENV_PATTERN = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Interpolate `${VAR}` / `${VAR:-fallback}` in every string (keys untouched). */
export function interpolateEnv<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
  warnings: string[] = [],
  at = '',
): T {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (match, escaped: string, name: string, fallback?: string) => {
      if (escaped) return match.slice(1)
      const resolved = env[name]
      if (resolved !== undefined && resolved !== '') return resolved
      if (fallback !== undefined) return fallback
      warnings.push(
        `Unset environment variable at ${at || '<root>'}: \${${name}} is not set (using ""). Export it, or write \${${name}:-default}.`,
      )
      return ''
    }) as T
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, env, warnings, `${at}[${i}]`)) as T
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolateEnv(item, env, warnings, at ? `${at}.${key}` : key)
    }
    return out as T
  }
  return value
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an object'
  return JSON.stringify(value)
}

/** Closest known key within edit distance 2 (case-insensitive), for did-you-mean hints. */
function suggestKey(key: string, known: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  const lower = key.toLowerCase()
  for (const candidate of known) {
    const score = editDistance(lower, candidate.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore <= 2 ? best : undefined
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

class Validator {
  /** Every problem found so far; loadConfig throws them together (all at once, not just the first). */
  readonly errors: string[] = []

  constructor(
    readonly source: string,
    readonly warnings: string[],
  ) {}

  /** Run one validation; a ConfigError is recorded instead of aborting the whole file. */
  attempt<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err
      this.errors.push(err.message)
      return undefined
    }
  }

  /** An unknown key is an error (it would silently fall back to a default). */
  unknownKey(
    at: string,
    key: string,
    known: Iterable<string>,
    docs = 'schema/vibrissa.schema.json',
  ): void {
    const near = suggestKey(key, known)
    this.errors.push(
      `Unknown config key at ${at ? `${at}.` : ''}${key} (${this.source}):${near ? ` did you mean "${near}"?` : ''} Check spelling against ${docs}.`,
    )
  }

  /** Throw every recorded problem as one ConfigError. */
  throwIfErrors(): void {
    if (this.errors.length === 0) return
    if (this.errors.length === 1) throw new ConfigError(this.errors[0])
    throw new ConfigError(
      `Invalid config (${this.source}): ${this.errors.length} problems:\n${this.errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }

  fail(
    at: string,
    expected: string,
    got: unknown,
    hint = 'See schema/vibrissa.schema.json.',
  ): never {
    throw new ConfigError(
      `Invalid config at ${at} (${this.source}): expected ${expected}, got ${describe(got)}. ${hint}`,
    )
  }

  string(value: unknown, at: string): string {
    if (typeof value !== 'string') this.fail(at, 'a string', value)
    return value
  }

  boolean(value: unknown, at: string): boolean {
    if (typeof value !== 'boolean') this.fail(at, 'true or false', value)
    return value
  }

  number(value: unknown, at: string, { min = 0, integer = false } = {}): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      (integer && !Number.isInteger(value))
    ) {
      this.fail(at, `${integer ? 'an integer' : 'a number'} >= ${min}`, value)
    }
    return value
  }

  strings(value: unknown, at: string, { allowSingle = false } = {}): string[] {
    if (allowSingle && typeof value === 'string') return [value]
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      this.fail(at, 'an array of strings', value)
    }
    return value as string[]
  }

  stringRecord(value: unknown, at: string): Record<string, string> {
    if (!isPlainObject(value)) this.fail(at, 'an object of string values', value)
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') out[key] = item
      else if (typeof item === 'number' || typeof item === 'boolean') {
        this.warnings.push(
          `Non-string value at ${at}.${key} (${this.source}): converted ${item} to "${item}". Quote it.`,
        )
        out[key] = String(item)
      } else this.fail(`${at}.${key}`, 'a string', item)
    }
    return out
  }

  protocol(value: unknown, at: string): ProtocolMode {
    return parseProtocolMode(value, (got) =>
      this.fail(
        at,
        '"auto", "legacy", "modern", or { "pin": "<revision>" }',
        got,
        'Use "auto" unless you need to force an era.',
      ),
    )
  }

  server(value: unknown, at: string): ServerConfig {
    if (!isPlainObject(value))
      this.fail(at, 'a server object ({ "cmd": ... } or { "url": ... })', value)
    const hasCmd = value.cmd !== undefined
    const hasUrl = value.url !== undefined
    if (hasCmd === hasUrl) {
      this.fail(
        at,
        'exactly one of "cmd" (stdio) or "url" (Streamable HTTP)',
        value,
        'Example: { "cmd": "node", "args": ["dist/index.js"] }.',
      )
    }
    const common: Record<string, unknown> = {}
    if (value.protocol !== undefined)
      common.protocol = this.protocol(value.protocol, `${at}.protocol`)
    if (value.spawnTimeoutMs !== undefined) {
      common.spawnTimeoutMs = this.number(value.spawnTimeoutMs, `${at}.spawnTimeoutMs`)
    }
    const known = new Set([
      'cmd',
      'args',
      'cwd',
      'env',
      'url',
      'headers',
      'protocol',
      'spawnTimeoutMs',
    ])
    for (const key of Object.keys(value)) {
      if (!known.has(key)) this.unknownKey(at, key, known)
    }
    if (hasUrl) {
      return {
        url: this.string(value.url, `${at}.url`),
        ...(value.headers !== undefined
          ? { headers: this.stringRecord(value.headers, `${at}.headers`) }
          : {}),
        ...common,
      } as ServerConfig
    }
    return {
      cmd: this.string(value.cmd, `${at}.cmd`),
      ...(value.args !== undefined ? { args: this.strings(value.args, `${at}.args`) } : {}),
      ...(value.cwd !== undefined ? { cwd: this.string(value.cwd, `${at}.cwd`) } : {}),
      ...(value.env !== undefined ? { env: this.stringRecord(value.env, `${at}.env`) } : {}),
      ...common,
    } as ServerConfig
  }

  /** Partial server entry for profiles (may omit cmd/url to patch fields). */
  serverPatch(value: unknown, at: string): Partial<ServerConfig> {
    if (isPlainObject(value) && value.cmd === undefined && value.url === undefined) {
      const known = ['args', 'cwd', 'env', 'headers', 'protocol', 'spawnTimeoutMs', 'cmd', 'url']
      for (const key of Object.keys(value)) {
        if (!known.includes(key)) this.unknownKey(at, key, known)
      }
      const out: Record<string, unknown> = {}
      if (value.args !== undefined) out.args = this.strings(value.args, `${at}.args`)
      if (value.cwd !== undefined) out.cwd = this.string(value.cwd, `${at}.cwd`)
      if (value.env !== undefined) out.env = this.stringRecord(value.env, `${at}.env`)
      if (value.headers !== undefined)
        out.headers = this.stringRecord(value.headers, `${at}.headers`)
      if (value.protocol !== undefined)
        out.protocol = this.protocol(value.protocol, `${at}.protocol`)
      if (value.spawnTimeoutMs !== undefined)
        out.spawnTimeoutMs = this.number(value.spawnTimeoutMs, `${at}.spawnTimeoutMs`)
      return out as Partial<ServerConfig>
    }
    return this.server(value, at)
  }

  shard(value: unknown, at: string): ShardSpec {
    const parsed = parseShard(value)
    if (!parsed)
      this.fail(at, '"<index>/<total>" (e.g. "1/4") or { "index": 1, "total": 4 }', value)
    return parsed
  }

  normalize(value: unknown, at: string): NormalizeConfig {
    if (!isPlainObject(value)) this.fail(at, 'an object ({ stripMeta, dropKeys, ttlMs })', value)
    const out: NormalizeConfig = {}
    if (value.stripMeta !== undefined)
      out.stripMeta = this.strings(value.stripMeta, `${at}.stripMeta`)
    if (value.dropKeys !== undefined) out.dropKeys = this.strings(value.dropKeys, `${at}.dropKeys`)
    if (value.ttlMs !== undefined) {
      if (value.ttlMs !== 'keep' && value.ttlMs !== 'ignore')
        this.fail(`${at}.ttlMs`, '"keep" or "ignore"', value.ttlMs)
      out.ttlMs = value.ttlMs
    }
    return out
  }

  hooks(value: unknown, at: string): SuiteHooks {
    if (!isPlainObject(value)) this.fail(at, 'an object ({ setup: [...], teardown: [...] })', value)
    const out: SuiteHooks = {}
    for (const key of ['setup', 'teardown'] as const) {
      if (value[key] === undefined) continue
      const steps = value[key]
      if (!Array.isArray(steps) || steps.some((s) => !isPlainObject(s)))
        this.fail(`${at}.${key}`, 'an array of step objects', steps)
      out[key] = steps as Step[]
    }
    return out
  }

  checks(value: unknown, at: string): ChecksOptions {
    if (!isPlainObject(value)) {
      this.fail(
        at,
        'an object ({ allow: [...], severity: { "<check id>": "failed" | "warned" } })',
        value,
      )
    }
    const out: ChecksOptions = {}
    for (const key of Object.keys(value)) {
      if (key !== 'allow' && key !== 'severity') this.unknownKey(at, key, ['allow', 'severity'])
    }
    if (value.allow !== undefined)
      out.allow = this.strings(value.allow, `${at}.allow`, { allowSingle: true })
    if (value.severity !== undefined) {
      if (!isPlainObject(value.severity))
        this.fail(`${at}.severity`, 'an object of check id → "failed" | "warned"', value.severity)
      const severity: Record<string, 'failed' | 'warned'> = {}
      for (const [id, level] of Object.entries(value.severity)) {
        if (level !== 'failed' && level !== 'warned')
          this.fail(`${at}.severity.${id}`, '"failed" or "warned"', level)
        severity[id] = level
      }
      out.severity = severity
    }
    return out
  }
}

/** Merge checks layers: `allow` lists accumulate (deduped), `severity` merges by check id. */
function mergeChecks(layers: Array<ChecksOptions | undefined>): ChecksOptions {
  const allow: string[] = []
  const severity: Record<string, 'failed' | 'warned'> = {}
  let hasAllow = false
  let hasSeverity = false
  for (const layer of layers) {
    if (!layer) continue
    if (layer.allow) {
      hasAllow = true
      for (const id of layer.allow) if (!allow.includes(id)) allow.push(id)
    }
    if (layer.severity) {
      hasSeverity = true
      Object.assign(severity, layer.severity)
    }
  }
  return { ...(hasAllow ? { allow } : {}), ...(hasSeverity ? { severity } : {}) }
}

/** Parse "auto" | "legacy" | "modern" | "<YYYY-MM-DD>" | { pin }. */
export function parseProtocolMode(value: unknown, onError?: (got: unknown) => never): ProtocolMode {
  if (value === 'auto' || value === 'legacy' || value === 'modern') return value
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { pin: value }
  if (isPlainObject(value) && typeof value.pin === 'string' && Object.keys(value).length === 1) {
    return { pin: value.pin }
  }
  if (onError) return onError(value)
  throw new ConfigError(
    `Invalid protocol: expected "auto", "legacy", "modern", or a revision like "2026-07-28", got ${describe(value)}.`,
  )
}

/** Parse "1/4" or { index, total } (1-based). Undefined when invalid. */
export function parseShard(value: unknown): ShardSpec | undefined {
  let index: unknown
  let total: unknown
  if (typeof value === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(value.trim())
    if (!match) return undefined
    index = Number(match[1])
    total = Number(match[2])
  } else if (isPlainObject(value)) {
    index = value.index
    total = value.total
  } else return undefined
  if (
    typeof index !== 'number' ||
    typeof total !== 'number' ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 1 ||
    index > total
  ) {
    return undefined
  }
  return { index, total }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface Layer extends Partial<Omit<RunOptions, 'servers' | 'rootDir'>> {
  servers?: Record<string, Partial<ServerConfig>>
}

const SCALAR_KEYS = new Set([
  'manifest',
  'manifestIgnore',
  'requireManifest',
  'outDir',
  'timeoutMs',
  'budgetMs',
  'failFast',
  'allowEmpty',
  'grep',
  'repeat',
  'concurrency',
  'update',
  'trace',
  'check',
  'baseline',
])

const IGNORED_KEYS = new Set(['$schema', 'display', 'profiles'])

/** Every top-level config key (for did-you-mean on unknown keys). */
export const CONFIG_KEYS: readonly string[] = [
  '$schema',
  'server',
  'servers',
  'defaultServer',
  'globs',
  'manifest',
  'manifestIgnore',
  'requireManifest',
  'outDir',
  'normalize',
  'timeoutMs',
  'budgetMs',
  'failFast',
  'allowEmpty',
  'reporters',
  'tags',
  'excludeTags',
  'grep',
  'repeat',
  'shard',
  'concurrency',
  'update',
  'trace',
  'check',
  'checks',
  'baseline',
  'hooks',
  'profiles',
]

/** Validate a file/profile object into a Layer. `patch` allows partial server entries (profiles). */
function toLayer(
  raw: Record<string, unknown>,
  v: Validator,
  prefix: string,
  patch: boolean,
): Layer {
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key)
  const layer: Layer = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || IGNORED_KEYS.has(key)) continue
    v.attempt(() => assignKey(layer, key, value, at, v, prefix))
  }

  const servers: Record<string, Partial<ServerConfig>> = {}
  if (raw.server !== undefined) {
    const entry = v.attempt(() =>
      patch ? v.serverPatch(raw.server, at('server')) : v.server(raw.server, at('server')),
    )
    if (entry) servers[DEFAULT_SERVER_NAME] = entry
  }
  if (raw.servers !== undefined) {
    if (!isPlainObject(raw.servers)) {
      v.attempt(() => v.fail(at('servers'), 'an object of named servers', raw.servers))
    } else {
      for (const [name, entry] of Object.entries(raw.servers)) {
        if (raw.server !== undefined && name === DEFAULT_SERVER_NAME) {
          v.warnings.push(
            `Both server and servers.default are set (${v.source}): servers.default wins.`,
          )
        }
        const parsed = v.attempt(() =>
          patch
            ? v.serverPatch(entry, at(`servers.${name}`))
            : v.server(entry, at(`servers.${name}`)),
        )
        if (parsed) servers[name] = parsed
      }
    }
  }
  if (Object.keys(servers).length > 0) layer.servers = servers
  return layer
}

function assignKey(
  layer: Layer,
  key: string,
  value: unknown,
  at: (key: string) => string,
  v: Validator,
  prefix: string,
): void {
  switch (key) {
    case 'server':
    case 'servers':
      break
    case 'defaultServer':
      layer.defaultServer = v.string(value, at(key))
      break
    case 'globs':
      layer.globs = v.strings(value, at(key), { allowSingle: true })
      break
    case 'reporters':
      layer.reporters = v.strings(value, at(key), { allowSingle: true })
      break
    case 'tags':
    case 'excludeTags':
      layer[key] = v.strings(value, at(key), { allowSingle: true })
      break
    case 'manifest':
    case 'grep':
    case 'baseline':
      layer[key] = v.string(value, at(key))
      break
    case 'timeoutMs':
    case 'budgetMs':
      layer[key] = v.number(value, at(key))
      break
    case 'repeat':
    case 'concurrency':
      layer[key] = v.number(value, at(key), { min: 1, integer: true })
      break
    case 'failFast':
    case 'allowEmpty':
    case 'update':
    case 'trace':
    case 'check':
      layer[key] = v.boolean(value, at(key))
      break
    case 'shard':
      layer.shard = v.shard(value, at(key))
      break
    case 'normalize':
      layer.normalize = v.normalize(value, at(key))
      break
    case 'hooks':
      layer.hooks = v.hooks(value, at(key))
      break
    case 'checks':
      layer.checks = v.checks(value, at(key))
      break
    case 'manifestIgnore':
      layer.manifestIgnore = v.strings(value, at(key), { allowSingle: true })
      break
    case 'outDir':
      layer.outDir = v.string(value, at(key))
      break
    case 'requireManifest':
      layer.requireManifest = v.boolean(value, at(key))
      break
    default:
      v.unknownKey(prefix, key, CONFIG_KEYS)
  }
}

function mergeServerEntry(
  base: ServerConfig | undefined,
  patch: Partial<ServerConfig>,
): ServerConfig {
  const replaces =
    (patch as { cmd?: unknown }).cmd !== undefined || (patch as { url?: unknown }).url !== undefined
  if (replaces || !base) return patch as ServerConfig
  // Patch fields only apply to the matching transport (no env on HTTP, no headers on stdio).
  const ignored = isHttpServerConfig(base) ? ['args', 'cwd', 'env'] : ['headers']
  const merged = Object.fromEntries(
    Object.entries({ ...base, ...patch }).filter(([key]) => !ignored.includes(key)),
  )
  return merged as unknown as ServerConfig
}

function inferDefaultServer(servers: Record<string, ServerConfig>): string | undefined {
  const names = Object.keys(servers)
  if (names.includes(DEFAULT_SERVER_NAME)) return DEFAULT_SERVER_NAME
  if (names.length === 1) return names[0]
  return undefined
}

function applyServerOverride(
  servers: Record<string, ServerConfig>,
  selected: string,
  override: string,
): { servers: Record<string, ServerConfig>; selected: string } {
  if (Object.hasOwn(servers, override)) return { servers, selected: override }
  const existing = servers[selected]
  const common = {
    ...(existing?.protocol !== undefined ? { protocol: existing.protocol } : {}),
    ...(existing?.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: existing.spawnTimeoutMs } : {}),
  }
  if (/^https?:\/\//i.test(override.trim())) {
    return { servers: { ...servers, [selected]: { url: override.trim(), ...common } }, selected }
  }
  const { cmd, args } = splitCommandLine(override)
  const next: ServerConfig =
    existing && isStdioServerConfig(existing)
      ? { ...existing, cmd, args }
      : { cmd, args, ...common }
  return { servers: { ...servers, [selected]: next }, selected }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Load + merge config. Prefer this in CLIs so `warnings` can be printed. */
export function loadConfig(cwd: string, input: ResolveOptionsInput = {}): ResolvedConfig {
  const env = input.env ?? process.env
  const warnings: string[] = []
  const loaded = loadConfigFile(cwd, input.configPath)
  const source = loaded?.configPath ? path.basename(loaded.configPath) : 'config'
  const { profiles: rawProfiles, ...base } = (loaded?.config ?? {}) as Record<string, unknown>
  const file = interpolateEnv(base, env, warnings)
  const validator = new Validator(source, warnings)
  const fileLayer = toLayer(file, validator, '', false)

  let profileLayer: Layer = {}
  if (input.profile !== undefined) {
    const profiles = isPlainObject(rawProfiles) ? rawProfiles : {}
    const profile = isPlainObject(profiles[input.profile])
      ? interpolateEnv(
          profiles[input.profile] as Record<string, unknown>,
          env,
          warnings,
          `profiles.${input.profile}`,
        )
      : undefined
    if (!isPlainObject(profile)) {
      const have = Object.keys(profiles)
      throw new ConfigError(
        `Unknown profile at --profile: "${input.profile}" is not defined in profiles (${have.length ? `have: ${have.join(', ')}` : 'none defined'}). Add it under "profiles" in ${source}.`,
      )
    }
    profileLayer = toLayer(profile, validator, `profiles.${input.profile}`, true)
  }

  // Servers: the file replaces the built-in default; profiles patch entries by name.
  let servers: Record<string, ServerConfig> = fileLayer.servers
    ? (fileLayer.servers as Record<string, ServerConfig>)
    : { ...defaultRunOptions.servers }

  // Every profile is validated (typos in a profile you are not using today still fail), and
  // a profile may only patch servers that exist (or define them fully with cmd / url).
  if (rawProfiles !== undefined && !isPlainObject(rawProfiles)) {
    validator.attempt(() => validator.fail('profiles', 'an object of named profiles', rawProfiles))
  }
  for (const [name, raw] of Object.entries(isPlainObject(rawProfiles) ? rawProfiles : {})) {
    let layer: Layer
    if (name === input.profile) layer = profileLayer
    else if (!isPlainObject(raw)) {
      validator.attempt(() => validator.fail(`profiles.${name}`, 'a profile object', raw))
      continue
    } else layer = toLayer(interpolateEnv(raw, env, []), validator, `profiles.${name}`, true)
    for (const [server, entry] of Object.entries(layer.servers ?? {})) {
      const defines =
        (entry as { cmd?: unknown }).cmd !== undefined ||
        (entry as { url?: unknown }).url !== undefined
      if (!defines && !Object.hasOwn(servers, server)) {
        validator.errors.push(
          `Invalid config at profiles.${name}.servers.${server} (${source}): profile ${name} patches unknown server '${server}'; servers are: ${Object.keys(servers).join(', ') || 'none'}. Fix the name, or give it "cmd" / "url" to define a new server.`,
        )
      }
    }
  }
  validator.throwIfErrors()

  for (const [name, entry] of Object.entries(profileLayer.servers ?? {})) {
    servers = { ...servers, [name]: mergeServerEntry(servers[name], entry) }
  }
  const overrides = input.overrides ?? {}
  if (overrides.servers) servers = { ...servers, ...overrides.servers }

  let selected =
    overrides.defaultServer ??
    profileLayer.defaultServer ??
    fileLayer.defaultServer ??
    inferDefaultServer(servers)

  if (overrides.server !== undefined && overrides.server.trim() !== '') {
    const applied = applyServerOverride(servers, selected ?? DEFAULT_SERVER_NAME, overrides.server)
    servers = applied.servers
    selected = applied.selected
  }

  if (selected === undefined) {
    throw new ConfigError(
      `Missing defaultServer at ${source}: servers has ${Object.keys(servers).join(', ')} and none is named "default". Set "defaultServer", or pass --server <name>.`,
    )
  }
  if (!Object.hasOwn(servers, selected)) {
    throw new ConfigError(
      `Unknown server at defaultServer: "${selected}" is not in servers (have: ${Object.keys(servers).join(', ') || 'none'}). Fix defaultServer in ${source}, or pass --server <name|"cmd args">.`,
    )
  }

  if (overrides.serverCwd !== undefined) {
    const current = servers[selected]
    if (isStdioServerConfig(current))
      servers = { ...servers, [selected]: { ...current, cwd: overrides.serverCwd } }
    else warnings.push(`--server-cwd ignored: server "${selected}" is an HTTP server.`)
  }
  if (overrides.env !== undefined || overrides.protocol !== undefined) {
    const next: Record<string, ServerConfig> = {}
    for (const [name, entry] of Object.entries(servers)) {
      let updated: ServerConfig = entry
      if (overrides.env && isStdioServerConfig(entry)) {
        updated = { ...entry, env: { ...(entry.env ?? {}), ...overrides.env } }
      }
      if (overrides.protocol !== undefined) updated = { ...updated, protocol: overrides.protocol }
      next[name] = updated
    }
    servers = next
  }

  const scalars: Partial<RunOptions> = {}
  for (const layer of [fileLayer, profileLayer, overrides as Layer]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      if (
        SCALAR_KEYS.has(key) ||
        ['globs', 'reporters', 'tags', 'excludeTags', 'shard', 'hooks'].includes(key)
      ) {
        ;(scalars as Record<string, unknown>)[key] = value
      }
    }
  }

  const options: RunOptions = {
    ...defaultRunOptions,
    ...scalars,
    servers,
    defaultServer: selected,
    manifestIgnore: [...(scalars.manifestIgnore ?? defaultRunOptions.manifestIgnore ?? [])],
    checks: mergeChecks([fileLayer.checks, profileLayer.checks, overrides.checks]),
    normalize: {
      ...DEFAULT_NORMALIZE,
      ...(fileLayer.normalize ?? {}),
      ...(profileLayer.normalize ?? {}),
      ...(overrides.normalize ?? {}),
    },
    rootDir: loaded?.rootDir ?? path.resolve(cwd),
  }
  return { options, warnings, configPath: loaded?.configPath, profile: input.profile }
}

/**
 * Resolve RunOptions: defaults → file → profile → overrides.
 * The second argument may be a config path (v1 signature).
 */
export function resolveOptions(cwd: string, input: ResolveOptionsInput | string = {}): RunOptions {
  const normalized: ResolveOptionsInput = typeof input === 'string' ? { configPath: input } : input
  return loadConfig(cwd, normalized).options
}
