import path from 'node:path'
import { resolveOptions } from '../config.js'
import { resolveRootDir, resolveServerConfig } from '../paths.js'
import type { RunCasesOptions, ServerConfig } from '../types.js'
import {
  hasFlag,
  parseEnvPairs,
  resolvePathFromCwd,
  splitCommandLine,
  takeAllFlags,
  takeFlag,
} from './args.js'

export interface CommonCliFlags {
  configPath?: string
  serverCmd?: string
  serverArgs?: string[]
  serverCwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  json?: boolean
}

export function parseCommonFlags(argv: string[]): CommonCliFlags {
  const configPath = takeFlag(argv, '--config')
  const serverRaw = takeFlag(argv, '--server')
  const serverCwd = takeFlag(argv, '--server-cwd')
  const timeoutRaw = takeFlag(argv, '--timeout')
  const env = parseEnvPairs(takeAllFlags(argv, '--env'))

  let serverCmd: string | undefined
  let serverArgs: string[] | undefined
  if (serverRaw !== undefined) {
    const split = splitCommandLine(serverRaw)
    serverCmd = split.cmd
    serverArgs = split.args
  }

  return {
    configPath,
    serverCmd,
    serverArgs,
    serverCwd,
    env: Object.keys(env).length > 0 ? env : undefined,
    timeoutMs:
      timeoutRaw !== undefined && Number.isFinite(Number(timeoutRaw))
        ? Number(timeoutRaw)
        : undefined,
    json: hasFlag(argv, '--json'),
  }
}

export function mergeCliOptions(
  flags: CommonCliFlags,
  overrides: Partial<RunCasesOptions> = {},
): RunCasesOptions {
  const resolved = resolveOptions(process.cwd(), flags.configPath)
  const serverCwd = flags.serverCwd
    ? path.isAbsolute(flags.serverCwd)
      ? flags.serverCwd
      : resolvePathFromCwd(flags.serverCwd)
    : undefined

  return {
    ...resolved,
    ...overrides,
    server: {
      ...resolved.server,
      ...(overrides.server ?? {}),
      ...(flags.serverCmd ? { cmd: flags.serverCmd } : {}),
      ...(flags.serverArgs ? { args: flags.serverArgs } : {}),
      ...(serverCwd ? { cwd: serverCwd } : {}),
      env: {
        ...(resolved.server.env ?? {}),
        ...(overrides.server?.env ?? {}),
        ...(flags.env ?? {}),
      },
    },
    ...(typeof flags.timeoutMs === 'number' ? { timeoutMs: flags.timeoutMs } : {}),
  }
}

export function openSessionOptions(flags: CommonCliFlags): {
  options: RunCasesOptions
  server: ServerConfig
  rootDir: string
  timeoutMs: number
} {
  const options = mergeCliOptions(flags)
  return {
    options,
    server: resolveServerConfig(options),
    rootDir: resolveRootDir(options),
    timeoutMs: options.timeoutMs,
  }
}
