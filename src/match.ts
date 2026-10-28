/**
 * Matcher engine (pure). Compares an expectation tree from a case file against an actual
 * (normalized) result and returns path-level mismatches. See docs/MATCHERS.md.
 *
 * Plain JSON in an expectation means exact deep equality. Objects whose keys start with
 * `$` and name a matcher ("directive objects") are interpreted instead:
 *
 *   v1: $partial, $regex (+flags), $wildcard, $unordered (+value)
 *   v2: $any, $type, $schema, $oneOf, $contains (+count), $length, $number, $ignore,
 *       $ref (expanded by resolveRefs before matching), $literal (escape hatch)
 *
 * Precedence rule: a directive object is only the directive. Plain keys next to a
 * directive are reported as an "invalid matcher" mismatch. Several directives in one
 * object must all hold (AND), evaluated in a fixed order that stops at the first failure;
 * $ignore, $ref and $literal must stand alone.
 */
import { posix } from 'node:path'
import type { Mismatch } from './events.js'
import { appendIndex, appendKey, validate as validateAgainstSchema } from './schema.js'
import type { JsonValue } from './types.js'

export type { Mismatch } from './events.js'

export interface MatchOptions {
  /** Start in partial mode, as if the root expectation carried `"$partial": true`. */
  partial?: boolean
}

interface MatchContext {
  partial: boolean
  /** Inside `$literal`: directive keys are plain data. */
  literal: boolean
  mismatches: Mismatch[]
  limit: number
}

export const MAX_MISMATCHES = 25

/** Evaluation order for AND-combined directives: cheap, specific checks first. */
const DIRECTIVES = [
  '$any',
  '$type',
  '$number',
  '$length',
  '$regex',
  '$wildcard',
  '$schema',
  '$contains',
  '$unordered',
  '$oneOf',
  '$ignore',
  '$ref',
  '$literal',
] as const

type DirectiveName = (typeof DIRECTIVES)[number]

/** Keys that may accompany a directive (and only that directive). */
const AUX_KEYS: Partial<Record<DirectiveName, readonly string[]>> = {
  $regex: ['flags'],
  $unordered: ['value', '$partial'],
  $contains: ['count', '$partial'],
  $oneOf: ['$partial'],
}

const SOLO = new Set<DirectiveName>(['$ignore', '$ref', '$literal'])

export const JSON_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
] as const

const NUMBER_BOUNDS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const

const LITERAL_HINT = 'wrap data that really has these keys in {"$literal": ...}'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function matchValue(
  expected: JsonValue,
  actual: unknown,
  options: MatchOptions = {},
): Mismatch[] {
  const ctx: MatchContext = {
    partial: options.partial === true,
    literal: false,
    mismatches: [],
    limit: MAX_MISMATCHES,
  }
  matchNode(expected, actual, '', ctx)
  return ctx.mismatches
}

export function matches(expected: JsonValue, actual: unknown, options?: MatchOptions): boolean {
  return matchValue(expected, actual, options).length === 0
}

/**
 * True when `value` would be interpreted as a matcher (`{"$regex": ...}`, `{"$type": ...}`,
 * `{"$ref": ...}`, `{"$literal": ...}`), not compared as plain data. Plain objects carrying
 * only `$partial` next to data keys are not matchers.
 */
export function isMatcherObject(value: unknown): boolean {
  return isPlainObject(value) && parseDirective(value) !== null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function report(ctx: MatchContext, mismatch: Mismatch): void {
  if (ctx.mismatches.length < ctx.limit) ctx.mismatches.push(mismatch)
}

function displayPath(path: string): string {
  return path === '' ? '(root)' : path
}

/** Join a path relative to `base` (as produced by schema.ts) onto `base`. */
function joinPath(base: string, relative: string): string {
  if (relative === '') return base
  if (relative.startsWith('[') || base === '') return `${base}${relative}`
  return `${base}.${relative}`
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Type plus a short preview, for v2 messages: `number 42`, `string "abc"`, `array (3 items)`. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array (${value.length} item${value.length === 1 ? '' : 's'})`
  if (typeof value === 'object') return 'object'
  return `${typeof value} ${short(value)}`
}

function short(value: unknown, max = 80): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isSchemaValue(value: unknown): boolean {
  return typeof value === 'boolean' || isPlainObject(value)
}

function isDirectiveKey(key: string, value: JsonValue): key is DirectiveName {
  if (!(DIRECTIVES as readonly string[]).includes(key)) return false
  // A string `$schema` is a JSON Schema dialect URI (data), not the $schema matcher.
  return key !== '$schema' || isSchemaValue(value)
}

/** Every `$` name an expectation may use (directives plus `$partial`). */
const MATCHER_NAMES: readonly string[] = ['$partial', ...DIRECTIVES]

/**
 * A `$`-prefixed key that is neither a matcher nor `$partial` (a string `$schema` is a
 * dialect URI, i.e. data). Typos such as `$partail` would otherwise be compared as data.
 */
function isUnknownDollarKey(key: string, value: JsonValue): boolean {
  if (!key.startsWith('$') || MATCHER_NAMES.includes(key)) return false
  return !(key === '$schema' && typeof value === 'string')
}

function closestMatcher(key: string): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const name of MATCHER_NAMES) {
    const score = levenshtein(key.toLowerCase(), name.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = name
    }
  }
  return bestScore <= 2 ? best : undefined
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

function scratch(ctx: MatchContext, partial: boolean, limit: number): MatchContext {
  return { partial, literal: ctx.literal, mismatches: [], limit }
}

function firstMismatch(
  expected: JsonValue,
  actual: unknown,
  path: string,
  ctx: MatchContext,
  partial: boolean,
): Mismatch | undefined {
  const sub = scratch(ctx, partial, 1)
  matchNode(expected, actual, path, sub)
  return sub.mismatches[0]
}

/** The candidate with the fewest mismatches (first wins ties), for "closest element" hints. */
function closest(
  expected: JsonValue,
  candidates: unknown[],
  indices: number[] | undefined,
  path: string,
  ctx: MatchContext,
  partial: boolean,
): { index: number; mismatch: Mismatch } | undefined {
  let best: { index: number; mismatch: Mismatch; count: number } | undefined
  for (const i of indices ?? candidates.map((_, j) => j)) {
    const sub = scratch(ctx, partial, MAX_MISMATCHES)
    matchNode(expected, candidates[i], appendIndex(path, i), sub)
    const count = sub.mismatches.length
    if (count > 0 && (!best || count < best.count)) {
      best = { index: i, mismatch: sub.mismatches[0], count }
    }
  }
  return best
}

function describeMismatch(m: Mismatch, at: string): string {
  return m.path === displayPath(at) ? m.message : `${m.path}: ${m.message}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Directive parsing / validation
// ---------------------------------------------------------------------------

interface ParsedDirective {
  names: DirectiveName[]
  /** Full mismatch message when the directive object is malformed. */
  error?: string
}

const parsedCache = new WeakMap<object, ParsedDirective | null>()

function parseDirective(expected: Record<string, JsonValue>): ParsedDirective | null {
  if (parsedCache.has(expected)) return parsedCache.get(expected) ?? null
  const parsed = parseDirectiveUncached(expected)
  parsedCache.set(expected, parsed)
  return parsed
}

function parseDirectiveUncached(expected: Record<string, JsonValue>): ParsedDirective | null {
  const names = DIRECTIVES.filter(
    (name) => hasOwn(expected, name) && isDirectiveKey(name, expected[name]),
  )
  if (names.length === 0) return null
  const label = names.join(' + ')

  const allowed = new Set<string>(names)
  for (const name of names) for (const aux of AUX_KEYS[name] ?? []) allowed.add(aux)
  const extra = Object.keys(expected).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    const keys = extra.map((k) => JSON.stringify(k)).join(', ')
    if (extra.length === 1 && extra[0] === '$partial') {
      return {
        names,
        error: `invalid matcher: "$partial" cannot be used with ${label} (only on plain objects, $unordered, $contains and $oneOf)`,
      }
    }
    return {
      names,
      error: `invalid matcher: ${keys} cannot sit next to ${label}; a matcher object holds only the matcher and its options. Move plain fields to the enclosing object, or ${LITERAL_HINT}`,
    }
  }

  const solo = names.find((name) => SOLO.has(name))
  if (solo && names.length > 1) {
    return {
      names,
      error: `invalid matcher: ${solo} must be used on its own, not combined with ${names.filter((n) => n !== solo).join(' + ')}`,
    }
  }

  for (const name of names) {
    const error = validateDirective(name, expected)
    if (error) return { names, error: `invalid matcher: ${error}` }
  }
  return { names }
}

interface Range {
  min?: number
  max?: number
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** `3` → exactly 3; `{ "min": 1, "max": 10 }` → bounds (either may be omitted). */
function parseRange(value: JsonValue | undefined, label: string): Range | string {
  if (isNonNegativeInteger(value)) return { min: value, max: value }
  if (!isPlainObject(value)) {
    return `${label} must be a non-negative integer or {"min": n, "max": n}; got ${short(value)}`
  }
  const extra = Object.keys(value).filter((k) => k !== 'min' && k !== 'max')
  if (extra.length > 0) return `${label} only accepts "min" and "max"; got ${short(value)}`
  const { min, max } = value
  if (min === undefined && max === undefined) {
    return `${label} needs "min" and/or "max"; got ${short(value)}`
  }
  if (
    (min !== undefined && !isNonNegativeInteger(min)) ||
    (max !== undefined && !isNonNegativeInteger(max))
  ) {
    return `${label} bounds must be non-negative integers; got ${short(value)}`
  }
  if (min !== undefined && max !== undefined && min > max) {
    return `${label} has min > max; got ${short(value)}`
  }
  return { min: min as number | undefined, max: max as number | undefined }
}

function describeRange(range: Range): string {
  if (range.min !== undefined && range.min === range.max) return `${range.min}`
  const parts: string[] = []
  if (range.min !== undefined) parts.push(`>= ${range.min}`)
  if (range.max !== undefined) parts.push(`<= ${range.max}`)
  return parts.join(' and ')
}

function inRange(n: number, range: Range): boolean {
  return (range.min === undefined || n >= range.min) && (range.max === undefined || n <= range.max)
}

function checkPartialOption(
  directive: Record<string, JsonValue>,
  name: string,
): string | undefined {
  if (hasOwn(directive, '$partial') && typeof directive.$partial !== 'boolean') {
    return `"$partial" on ${name} must be true or false; got ${short(directive.$partial)}`
  }
  return undefined
}

function validateDirective(name: DirectiveName, d: Record<string, JsonValue>): string | undefined {
  const value = d[name]
  switch (name) {
    case '$any':
    case '$ignore':
      return value === true ? undefined : `"${name}" must be true; got ${short(value)}`
    case '$type': {
      const types = Array.isArray(value) ? value : [value]
      const valid =
        types.length > 0 &&
        types.every((t) => typeof t === 'string' && (JSON_TYPES as readonly string[]).includes(t))
      return valid
        ? undefined
        : `"$type" must be one of ${JSON_TYPES.map((t) => `"${t}"`).join(', ')} or an array of them; got ${short(value)}. If this is data, ${LITERAL_HINT}`
    }
    case '$number': {
      if (!isPlainObject(value) || Object.keys(value).length === 0) {
        return `"$number" must be an object with any of ${NUMBER_BOUNDS.join(', ')}; got ${short(value)}`
      }
      for (const [key, bound] of Object.entries(value)) {
        if (!(NUMBER_BOUNDS as readonly string[]).includes(key)) {
          return `"$number" does not support "${key}" (use ${NUMBER_BOUNDS.join(', ')})`
        }
        if (typeof bound !== 'number' || !Number.isFinite(bound)) {
          return `"$number".${key} must be a number; got ${short(bound)}`
        }
      }
      return undefined
    }
    case '$length': {
      const range = parseRange(value, '"$length"')
      return typeof range === 'string' ? range : undefined
    }
    case '$regex': {
      if (typeof value !== 'string') return `"$regex" must be a string pattern; got ${short(value)}`
      if (hasOwn(d, 'flags') && typeof d.flags !== 'string') {
        return `"flags" must be a string such as "i"; got ${short(d.flags)}`
      }
      return undefined
    }
    case '$wildcard':
      return typeof value === 'string'
        ? undefined
        : `"$wildcard" must be a string pattern; got ${short(value)}`
    case '$schema':
      return undefined
    case '$contains': {
      if (hasOwn(d, 'count')) {
        const range = parseRange(d.count, '"count"')
        if (typeof range === 'string') return range
      }
      return checkPartialOption(d, '$contains')
    }
    case '$unordered': {
      if (value !== true) return `"$unordered" must be true; got ${short(value)}`
      if (!Array.isArray(d.value)) {
        return `"$unordered" needs "value": [ ...expected elements ]; got ${short(d.value)}`
      }
      return checkPartialOption(d, '$unordered')
    }
    case '$oneOf': {
      if (!Array.isArray(value) || value.length === 0) {
        return `"$oneOf" must be a non-empty array of alternatives; got ${short(value)}`
      }
      return checkPartialOption(d, '$oneOf')
    }
    case '$ref':
      return typeof value === 'string'
        ? undefined
        : `"$ref" must be a path string; got ${short(value)}`
    case '$literal':
      return undefined
  }
}

/** Whether a missing key satisfies this expectation (`$ignore`, or `$oneOf` with one). */
function acceptsMissing(expected: JsonValue, ctx: MatchContext): boolean {
  if (ctx.literal || !isPlainObject(expected)) return false
  const parsed = parseDirective(expected)
  if (!parsed || parsed.error) return false
  return parsed.names.every((name) => {
    if (name === '$ignore') return true
    if (name === '$oneOf')
      return (expected.$oneOf as JsonValue[]).some((alt) => acceptsMissing(alt, ctx))
    return false
  })
}

function isInvalidDirective(expected: JsonValue, ctx: MatchContext): boolean {
  if (ctx.literal || !isPlainObject(expected)) return false
  return parseDirective(expected)?.error !== undefined
}

// ---------------------------------------------------------------------------
// Core walk
// ---------------------------------------------------------------------------

function matchNode(expected: JsonValue, actual: unknown, path: string, ctx: MatchContext): void {
  if (ctx.mismatches.length >= ctx.limit) return
  if (isPlainObject(expected)) {
    if (!ctx.literal) {
      const parsed = parseDirective(expected)
      if (parsed) {
        matchDirective(expected, parsed, actual, path, ctx)
        return
      }
    }
    matchObject(expected, actual, path, ctx)
    return
  }
  if (Array.isArray(expected)) {
    matchArray(expected, actual, path, ctx)
    return
  }
  if (!Object.is(expected, actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      expected,
      actual,
    })
  }
}

type DirectiveHandler = (
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
) => void

const HANDLERS: Record<DirectiveName, DirectiveHandler> = {
  $any: matchAny,
  $type: matchType,
  $number: matchNumber,
  $length: matchLength,
  $regex: matchRegexDirective,
  $wildcard: matchWildcardDirective,
  $schema: matchSchema,
  $contains: matchContains,
  $unordered: (directive, actual, path, ctx) => {
    const partial = typeof directive.$partial === 'boolean' ? directive.$partial : ctx.partial
    matchUnordered(directive.value as JsonValue[], directive, actual, path, { ...ctx, partial })
  },
  $oneOf: matchOneOf,
  $ignore: () => {},
  $ref: (directive, actual, path, ctx) => {
    report(ctx, {
      path: displayPath(path),
      message: `unresolved $ref ${JSON.stringify(directive.$ref)}: expand refs with resolveRefs() before matching`,
      expected: directive,
      actual,
    })
  },
  $literal: (directive, actual, path, ctx) => {
    matchNode(directive.$literal, actual, path, { ...ctx, literal: true })
  },
}

function matchDirective(
  directive: Record<string, JsonValue>,
  parsed: ParsedDirective,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (parsed.error) {
    report(ctx, { path: displayPath(path), message: parsed.error, expected: directive, actual })
    return
  }
  for (const name of parsed.names) {
    const before = ctx.mismatches.length
    HANDLERS[name](directive, actual, path, ctx)
    if (ctx.mismatches.length > before) return
  }
}

function matchObject(
  expected: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (!isPlainObject(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an object, got ${describeType(actual)}`,
      expected,
      actual,
    })
    return
  }
  const usesPartialKey = !ctx.literal && hasOwn(expected, '$partial')
  let partial = ctx.partial
  if (usesPartialKey) {
    if (typeof expected.$partial === 'boolean') partial = expected.$partial
    else {
      report(ctx, {
        path: displayPath(path),
        message: `invalid matcher: "$partial" must be true or false; got ${short(expected.$partial)}`,
        expected,
        actual,
      })
    }
  }
  const expectedKeys = Object.keys(expected).filter((key) => !usesPartialKey || key !== '$partial')
  if (!partial) {
    const extra = Object.keys(actual).filter((key) => !expectedKeys.includes(key))
    if (extra.length > 0) {
      report(ctx, {
        path: displayPath(path),
        message: `unexpected key${extra.length > 1 ? 's' : ''} ${extra.map((k) => JSON.stringify(k)).join(', ')} (use "$partial": true to allow extra fields)`,
        expected,
        actual,
      })
    }
  }
  const childCtx: MatchContext = { ...ctx, partial }
  for (const key of expectedKeys) {
    const childPath = appendKey(path, key)
    if (!hasOwn(actual, key)) {
      if (acceptsMissing(expected[key], childCtx)) continue
      if (isInvalidDirective(expected[key], childCtx)) {
        matchNode(expected[key], undefined, childPath, childCtx)
        continue
      }
      report(ctx, {
        path: displayPath(childPath),
        message: `missing expected key (expected ${JSON.stringify(expected[key])})`,
        expected: expected[key],
        actual: undefined,
      })
      continue
    }
    matchNode(expected[key], actual[key], childPath, childCtx)
  }
}

function matchArray(expected: JsonValue[], actual: unknown, path: string, ctx: MatchContext): void {
  if (!Array.isArray(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an array, got ${describeType(actual)}`,
      expected,
      actual,
    })
    return
  }
  const lengthOk = ctx.partial
    ? actual.length >= expected.length
    : actual.length === expected.length
  if (!lengthOk) {
    report(ctx, {
      path: displayPath(path),
      message: `expected array of length ${ctx.partial ? `>= ${expected.length}` : expected.length}, got ${actual.length}`,
      expected,
      actual,
    })
    return
  }
  for (let i = 0; i < expected.length; i++) {
    matchNode(expected[i], actual[i], appendIndex(path, i), ctx)
  }
}

// ---------------------------------------------------------------------------
// v1 directives
// ---------------------------------------------------------------------------

function matchRegexDirective(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const pattern = directive.$regex as string
  const flags = directive.flags as string | undefined
  if (typeof actual !== 'string') {
    report(ctx, {
      path: displayPath(path),
      message: `expected a string matching /${pattern}/${flags ?? ''}, got ${describeType(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch (err) {
    report(ctx, {
      path: displayPath(path),
      message: `invalid $regex pattern /${pattern}/${flags ?? ''}: ${err instanceof Error ? err.message : String(err)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (!regex.test(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected string matching /${pattern}/${flags ?? ''}, got ${JSON.stringify(actual)}`,
      expected: directive,
      actual,
    })
  }
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')
  return new RegExp(`^${body}$`)
}

function matchWildcardDirective(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const pattern = directive.$wildcard as string
  if (typeof actual !== 'string') {
    report(ctx, {
      path: displayPath(path),
      message: `expected a string matching wildcard "${pattern}", got ${describeType(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (!wildcardToRegex(pattern).test(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected string matching wildcard "${pattern}", got ${JSON.stringify(actual)}`,
      expected: directive,
      actual,
    })
  }
}

function matchUnordered(
  expected: JsonValue[],
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (!Array.isArray(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an array (unordered), got ${describeType(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (ctx.partial ? actual.length < expected.length : actual.length !== expected.length) {
    report(ctx, {
      path: displayPath(path),
      message: `expected unordered array of length ${ctx.partial ? `>= ${expected.length}` : expected.length}, got ${actual.length}`,
      expected: directive,
      actual,
    })
    return
  }
  // Bipartite matching (augmenting paths): expected[i] may take actual[j] when they match.
  const fits = expected.map((item) =>
    actual.map((candidate) => firstMismatch(item, candidate, '', ctx, ctx.partial) === undefined),
  )
  const owner = new Array<number>(actual.length).fill(-1)
  const assign = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < actual.length; j++) {
      if (!fits[i][j] || seen[j]) continue
      seen[j] = true
      if (owner[j] === -1 || assign(owner[j], seen)) {
        owner[j] = i
        return true
      }
    }
    return false
  }
  let complete = true
  for (let i = 0; i < expected.length; i++) {
    if (!assign(i, new Array<boolean>(actual.length).fill(false))) complete = false
  }
  if (complete) return

  let detail: string
  const orphan = fits.findIndex((row) => !row.some(Boolean))
  if (orphan >= 0) {
    detail = `expected value[${orphan}] ${short(expected[orphan], 60)} matches no actual element`
    // Prefer actual elements the (maximum) assignment left over: they are the likely pair.
    const leftovers = actual.map((_, j) => j).filter((j) => owner[j] === -1)
    const near =
      closest(expected[orphan], actual, leftovers, path, ctx, ctx.partial) ??
      closest(expected[orphan], actual, undefined, path, ctx, ctx.partial)
    if (near) detail += `; closest is ${describeMismatch(near.mismatch, '')}`
  } else {
    detail =
      'every expected element matches some actual element, but not all at once (each actual element can satisfy only one expected element)'
  }
  report(ctx, {
    path: displayPath(path),
    message: `no arrangement of the actual array satisfies the expected elements (unordered${ctx.partial ? ', partial' : ''}): ${detail}`,
    expected: directive,
    actual,
  })
}

// ---------------------------------------------------------------------------
// v2 directives
// ---------------------------------------------------------------------------

function matchAny(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (actual === undefined) {
    report(ctx, {
      path: displayPath(path),
      message: 'expected a value to be present ($any), got nothing',
      expected: directive,
      actual,
    })
  }
}

function hasJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return false
  }
}

function matchType(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const types = (Array.isArray(directive.$type) ? directive.$type : [directive.$type]) as string[]
  if (types.some((type) => hasJsonType(actual, type))) return
  report(ctx, {
    path: displayPath(path),
    message: `expected type ${types.join(' | ')}, got ${describeValue(actual)}`,
    expected: directive,
    actual,
  })
}

function describeBounds(bounds: Record<string, JsonValue>): string {
  const symbols: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==' }
  return NUMBER_BOUNDS.filter((key) => hasOwn(bounds, key))
    .map((key) => `${symbols[key]} ${bounds[key]}`)
    .join(' and ')
}

function matchNumber(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const bounds = directive.$number as Record<string, number>
  const range = describeBounds(bounds)
  if (typeof actual !== 'number') {
    report(ctx, {
      path: displayPath(path),
      message: `expected a number ${range}, got ${describeValue(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  const ok =
    (bounds.gt === undefined || actual > bounds.gt) &&
    (bounds.gte === undefined || actual >= bounds.gte) &&
    (bounds.lt === undefined || actual < bounds.lt) &&
    (bounds.lte === undefined || actual <= bounds.lte) &&
    (bounds.eq === undefined || actual === bounds.eq)
  if (!ok) {
    report(ctx, {
      path: displayPath(path),
      message: `expected number ${range}, got ${actual}`,
      expected: directive,
      actual,
    })
  }
}

function matchLength(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const range = parseRange(directive.$length, '"$length"') as Range
  const spec = describeRange(range)
  if (typeof actual !== 'string' && !Array.isArray(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an array or string with length ${spec}, got ${describeValue(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  // Strings count Unicode code points (like JSON Schema's minLength/maxLength).
  const length = Array.isArray(actual) ? actual.length : Array.from(actual).length
  if (!inRange(length, range)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected ${Array.isArray(actual) ? 'array' : 'string'} length ${spec}, got ${length}`,
      expected: directive,
      actual,
    })
  }
}

const SCHEMA_ERRORS_SHOWN = 3

function matchSchema(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const result = validateAgainstSchema(directive.$schema, actual)
  if (result.ok) return
  if (result.schemaError !== undefined) {
    report(ctx, {
      path: displayPath(path),
      message: `invalid matcher: $schema could not be compiled: ${result.schemaError}`,
      expected: directive,
      actual,
    })
    return
  }
  const shown = result.errors
    .slice(0, SCHEMA_ERRORS_SHOWN)
    .map((issue) => `${displayPath(joinPath(path, issue.path))} ${issue.message}`)
  const more = result.errors.length - shown.length
  report(ctx, {
    path: displayPath(path),
    message: `value does not match $schema: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`,
    expected: directive,
    actual,
  })
}

function matchContains(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const needle = directive.$contains
  const partial = typeof directive.$partial === 'boolean' ? directive.$partial : true
  const mode = partial ? '' : ' (exact)'
  const count = hasOwn(directive, 'count')
    ? (parseRange(directive.count, '"count"') as Range)
    : undefined
  if (!Array.isArray(actual)) {
    const hint =
      typeof actual === 'string' ? ' (for substrings use {"$wildcard": "*text*"} or $regex)' : ''
    report(ctx, {
      path: displayPath(path),
      message: `expected an array containing ${short(needle, 60)}, got ${describeValue(actual)}${hint}`,
      expected: directive,
      actual,
    })
    return
  }
  const hits: number[] = []
  for (let i = 0; i < actual.length; i++) {
    if (firstMismatch(needle, actual[i], '', ctx, partial) === undefined) hits.push(i)
  }
  if (count === undefined ? hits.length > 0 : inRange(hits.length, count)) return

  let message: string
  if (count === undefined) {
    message =
      actual.length === 0
        ? `expected array to contain an element matching ${short(needle, 60)}${mode}, but the array is empty`
        : `expected array to contain an element matching ${short(needle, 60)}${mode}, but none of ${plural(actual.length, 'element')} matched`
    const near = closest(needle, actual, undefined, path, ctx, partial)
    if (near) message += `; closest is ${describeMismatch(near.mismatch, '')}`
  } else {
    const where = hits.length > 0 ? ` (at ${hits.map((i) => `[${i}]`).join(', ')})` : ''
    message = `expected ${describeRange(count)} element(s) matching ${short(needle, 60)}${mode}, found ${hits.length}${where}`
  }
  report(ctx, { path: displayPath(path), message, expected: directive, actual })
}

const ONE_OF_SHOWN = 5

function matchOneOf(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const alternatives = directive.$oneOf as JsonValue[]
  const partial = typeof directive.$partial === 'boolean' ? directive.$partial : ctx.partial
  const reasons: string[] = []
  for (const alternative of alternatives) {
    const miss = firstMismatch(alternative, actual, path, ctx, partial)
    if (miss === undefined) return
    reasons.push(describeMismatch(miss, path))
  }
  const shown = reasons
    .slice(0, ONE_OF_SHOWN)
    .map((reason, i) => `#${i + 1} ${reason.length > 160 ? `${reason.slice(0, 159)}…` : reason}`)
  const more = reasons.length - shown.length
  report(ctx, {
    path: displayPath(path),
    message: `none of ${plural(alternatives.length, '$oneOf alternative')} matched: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`,
    expected: directive,
    actual,
  })
}

// ---------------------------------------------------------------------------
// Static checks & recording helpers
// ---------------------------------------------------------------------------

/**
 * Statically check an expectation for malformed matchers (bad shapes, invalid regexes,
 * uncompilable `$schema`s), including inside `$oneOf` alternatives that matching may never
 * reach. Paths point into the expectation tree (e.g. `content[0].text.$oneOf[1]`).
 * Returns an empty array when the expectation is well formed.
 */
export function lintExpectation(expected: JsonValue): Mismatch[] {
  const out: Mismatch[] = []
  lintNode(expected, '', out)
  return out
}

function lintNode(node: JsonValue, path: string, out: Mismatch[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) lintNode(node[i], appendIndex(path, i), out)
    return
  }
  if (!isPlainObject(node)) return
  const parsed = parseDirective(node)
  if (!parsed) {
    if (hasOwn(node, '$partial') && typeof node.$partial !== 'boolean') {
      out.push({
        path: displayPath(path),
        message: `invalid matcher: "$partial" must be true or false; got ${short(node.$partial)}`,
        expected: node,
      })
    }
    for (const key of Object.keys(node)) {
      if (isUnknownDollarKey(key, node[key])) {
        const near = closestMatcher(key)
        out.push({
          path: displayPath(path),
          message: `"${key}" is not a matcher;${near ? ` did you mean "${near}"?` : ` matchers are ${MATCHER_NAMES.join(', ')}.`} Use {"$literal": ...} for data with a literal $-key`,
          expected: node,
        })
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== '$partial') lintNode(child, appendKey(path, key), out)
    }
    return
  }
  if (parsed.error) {
    out.push({ path: displayPath(path), message: parsed.error, expected: node })
    return
  }
  for (const name of parsed.names) {
    if (name === '$regex') {
      try {
        new RegExp(node.$regex as string, node.flags as string | undefined)
      } catch (err) {
        out.push({
          path: displayPath(path),
          message: `invalid $regex pattern /${node.$regex}/${node.flags ?? ''}: ${err instanceof Error ? err.message : String(err)}`,
          expected: node,
        })
      }
    } else if (name === '$schema') {
      const result = validateAgainstSchema(node.$schema, null)
      if (result.schemaError !== undefined) {
        out.push({
          path: displayPath(path),
          message: `invalid matcher: $schema could not be compiled: ${result.schemaError}`,
          expected: node,
        })
      }
    } else if (name === '$contains') {
      lintNode(node.$contains, appendKey(path, '$contains'), out)
    } else if (name === '$unordered') {
      lintNode(node.value, appendKey(path, 'value'), out)
    } else if (name === '$oneOf') {
      lintNode(node.$oneOf, appendKey(path, '$oneOf'), out)
    }
  }
}

/**
 * Make recorded data safe to use as an expectation: any object that would be read as a
 * matcher (it has a key such as `$ref`, `$type`, `$regex`, `$partial`) is wrapped in
 * `{"$literal": ...}` so it is compared as plain data. Use when writing goldens from
 * live results.
 */
export function escapeDirectives(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(escapeDirectives)
  if (!isPlainObject(value)) return value
  // Any `$`-key (except a string `$schema` URI) would be read as a matcher or rejected by
  // lintExpectation as an unknown one, so the data is compared literally.
  const interpreted = Object.keys(value).some(
    (key) =>
      key === '$partial' || isDirectiveKey(key, value[key]) || isUnknownDollarKey(key, value[key]),
  )
  if (interpreted) return { $literal: value }
  const out: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) out[key] = escapeDirectives(child)
  return out
}

// ---------------------------------------------------------------------------
// $ref resolution (run by the runner before matching; never reads files itself)
// ---------------------------------------------------------------------------

/**
 * Loads a referenced fragment. `relPath` is a normalized POSIX path relative to the
 * directory of the case file (nested refs are already re-based onto that directory), or
 * an absolute path / URL when the ref was written that way.
 */
export type RefLoader = (relPath: string) => JsonValue

export class RefResolutionError extends Error {
  /** The `$ref` string as written. */
  readonly ref: string
  /** Where in the expectation tree the failing `$ref` sits (matcher path format). */
  readonly path: string
  /** Fragments being expanded when the error occurred, outermost first. */
  readonly chain: string[]

  constructor(message: string, ref: string, path: string, chain: string[]) {
    super(message)
    this.name = 'RefResolutionError'
    this.ref = ref
    this.path = path
    this.chain = chain
  }
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

function resolveRefPath(base: string, file: string): string {
  const target = file.replace(/\\/g, '/')
  if (URL_LIKE.test(target)) return target
  if (URL_LIKE.test(base)) return new URL(target, base).toString()
  if (target.startsWith('/') || /^[A-Za-z]:\//.test(target)) return posix.normalize(target)
  return posix.normalize(posix.join(base === '' ? '' : posix.dirname(base), target))
}

function readPointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '') return doc
  if (!pointer.startsWith('/')) return undefined
  let node: JsonValue | undefined = doc
  for (const raw of pointer.slice(1).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) node = node[Number(segment)]
    else if (isPlainObject(node) && hasOwn(node, segment)) node = node[segment]
    else return undefined
  }
  return node
}

/**
 * Expand every `{"$ref": "./shared/x.json"}` (optionally with a `#/json/pointer`) in an
 * expectation tree. Refs may appear anywhere and fragments may contain further refs,
 * which resolve relative to the fragment that contains them. `$schema` bodies and
 * `$literal` values are left untouched (their `$ref`s are JSON Schema refs / data).
 * Throws `RefResolutionError` on load failures, bad pointers and cycles.
 */
export function resolveRefs(expected: JsonValue, loader: RefLoader): JsonValue {
  const documents = new Map<string, JsonValue>()
  const load = (file: string): JsonValue => {
    if (!documents.has(file)) {
      const doc = loader(file)
      if (doc === undefined) throw new Error('loader returned nothing')
      documents.set(file, doc)
    }
    return documents.get(file) as JsonValue
  }

  const walk = (node: JsonValue, path: string, base: string, chain: string[]): JsonValue => {
    if (Array.isArray(node))
      return node.map((item, i) => walk(item, appendIndex(path, i), base, chain))
    if (!isPlainObject(node)) return node
    if (hasOwn(node, '$literal')) return node
    if (hasOwn(node, '$ref')) return expand(node, path, base, chain)
    const out: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(node)) {
      out[key] =
        key === '$schema' && isSchemaValue(child)
          ? child
          : walk(child, appendKey(path, key), base, chain)
    }
    return out
  }

  const expand = (
    node: Record<string, JsonValue>,
    path: string,
    base: string,
    chain: string[],
  ): JsonValue => {
    const ref = node.$ref
    const where = displayPath(path)
    const fail = (message: string): never => {
      throw new RefResolutionError(message, typeof ref === 'string' ? ref : short(ref), path, chain)
    }
    if (typeof ref !== 'string')
      return fail(`Invalid $ref at ${where}: "$ref" must be a path string, got ${short(ref)}.`)
    const extra = Object.keys(node).filter((key) => key !== '$ref')
    if (extra.length > 0) {
      return fail(
        `Invalid $ref at ${where}: a $ref object may only contain "$ref", found ${extra.map((k) => JSON.stringify(k)).join(', ')}. Move those fields into the referenced fragment or a surrounding object.`,
      )
    }
    const hash = ref.indexOf('#')
    const filePart = hash < 0 ? ref : ref.slice(0, hash)
    const pointer = hash < 0 ? '' : ref.slice(hash + 1)
    let file: string
    if (filePart === '') {
      if (base === '') {
        return fail(
          `Cannot resolve $ref "${ref}" at ${where}: same-document refs only work inside a fragment file. Point at a file instead, e.g. "./shared/fragments.json${ref}".`,
        )
      }
      file = base
    } else {
      file = resolveRefPath(base, filePart)
    }
    const key = pointer === '' ? file : `${file}#${pointer}`
    if (chain.includes(key)) {
      return fail(
        `$ref cycle at ${where}: ${[...chain, key].join(' -> ')}. Break the cycle by inlining one of the fragments.`,
      )
    }
    let doc: JsonValue
    try {
      doc = load(file)
    } catch (err) {
      return fail(
        `Cannot resolve $ref "${ref}" at ${where}: failed to load "${file}": ${err instanceof Error ? err.message : String(err)}. Ref paths are relative to the file that contains them.`,
      )
    }
    const target = readPointer(doc, pointer)
    if (target === undefined) {
      return fail(
        `Cannot resolve $ref "${ref}" at ${where}: "${file}" has nothing at pointer "#${pointer}".`,
      )
    }
    return walk(target, path, file, [...chain, key])
  }

  return walk(expected, '', '', [])
}
