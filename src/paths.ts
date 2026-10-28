import path from 'node:path'
import { DEFAULT_MANIFEST_PATH } from './defaults.js'
import type { RunOptions, ServerConfig } from './types.js'
import { isStdioServerConfig } from './types.js'

export function resolveRootDir(options: Pick<RunOptions, 'rootDir'>): string {
  return options.rootDir ? path.resolve(options.rootDir) : process.cwd()
}

/** Resolve a path from the config (globs, manifest, reports) against rootDir. */
export function resolveFromRoot(options: Pick<RunOptions, 'rootDir'>, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(resolveRootDir(options), value)
}

/** Which server a case runs against: the case's `server`, else `defaultServer`. */
export function resolveServerName(
  options: Pick<RunOptions, 'servers' | 'defaultServer'>,
  name?: string,
): string {
  const selected = name ?? options.defaultServer
  if (!Object.hasOwn(options.servers, selected)) {
    const have = Object.keys(options.servers)
    throw new Error(
      `Unknown server at ${name !== undefined ? 'case.server' : 'defaultServer'}: "${selected}" is not in servers (have: ${have.join(', ') || 'none'}). Add it to "servers" in vibrissa.json or fix the name.`,
    )
  }
  return selected
}

/**
 * The ServerConfig to start for `name` (default: defaultServer), with a stdio `cwd`
 * resolved against rootDir. HTTP servers are returned unchanged.
 */
export function resolveServerConfig(
  options: Pick<RunOptions, 'servers' | 'defaultServer' | 'rootDir'>,
  name?: string,
): ServerConfig {
  const server = options.servers[resolveServerName(options, name)]
  if (!isStdioServerConfig(server)) return { ...server }
  const cwd = server.cwd ?? '.'
  return { ...server, cwd: path.isAbsolute(cwd) ? cwd : path.resolve(resolveRootDir(options), cwd) }
}

/** Every configured server, resolved (keyed by name). */
export function resolveAllServers(
  options: Pick<RunOptions, 'servers' | 'defaultServer' | 'rootDir'>,
): Record<string, ServerConfig> {
  return Object.fromEntries(
    Object.keys(options.servers).map((name) => [name, resolveServerConfig(options, name)]),
  )
}

export function resolveManifestPath(options: Pick<RunOptions, 'manifest' | 'rootDir'>): string {
  return resolveFromRoot(options, options.manifest ?? DEFAULT_MANIFEST_PATH)
}
