/**
 * JSON Schema → tool-argument generator for `vib fuzz` (V2_SCOPE §3.5 / §3.6). Pure and
 * seeded: the same schema + seed + options always yield the same cases with the same ids.
 *
 * Four strategies:
 * - valid     schema-conforming args (examples/defaults first, then varied random samples)
 * - boundary  values at / just past declared limits, plus extreme values that must not crash
 * - invalid   one violation per case (missing required, wrong type, extra property, ...)
 * - inject    valid-shaped args whose free-form strings carry injection / control payloads
 *
 * See docs/FUZZ.md for the full behavior and how to reproduce a failing case.
 */
import { validate } from '../schema.js'
import type { JsonValue } from '../types.js'
import { KNOWN_STRING_FORMATS, formatValue, invalidFormatValue } from './formats.js'
import { INJECTION_PAYLOADS, type InjectionPayload } from './payloads.js'
import { type Rng, createRng, hashString, normalizeSeed, seedFromString } from './random.js'
import { UnsupportedPatternError, stringFromPattern, testPattern } from './regex.js'
import {
  type FlattenContext,
  type JsonObject,
  type Node,
  type TypeName,
  allowsNull,
  canonicalJson,
  flatten,
  inferTypes,
  isNullBranch,
  isObject,
  isSafeGroup,
  jsonType,
  mergeNodes,
  possibleTypes,
  resolveRef,
  typeAllowed,
} from './schema-model.js'

export { INJECTION_PAYLOADS, findEchoedPayloads, payloadById } from './payloads.js'
export type { InjectionPayload } from './payloads.js'
export { canonicalJson } from './schema-model.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Strategy = 'valid' | 'boundary' | 'invalid' | 'inject'
export type Expectation = 'success' | 'invalid-params' | 'any'

export interface GeneratedCase {
  /** `<strategy>-<hash>`; stable for a given schema + seed (content-addressed). */
  id: string
  strategy: Strategy
  args: Record<string, JsonValue>
  /**
   * success: schema-valid, the server must not answer with a protocol error.
   * invalid-params: schema-invalid, the server must reject it (InvalidParams or a tool error).
   * any: no contract either way; the server must merely survive it.
   */
  expectation: Expectation
  /** Human-readable why, e.g. "required property 'text' omitted". */
  reason: string
  /** The argument this case targets, in matcher path format ('(root)' for the args object). */
  target?: string
  /** Injection payload ids carried by this case (inject strategy only). */
  payloadIds?: string[]
}

export interface GenerateOptions {
  seed: number | string
  /** Total number of cases across all strategies (an upper bound; small schemas yield fewer). */
  count: number
  /** Default: valid, boundary, invalid. `inject` is opt-in (`vib fuzz --inject`). */
  strategies?: Strategy[]
  /** Maximum object/array nesting the generator builds (default 6). */
  maxDepth?: number
  /**
   * Validate each case with `validateAgainstSchema` (or the given predicate) and drop any
   * whose expectation would be wrong. Also restores strict expectations that were relaxed
   * to 'any' inside non-discriminated oneOf/anyOf. Recommended for the runner.
   */
  selfCheck?: boolean | ((schema: JsonValue, args: Record<string, JsonValue>) => boolean)
}

export const ALL_STRATEGIES: readonly Strategy[] = ['valid', 'boundary', 'invalid', 'inject']
export const DEFAULT_STRATEGIES: readonly Strategy[] = ['valid', 'boundary', 'invalid']
export const DEFAULT_MAX_DEPTH = 6
/** Length of the "very long string" boundary case for strings without maxLength. */
export const LONG_STRING_LENGTH = 10_000
/** Length of the "large array" boundary case for arrays without maxItems. */
export const LARGE_ARRAY_LENGTH = 1_000

export interface SchemaCheckResult {
  ok: boolean
  errors: Array<{ path: string; message: string }>
  /** Set when the schema itself could not be compiled. */
  schemaError?: string
}

/** Validate tool args against a schema (delegates to `src/schema.ts`). */
export function validateAgainstSchema(schema: JsonValue, args: unknown): SchemaCheckResult {
  const result = validate(schema, args) as SchemaCheckResult
  const out: SchemaCheckResult = {
    ok: result.ok,
    errors: (result.errors ?? []).map((e) => ({ path: e.path, message: e.message })),
  }
  if (result.schemaError !== undefined) out.schemaError = result.schemaError
  return out
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type PathSeg = string | number

const BARE_KEY = /^[A-Za-z_$][\w$-]*$/

/** Matcher-style path: `ticket.tags[0]`, `meta["a b"]`, '(root)' for []. */
export function formatPath(path: readonly PathSeg[]): string {
  if (path.length === 0) return '(root)'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else if (BARE_KEY.test(seg)) out += out === '' ? seg : `.${seg}`
    else out += `[${JSON.stringify(seg)}]`
  }
  return out
}

function preview(value: JsonValue | undefined, max = 48): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value)
}

function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

// ---------------------------------------------------------------------------
// Generation core
// ---------------------------------------------------------------------------

type Mode = 'random' | 'minimal' | 'maximal' | 'defaults'
type Flavor = 'ascii' | 'emoji' | 'rtl' | 'cjk' | 'whitespace' | 'empty' | 'mixed'
/** 0 = strict, 1 = invalid expectations unreliable (anyOf), 2 = all unreliable (oneOf). */
type Relax = 0 | 1 | 2

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'
const EMOJI = ['😀', '🎉', '🚀', '🔥', '🐱', '👍', '💡', '🌍', '🧪', '🦀']
const RTL = Array.from('שלוםעולםמרחבابالعالم')
const CJK = Array.from('漢字中文日本語テストかなカナ한국어')
const WHITESPACE = [' ', '\t', '\n', ' ', '　']
const ALPHABETS: Record<Exclude<Flavor, 'empty'>, readonly string[]> = {
  ascii: Array.from(ASCII),
  emoji: EMOJI,
  rtl: RTL,
  cjk: CJK,
  whitespace: WHITESPACE,
  mixed: [...Array.from(ASCII), ...EMOJI, ...RTL, ...CJK, ' '],
}
const FLAVOR_LABEL: Record<Flavor, string> = {
  ascii: 'ascii',
  emoji: 'emoji (astral plane)',
  rtl: 'right-to-left (Hebrew/Arabic)',
  cjk: 'CJK',
  whitespace: 'whitespace-only',
  empty: 'empty where minLength allows',
  mixed: 'mixed scripts',
}
const RANDOM_FLAVORS: readonly Flavor[] = [
  'ascii',
  'ascii',
  'ascii',
  'emoji',
  'rtl',
  'cjk',
  'whitespace',
  'empty',
  'mixed',
]
const COVERAGE_FLAVORS: readonly Flavor[] = ['cjk', 'emoji', 'rtl', 'whitespace', 'empty', 'mixed']

interface Env {
  root: JsonValue
  fctx: FlattenContext
  maxDepth: number
  seed: number
  schemaHash: string
}

interface Loc {
  path: PathSeg[]
  /** Branch-resolved node the value was generated from. */
  node: Node
  /** Types allowed here across every branch (null = unconstrained). */
  possible: TypeName[] | null
  nullOk: boolean
  value: JsonValue
  relax: Relax
}

interface Gen {
  env: Env
  rng: Rng
  mode: Mode
  flavor?: Flavor
  /** Force branch `branchIndex % n` at every oneOf/anyOf. */
  branchIndex?: number
  trace?: Loc[]
  notes: Set<string>
  relax: Relax
  maxGroup: number
}

function fillAscii(n: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  let out = ''
  for (let i = 0; i < n; i++) out += letters[i % letters.length]
  return out
}

function isKnownFormat(format: string | undefined): format is string {
  return format !== undefined && KNOWN_STRING_FORMATS.includes(format)
}

/** A string with no enum/const/pattern/known format: free text the generator may vary. */
function isFreeString(node: Node): boolean {
  return !node.enum && !node.const && node.patterns.length === 0 && !isKnownFormat(node.format)
}

function allowsExtraKey(node: Node): boolean {
  return node.additionalProperties !== false && !node.unevaluatedPropertiesFalse
}

function extraKeyName(node: Node, base: string): string {
  const matchesPattern = (key: string) =>
    Object.keys(node.patternProperties ?? {}).some((p) => testPattern(p, key))
  let key = base
  for (let i = 1; key in node.properties || matchesPattern(key); i++) key = `${base}_${i}`
  return key
}

function resolveChoices(g: Gen, raw: Node, relax: Relax): { node: Node; relax: Relax } {
  if (raw.groups.length === 0) return { node: raw, relax }
  const { fctx } = g.env
  let node: Node = { ...raw, groups: [] }
  const pending = [...raw.groups]
  let r = relax
  for (let guard = 0; pending.length > 0 && guard < 32; guard++) {
    const group = pending.shift() as (typeof pending)[number]
    g.maxGroup = Math.max(g.maxGroup, group.branches.length)
    if (!isSafeGroup(group, fctx)) r = Math.max(r, group.kind === 'oneOf' ? 2 : 1) as Relax
    const branches = group.branches.map((b, i) => ({ i, node: flatten(b, fctx) }))
    let order: typeof branches
    if (g.branchIndex !== undefined) {
      const start = g.branchIndex % branches.length
      order = [...branches.slice(start), ...branches.slice(0, start)]
    } else {
      order = g.rng.shuffle(branches)
      const preferNonNull = g.mode !== 'random' || g.rng.chance(0.8)
      if (preferNonNull) {
        order = [
          ...order.filter((b) => !isNullBranch(b.node, fctx)),
          ...order.filter((b) => isNullBranch(b.node, fctx)),
        ]
      }
    }
    let chosen: Node | undefined
    for (const candidate of order) {
      const merged = mergeNodes(node, candidate.node)
      if (!merged.never) {
        chosen = merged
        break
      }
    }
    chosen ??= mergeNodes(node, (order[0] as (typeof order)[number]).node)
    pending.push(...chosen.groups)
    node = { ...chosen, groups: [] }
  }
  if (r > g.relax) g.relax = r
  return { node, relax: r }
}

function genValue(
  g: Gen,
  schema: JsonValue | undefined,
  path: PathSeg[],
  depth: number,
  relax: Relax,
): JsonValue {
  const raw = flatten(schema, g.env.fctx)
  const resolved = resolveChoices(g, raw, relax)
  let node = resolved.node
  if (path.length === 0 && (node.types === null || node.types.includes('object'))) {
    node = { ...node, types: ['object'] } // MCP tool arguments are always an object
  }
  let loc: Loc | undefined
  if (g.trace) {
    loc = {
      path,
      node,
      possible: possibleTypes(raw, g.env.fctx),
      nullOk: allowsNull(raw, g.env.fctx),
      value: null,
      relax: resolved.relax,
    }
    g.trace.push(loc)
  }
  const value = genNode(g, node, path, depth, resolved.relax)
  if (loc) loc.value = value
  return value
}

function annotationSample(node: Node): JsonValue | undefined {
  if (node.default !== undefined) return node.default.value
  if (node.examples.length > 0) return node.examples[0]
  return undefined
}

function genNode(g: Gen, node: Node, path: PathSeg[], depth: number, relax: Relax): JsonValue {
  const { rng } = g
  if (node.never) {
    g.notes.add('unsatisfiable subschema')
    return null
  }
  if (node.const) return clone(node.const.value)
  if (path.length > 0) {
    const sample = annotationSample(node)
    if (
      sample !== undefined &&
      (g.mode === 'defaults' || (g.mode === 'random' && rng.chance(0.2)))
    ) {
      g.notes.add(node.default !== undefined ? 'property default' : 'property example')
      return clone(sample)
    }
  }
  if (node.enum) {
    const typed = node.types
      ? node.enum.filter((v) => typeAllowed(node.types, jsonType(v)))
      : node.enum
    const pool = typed.length > 0 ? typed : node.enum
    return clone(rng.pick(pool))
  }
  const types = inferTypes(node)
  let type: TypeName
  if (types === null) {
    type =
      g.mode === 'random' ? rng.pick(['string', 'integer', 'number', 'boolean'] as const) : 'string'
  } else {
    const nonNull = types.filter((t) => t !== 'null')
    if (nonNull.length === 0) type = 'null'
    else if (types.includes('null') && g.mode === 'random' && rng.chance(0.15)) type = 'null'
    else type = g.mode === 'random' ? rng.pick(nonNull) : (nonNull[0] as TypeName)
  }
  switch (type) {
    case 'null':
      return null
    case 'boolean':
      return rng.bool()
    case 'integer':
      return genNumber(g, node, true)
    case 'number':
      return genNumber(g, node, false)
    case 'string':
      return genString(g, node)
    case 'array':
      return genArray(g, node, path, depth, relax)
    case 'object':
      return genObject(g, node, path, depth, relax)
  }
}

function includeOptional(g: Gen, schema: JsonValue | undefined): boolean {
  switch (g.mode) {
    case 'maximal':
      return true
    case 'minimal':
      return false
    case 'defaults':
      return annotationSample(flatten(schema, g.env.fctx)) !== undefined
    case 'random':
      return g.rng.chance(0.5)
  }
}

function genObject(g: Gen, node: Node, path: PathSeg[], depth: number, relax: Relax): JsonValue {
  const required = new Set(node.required)
  const keys = [
    ...Object.keys(node.properties),
    ...node.required.filter((k) => !(k in node.properties)),
  ]
  const deep = depth >= g.env.maxDepth
  const chosen = new Set<string>()
  for (const key of keys) {
    if (required.has(key) || (!deep && includeOptional(g, node.properties[key]))) chosen.add(key)
  }
  if (node.minProperties !== undefined) {
    for (const key of keys) {
      if (chosen.size >= node.minProperties) break
      chosen.add(key)
    }
  }
  const deps = node.dependentRequired
  if (deps) {
    for (let changed = true; changed; ) {
      changed = false
      for (const key of [...chosen]) {
        for (const dep of deps[key] ?? []) {
          if (!chosen.has(dep)) {
            chosen.add(dep)
            if (!keys.includes(dep)) keys.push(dep)
            changed = true
          }
        }
      }
    }
  }
  if (node.maxProperties !== undefined) {
    const neededBy = (key: string) =>
      [...chosen].some((k) => k !== key && (deps?.[k] ?? []).includes(key))
    for (const key of [...chosen].reverse()) {
      if (chosen.size <= node.maxProperties) break
      if (!required.has(key) && !neededBy(key)) chosen.delete(key)
    }
  }
  const addl = node.additionalProperties
  const out: JsonObject = {}
  for (const key of keys) {
    if (!chosen.has(key)) continue
    const schema = key in node.properties ? node.properties[key] : isObject(addl) ? addl : true
    out[key] = genValue(g, schema, [...path, key], depth + 1, relax)
  }
  // Map-like objects (additionalProperties is a schema) get a few generated keys.
  let extras = 0
  if (isObject(addl) && !node.unevaluatedPropertiesFalse && !deep) {
    extras = g.mode === 'maximal' ? 1 : g.mode === 'random' ? g.rng.int(0, 2) : 0
  }
  const size = Object.keys(out).length
  if (
    node.minProperties !== undefined &&
    size + extras < node.minProperties &&
    allowsExtraKey(node)
  ) {
    extras = node.minProperties - size
  }
  if (node.maxProperties !== undefined)
    extras = Math.max(0, Math.min(extras, node.maxProperties - size))
  for (let i = 0; i < extras; i++) {
    const key = extraKeyName(node, `key${i + 1}`)
    out[key] = genValue(g, isObject(addl) ? addl : true, [...path, key], depth + 1, relax)
  }
  return out
}

function genArray(
  g: Gen,
  node: Node,
  path: PathSeg[],
  depth: number,
  relax: Relax,
  forcedLength?: number,
): JsonValue[] {
  const prefix = node.prefixItems ?? []
  const minI = node.minItems ?? 0
  let maxI = node.maxItems ?? Number.POSITIVE_INFINITY
  if (node.items === false) maxI = Math.min(maxI, prefix.length)
  let len: number
  if (forcedLength !== undefined) len = forcedLength
  else if (depth >= g.env.maxDepth || g.mode === 'minimal') len = minI
  else if (g.mode === 'maximal') len = Math.min(Math.max(minI, 1, Math.min(prefix.length, 4)), maxI)
  else len = g.rng.int(minI, Math.min(maxI, minI + 3))
  if (forcedLength === undefined && node.contains !== undefined && len === 0 && maxI >= 1) len = 1
  const out: JsonValue[] = []
  const seen = new Set<string>()
  for (let i = 0; i < len; i++) {
    let schema: JsonValue = i < prefix.length ? (prefix[i] as JsonValue) : (node.items ?? true)
    if (i === 0 && node.contains !== undefined && i >= prefix.length)
      schema = { allOf: [schema, node.contains] }
    const mark = g.trace?.length ?? 0
    let value = genValue(g, schema, [...path, i], depth + 1, relax)
    if (node.uniqueItems) {
      for (let tries = 0; seen.has(canonicalJson(value)) && tries < 12; tries++) {
        if (g.trace) g.trace.length = mark
        value = genValue(g, schema, [...path, i], depth + 1, relax)
      }
      seen.add(canonicalJson(value))
    }
    out.push(value)
  }
  return out
}

function genString(g: Gen, node: Node): string {
  const { rng } = g
  const minL = node.minLength ?? 0
  const maxL = node.maxLength ?? Number.POSITIVE_INFINITY
  const lengthOk = (s: string) => {
    const n = codePointLength(s)
    return n >= minL && n <= maxL
  }
  if (node.patterns.length > 0) return genPatternString(g, node, lengthOk)
  if (isKnownFormat(node.format)) {
    let value = ''
    for (let i = 0; i < 8; i++) {
      value = formatValue(node.format, rng) ?? ''
      if (lengthOk(value)) return value
    }
    return value
  }
  let flavor: Flavor = g.flavor ?? (g.mode === 'random' ? rng.pick(RANDOM_FLAVORS) : 'ascii')
  if (flavor === 'empty') {
    if (minL === 0) {
      g.notes.add(flavor)
      return ''
    }
    flavor = 'ascii'
  }
  let len: number
  if (maxL === 0) len = 0
  else if (g.mode === 'minimal') len = Math.max(minL, 1)
  else {
    const lo = Math.max(minL, 1)
    len = rng.int(lo, Math.max(lo, Math.min(maxL, lo + 12)))
  }
  g.notes.add(flavor)
  return rng.string(len, ALPHABETS[flavor])
}

function genPatternString(g: Gen, node: Node, lengthOk: (s: string) => boolean): string {
  const { rng } = g
  const matchesAll = (s: string) => node.patterns.every((p) => testPattern(p, s))
  const primary = node.patterns[0] as string
  let last = ''
  try {
    for (let attempt = 0; attempt < 24; attempt++) {
      last = stringFromPattern(primary, rng, { short: attempt >= 12 })
      if (matchesAll(last) && lengthOk(last)) return last
    }
  } catch (err) {
    if (!(err instanceof UnsupportedPatternError)) throw err
  }
  for (const sample of [node.default?.value, ...node.examples]) {
    if (typeof sample === 'string' && matchesAll(sample) && lengthOk(sample)) {
      g.notes.add('pattern via example/default')
      return sample
    }
  }
  const minL = node.minLength ?? 0
  const maxL = Math.min(node.maxLength ?? minL + 12, minL + 12)
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = rng.string(rng.int(minL, Math.max(minL, maxL)), ALPHABETS.ascii)
    if (matchesAll(candidate) && lengthOk(candidate)) return candidate
  }
  g.notes.add('pattern could not be satisfied')
  return last
}

// --- numbers ---------------------------------------------------------------

interface NumRange {
  lo?: number
  loExcl: boolean
  hi?: number
  hiExcl: boolean
}

function numericRange(node: Node): NumRange {
  let lo = node.minimum
  let loExcl = false
  if (node.exclusiveMinimum !== undefined && (lo === undefined || node.exclusiveMinimum >= lo)) {
    lo = node.exclusiveMinimum
    loExcl = true
  }
  let hi = node.maximum
  let hiExcl = false
  if (node.exclusiveMaximum !== undefined && (hi === undefined || node.exclusiveMaximum <= hi)) {
    hi = node.exclusiveMaximum
    hiExcl = true
  }
  return { lo, loExcl, hi, hiExcl }
}

function isIntegerOnly(node: Node): boolean {
  return node.types?.includes('integer') === true && !node.types.includes('number')
}

/** Ajv's multipleOf semantics: value / m must be an exact integer. */
function isMultiple(value: number, m: number | undefined): boolean {
  return m === undefined || Number.isInteger(value / m)
}

function satisfiesNumber(node: Node, v: number, integer: boolean): boolean {
  if (!Number.isFinite(v)) return false
  if (integer && !Number.isInteger(v)) return false
  const r = numericRange(node)
  if (r.lo !== undefined && (r.loExcl ? v <= r.lo : v < r.lo)) return false
  if (r.hi !== undefined && (r.hiExcl ? v >= r.hi : v > r.hi)) return false
  return isMultiple(v, node.multipleOf)
}

function tidy(x: number): number {
  return Number.parseFloat(x.toPrecision(12))
}

/** Smallest (or largest) value satisfying the node, if it has that bound. */
function extremeValid(node: Node, integer: boolean, side: 'min' | 'max'): number | undefined {
  const r = numericRange(node)
  const bound = side === 'min' ? r.lo : r.hi
  const excl = side === 'min' ? r.loExcl : r.hiExcl
  if (bound === undefined) return undefined
  const dir = side === 'min' ? 1 : -1
  const m = node.multipleOf
  let v: number
  if (m !== undefined) {
    let k = side === 'min' ? Math.ceil(bound / m) : Math.floor(bound / m)
    v = tidy(k * m)
    for (let i = 0; i < 4 && !satisfiesNumber(node, v, integer); i++) {
      k += dir
      v = tidy(k * m)
    }
  } else if (integer) {
    v =
      side === 'min'
        ? excl
          ? Math.floor(bound) + 1
          : Math.ceil(bound)
        : excl
          ? Math.ceil(bound) - 1
          : Math.floor(bound)
  } else if (excl) {
    const other = side === 'min' ? r.hi : r.lo
    const step = other !== undefined ? Math.min(0.001, Math.abs(other - bound) / 2) : 0.001
    v = bound + dir * step
  } else {
    v = bound
  }
  return satisfiesNumber(node, v, integer) ? v : undefined
}

function genNumber(g: Gen, node: Node, integer: boolean): number {
  const { rng } = g
  const r = numericRange(node)
  const lo = r.lo ?? Number.NEGATIVE_INFINITY
  const hi = r.hi ?? Number.POSITIVE_INFINITY
  let wLo: number
  let wHi: number
  if (lo <= 0 && hi >= 0) {
    wLo = Math.max(lo, -100)
    wHi = Math.min(hi, 100)
  } else if (lo > 0) {
    wLo = lo
    wHi = Math.min(hi, lo + 200)
  } else {
    wHi = hi
    wLo = Math.max(lo, hi - 200)
  }
  const m = node.multipleOf
  for (let attempt = 0; attempt < 32; attempt++) {
    let v: number
    if (m !== undefined) {
      v = tidy(rng.int(Math.ceil(wLo / m), Math.floor(wHi / m)) * m)
    } else if (integer || rng.chance(0.4)) {
      v = rng.int(Math.ceil(wLo), Math.floor(wHi))
    } else {
      v = Math.round(rng.float(wLo, wHi) * 100) / 100
    }
    if (Object.is(v, -0)) v = 0
    if (satisfiesNumber(node, v, integer)) return v
  }
  return extremeValid(node, integer, 'min') ?? extremeValid(node, integer, 'max') ?? 0
}

// ---------------------------------------------------------------------------
// Building bases
// ---------------------------------------------------------------------------

interface Built {
  args: Record<string, JsonValue>
  trace: Loc[]
  gen: Gen
}

function rngFor(env: Env, label: string): Rng {
  return createRng(seedFromString(`${env.seed}|${label}`))
}

function newGen(env: Env, label: string, mode: Mode, extra: Partial<Gen> = {}): Gen {
  return {
    env,
    rng: rngFor(env, label),
    mode,
    notes: new Set(),
    relax: 0,
    maxGroup: 0,
    ...extra,
  }
}

function build(
  env: Env,
  label: string,
  mode: Mode,
  extra: { flavor?: Flavor; branchIndex?: number } = {},
): Built {
  const trace: Loc[] = []
  const gen = newGen(env, label, mode, { ...extra, trace })
  const value = genValue(gen, env.root, [], 0, 0)
  return { args: isObject(value) ? value : {}, trace, gen }
}

// ---------------------------------------------------------------------------
// Candidates & mutations
// ---------------------------------------------------------------------------

interface Candidate {
  args: Record<string, JsonValue>
  intended: Expectation
  relax: Relax
  reason: string
  target?: string
  payloadIds?: string[]
}

interface Mutation {
  path: PathSeg[]
  op: 'set' | 'omit' | 'add'
  key?: string
  value?: JsonValue
  intended: Expectation
  relax: Relax
  reason: string
}

function getAt(root: JsonValue, path: readonly PathSeg[]): JsonValue | undefined {
  let node: JsonValue | undefined = root
  for (const seg of path) {
    if (Array.isArray(node) && typeof seg === 'number') node = node[seg]
    else if (isObject(node) && typeof seg === 'string') node = node[seg]
    else return undefined
  }
  return node
}

function applyMutation(args: Record<string, JsonValue>, m: Mutation): Record<string, JsonValue> {
  const copy = clone(args)
  if (m.op === 'add') {
    const target = getAt(copy, m.path)
    if (isObject(target) && m.key !== undefined) target[m.key] = m.value as JsonValue
    return copy
  }
  if (m.path.length === 0) return copy
  const parent = getAt(copy, m.path.slice(0, -1))
  const last = m.path[m.path.length - 1] as PathSeg
  if (m.op === 'omit') {
    if (isObject(parent) && typeof last === 'string') delete parent[last]
  } else if (Array.isArray(parent) && typeof last === 'number') {
    parent[last] = m.value as JsonValue
  } else if (isObject(parent) && typeof last === 'string') {
    parent[last] = m.value as JsonValue
  }
  return copy
}

function quoted(path: readonly PathSeg[]): string {
  return `'${formatPath(path)}'`
}

function boundaryMutations(loc: Loc, mg: Gen): Mutation[] {
  const { node, value, path, relax } = loc
  const out: Mutation[] = []
  const at = quoted(path)
  const set = (v: JsonValue, intended: Expectation, reason: string) =>
    out.push({ path, op: 'set', value: v, intended, relax, reason: `${at}: ${reason}` })
  const t = jsonType(value)
  if (path.length > 0 && t === 'string' && isFreeString(node)) {
    const minL = node.minLength
    const maxL = node.maxLength
    if (minL !== undefined && minL > 0) {
      set(fillAscii(minL), 'success', `minLength ${minL} exactly`)
      set(
        fillAscii(minL - 1),
        'invalid-params',
        `minLength ${minL} violated by 1 (length ${minL - 1})`,
      )
    } else {
      set('', 'success', 'empty string (no minLength)')
    }
    if (maxL !== undefined) {
      if (maxL <= 100_000) set(fillAscii(maxL), 'success', `maxLength ${maxL} exactly`)
      set(fillAscii(maxL + 1), 'invalid-params', `maxLength ${maxL} exceeded by 1`)
      if (maxL >= 1 && maxL <= LONG_STRING_LENGTH) {
        set(
          EMOJI[0]?.repeat(maxL) ?? '',
          'any',
          `maxLength ${maxL} exactly in astral-plane emoji (JSON Schema counts code points; UTF-16 length is ${maxL * 2})`,
        )
      }
    } else {
      set(
        fillAscii(LONG_STRING_LENGTH),
        'any',
        `very long string (${LONG_STRING_LENGTH} chars, no maxLength) must not crash`,
      )
    }
  }
  if (
    path.length > 0 &&
    t === 'string' &&
    isKnownFormat(node.format) &&
    !node.enum &&
    !node.const &&
    node.patterns.length === 0
  ) {
    const bad = invalidFormatValue(node.format)
    set(
      bad,
      'any',
      `format '${node.format}' violated (${preview(bad)}); format is an annotation in 2020-12, servers may accept it`,
    )
  }
  if (path.length > 0 && (t === 'integer' || t === 'number') && !node.enum && !node.const) {
    const integer = isIntegerOnly(node)
    const r = numericRange(node)
    const m = node.multipleOf
    const ok = (v: number) => satisfiesNumber(node, v, integer)
    const mult = m !== undefined ? `, multipleOf ${m}` : ''
    if (r.lo !== undefined) {
      const v = extremeValid(node, integer, 'min')
      if (!r.loExcl) {
        if (v !== undefined) {
          set(
            v,
            'success',
            v === r.lo
              ? `minimum ${r.lo} exactly`
              : `smallest valid value ${v} (minimum ${r.lo}${mult})`,
          )
        }
        const below = integer ? Math.ceil(r.lo) - 1 : r.lo - 1
        set(below, 'invalid-params', `minimum ${r.lo} violated by ${tidy(r.lo - below)} (${below})`)
      } else {
        set(r.lo, 'invalid-params', `exclusiveMinimum ${r.lo} violated (value equal to the bound)`)
        if (v !== undefined)
          set(v, 'success', `exclusiveMinimum ${r.lo}: smallest valid value ${v}`)
      }
    } else {
      set(
        integer ? -Number.MAX_SAFE_INTEGER : -1e308,
        'any',
        'very large negative value (no minimum) must not crash',
      )
    }
    if (r.hi !== undefined) {
      const v = extremeValid(node, integer, 'max')
      if (!r.hiExcl) {
        if (v !== undefined) {
          set(
            v,
            'success',
            v === r.hi
              ? `maximum ${r.hi} exactly`
              : `largest valid value ${v} (maximum ${r.hi}${mult})`,
          )
        }
        const above = integer ? Math.floor(r.hi) + 1 : r.hi + 1
        set(above, 'invalid-params', `maximum ${r.hi} exceeded by ${tidy(above - r.hi)} (${above})`)
      } else {
        set(r.hi, 'invalid-params', `exclusiveMaximum ${r.hi} violated (value equal to the bound)`)
        if (v !== undefined) set(v, 'success', `exclusiveMaximum ${r.hi}: largest valid value ${v}`)
      }
    } else {
      set(
        integer ? Number.MAX_SAFE_INTEGER : 1e308,
        'any',
        'very large value (no maximum) must not crash',
      )
    }
    if (ok(0)) set(0, 'success', 'zero')
    if (ok(-1)) set(-1, 'success', 'negative value (-1)')
    if (integer) {
      const anchor = extremeValid(node, integer, 'min') ?? extremeValid(node, integer, 'max') ?? 0
      set(anchor + 0.5, 'invalid-params', `expected integer, got float ${anchor + 0.5}`)
    }
    if (m !== undefined && !(integer && m === 1)) {
      const anchor = extremeValid(node, integer, 'min') ?? extremeValid(node, integer, 'max') ?? 0
      // Integers: step by 1 so only multipleOf is violated, not the integer type too.
      const v = integer && Number.isInteger(m) ? anchor + 1 : tidy(anchor + m / 2)
      if (!isMultiple(v, m) && !(integer && !Number.isInteger(v))) {
        set(v, 'invalid-params', `multipleOf ${m} violated (${v})`)
      }
    }
  }
  if (path.length > 0 && t === 'array') {
    const minI = node.minItems
    const maxI = node.maxItems
    const make = (n: number) => genArray(mg, node, path, path.length, relax, n)
    if (minI !== undefined && minI > 0) {
      set(make(minI), 'success', `minItems ${minI} exactly`)
      set(make(minI - 1), 'invalid-params', `minItems ${minI} violated (${minI - 1} items)`)
    } else if (node.contains === undefined) {
      set([], 'success', 'empty array (no minItems)')
    }
    if (maxI !== undefined) {
      if (maxI <= LARGE_ARRAY_LENGTH && maxI !== minI && maxI > 0)
        set(make(maxI), 'success', `maxItems ${maxI} exactly`)
      if (maxI < LARGE_ARRAY_LENGTH)
        set(make(maxI + 1), 'invalid-params', `maxItems ${maxI} exceeded by 1`)
    } else {
      set(
        make(LARGE_ARRAY_LENGTH),
        'any',
        `large array (${LARGE_ARRAY_LENGTH} items, no maxItems) must not crash`,
      )
    }
    if (node.uniqueItems && (maxI ?? 2) >= 2) {
      const arr =
        Array.isArray(value) && value.length > 0 ? clone(value) : make(Math.max(1, minI ?? 1))
      if (arr.length > 0) {
        if (arr.length >= 2) arr[1] = clone(arr[0] as JsonValue)
        else arr.push(clone(arr[0] as JsonValue))
        set(arr, 'invalid-params', 'uniqueItems violated (duplicate item)')
      }
    }
  }
  if (t === 'object' && allowsExtraKey(node)) {
    const key = extraKeyName(node, 'vib_deep')
    let deep: JsonValue = { leaf: true }
    for (let i = mg.env.maxDepth; i >= 1; i--) deep = { depth: i, child: deep }
    out.push({
      path,
      op: 'add',
      key,
      value: deep,
      intended: 'any',
      relax,
      reason: `${at}: deeply nested object (depth ${mg.env.maxDepth}) in extra property '${key}' must not crash`,
    })
  }
  return out
}

const WRONG_TYPE_CANDIDATES: Record<TypeName, JsonValue[]> = {
  string: [12345, true, ['vib'], { vib: true }],
  integer: ['42', true, [1]],
  number: ['3.14', true, [1]],
  boolean: ['true', 1, []],
  array: ['a,b', { '0': 'a' }, 7],
  object: ['{}', [], 7],
  null: [0, 'null', false],
}

function wrongTypeValue(actual: TypeName, possible: TypeName[]): JsonValue | undefined {
  const primary: TypeName =
    actual === 'integer' && !possible.includes('integer') ? 'number' : actual
  const candidates = [...(WRONG_TYPE_CANDIDATES[primary] ?? []), 'vib', 7, true, [], {}]
  return candidates.find((c) => c !== null && !typeAllowed(possible, jsonType(c)))
}

function enumViolation(values: JsonValue[]): JsonValue {
  const keys = new Set(values.map(canonicalJson))
  if (values.length > 0 && values.every((v) => typeof v === 'number')) {
    return Math.max(...(values as number[])) + 1
  }
  if (values.length === 1 && typeof values[0] === 'boolean') return !values[0]
  let candidate = 'vib_not_in_enum'
  while (keys.has(canonicalJson(candidate))) candidate += '_x'
  return candidate
}

function constViolation(value: JsonValue): JsonValue {
  if (typeof value === 'string') return `${value}_vib`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (value === null) return 'vib_not_null'
  return 'vib_not_const'
}

const PATTERN_BREAKERS = ['', ' ', '!!!', '~', 'vib invalid value', '0', 'A', 'a', '\u0000']

function patternViolation(patterns: string[]): string | undefined {
  return PATTERN_BREAKERS.find((s) => !patterns.every((p) => testPattern(p, s)))
}

function invalidMutations(loc: Loc): Mutation[] {
  const { node, value, path, possible, relax } = loc
  const out: Mutation[] = []
  const at = quoted(path)
  const set = (v: JsonValue, reason: string) =>
    out.push({ path, op: 'set', value: v, intended: 'invalid-params', relax, reason })
  const t = jsonType(value)
  if (t === 'object' && isObject(value)) {
    for (const key of node.required) {
      if (key in value) {
        out.push({
          path: [...path, key],
          op: 'omit',
          intended: 'invalid-params',
          relax,
          reason: `required property ${quoted([...path, key])} omitted`,
        })
      }
    }
    if (!allowsExtraKey(node)) {
      const key = extraKeyName(node, 'vib_extra')
      const keyword =
        node.additionalProperties === false ? 'additionalProperties' : 'unevaluatedProperties'
      out.push({
        path,
        op: 'add',
        key,
        value: 'unexpected',
        intended: 'invalid-params',
        relax,
        reason: `additional property '${key}' not allowed at ${formatPath(path)} (${keyword}: false)`,
      })
    }
    if (path.length > 0 && (node.required.length > 0 || !allowsExtraKey(node))) {
      const parts: string[] = []
      if (node.required.length > 0) parts.push(`missing required ${node.required.join(', ')}`)
      if (!allowsExtraKey(node)) parts.push("unexpected key 'vib_unexpected'")
      set({ vib_unexpected: true }, `wrong-shape object for ${at} (${parts.join('; ')})`)
    }
  }
  if (path.length === 0) return out
  if (possible !== null) {
    const wrong = wrongTypeValue(t, possible)
    if (wrong !== undefined) {
      set(
        wrong,
        `wrong type for ${at}: expected ${possible.join(' | ')}, got ${jsonType(wrong)} (${preview(wrong)})`,
      )
    }
  }
  if (!loc.nullOk && value !== null) set(null, `null for non-nullable ${at}`)
  if (node.enum && node.enum.length > 0) {
    const bad = enumViolation(node.enum)
    set(bad, `enum violation for ${at}: ${preview(bad)} not in ${preview(node.enum, 80)}`)
  } else if (node.const) {
    const bad = constViolation(node.const.value)
    set(
      bad,
      `const violation for ${at}: expected ${preview(node.const.value)}, got ${preview(bad)}`,
    )
  }
  if (t === 'string' && node.patterns.length > 0) {
    const bad = patternViolation(node.patterns)
    const failing = node.patterns.find((p) => bad !== undefined && !testPattern(p, bad))
    if (bad !== undefined && failing !== undefined) {
      set(bad, `pattern /${failing}/ violated for ${at} by ${preview(bad)}`)
    }
  }
  return out
}

/** Round-robin across locations so a small budget still touches every argument. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i] as T)
  }
  return out
}

function collectMutations(
  env: Env,
  base: Built,
  strategy: 'boundary' | 'invalid',
  label: string,
): Mutation[] {
  const mg = newGen(env, `${label}|mutations`, 'random')
  const lists = base.trace.map((loc) =>
    strategy === 'boundary' ? boundaryMutations(loc, mg) : invalidMutations(loc),
  )
  return interleave(lists)
}

function fromMutation(base: Built, m: Mutation, suffix = ''): Candidate {
  return {
    args: applyMutation(base.args, m),
    intended: m.intended,
    relax: m.relax,
    reason: `${m.reason}${suffix}`,
    target: formatPath(m.path),
  }
}

function countOptional(
  env: Env,
  args: Record<string, JsonValue>,
): { included: number; total: number } {
  const root = flatten(env.root, env.fctx)
  const optional = Object.keys(root.properties).filter((k) => !root.required.includes(k))
  return { included: optional.filter((k) => k in args).length, total: optional.length }
}

function stringNotes(gen: Gen): string {
  const flavors = [...gen.notes].filter((n) => n in FLAVOR_LABEL)
  const other = [...gen.notes].filter((n) => !(n in FLAVOR_LABEL))
  const parts: string[] = []
  if (flavors.length > 0) parts.push(`strings: ${flavors.join(', ')}`)
  parts.push(...other)
  return parts.join('; ')
}

function* validCandidates(env: Env): Generator<Candidate | null> {
  const root = flatten(env.root, env.fctx)
  for (const [i, example] of root.examples.entries()) {
    if (isObject(example)) {
      yield {
        args: clone(example),
        intended: 'success',
        relax: 0,
        reason: `schema examples[${i}]`,
        target: '(root)',
      }
    }
  }
  if (root.default && isObject(root.default.value)) {
    yield {
      args: clone(root.default.value),
      intended: 'success',
      relax: 0,
      reason: 'schema default',
      target: '(root)',
    }
  }
  const hasAnnotations = Object.values(root.properties).some(
    (p) => annotationSample(flatten(p, env.fctx)) !== undefined,
  )
  if (hasAnnotations) {
    const b = build(env, 'valid|defaults', 'defaults')
    yield {
      args: b.args,
      intended: 'success',
      relax: b.gen.relax,
      reason: 'property defaults/examples',
    }
  }
  const minimal = build(env, 'valid|minimal', 'minimal')
  yield {
    args: minimal.args,
    intended: 'success',
    relax: minimal.gen.relax,
    reason: `only required properties (${root.required.length})`,
  }
  const maximal = build(env, 'valid|maximal', 'maximal')
  yield {
    args: maximal.args,
    intended: 'success',
    relax: maximal.gen.relax,
    reason: `all optional properties present (nested up to depth ${env.maxDepth})`,
  }
  for (let i = 0; i < Math.min(maximal.gen.maxGroup, 16); i++) {
    const b = build(env, `valid|branch:${i}`, 'maximal', { branchIndex: i })
    yield {
      args: b.args,
      intended: 'success',
      relax: b.gen.relax,
      reason: `oneOf/anyOf branch #${i + 1} at every choice`,
    }
  }
  const hasFreeStrings = maximal.trace.some(
    (l) => typeof l.value === 'string' && isFreeString(l.node),
  )
  if (hasFreeStrings) {
    for (const flavor of COVERAGE_FLAVORS) {
      const b = build(env, `valid|flavor:${flavor}`, 'maximal', { flavor })
      yield {
        args: b.args,
        intended: 'success',
        relax: b.gen.relax,
        reason: `all free-form strings ${FLAVOR_LABEL[flavor]}`,
      }
    }
  }
  for (let i = 0; ; i++) {
    const b = build(env, `valid|random:${i}`, 'random')
    const { included, total } = countOptional(env, b.args)
    const notes = stringNotes(b.gen)
    yield {
      args: b.args,
      intended: 'success',
      relax: b.gen.relax,
      reason: `random valid sample #${i + 1} (${included}/${total} optional properties${notes ? `; ${notes}` : ''})`,
    }
  }
}

function* mutationCandidates(
  env: Env,
  strategy: 'boundary' | 'invalid',
): Generator<Candidate | null> {
  const base = build(env, 'base', 'maximal')
  const systematic = collectMutations(env, base, strategy, `${strategy}|base`)
  if (systematic.length === 0) return
  for (const m of systematic) yield fromMutation(base, m)
  for (let i = 0; ; i++) {
    const b = build(env, `${strategy}|random:${i}`, i % 2 === 0 ? 'maximal' : 'random')
    const all = collectMutations(env, b, strategy, `${strategy}|random:${i}`)
    if (all.length === 0) {
      yield null
      continue
    }
    const m = rngFor(env, `${strategy}|pick:${i}`).pick(all)
    yield fromMutation(b, m, ` (random base #${i + 1})`)
  }
}

function freeStringLocs(base: Built): Loc[] {
  return base.trace.filter(
    (l) => l.path.length > 0 && typeof l.value === 'string' && isFreeString(l.node),
  )
}

function listPaths(locs: Loc[], max = 5): string {
  const names = locs.slice(0, max).map((l) => formatPath(l.path))
  return locs.length > max ? `${names.join(', ')}, +${locs.length - max} more` : names.join(', ')
}

function* injectCandidates(env: Env): Generator<Candidate | null> {
  const base = build(env, 'base', 'maximal')
  const locs = freeStringLocs(base)
  if (locs.length === 0) return
  const fill = (b: Built, targets: Loc[], payloadFor: (i: number) => InjectionPayload) => {
    let args = b.args
    targets.forEach((loc, i) => {
      args = applyMutation(args, {
        path: loc.path,
        op: 'set',
        value: payloadFor(i).value,
        intended: 'any',
        relax: 0,
        reason: '',
      })
    })
    return args
  }
  for (const payload of INJECTION_PAYLOADS) {
    yield {
      args: fill(base, locs, () => payload),
      intended: 'any',
      relax: 0,
      reason: `injection payload '${payload.id}' (${payload.title}) in ${locs.length} string field(s): ${listPaths(locs)}`,
      target: listPaths(locs),
      payloadIds: [payload.id],
    }
  }
  for (let i = 0; ; i++) {
    const b = build(env, `inject|random:${i}`, i % 2 === 0 ? 'maximal' : 'random')
    const targets = freeStringLocs(b)
    if (targets.length === 0) {
      yield null
      continue
    }
    const rng = rngFor(env, `inject|pick:${i}`)
    const chosen = targets.map(() => rng.pick(INJECTION_PAYLOADS))
    const pairs = targets
      .slice(0, 4)
      .map((l, k) => `${formatPath(l.path)}←${(chosen[k] as InjectionPayload).id}`)
    yield {
      args: fill(b, targets, (k) => chosen[k] as InjectionPayload),
      intended: 'any',
      relax: 0,
      reason: `mixed injection payloads: ${pairs.join(', ')}${targets.length > 4 ? ', …' : ''}`,
      target: listPaths(targets),
      payloadIds: [...new Set(chosen.map((p) => p.id))],
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const MAX_MISSES = 64

type Checker = (args: Record<string, JsonValue>) => boolean | undefined

class Stream {
  private readonly seen = new Set<string>()
  private done = false

  constructor(
    private readonly strategy: Strategy,
    private readonly source: Iterator<Candidate | null>,
    private readonly env: Env,
    private readonly check?: Checker,
  ) {}

  next(): GeneratedCase | undefined {
    let misses = 0
    while (!this.done && misses < MAX_MISSES) {
      const step = this.source.next()
      if (step.done) break
      const cand = step.value
      if (!cand) {
        misses++
        continue
      }
      const key = canonicalJson(cand.args)
      if (this.seen.has(key)) {
        misses++
        continue
      }
      this.seen.add(key)
      const finished = this.finish(cand, key)
      if (!finished) {
        misses++
        continue
      }
      return finished
    }
    this.done = true
    return undefined
  }

  private finish(cand: Candidate, key: string): GeneratedCase | undefined {
    let expectation: Expectation = cand.intended
    if (cand.intended === 'invalid-params' && cand.relax >= 1) expectation = 'any'
    if (cand.intended === 'success' && cand.relax >= 2) expectation = 'any'
    if (this.check && cand.intended !== 'any') {
      const valid = this.check(cand.args)
      if (valid !== undefined) {
        if (cand.intended === 'success' && !valid) return undefined
        if (cand.intended === 'invalid-params' && valid) return undefined
        expectation = cand.intended
      }
    }
    let reason = cand.reason
    if (expectation !== cand.intended) {
      reason += ` (expectation relaxed to 'any': inside a non-discriminated ${cand.relax >= 2 ? 'oneOf' : 'anyOf'})`
    }
    const id = `${this.strategy}-${hashString(`${this.env.schemaHash}|${this.strategy}|${key}`, 10)}`
    const out: GeneratedCase = { id, strategy: this.strategy, args: cand.args, expectation, reason }
    if (cand.target !== undefined) out.target = cand.target
    if (cand.payloadIds !== undefined) out.payloadIds = cand.payloadIds
    return out
  }
}

function makeChecker(
  schema: JsonValue,
  selfCheck: GenerateOptions['selfCheck'],
): Checker | undefined {
  if (!selfCheck) return undefined
  if (typeof selfCheck === 'function') return (args) => selfCheck(schema, args)
  let broken = false
  return (args) => {
    if (broken) return undefined
    const result = validateAgainstSchema(schema, args)
    if (result.schemaError !== undefined) {
      broken = true // schema does not compile: cannot judge, keep model expectations
      return undefined
    }
    return result.ok
  }
}

/**
 * Generate up to `count` argument sets for a tool's `inputSchema`.
 *
 * Cases are taken round-robin from each requested strategy (systematic cases first, then
 * seeded random variations) and returned grouped by strategy. A strategy that runs out
 * (e.g. `inject` on a schema without free-form strings) leaves its share to the others.
 * Raising `count` only appends: every case of a smaller run is in the larger one.
 */
export function generateArgs(schema: JsonValue, opts: GenerateOptions): GeneratedCase[] {
  const strategies = [...new Set(opts.strategies ?? DEFAULT_STRATEGIES)].filter((s) =>
    ALL_STRATEGIES.includes(s),
  )
  const count = Math.max(0, Math.floor(opts.count))
  const env: Env = {
    root: schema,
    fctx: { root: schema, memo: new Map() },
    maxDepth: Math.max(1, Math.floor(opts.maxDepth ?? DEFAULT_MAX_DEPTH)),
    seed: normalizeSeed(opts.seed),
    schemaHash: hashString(canonicalJson(schema), 16),
  }
  const check = makeChecker(schema, opts.selfCheck)
  const sources: Record<Strategy, () => Iterator<Candidate | null>> = {
    valid: () => validCandidates(env),
    boundary: () => mutationCandidates(env, 'boundary'),
    invalid: () => mutationCandidates(env, 'invalid'),
    inject: () => injectCandidates(env),
  }
  const streams = strategies.map((s) => ({
    s,
    stream: new Stream(s, sources[s](), env, check),
    out: [] as GeneratedCase[],
    live: true,
  }))
  let total = 0
  while (total < count) {
    let progressed = false
    for (const entry of streams) {
      if (total >= count) break
      if (!entry.live) continue
      const next = entry.stream.next()
      if (!next) {
        entry.live = false
        continue
      }
      entry.out.push(next)
      total++
      progressed = true
    }
    if (!progressed) break
  }
  return streams.flatMap((e) => e.out)
}

/** Regenerate a run and return the case with `id` (to reproduce a recorded failure). */
export function findCase(
  schema: JsonValue,
  opts: GenerateOptions & { id: string },
): GeneratedCase | undefined {
  const strategy = ALL_STRATEGIES.find((s) => opts.id.startsWith(`${s}-`))
  const strategies = strategy ? [strategy] : opts.strategies
  return generateArgs(schema, { ...opts, strategies }).find((c) => c.id === opts.id)
}

// ---------------------------------------------------------------------------
// Schema warnings
// ---------------------------------------------------------------------------

const IGNORED_KEYWORDS: Record<string, string> = {
  not: 'ignored by the generator',
  if: 'if/then/else is ignored by the generator',
  dependentSchemas: 'ignored by the generator',
  propertyNames: 'ignored by the generator',
  unevaluatedItems: 'ignored by the generator',
  $dynamicRef: 'not resolved (treated as any value)',
  $recursiveRef: 'not resolved (treated as any value)',
  minContains: 'ignored (one matching item is generated)',
  maxContains: 'ignored',
  patternProperties: 'only used to pick extra property names; matching keys are never generated',
}

/**
 * Keywords in `schema` the generator ignores or only approximates. When non-empty, expect
 * some expectations to be wrong unless `selfCheck` is on.
 */
export function schemaWarnings(schema: JsonValue): string[] {
  const out = new Set<string>()
  const visit = (node: JsonValue | undefined, pointer: string, depth: number) => {
    if (depth > 48 || !isObject(node)) return
    for (const [kw, note] of Object.entries(IGNORED_KEYWORDS)) {
      if (kw in node) out.add(`${pointer || '#'}: '${kw}' ${note}`)
    }
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#'))
        out.add(
          `${pointer || '#'}: remote $ref "${node.$ref}" is not resolved (treated as any value)`,
        )
      else if (resolveRef(schema, node.$ref) === undefined)
        out.add(`${pointer || '#'}: $ref "${node.$ref}" does not resolve`)
    }
    if (typeof node.pattern === 'string') {
      try {
        stringFromPattern(node.pattern, createRng(0))
      } catch (err) {
        if (err instanceof UnsupportedPatternError) {
          out.add(
            `${pointer || '#'}: pattern /${node.pattern}/ uses unsupported syntax; values come from examples/default or brute force`,
          )
        }
      }
    }
    const child = (value: JsonValue | undefined, suffix: string) =>
      visit(value, `${pointer}/${suffix}`, depth + 1)
    for (const key of [
      'properties',
      'patternProperties',
      '$defs',
      'definitions',
      'dependentSchemas',
    ]) {
      const map = node[key]
      if (isObject(map)) for (const [k, v] of Object.entries(map)) child(v, `${key}/${k}`)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const list = node[key]
      if (Array.isArray(list)) list.forEach((v, i) => child(v, `${key}/${i}`))
    }
    if (Array.isArray(node.items)) node.items.forEach((v, i) => child(v, `items/${i}`))
    for (const key of [
      'items',
      'additionalProperties',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
      'unevaluatedProperties',
      'additionalItems',
    ]) {
      if (isObject(node[key])) child(node[key], key)
    }
  }
  visit(schema, '', 0)
  return [...out]
}
