import { diffLinesUnified } from 'jest-diff'
import { type LoadedCase, loadCases } from '../cases.js'
import { ConfigError, type ConfigOverrides, loadConfig } from '../config.js'
import {
  type Manifest,
  type ManifestDiff,
  captureManifest,
  diffManifest,
  formatDiff,
  jsonEqual,
  summarizeDiff,
} from '../manifest.js'
import { isMatcherObject, matchValue } from '../match.js'
import { resolveRootDir, resolveServerConfig } from '../paths.js'
import { executeCase } from '../runner.js'
import { McpSession } from '../session/index.js'
import type {
  JsonObject,
  JsonValue,
  RunOptions,
  ServerConfig,
  Step,
  ToolSummary,
} from '../types.js'
import { isHttpServerConfig, isStdioServerConfig } from '../types.js'
import {
  UsageError,
  VALUE_FLAGS,
  hasFlag,
  normalizeArgv,
  printJson,
  resolvePathFromCwd,
  splitCommandLine,
  takeAllFlags,
  takeFlag,
} from './args.js'
import { type CommandHelp, formatCommandHelp } from './format.js'
import { manifestIgnoreOf } from './manifest.js'
import { cliOverrides, describeServerTarget, parseCommonFlags } from './resolve.js'
import { assertCommandFlags, usageFailure } from './run.js'

const DIFF_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, '--against', '--cases'])

export const diffHelp: CommandHelp = {
  name: 'diff',
  group: 'contract',
  summary: 'Contract diff between two servers: manifest changes and per-case result changes',
  usage: [
    'vib diff --against "<cmd | url | server name>" [--cases <glob>] [--manifest-only] [--json]',
  ],
  description: [
    'The base server is the configured default (or --server). Both servers get the same',
    'manifest snapshot and, unless --manifest-only, every case runs against both; results are',
    'normalized and compared. Exit 1 when anything differs. Release notes and migration check.',
    "A command line runs in the base server's cwd and env. Full reference: docs/CLI.md.",
  ].join('\n'),
  flags: [
    {
      flag: '--against <target>',
      text: 'The other server: a server name, a command line, or a URL',
    },
    {
      flag: '--cases <glob>',
      text: 'Cases to compare, relative to the shell cwd (default: config globs; repeatable)',
    },
    { flag: '--manifest-only', text: 'Compare only the manifests (no cases are run)' },
  ],
  common: true,
  examples: [
    'vib diff --against "node ../v1/dist/index.js"',
    'vib diff --against staging --manifest-only',
    'vib diff --against https://staging.example.com/mcp --cases "tests/integration/smoke/*.json" --json',
  ],
}

/** Full `vib diff --help` text. */
export const help: string = formatCommandHelp(diffHelp)

interface Side {
  name: string
  config: ServerConfig
  session?: McpSession
  manifest?: Manifest
  tools?: Map<string, ToolSummary>
}

/** One step's observed result, as compared (see projectObservation). */
export interface ObservedStep {
  /** `tool echo`, `resource fixture://readme`, ... */
  step: string
  observed: JsonValue
}

export interface CaseComparison {
  id: string
  name: string
  same: boolean
  /** Observed results only (no pass/fail status: vib diff compares servers, not goldens). */
  base: ObservedStep[]
  against: ObservedStep[]
  diff?: string
}

/** The `--against` target as a ServerConfig (a configured name, a URL, or a command line). */
export function resolveAgainst(
  options: RunOptions,
  against: string,
  base: ServerConfig,
): ServerConfig {
  const trimmed = against.trim()
  if (Object.hasOwn(options.servers, trimmed)) return resolveServerConfig(options, trimmed)
  const common = {
    ...(base.protocol !== undefined ? { protocol: base.protocol } : {}),
    ...(base.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: base.spawnTimeoutMs } : {}),
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      url: trimmed,
      ...(isHttpServerConfig(base) && base.headers ? { headers: base.headers } : {}),
      ...common,
    }
  }
  const { cmd, args } = splitCommandLine(trimmed)
  return {
    cmd,
    args,
    cwd: isStdioServerConfig(base) && base.cwd ? base.cwd : process.cwd(),
    ...(isStdioServerConfig(base) && base.env ? { env: base.env } : {}),
    ...common,
  }
}

const plain = (s: string) => s

function textDiff(a: unknown, b: unknown): string {
  return diffLinesUnified(
    (JSON.stringify(a, null, 2) ?? 'undefined').split('\n'),
    (JSON.stringify(b, null, 2) ?? 'undefined').split('\n'),
    {
      aAnnotation: 'base',
      bAnnotation: 'against',
      expand: false,
      contextLines: 2,
      aColor: plain,
      bColor: plain,
      changeColor: plain,
      commonColor: plain,
      patchColor: plain,
    },
  )
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matcherLabel(expected: JsonObject): string {
  return `<matches ${Object.keys(expected)
    .filter((key) => key.startsWith('$'))
    .join(' + ')}>`
}

/**
 * Project an observed value through what the case asserts: values a matcher accepts become
 * `"<matches $type>"` (so timestamps and ids that the case itself treats as variable do not
 * count as differences), `{{captured}}` positions become `"<captured>"`, and keys a
 * `$partial` expectation does not mention are dropped. Without an expectation the value is
 * compared as is.
 */
export function projectThrough(
  expected: JsonValue | undefined,
  actual: JsonValue,
  partial = false,
): JsonValue {
  if (expected === undefined) return actual
  if (typeof expected === 'string' && expected.includes('{{')) return '<captured>'
  if (isMatcherObject(expected)) {
    return matchValue(expected, actual, { partial }).length === 0 && isObject(expected)
      ? matcherLabel(expected)
      : actual
  }
  if (isObject(expected) && isObject(actual)) {
    const childPartial = typeof expected.$partial === 'boolean' ? expected.$partial : partial
    const out: JsonObject = {}
    for (const [key, value] of Object.entries(actual)) {
      if (Object.hasOwn(expected, key))
        out[key] = projectThrough(expected[key], value, childPartial)
      else if (!childPartial) out[key] = value
    }
    return out
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return actual.map((item, i) => projectThrough(expected[i], item, partial))
  }
  return actual
}

function projectObservation(step: Step, observed: JsonValue): JsonValue {
  if (isObject(observed) && isObject(observed.error)) {
    const error = observed.error
    if (step.expectError === undefined) return observed
    const message = typeof error.message === 'string' ? error.message : ''
    const expected = step.expectError.message
    return {
      error: {
        code: error.codeName ?? error.code ?? null,
        message:
          expected !== undefined && matchValue(expected as JsonValue, message).length === 0
            ? typeof expected === 'string'
              ? message
              : '<matches $regex>'
            : message,
      },
    }
  }
  if (isObject(observed) && observed.inputRequired !== undefined) return observed
  return projectThrough(step.expect, observed)
}

async function observe(
  side: Side,
  loaded: LoadedCase,
  options: RunOptions,
): Promise<ObservedStep[]> {
  if (!side.session || !loaded.data) return []
  const execution = await executeCase(loaded.data, {
    session: side.session,
    normalize: options.normalize,
    timeoutMs: options.timeoutMs,
    budgetMs: options.budgetMs,
    tools: side.tools,
    env: process.env,
    update: 'off',
    updateHint: false,
    caseId: loaded.ref.id,
  })
  return execution.observations.map((o) => ({
    step: `${o.step.kind} ${o.step.target}`,
    observed: projectObservation(o.planned.step, o.observed),
  }))
}

/** `vib diff --against`: exit 0 identical, 1 different, 2 usage / connection error. */
export async function diffCommand(rawArgv: string[]): Promise<number> {
  if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
    console.log(help)
    return 0
  }
  const argv = normalizeArgv(rawArgv, DIFF_VALUE_FLAGS)
  const json = argv.includes('--json')
  try {
    assertCommandFlags(argv, diffHelp, DIFF_VALUE_FLAGS)
  } catch (err) {
    return usageFailure(err, 'diff', json)
  }
  const against = takeFlag(argv, '--against')
  if (!against) {
    return usageFailure(
      new UsageError(
        'Missing --against: pass the other server as a name from vibrissa.json, a command line, or a URL.',
        {
          code: 'missing-argument',
          hint: 'Example: vib diff --against "node ../v1/dist/index.js"',
          next: ['vib diff --help'],
        },
      ),
      'diff',
      json,
    )
  }
  const manifestOnly = hasFlag(argv, '--manifest-only')
  let options: RunOptions
  let flags: ReturnType<typeof parseCommonFlags>
  try {
    flags = parseCommonFlags(argv)
    const overrides: ConfigOverrides = {}
    const cases = takeAllFlags(argv, '--cases')
    if (cases.length > 0)
      overrides.globs = cases.map((g) => resolvePathFromCwd(g).replace(/\\/g, '/'))
    const loaded = loadConfig(process.cwd(), {
      configPath: flags.configPath,
      profile: flags.profile,
      overrides: cliOverrides(flags, overrides),
    })
    options = loaded.options
  } catch (err) {
    return usageFailure(err, 'diff', json)
  }

  const baseConfig = resolveServerConfig(options)
  const sides: [Side, Side] = [
    { name: options.defaultServer, config: baseConfig },
    { name: against, config: resolveAgainst(options, against, baseConfig) },
  ]
  try {
    for (const side of sides) {
      side.session = await McpSession.start(side.config, {
        timeoutMs: options.timeoutMs,
        stderr: 'capture',
      })
      side.manifest = (await captureManifest(side.session)).manifest
      side.tools = new Map(side.manifest.tools.map((tool) => [tool.name, tool]))
    }
    const manifestDiff: ManifestDiff = diffManifest(
      sides[0].manifest as Manifest,
      sides[1].manifest as Manifest,
      { ignore: manifestIgnoreOf(options) },
    )

    const comparisons: CaseComparison[] = []
    if (!manifestOnly) {
      const loaded = await loadCases({
        rootDir: resolveRootDir(options),
        globs: options.globs,
        defaultServer: options.defaultServer,
        servers: Object.keys(options.servers),
        manifest: options.manifest,
        tags: options.tags,
        excludeTags: options.excludeTags,
        grep: options.grep,
      })
      for (const c of loaded.cases) {
        if (c.skip || c.ref.server !== options.defaultServer) continue
        const base = await observe(sides[0], c, options)
        const other = await observe(sides[1], c, options)
        const same = jsonEqual(base, other)
        comparisons.push({
          id: c.ref.id,
          name: c.ref.name,
          same,
          base,
          against: other,
          ...(same ? {} : { diff: textDiff(base, other) }),
        })
      }
    }

    const differing = comparisons.filter((c) => !c.same)
    const identical = manifestDiff.identical && differing.length === 0
    if (flags.json) {
      printJson({
        ok: identical,
        identical,
        base: {
          server: sides[0].name,
          target: describeServerTarget(sides[0].config),
          info: sides[0].manifest?.server,
        },
        against: {
          server: sides[1].name,
          target: describeServerTarget(sides[1].config),
          info: sides[1].manifest?.server,
        },
        manifest: {
          identical: manifestDiff.identical,
          summary: summarizeDiff(manifestDiff),
          diff: manifestDiff,
        },
        cases: comparisons,
        summary: { cases: comparisons.length, different: differing.length },
      })
    } else {
      console.log(`base:    ${describeServerTarget(sides[0].config)}`)
      console.log(`against: ${describeServerTarget(sides[1].config)}`)
      console.log('')
      console.log(formatDiff(manifestDiff))
      if (!manifestOnly) {
        console.log('')
        for (const c of comparisons) {
          console.log(`${c.same ? 'same' : 'DIFF'}  ${c.name} (${c.id})`)
          if (!c.same && c.diff) for (const line of c.diff.split('\n')) console.log(`      ${line}`)
        }
        console.log('')
        console.log(
          `${differing.length} of ${comparisons.length} case${comparisons.length === 1 ? '' : 's'} differ${manifestDiff.identical ? '' : '; manifest differs'}.`,
        )
      }
    }
    return identical ? 0 : 1
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      return 2
    }
    throw err
  } finally {
    for (const side of sides) await side.session?.close()
  }
}
