/**
 * Vitest bridge: expand Vibrissa case files into Vitest tests so teams with an existing
 * Vitest suite get one report, gated on the same things as `vib run`.
 *
 * ```ts
 * // tests/mcp.test.ts
 * import { describeCases } from '@jmoak/vibrissa/vitest'
 *
 * await describeCases('tests/integration/**\/*.json')
 * // or, with options (all optional):
 * await describeCases({
 *   config: 'vibrissa.json',   // false = no config file (pass servers/globs yourself)
 *   profile: 'ci',
 *   globs: ['tests/integration/**\/*.json'],
 *   checks: true,              // also run `vib check` (spec sanity + description lint)
 *   lockManifest: true,        // default: verify the manifest lock when one exists
 *   title: 'mcp contract',
 * })
 * ```
 *
 * Registers one `describe` per call with, in order:
 * - `manifest lock (<path>)` per server whose lock file exists (or a failing test when the
 *   lock is missing and `requireManifest` is on), failing on drift with the rendered diff;
 * - `checks (<server>)` when `checks: true` (or config `check: true`), failing on failed checks;
 * - one `it` per case (`it.skip` for `skip: true`), failing with the reason and mismatches.
 *
 * One session per server for the whole block (beforeAll / afterAll). Vitest is an optional
 * peer dependency: pass `{ api: { describe, it, beforeAll, afterAll } }`, enable Vitest
 * `globals`, or let the bridge import `vitest` lazily (hence the `await`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { type LoadedCase, loadCasesSync } from './cases.js'
import { loadConfig } from './config.js'
import { DEFAULT_NORMALIZE, defaultRunOptions } from './defaults.js'
import { runChecks } from './lint/index.js'
import {
  type CapturedManifest,
  DEFAULT_MANIFEST_IGNORE,
  captureManifest,
  diffManifest,
  formatDiff,
  manifestPathFor,
  readManifest,
} from './manifest.js'
import { resolveRootDir, resolveServerConfig } from './paths.js'
import { type RunnerOptions, executeCase } from './runner.js'
import { McpSession } from './session/index.js'
import type { RunOptions, ToolSummary } from './types.js'
import { isHttpServerConfig } from './types.js'

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

/**
 * Options for `describeCases`. Every RunOptions key may be overridden here (servers,
 * normalize, timeoutMs, tags, grep, manifest, manifestIgnore, requireManifest, ...).
 */
export interface DescribeCasesOptions extends Partial<Omit<RunnerOptions, 'globs' | 'checks'>> {
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
  /**
   * `true` adds a `checks (<server>)` test (spec sanity + description lint, like
   * `vib run --check`); an object also sets `allow` / `severity` (and turns checks on).
   */
  checks?: boolean | NonNullable<RunOptions['checks']>
  /** Vitest functions; default: globals, else `import('vitest')`. */
  api?: VitestApi
}

interface Resolved {
  options: RunOptions & Pick<RunnerOptions, 'lockManifest'>
  checks: boolean
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

function resolveOptions(input: DescribeCasesOptions): Resolved {
  const globs =
    input.globs === undefined ? undefined : Array.isArray(input.globs) ? input.globs : [input.globs]
  const { config, profile, cwd, title: _title, api: _api, globs: _globs, checks, ...rest } = input
  const checkConfig = typeof checks === 'object' ? { checks } : {}
  let options: Resolved['options']
  if (config === false) {
    options = {
      ...defaultRunOptions,
      ...rest,
      ...checkConfig,
      normalize: { ...DEFAULT_NORMALIZE, ...(rest.normalize ?? {}) },
      globs: globs ?? defaultRunOptions.globs,
      rootDir: rest.rootDir ?? cwd ?? process.cwd(),
    } as Resolved['options']
  } else {
    const loaded = loadConfig(cwd ?? process.cwd(), {
      ...(config !== undefined ? { configPath: config } : {}),
      ...(profile !== undefined ? { profile } : {}),
      overrides: { ...(globs ? { globs } : {}) },
    })
    options = {
      ...loaded.options,
      ...rest,
      ...checkConfig,
      normalize: { ...loaded.options.normalize, ...(rest.normalize ?? {}) },
    } as Resolved['options']
  }
  return {
    options,
    checks: checks === true || typeof checks === 'object' || options.check === true,
  }
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

interface ServerEntry {
  session: McpSession
  tools: Map<string, ToolSummary>
  captured?: CapturedManifest
}

function register(api: VitestApi, resolved: Resolved, title: string): void {
  const { options } = resolved
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
  const sessions = new Map<string, ServerEntry>()
  const servers = [...new Set(cases.filter((c) => !c.error && !c.skip).map((c) => c.ref.server))]
  const timeout = Math.max(30000, options.timeoutMs * 4)
  const lockOn = options.lockManifest !== false
  const lockFor = (server: string) => manifestPathFor({ ...options, rootDir }, server)

  const entryFor = (server: string): ServerEntry => {
    const entry = sessions.get(server)
    if (!entry)
      throw new Error(`No session for server "${server}" (it failed to start in beforeAll).`)
    return entry
  }

  api.describe(title, () => {
    api.beforeAll(async () => {
      for (const warning of warnings) console.warn(`vibrissa: ${warning}`)
      for (const server of servers) {
        const session = await McpSession.start(resolveServerConfig(options, server), {
          timeoutMs: options.timeoutMs,
          stderr: 'capture',
        })
        const needsManifest = resolved.checks || (lockOn && fs.existsSync(lockFor(server)))
        const captured = needsManifest
          ? await captureManifest(session, { toolsListSamples: resolved.checks ? 2 : 1 })
          : undefined
        const tools = new Map(
          (captured?.toolsListSamples[0] ?? (await session.listTools())).map((tool) => [
            tool.name,
            tool,
          ]),
        )
        sessions.set(server, { session, tools, captured })
      }
    }, timeout)

    api.afterAll(async () => {
      for (const { session } of sessions.values()) await session.close()
      sessions.clear()
    })

    if (lockOn) {
      for (const server of servers) {
        const file = lockFor(server)
        const shown = path.relative(rootDir, file).replace(/\\/g, '/') || file
        const record = `vib manifest record${server === options.defaultServer ? '' : ` --server ${server}`}`
        if (fs.existsSync(file)) {
          api.it(`manifest lock (${shown})`, () => {
            const captured = entryFor(server).captured
            if (!captured) throw new Error(`The live manifest of "${server}" was not captured.`)
            const diff = diffManifest(readManifest(file), captured.manifest, {
              ignore: options.manifestIgnore ?? DEFAULT_MANIFEST_IGNORE,
            })
            if (!diff.identical) {
              throw new Error(
                `${formatDiff(diff)}\nReview the change, then accept it with "${record}" (or vib run --update-manifest).`,
              )
            }
          })
        } else if (options.requireManifest) {
          api.it(`manifest lock (${shown})`, () => {
            throw new Error(
              `No manifest lock at ${shown}, and requireManifest is on. Record it with "${record}", review it, and commit it.`,
            )
          })
        }
      }
    }

    if (resolved.checks) {
      for (const server of servers) {
        api.it(`checks (${server})`, () => {
          const entry = entryFor(server)
          if (!entry.captured) throw new Error(`The live manifest of "${server}" was not captured.`)
          const config = resolveServerConfig(options, server)
          const failed = runChecks(
            {
              ...entry.captured.manifest,
              transport: isHttpServerConfig(config) ? 'http' : 'stdio',
              stdoutNoise: entry.session.stdoutNoise,
            },
            {
              toolsListSamples: entry.captured.toolsListSamples,
              allow: options.checks?.allow,
              severity: options.checks?.severity,
            },
          ).filter((outcome) => outcome.status === 'failed')
          if (failed.length > 0) {
            throw new Error(
              [
                `${failed.length} check(s) failed on "${server}":`,
                ...failed.map(
                  (o) => `  - ${o.id}: ${o.title}${o.detail ? `\n      ${o.detail}` : ''}`,
                ),
                'Skip a reviewed finding with "checks": { "allow": ["<id>:<subject>"] } in vibrissa.json.',
              ].join('\n'),
            )
          }
        })
      }
    }

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
          const entry = entryFor(loaded.ref.server)
          const execution = await executeCase(loaded.data, {
            session: entry.session,
            normalize: options.normalize,
            timeoutMs: options.timeoutMs,
            budgetMs: options.budgetMs,
            tools: entry.tools,
            update: 'off',
            // `vib run --update` is not reachable from here: keep it out of failure messages.
            updateHint: false,
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
 * Register Vitest tests for a Vibrissa suite: manifest lock, optional checks, one test per
 * case. Accepts globs or DescribeCasesOptions. Resolves once the tests are registered;
 * `await` it at the top of the test file unless you pass `api` or use Vitest globals.
 */
export function describeCases(
  target: string | string[] | DescribeCasesOptions = {},
  extra: DescribeCasesOptions = {},
): Promise<void> {
  const input: DescribeCasesOptions =
    typeof target === 'string' || Array.isArray(target)
      ? { ...extra, globs: target }
      : { ...target, ...extra }
  const resolved = resolveOptions(input)
  const title = input.title ?? 'vibrissa'
  const api = input.api ?? globalApi()
  if (api) {
    register(api, resolved, title)
    return Promise.resolve()
  }
  return importVitest().then((imported) => register(imported, resolved, title))
}
