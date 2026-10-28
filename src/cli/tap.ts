import path from 'node:path'
import { runTapProxy } from '../tap/proxy.js'
import { isHttpServerConfig } from '../types.js'
import {
  UsageError,
  hasFlag,
  parseEnvPairs,
  resolvePathFromCwd,
  splitAtDoubleDash,
  takeAllFlags,
  takeFlag,
} from './args.js'
import { openSessionOptions, parseCommonFlags } from './resolve.js'

/** `reports/tap/2026-10-28T12-30-00-000Z.ndjson` under the current directory. */
export function defaultTapPath(now = new Date()): string {
  return path.join(
    process.cwd(),
    'reports',
    'tap',
    `${now.toISOString().replace(/[:.]/g, '-')}.ndjson`,
  )
}

/**
 * `vib tap [--out file] -- <server cmd...>`: stdout is the protocol channel, so this
 * command never prints to it; everything else goes to stderr.
 */
export async function tapCommand(argv: string[]): Promise<number> {
  const [own, server] = splitAtDoubleDash(argv)
  const outFlag = takeFlag(own, '--out')
  const out = outFlag ? resolvePathFromCwd(outFlag) : defaultTapPath()
  const quiet = hasFlag(own, '--quiet')
  let cmd: string
  let args: string[]
  let cwd: string | undefined
  let env: Record<string, string> = parseEnvPairs(takeAllFlags(own, '--env'))
  if (server.length > 0) {
    cmd = server[0]
    args = server.slice(1)
    const serverCwd = takeFlag(own, '--server-cwd')
    cwd = serverCwd ? resolvePathFromCwd(serverCwd) : undefined
  } else {
    // No `-- <cmd>`: proxy the configured (stdio) server. Config warnings go to stderr.
    const { server: configured, serverName } = openSessionOptions(parseCommonFlags(own))
    if (isHttpServerConfig(configured)) {
      throw new UsageError(
        `vib tap proxies stdio servers; "${serverName}" is an HTTP server (${configured.url}). Pass the stdio command after --: vib tap -- node dist/index.js`,
      )
    }
    cmd = configured.cmd
    args = configured.args ?? []
    cwd = configured.cwd
    env = { ...(configured.env ?? {}), ...env }
  }
  const result = await runTapProxy({ cmd, args, cwd, env, out, quiet, forwardSignals: true })
  return result.exitCode
}
