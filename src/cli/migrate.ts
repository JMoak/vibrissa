/**
 * `vib migrate`: rewrite v1 config and case files to the v2 shape, in place. Idempotent:
 * a second run changes nothing.
 *
 * Config: `server` → `servers.default` + `defaultServer` (also inside profiles); `$schema`
 * added or pointed at the published `@jmoak/vibrissa` schema (v1 wrote
 * `node_modules/vibrissa/...`, which never resolves).
 * Cases: `$schema` likewise; `expectError.code` aliases renamed to canonical names
 * (`RequestTimedOut` → `RequestTimeout`), and v1 numeric codes that no longer arrive as
 * numbers (-32000 / -32001 are SDK errors in v2, -32002 became -32602 + {uri}) → names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { caseFileHasComments, parseCaseText, resolveCaseFilesSync } from '../cases.js'
import { ConfigError, loadConfigFile } from '../config.js'
import { DEFAULT_SERVER_NAME } from '../defaults.js'
import { canonicalCodeName } from '../session/errors.js'
import type { JsonValue } from '../types.js'
import { UsageError, hasFlag, printJson, schemaRefFor, takeFlag } from './args.js'
import { colors, isObject, plural } from './format.js'
import { manifestCommand } from './manifest.js'
import { mergeCliOptions, parseCommonFlags } from './resolve.js'

type Obj = Record<string, JsonValue>

/** v1 numeric codes → v2 names (see session/errors.ts NUMERIC_CODE_NAMES). */
const LEGACY_NUMERIC_CODES: Record<number, string> = {
  [-32000]: 'ConnectionClosed',
  [-32001]: 'RequestTimeout',
  [-32002]: 'ResourceNotFound',
}

/** `$schema` values written by v1 that never resolve (unscoped package name). */
const STALE_SCHEMA = /(^|\/)node_modules\/vibrissa\/|unpkg\.com\/vibrissa\//

export interface MigrationResult {
  value: Obj
  edits: string[]
}

function schemaEdit(obj: Obj, wanted: string, edits: string[]): Obj {
  const current = obj.$schema
  if (typeof current === 'string' && !STALE_SCHEMA.test(current)) return obj
  const { $schema: _old, ...rest } = obj
  edits.push(
    typeof current === 'string'
      ? `$schema "${current}" → "${wanted}" (v1 path never resolves)`
      : `$schema added: "${wanted}"`,
  )
  return { $schema: wanted, ...rest }
}

/** `server` → `servers.default` (+ `defaultServer`), keeping key order. */
function serverEdit(obj: Obj, at: string, edits: string[], addDefault: boolean): Obj {
  if (obj.server === undefined) return obj
  const out: Obj = {}
  const servers = isObject(obj.servers) ? { ...obj.servers } : undefined
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'server') {
      if (servers && servers[DEFAULT_SERVER_NAME] !== undefined) {
        edits.push(`${at}server removed: servers.default already exists and wins`)
        continue
      }
      if (servers) {
        // Merged below where `servers` sits.
        continue
      }
      out.servers = { [DEFAULT_SERVER_NAME]: value }
      if (addDefault && obj.defaultServer === undefined) out.defaultServer = DEFAULT_SERVER_NAME
      edits.push(
        `${at}server → ${at}servers.default${addDefault && obj.defaultServer === undefined ? ' (+ defaultServer "default")' : ''}`,
      )
      continue
    }
    if (key === 'servers' && servers) {
      if (servers[DEFAULT_SERVER_NAME] === undefined) {
        out.servers = { [DEFAULT_SERVER_NAME]: obj.server, ...servers }
        edits.push(`${at}server → ${at}servers.default`)
      } else out.servers = servers
      continue
    }
    out[key] = value
  }
  return out
}

/** Migrate a config object (the file, or package.json#vibrissa). Pure. */
export function migrateConfig(config: Obj, opts: { schema?: string } = {}): MigrationResult {
  const edits: string[] = []
  let value = serverEdit(config, '', edits, true)
  if (isObject(value.profiles)) {
    const profiles: Obj = {}
    for (const [name, profile] of Object.entries(value.profiles)) {
      profiles[name] = isObject(profile)
        ? serverEdit(profile, `profiles.${name}.`, edits, false)
        : profile
    }
    value = { ...value, profiles }
  }
  if (opts.schema) value = schemaEdit(value, opts.schema, edits)
  return { value, edits }
}

function migrateExpectError(step: Obj, at: string, edits: string[]): Obj {
  const expectError = step.expectError
  if (!isObject(expectError) || expectError.code === undefined) return step
  const code = expectError.code
  let next: JsonValue = code
  if (typeof code === 'string') next = canonicalCodeName(code)
  else if (typeof code === 'number' && LEGACY_NUMERIC_CODES[code] !== undefined)
    next = LEGACY_NUMERIC_CODES[code]
  if (next === code) return step
  edits.push(`${at}expectError.code ${JSON.stringify(code)} → ${JSON.stringify(next)}`)
  return { ...step, expectError: { ...expectError, code: next } }
}

const OP_KEYS = ['tool', 'resource', 'resourceTemplate', 'prompt', 'steps']

export function looksLikeCase(value: unknown): value is Obj {
  return isObject(value) && OP_KEYS.some((key) => value[key] !== undefined)
}

/** Migrate one case object. Pure. */
export function migrateCase(testCase: Obj, opts: { schema?: string } = {}): MigrationResult {
  const edits: string[] = []
  let value = migrateExpectError(testCase, '', edits)
  for (const list of ['steps', 'setup', 'teardown']) {
    const steps = value[list]
    if (!Array.isArray(steps)) continue
    value = {
      ...value,
      [list]: steps.map((step, i) =>
        isObject(step) ? migrateExpectError(step, `${list}[${i}].`, edits) : step,
      ),
    }
  }
  if (opts.schema) value = schemaEdit(value, opts.schema, edits)
  return { value, edits }
}

interface FileChange {
  file: string
  kind: 'config' | 'case'
  edits: string[]
  written: boolean
  /** Why the change was not applied (comments would be lost without --force). */
  blocked?: string
}

function serialize(value: unknown, original: string): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  return original.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

export async function migrateCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const dryRun = hasFlag(argv, '--dry-run')
  const force = hasFlag(argv, '--force')
  const loaded = loadConfigFile(process.cwd(), flags.configPath)
  if (!loaded?.configPath) {
    throw new UsageError(
      'No vibrissa config found (vibrissa.json, vibrissa.jsonc or package.json#vibrissa). Pass --config <path>, or run vib init to create one.',
    )
  }
  const { configPath, rootDir } = loaded
  const changes: FileChange[] = []
  const write = (
    file: string,
    text: string,
    kind: FileChange['kind'],
    edits: string[],
    value: unknown,
  ) => {
    if (edits.length === 0) return
    const change: FileChange = { file, kind, edits, written: false }
    if (caseFileHasComments(text) && !force) {
      change.blocked =
        'the file has comments, which a rewrite would drop; edit by hand or pass --force'
    } else if (!dryRun) {
      fs.writeFileSync(file, serialize(value, text), 'utf8')
      change.written = true
    }
    changes.push(change)
  }

  // Config
  const configText = fs.readFileSync(configPath, 'utf8')
  if (path.basename(configPath) === 'package.json') {
    const pkg = parseCaseText(configText, configPath) as Obj
    const { value, edits } = migrateConfig(isObject(pkg.vibrissa) ? pkg.vibrissa : {})
    write(
      configPath,
      configText,
      'config',
      edits.map((e) => `vibrissa.${e}`),
      { ...pkg, vibrissa: value },
    )
  } else {
    const raw = parseCaseText(configText, configPath)
    if (!isObject(raw))
      throw new ConfigError(`Invalid config at ${configPath}: expected a JSON object.`)
    const { value, edits } = migrateConfig(raw, {
      schema: schemaRefFor(configPath, rootDir, 'vibrissa.schema.json'),
    })
    write(configPath, configText, 'config', edits, value)
  }

  // Cases (globs from the config, or --cases)
  const options = mergeCliOptions(flags, {}, { quiet: true })
  const casesFlag = takeFlag(argv, '--cases')
  const files = resolveCaseFilesSync(
    casesFlag ? [casesFlag] : options.globs,
    casesFlag ? process.cwd() : rootDir,
  )
  let unchanged = 0
  const skipped: Array<{ file: string; reason: string }> = []
  for (const file of files) {
    if (path.resolve(file) === path.resolve(configPath)) continue
    const text = fs.readFileSync(file, 'utf8')
    let parsed: unknown
    try {
      parsed = parseCaseText(text, file)
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!looksLikeCase(parsed)) continue // manifests, $ref fragments, other JSON
    const { value, edits } = migrateCase(parsed, {
      schema: schemaRefFor(file, rootDir, 'case.schema.json'),
    })
    if (edits.length === 0) unchanged++
    write(file, text, 'case', edits, value)
  }

  // Manifest
  let manifest: { requested: boolean; exitCode?: number } = {
    requested: hasFlag(argv, '--manifest'),
  }
  if (manifest.requested && !dryRun) {
    const pass: string[] = []
    for (const flag of [
      '--config',
      '--server',
      '--profile',
      '--protocol',
      '--timeout',
      '--server-cwd',
    ]) {
      const value = takeFlag(argv, flag)
      if (value !== undefined) pass.push(flag, value)
    }
    if (flags.json) pass.push('--json')
    manifest = { requested: true, exitCode: await manifestCommand(['record', ...pass]) }
  }

  const blocked = changes.filter((c) => c.blocked)
  const ok = blocked.length === 0 && (manifest.exitCode ?? 0) === 0
  const hint = dryRun
    ? 'Dry run: nothing was written. Re-run without --dry-run to apply.'
    : manifest.requested
      ? undefined
      : 'Next: vib manifest record (or vib migrate --manifest) to lock the server surface.'
  if (flags.json) {
    printJson({
      ok,
      dryRun,
      config: configPath,
      changes,
      unchanged,
      skipped,
      manifest,
      ...(hint ? { hint } : {}),
    })
    return ok ? 0 : 1
  }
  const c = colors()
  const rel = (file: string) => path.relative(process.cwd(), file).replace(/\\/g, '/') || file
  console.log(c.bold(`vib migrate${dryRun ? ' (dry run)' : ''}`))
  if (changes.length === 0) console.log(c.green('  Everything is already in v2 form.'))
  for (const change of changes) {
    const state = change.blocked
      ? c.yellow('needs manual edit')
      : change.written
        ? c.green('updated')
        : c.dim('would change')
    console.log(`  ${c.bold(rel(change.file))} ${state}`)
    for (const edit of change.edits) console.log(`    · ${edit}`)
    if (change.blocked) console.log(c.yellow(`    ${change.blocked}`))
  }
  for (const s of skipped) console.log(`  ${c.yellow('skipped')} ${rel(s.file)}: ${s.reason}`)
  const changedCount = changes.filter((c) => !c.blocked).length
  console.log('')
  console.log(
    `${plural(changedCount, 'file')} ${dryRun ? 'would change' : 'changed'}, ${plural(unchanged, 'case')} already v2.`,
  )
  if (hint) console.log(c.dim(hint))
  return ok ? 0 : 1
}
