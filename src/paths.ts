import path from 'node:path'
import type { RunCasesOptions, ServerConfig } from './types.js'

export function resolveRootDir(options: Pick<RunCasesOptions, 'rootDir'>): string {
  return options.rootDir ? path.resolve(options.rootDir) : process.cwd()
}

export function resolveServerConfig(options: RunCasesOptions): ServerConfig {
  const rootDir = resolveRootDir(options)
  const cwd = options.server.cwd ?? '.'
  return {
    ...options.server,
    cwd: path.isAbsolute(cwd) ? cwd : path.resolve(rootDir, cwd),
  }
}
