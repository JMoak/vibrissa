/**
 * Reporter registry. Built-ins: console (default), json, junit, github, tap.
 * Plugins add their own with `registerReporter(name, factory)`; the runner builds the
 * active set with `createReporters(names, ctx)` and drives them through `fanout(...)`.
 */
import type { Reporter, ReporterContext, RunEvent } from '../events.js'
import { ConsoleReporter } from './console.js'
import { GithubReporter } from './github.js'
import { JsonReporter } from './json.js'
import { JunitReporter } from './junit.js'
import { TapReporter } from './tap.js'

export type ReporterFactory = (ctx: ReporterContext) => Reporter

export const BUILTIN_REPORTERS = ['console', 'json', 'junit', 'github', 'tap'] as const

const registry = new Map<string, ReporterFactory>()

function builtins(): Array<[string, ReporterFactory]> {
  return [
    ['console', (ctx) => new ConsoleReporter(ctx)],
    ['json', (ctx) => new JsonReporter(ctx)],
    ['junit', (ctx) => new JunitReporter(ctx)],
    ['github', (ctx) => new GithubReporter(ctx)],
    ['tap', (ctx) => new TapReporter(ctx)],
  ]
}

for (const [name, factory] of builtins()) registry.set(name, factory)

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Register a reporter factory under `name` (case-insensitive). Throws if the name is
 * taken, unless `{ override: true }` — which also allows replacing a built-in.
 */
export function registerReporter(
  name: string,
  factory: ReporterFactory,
  options: { override?: boolean } = {},
): void {
  const key = normalizeName(name)
  if (!key || /[\s,]/.test(key)) {
    throw new Error(
      `Invalid reporter name ${JSON.stringify(name)}: expected a non-empty name without spaces or commas.`,
    )
  }
  if (typeof factory !== 'function') {
    throw new Error(
      `Invalid reporter factory for "${key}": expected a function (ctx) => Reporter, got ${typeof factory}.`,
    )
  }
  if (registry.has(key) && !options.override) {
    throw new Error(
      `Reporter "${key}" is already registered. Pass { override: true } to replace it.`,
    )
  }
  registry.set(key, factory)
}

/** Remove a reporter. Built-ins removed this way can be restored with `resetReporters()`. */
export function unregisterReporter(name: string): boolean {
  return registry.delete(normalizeName(name))
}

/** Restore the registry to just the built-ins (mainly for tests). */
export function resetReporters(): void {
  registry.clear()
  for (const [name, factory] of builtins()) registry.set(name, factory)
}

export function hasReporter(name: string): boolean {
  return registry.has(normalizeName(name))
}

/** Registered reporter names, sorted. */
export function listReporters(): string[] {
  return [...registry.keys()].sort()
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

export class UnknownReporterError extends Error {
  readonly reporter: string
  readonly known: string[]
  readonly suggestion?: string

  constructor(reporter: string, known: string[]) {
    const key = normalizeName(reporter)
    const suggestion = known
      .map((name) => ({ name, d: editDistance(key, name) }))
      .filter(({ name, d }) => d <= 2 || name.startsWith(key) || key.startsWith(name))
      .sort((a, b) => a.d - b.d)[0]?.name
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : ''
    super(
      `Unknown reporter "${reporter}": expected one of ${known.join(', ')}.${hint} Set "reporters" in vibrissa.json or pass --reporter <name>; plugins must call registerReporter() before the run.`,
    )
    this.name = 'UnknownReporterError'
    this.reporter = reporter
    this.known = known
    this.suggestion = suggestion
  }
}

/**
 * Instantiate reporters by name. Names are case-insensitive, may be comma-separated
 * (`"console,junit"`), and duplicates collapse to one instance. All names are validated
 * before any reporter is created, so a typo never leaves half the set constructed.
 */
export function createReporters(names: string[], ctx: ReporterContext): Reporter[] {
  const keys: string[] = []
  for (const raw of names) {
    for (const part of String(raw).split(',')) {
      const key = normalizeName(part)
      if (!key || keys.includes(key)) continue
      if (!registry.has(key)) throw new UnknownReporterError(part.trim(), listReporters())
      keys.push(key)
    }
  }
  if (keys.includes('console') && keys.includes('tap')) {
    ctx.stderr(
      'vibrissa: warning: "console" and "tap" both write to stdout, so the TAP stream will be interleaved with console output. Pick one, or run them separately.',
    )
  }
  return keys.map((key) => {
    const factory = registry.get(key) as ReporterFactory
    return factory(ctx)
  })
}

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

interface Slot {
  reporter: Reporter
  /** Settles when this reporter's in-flight async onEvent calls are done. */
  tail?: Promise<void>
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function reporterError(reporter: Reporter, phase: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`Reporter "${reporter.name}" failed during ${phase}: ${message}`, { cause: err })
}

function combine(errors: Error[], phase: string): Error {
  if (errors.length === 1) return errors[0]
  return new AggregateError(
    errors,
    `${errors.length} reporters failed during ${phase}: ${errors.map((e) => e.message).join('; ')}`,
  )
}

/**
 * Deliver `fn` to one reporter, preserving per-reporter event order: while an async
 * onEvent is in flight, later events queue behind it; otherwise delivery is synchronous.
 */
function deliver(slot: Slot, fn: () => void | Promise<void>): Promise<void> | undefined {
  const track = (p: Promise<void>) => {
    const tail = p.then(
      () => undefined,
      () => undefined,
    )
    slot.tail = tail
    void tail.then(() => {
      if (slot.tail === tail) slot.tail = undefined
    })
    return p
  }
  if (slot.tail) return track(slot.tail.then(fn))
  const result = fn()
  if (isPromiseLike(result)) return track(Promise.resolve(result))
  return undefined
}

/**
 * Combine reporters into one. Every reporter sees every event even if another throws;
 * failures are rethrown afterwards (one Error, or an AggregateError for several). The
 * return value is synchronous when all reporters handled the event synchronously, and a
 * promise otherwise. `close()` waits for queued events, then awaits every close().
 */
export function fanout(reporters: Reporter[]): Reporter {
  const slots: Slot[] = reporters.map((reporter) => ({ reporter }))
  return {
    name: `fanout(${reporters.map((r) => r.name).join(',')})`,
    onEvent(event: RunEvent): void | Promise<void> {
      const errors: Error[] = []
      const pending: Promise<void>[] = []
      for (const slot of slots) {
        try {
          const p = deliver(slot, () => slot.reporter.onEvent(event))
          if (p) {
            pending.push(
              p.catch((err) => {
                errors.push(reporterError(slot.reporter, event.type, err))
              }),
            )
          }
        } catch (err) {
          errors.push(reporterError(slot.reporter, event.type, err))
        }
      }
      if (pending.length === 0) {
        if (errors.length > 0) throw combine(errors, event.type)
        return
      }
      return Promise.all(pending).then(() => {
        if (errors.length > 0) throw combine(errors, event.type)
      })
    },
    async close(): Promise<void> {
      const errors: Error[] = []
      await Promise.all(
        slots.map(async (slot) => {
          try {
            if (slot.tail) await slot.tail
            await slot.reporter.close?.()
          } catch (err) {
            errors.push(reporterError(slot.reporter, 'close', err))
          }
        }),
      )
      if (errors.length > 0) throw combine(errors, 'close')
    },
  }
}

export { ConsoleReporter, createConsoleReporter, type ConsoleReporterOptions } from './console.js'
export {
  JsonReporter,
  createJsonReporter,
  buildJsonReport,
  RESULTS_FILE,
  type JsonReport,
  type JsonCase,
  type JsonStep,
  type JsonMismatch,
  type JsonManifest,
  type JsonServer,
  type JsonSummary,
} from './json.js'
export { JunitReporter, createJunitReporter, buildJunitXml, JUNIT_FILE } from './junit.js'
export {
  GithubReporter,
  createGithubReporter,
  SUMMARY_FILE,
  type GithubReporterOptions,
} from './github.js'
export { TapReporter, createTapReporter } from './tap.js'
export { RunCollector, type CaseRecord } from './shared.js'
export { resolveStyle } from './ansi.js'
