/**
 * Vitest bridge: expand Vibrissa case files into Vitest tests so teams with an existing
 * Vitest suite get one report.
 *
 * ```ts
 * // tests/mcp.test.ts
 * import { describeCases } from '@jmoak/vibrissa/vitest'
 * await describeCases('tests/integration/**\/*.json')
 * ```
 *
 * One `describe` per call, one session per server for the whole block (beforeAll /
 * afterAll), one `it` per case (`it.skip` for `skip: true`). Vitest is an optional peer
 * dependency: pass `{ api: { describe, it, beforeAll, afterAll } }`, enable Vitest
 * `globals`, or let the bridge import `vitest` lazily (hence the `await`).
 */
import { type LoadedCase, loadCasesSync } from './cases.js'
import { loadConfig } from './config.js'
import { DEFAULT_NORMALIZE, defaultRunOptions } from './defaults.js'
import { resolveRootDir, resolveServerConfig } from './paths.js'
import { type RunnerOptions, executeCase } from './runner.js'
import { McpSession } from './session/index.js'
import type { RunOptions, ToolSummary } from './types.js'

type TestFn = () => void | Promise<void>

/** The slice of the Vitest API the bridge uses. */
export interface VitestApi {
  describe: (name: string, fn: () => void) => void
  it: ((name: string, fn: TestFn, timeout?: number) => void) & {
    skip?: (name: string, fn: TestFn) => void
  }
  beforeAll: (fn: TestFn, timeout?: number) => void
  afterAll: (fn: TestFn, timeout?: number) => void
}

export interface DescribeCasesOptions extends Partial<Omit<RunnerOptions, 'globs'>> {
  /** Case globs (relative to the config's directory). Default: config `globs`. */
  globs?: string | string[]
  /** Config file to load; `false` skips config loading. Default: vibrissa.json from `cwd`. */
  config?: string | false
  /** Profile to merge over the config. */
  profile?: string
  /** Where to look for the config. Default process.cwd(). */
  cwd?: string
  /** `describe` title. Default "vibrissa". */
  title?: string
  /** Vitest functions; default: globals, else `import('vitest')`. */
  api?: VitestApi
}

function globalApi(): VitestApi | undefined {
  const g = globalThis as Record<string, unknown>
  if (
    typeof g.describe === 'function' &&
    typeof g.it === 'function' &&
    typeof g.beforeAll === 'function' &&
    typeof g.afterAll === 'function'
  ) {
    return g as unknown as VitestApi
  }
  return undefined
}

async function importVitest(): Promise<VitestApi> {
  try {
    // A literal specifier so bundlers and Vitest's module runner resolve it; vitest stays
    // external (optional peer) in the published build.
    return (await import('vitest')) as unknown as VitestApi
  } catch (err) {
    throw new Error(
      `describeCases needs Vitest: could not import "vitest" (${err instanceof Error ? err.message : String(err)}). Install it (npm i -D vitest), enable globals, or pass { api: { describe, it, beforeAll, afterAll } }.`,
    )
  }
}

function resolveOptions(input: DescribeCasesOptions): RunOptions {
  const globs =
    input.globs === undefined ? undefined : Array.isArray(input.globs) ? input.globs : [input.globs]
  const { config, profile, cwd, title: _title, api: _api, globs: _globs, ...rest } = input
  if (config === false) {
    return {
      ...defaultRunOptions,
      ...rest,
      normalize: { ...DEFAULT_NORMALIZE, ...(rest.normalize ?? {}) },
      globs: globs ?? defaultRunOptions.globs,
      rootDir: rest.rootDir ?? cwd ?? process.cwd(),
    } as RunOptions
  }
  const loaded = loadConfig(cwd ?? process.cwd(), {
    ...(config !== undefined ? { configPath: config } : {}),
    ...(profile !== undefined ? { profile } : {}),
    overrides: { ...(globs ? { globs } : {}) },
  })
  return {
    ...loaded.options,
    ...rest,
    normalize: { ...loaded.options.normalize, ...(rest.normalize ?? {}) },
  } as RunOptions
}

function failureMessage(
  loaded: LoadedCase,
  outcome: { reason?: string; mismatches?: Array<{ path: string; message: string }> },
): string {
  const lines = [outcome.reason ?? 'Case failed.']
  for (const m of (outcome.mismatches ?? []).slice(0, 10)) lines.push(`  - ${m.path}: ${m.message}`)
  lines.push(`  (${loaded.ref.id})`)
  return lines.join('\n')
}

function register(api: VitestApi, options: RunOptions, title: string): void {
  const rootDir = resolveRootDir(options)
  const { cases, warnings } = loadCasesSync({
    rootDir,
    globs: options.globs,
    defaultServer: options.defaultServer,
    servers: Object.keys(options.servers),
    hooks: options.hooks,
    manifest: options.manifest,
    tags: options.tags,
    excludeTags: options.excludeTags,
    grep: options.grep,
    shard: options.shard,
  })
  const sessions = new Map<string, { session: McpSession; tools: Map<string, ToolSummary> }>()
  const servers = [...new Set(cases.filter((c) => !c.error && !c.skip).map((c) => c.ref.server))]
  const timeout = Math.max(30000, options.timeoutMs * 4)

  api.describe(title, () => {
    api.beforeAll(async () => {
      for (const warning of warnings) console.warn(`vibrissa: ${warning}`)
      for (const server of servers) {
        const session = await McpSession.start(resolveServerConfig(options, server), {
          timeoutMs: options.timeoutMs,
          stderr: 'capture',
        })
        const tools = new Map((await session.listTools()).map((tool) => [tool.name, tool]))
        sessions.set(server, { session, tools })
      }
    }, timeout)

    api.afterAll(async () => {
      for (const { session } of sessions.values()) await session.close()
      sessions.clear()
    })

    if (cases.length === 0 && !options.allowEmpty) {
      api.it('has cases', () => {
        throw new Error(
          `No test cases matched globs: ${options.globs.join(', ')} (from ${rootDir}). Check the globs passed to describeCases.`,
        )
      })
    }

    for (const loaded of cases) {
      const name = loaded.ref.name
      if (loaded.skip) {
        if (api.it.skip) api.it.skip(name, () => {})
        continue
      }
      api.it(
        name,
        async () => {
          if (loaded.error || !loaded.data) throw new Error(loaded.error ?? 'Case failed to load.')
          const entry = sessions.get(loaded.ref.server)
          if (!entry) throw new Error(`No session for server "${loaded.ref.server}".`)
          const execution = await executeCase(loaded.data, {
            session: entry.session,
            normalize: options.normalize,
            timeoutMs: options.timeoutMs,
            budgetMs: options.budgetMs,
            tools: entry.tools,
            update: 'off',
            caseId: loaded.ref.id,
          })
          if (execution.outcome.status === 'failed') {
            throw new Error(failureMessage(loaded, execution.outcome))
          }
        },
        timeout,
      )
    }
  })
}

/**
 * Register one Vitest test per case. Accepts globs or options. Resolves once the tests are
 * registered; `await` it at the top of the test file unless you pass `api` or use globals.
 */
export function describeCases(
  target: string | string[] | DescribeCasesOptions = {},
  extra: DescribeCasesOptions = {},
): Promise<void> {
  const input: DescribeCasesOptions =
    typeof target === 'string' || Array.isArray(target)
      ? { ...extra, globs: target }
      : { ...target, ...extra }
  const options = resolveOptions(input)
  const title = input.title ?? 'vibrissa'
  const api = input.api ?? globalApi()
  if (api) {
    register(api, options, title)
    return Promise.resolve()
  }
  return importVitest().then((imported) => register(imported, options, title))
}
