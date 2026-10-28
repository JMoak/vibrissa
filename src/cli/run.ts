import { ConfigError, type ConfigOverrides, loadConfig, parseShard } from '../config.js'
import { resolveRootDir } from '../paths.js'
import { JsonReporter, UnknownReporterError } from '../reporters/index.js'
import { Runner, type RunnerOptions } from '../runner.js'
import {
  VALUE_FLAGS,
  hasFlag,
  normalizeArgv,
  printJson,
  resolvePathFromCwd,
  takeAllFlags,
  takeFlag,
} from './args.js'
import { type CommandHelp, formatCommandHelp } from './format.js'
import { type CommonCliFlags, cliOverrides, parseCommonFlags } from './resolve.js'

/** Value-taking flags of `vib run` (on top of the shared ones), for `--flag=value` splitting. */
export const RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...VALUE_FLAGS,
  '--cases',
  '--tag',
  '--exclude-tag',
  '--grep',
  '--shard',
  '--repeat',
  '--concurrency',
  '--baseline',
  '--reporter',
  '--out-dir',
])

export const runHelp: CommandHelp = {
  name: 'run',
  group: 'test',
  summary: 'Run JSON cases (and the manifest lock / checks) against the server',
  usage: ['vib run [options]'],
  description: [
    'Runs every case matched by "globs" (minus tag/grep/shard filters), verifies the manifest',
    'lock, and reports through the configured reporters. Failures write reports/traces/.',
    '--json prints one JSON object (the results.json report) on stdout; logs go to stderr.',
    'Full reference: docs/CLI.md (flags), docs/CASES.md (case keys), docs/CONFIG.md.',
  ].join('\n'),
  flags: [
    { flag: '--cases <glob>', text: 'Case glob, relative to the shell cwd (repeatable)' },
    { flag: '--tag <t>', text: 'Only cases with this tag (repeatable, comma ok)' },
    { flag: '--exclude-tag <t>', text: 'Skip cases with this tag (repeatable, comma ok)' },
    {
      flag: '--grep <pattern>',
      text: 'Only cases whose name or file matches (regex, case-insensitive)',
    },
    { flag: '--shard <i/n>', text: 'Run shard i of n (stable split by case id)' },
    {
      flag: '--repeat <n>',
      text: 'Run every case n times; reports pass rates (flaky: true gets a floor)',
    },
    { flag: '--concurrency <n>', text: 'Workers per server, one session each (flows never split)' },
    {
      flag: '--update[=all]',
      text: 'Rewrite failing goldens from live output (=all: also matcher goldens)',
    },
    { flag: '--update-manifest', text: 'Accept manifest drift (rewrite or create the lock)' },
    {
      flag: '--check',
      text: 'Also run spec-sanity + description checks (failed checks fail the run)',
    },
    { flag: '--baseline <file>', text: 'Fail only on regressions vs a previous results.json' },
    {
      flag: '--trace',
      text: 'Write reports/traces/<case>.ndjson for every case (default: failures)',
    },
    {
      flag: '--reporter <name>',
      text: 'console | json | junit | github | tap (repeatable, comma ok)',
    },
    { flag: '--out-dir <dir>', text: 'Directory for reports (default: reports/)' },
    { flag: '--fail-fast', text: 'Stop after the first failing case' },
    { flag: '--allow-empty', text: 'Exit 0 when no cases match' },
    { flag: '--pretty / --no-pretty', text: 'Force colors and glyphs on or off' },
  ],
  common: true,
  examples: [
    'vib run',
    'vib run --profile ci --check --reporter junit',
    'vib run --tag smoke --fail-fast',
    'vib run --repeat 5 --concurrency 2',
    'vib run --update',
    'vib run --baseline reports/last-green.json',
  ],
  extraFlags: ['--update=all', '--pretty', '--no-pretty', '--display'],
}

/** Full `vib run --help` text. */
export const help: string = formatCommandHelp(runHelp)

function splitList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}

function intFlag(argv: string[], name: string, min: number): number | undefined {
  const raw = takeFlag(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(
      `Invalid ${name} value "${raw}": expected an integer >= ${min}. Example: ${name} ${Math.max(min, 2)}.`,
    )
  }
  return value
}

/** CLI flags → RunnerOptions (config file → profile → flags). Throws ConfigError on bad flags. */
export function resolveRunOptions(rawArgv: string[]): RunnerOptions {
  const argv = normalizeArgv(rawArgv, RUN_VALUE_FLAGS)
  const flags: CommonCliFlags = parseCommonFlags(argv)
  const overrides: ConfigOverrides = {}

  const cases = takeAllFlags(argv, '--cases')
  if (cases.length > 0) {
    overrides.globs = cases.map((glob) => {
      const negated = glob.startsWith('!')
      const body = negated ? glob.slice(1) : glob
      const abs = resolvePathFromCwd(body).replace(/\\/g, '/')
      return negated ? `!${abs}` : abs
    })
  }
  const tags = splitList(takeAllFlags(argv, '--tag'))
  if (tags.length > 0) overrides.tags = tags
  const excludeTags = splitList(takeAllFlags(argv, '--exclude-tag'))
  if (excludeTags.length > 0) overrides.excludeTags = excludeTags
  const grep = takeFlag(argv, '--grep')
  if (grep !== undefined) overrides.grep = grep
  const shardRaw = takeFlag(argv, '--shard')
  if (shardRaw !== undefined) {
    const shard = parseShard(shardRaw)
    if (!shard) {
      throw new ConfigError(
        `Invalid --shard value "${shardRaw}": expected <index>/<total> with 1 <= index <= total, e.g. --shard 1/4.`,
      )
    }
    overrides.shard = shard
  }
  const repeat = intFlag(argv, '--repeat', 1)
  if (repeat !== undefined) overrides.repeat = repeat
  const concurrency = intFlag(argv, '--concurrency', 1)
  if (concurrency !== undefined) overrides.concurrency = concurrency
  const updateAll = argv.includes('--update=all')
  if (hasFlag(argv, '--update') || updateAll) overrides.update = true
  if (hasFlag(argv, '--trace')) overrides.trace = true
  if (hasFlag(argv, '--check')) overrides.check = true
  const baseline = takeFlag(argv, '--baseline')
  if (baseline !== undefined) overrides.baseline = resolvePathFromCwd(baseline)
  if (hasFlag(argv, '--fail-fast')) overrides.failFast = true
  if (hasFlag(argv, '--allow-empty')) overrides.allowEmpty = true
  const reporterFlags = splitList(takeAllFlags(argv, '--reporter'))
  if (reporterFlags.length > 0) overrides.reporters = reporterFlags

  const { options, warnings } = loadConfig(process.cwd(), {
    configPath: flags.configPath,
    profile: flags.profile,
    overrides: cliOverrides(flags, overrides),
  })
  for (const warning of warnings) console.warn(`warning: ${warning}`)

  let pretty: boolean | undefined
  const display = takeFlag(argv, '--display')
  if (hasFlag(argv, '--pretty') || display === 'pretty') pretty = true
  if (hasFlag(argv, '--no-pretty') || display === 'plain') pretty = false

  let reporters = options.reporters
  let stdout: RunnerOptions['stdout']
  if (flags.json) {
    // stdout carries exactly one JSON object (printed by runCommand): every other reporter
    // writes to stderr, and the json reporter is attached by runCommand itself.
    const names = reporters.flatMap((r) => r.split(',')).map((r) => r.trim().toLowerCase())
    reporters = [...new Set([...names, 'console'])].filter((r) => r && r !== 'json')
    stdout = (line) => console.error(line)
    pretty = false
  }

  // checks / manifestIgnore / outDir come resolved from config (defaults → file → profile).
  const outDir = takeFlag(argv, '--out-dir')
  const runner: RunnerOptions = {
    ...options,
    reporters,
    ...(outDir !== undefined ? { outDir: resolvePathFromCwd(outDir) } : {}),
    ...(pretty !== undefined ? { pretty } : {}),
    ...(stdout ? { stdout } : {}),
    ...(updateAll ? { updateAll: true } : {}),
    ...(hasFlag(argv, '--update-manifest') ? { updateManifest: true } : {}),
  }
  return runner
}

function usageError(err: unknown, json: boolean): number {
  const message = err instanceof Error ? err.message : String(err)
  if (json) {
    printJson({
      ok: false,
      error: { type: err instanceof Error ? err.name : 'Error', message },
    })
  }
  console.error(message)
  return 2
}

/**
 * `vib run`: exit 0 ok, 1 failures / drift / failed checks, 2 usage or config error.
 * With `--json`, stdout carries exactly one JSON object — the JsonReport also written to
 * `<outDir>/results.json` (or `{ ok: false, error }` on a usage error); everything else
 * (console reporter, warnings) goes to stderr.
 */
export async function runCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help)
    return 0
  }
  const json = argv.includes('--json')
  let options: RunnerOptions
  try {
    options = resolveRunOptions(argv)
  } catch (err) {
    return usageError(err, json)
  }
  let jsonReporter: JsonReporter | undefined
  if (json) {
    jsonReporter = new JsonReporter({
      rootDir: resolveRootDir(options),
      outDir: options.outDir ?? 'reports',
      pretty: false,
      stdout: (line) => console.error(line),
      stderr: (line) => console.error(line),
    })
    options = { ...options, extraReporters: [...(options.extraReporters ?? []), jsonReporter] }
  }
  try {
    const code = await new Runner(options).run()
    if (jsonReporter) printJson(jsonReporter.report())
    return code
  } catch (err) {
    if (err instanceof UnknownReporterError || err instanceof ConfigError) {
      return usageError(err, json)
    }
    throw err
  }
}
