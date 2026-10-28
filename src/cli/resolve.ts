import path from 'node:path'
import { type ConfigOverrides, loadConfig, loadConfigFile, parseProtocolMode } from '../config.js'
import { resolveRootDir, resolveServerConfig } from '../paths.js'
import { McpSession, type SessionOptions, SessionStartError } from '../session/index.js'
import type { ProtocolMode, RunOptions, ServerConfig } from '../types.js'
import { isHttpServerConfig } from '../types.js'
import {
  UsageError,
  hasFlag,
  parseEnvPairs,
  resolvePathFromCwd,
  splitCommandLine,
  takeAllFlags,
  takeFlag,
} from './args.js'

export interface CommonCliFlags {
  configPath?: string
  /** Raw `--server` value: a server name from config, an http(s) URL, or a command line. */
  server?: string
  /** `--server` split as a command line (meaningful when it is not a server name or URL). */
  serverCmd?: string
  serverArgs?: string[]
  serverCwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  json?: boolean
  profile?: string
  protocol?: ProtocolMode
}

export function parseCommonFlags(argv: string[]): CommonCliFlags {
  const configPath = takeFlag(argv, '--config')
  const serverRaw = takeFlag(argv, '--server')
  const serverCwd = takeFlag(argv, '--server-cwd')
  const timeoutRaw = takeFlag(argv, '--timeout')
  const profile = takeFlag(argv, '--profile')
  const protocolRaw = takeFlag(argv, '--protocol')
  const env = parseEnvPairs(takeAllFlags(argv, '--env'))

  let serverCmd: string | undefined
  let serverArgs: string[] | undefined
  if (serverRaw !== undefined && serverRaw.trim() === '') {
    throw new UsageError('Empty --server value.', {
      code: 'invalid-argument',
      hint: 'Pass a server name from vibrissa.json, a command line ("node dist/index.js") or a URL.',
    })
  }
  if (serverRaw !== undefined && !/^https?:\/\//i.test(serverRaw.trim())) {
    const split = splitCommandLine(serverRaw)
    serverCmd = split.cmd
    serverArgs = split.args
  }

  let protocol: ProtocolMode | undefined
  if (protocolRaw !== undefined) {
    protocol = parseProtocolMode(protocolRaw, () => {
      throw new UsageError(`Invalid --protocol value "${protocolRaw}".`, {
        code: 'invalid-argument',
        hint: 'Use auto, legacy, modern, or a revision like 2026-07-28.',
      })
    })
  }
  let timeoutMs: number | undefined
  if (timeoutRaw !== undefined) {
    timeoutMs = Number(timeoutRaw)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UsageError(`Invalid --timeout value "${timeoutRaw}".`, {
        code: 'invalid-argument',
        hint: 'Pass milliseconds, e.g. --timeout 5000.',
      })
    }
  }

  return {
    configPath,
    server: serverRaw,
    serverCmd,
    serverArgs,
    serverCwd,
    env: Object.keys(env).length > 0 ? env : undefined,
    timeoutMs,
    json: hasFlag(argv, '--json'),
    profile,
    protocol,
  }
}

/** Translate parsed CLI flags into the config loader's override layer. */
export function cliOverrides(flags: CommonCliFlags, extra: ConfigOverrides = {}): ConfigOverrides {
  const serverCwd = flags.serverCwd
    ? path.isAbsolute(flags.serverCwd)
      ? flags.serverCwd
      : resolvePathFromCwd(flags.serverCwd)
    : undefined
  return {
    ...extra,
    ...(flags.server !== undefined ? { server: flags.server } : {}),
    ...(serverCwd ? { serverCwd } : {}),
    ...(flags.env || extra.env ? { env: { ...(extra.env ?? {}), ...(flags.env ?? {}) } } : {}),
    ...(typeof flags.timeoutMs === 'number' ? { timeoutMs: flags.timeoutMs } : {}),
    ...(flags.protocol !== undefined ? { protocol: flags.protocol } : {}),
  }
}

/**
 * Resolve RunOptions for a CLI command: defaults → config file → --profile → flags/overrides.
 * Config warnings are printed to stderr unless `quiet`.
 */
export function mergeCliOptions(
  flags: CommonCliFlags,
  overrides: ConfigOverrides = {},
  { quiet = false }: { quiet?: boolean } = {},
): RunOptions {
  const { options, warnings } = loadConfig(process.cwd(), {
    configPath: flags.configPath,
    profile: flags.profile,
    overrides: cliOverrides(flags, overrides),
  })
  if (!quiet) for (const warning of warnings) console.warn(`warning: ${warning}`)
  return options
}

/** True when no config file is found for these flags (built-in defaults apply). */
export function usingDefaultConfig(flags: CommonCliFlags): boolean {
  if (flags.configPath) return false
  try {
    return loadConfigFile(process.cwd()) === undefined
  } catch {
    return false
  }
}

export const NO_CONFIG_HINT =
  "No vibrissa.json found; using the default server command `node dist/index.js`. Run vib init --server '<cmd>' to configure yours (or pass --server)."

export function openSessionOptions(flags: CommonCliFlags): {
  options: RunOptions
  server: ServerConfig
  serverName: string
  rootDir: string
  timeoutMs: number
  /** No config file and no --server: the built-in `node dist/index.js` is used. */
  defaulted: boolean
} {
  const options = mergeCliOptions(flags)
  const defaulted = flags.server === undefined && usingDefaultConfig(flags)
  if (defaulted && !flags.json) console.warn(`note: ${NO_CONFIG_HINT}`)
  return {
    defaulted,
    options,
    server: resolveServerConfig(options),
    serverName: options.defaultServer,
    rootDir: resolveRootDir(options),
    timeoutMs: options.timeoutMs,
  }
}

/** Human label for a server: `stdio: node dist/index.js` / `http: https://...`. */
export function describeServerTarget(server: ServerConfig): string {
  if (isHttpServerConfig(server)) return `http: ${server.url}`
  return `stdio: ${[server.cmd, ...(server.args ?? [])].join(' ')}`
}

export interface StartedSession {
  session: McpSession
  options: RunOptions
  server: ServerConfig
  serverName: string
  rootDir: string
  timeoutMs: number
}

/**
 * Resolve config + flags and connect. Server stderr is captured (kept off the console,
 * shown in start errors) unless `stderr` is overridden.
 */
export async function startSession(
  flags: CommonCliFlags,
  extra: Partial<SessionOptions> = {},
  resolved: ReturnType<typeof openSessionOptions> = openSessionOptions(flags),
): Promise<StartedSession> {
  let session: McpSession
  try {
    session = await McpSession.start(resolved.server, {
      timeoutMs: resolved.timeoutMs,
      stderr: 'capture',
      ...extra,
    })
  } catch (err) {
    // The note was already printed unless --json suppressed it; say it once.
    if (resolved.defaulted && flags.json && err instanceof SessionStartError) {
      throw new SessionStartError(`${err.message} ${NO_CONFIG_HINT}`, err.code, err.stderr, {
        cause: err,
      })
    }
    throw err
  }
  return { session, ...resolved }
}

/**
 * The server name `vib record` should write into a case: `--server X` when X is a server
 * configured in vibrissa.json other than its defaultServer; undefined otherwise (no flag,
 * the default server, or a command line / URL, which a case cannot name).
 */
export function caseServerName(flags: CommonCliFlags): string | undefined {
  if (flags.server === undefined) return undefined
  const base = mergeCliOptions(
    { ...flags, server: undefined, serverCmd: undefined, serverArgs: undefined },
    {},
    { quiet: true },
  )
  if (!Object.hasOwn(base.servers, flags.server)) return undefined
  return flags.server === base.defaultServer ? undefined : flags.server
}

export interface ChecksConfig {
  allow?: string[]
  severity?: Record<string, 'failed' | 'warned'>
}

/**
 * The `checks` section (allow-list + severity overrides for `vib check` / `--check`), as
 * resolved by config.ts (file → profile, allow lists accumulated). Pass already-resolved
 * `options` to avoid loading the config twice.
 */
export function loadChecksConfig(flags: CommonCliFlags, options?: RunOptions): ChecksConfig {
  const resolved = options ?? mergeCliOptions(flags, {}, { quiet: true })
  if (resolved.checks !== undefined) return resolved.checks
  return rawChecksConfig(flags)
}

/** Fallback for a config loader that does not resolve `checks`: read the raw file. */
function rawChecksConfig(flags: CommonCliFlags): ChecksConfig {
  const loaded = loadConfigFile(process.cwd(), flags.configPath)
  if (!loaded) return {}
  const raw = loaded.config as Record<string, unknown>
  const base = pickChecks(raw.checks)
  const profiles = raw.profiles as Record<string, Record<string, unknown>> | undefined
  const profile =
    flags.profile !== undefined ? pickChecks(profiles?.[flags.profile]?.checks) : undefined
  return {
    ...(base.allow || profile?.allow
      ? { allow: [...(base.allow ?? []), ...(profile?.allow ?? [])] }
      : {}),
    ...(base.severity || profile?.severity
      ? { severity: { ...(base.severity ?? {}), ...(profile?.severity ?? {}) } }
      : {}),
  }
}

function pickChecks(value: unknown): ChecksConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const out: ChecksConfig = {}
  if (Array.isArray(record.allow)) {
    out.allow = record.allow.filter((v): v is string => typeof v === 'string')
  }
  if (typeof record.severity === 'object' && record.severity !== null) {
    const severity: Record<string, 'failed' | 'warned'> = {}
    for (const [id, level] of Object.entries(record.severity as Record<string, unknown>)) {
      if (level === 'failed' || level === 'warned') severity[id] = level
    }
    out.severity = severity
  }
  return out
}
