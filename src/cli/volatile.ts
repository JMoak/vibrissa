/**
 * Volatile-field loosening for recorded goldens (`vib record`). Values that will not
 * repeat on the next run are replaced with matchers:
 *
 * - ISO date-time strings        → {"$schema": {"type": "string", "format": "date-time"}}
 * - UUID strings                 → {"$schema": {"type": "string", "format": "uuid"}}
 * - epoch-millisecond integers   → {"$type": "integer"}
 * - timestamps / UUIDs inside text → {"$regex": "^literal…<pattern>…literal$"}
 * - anything that differed between two back-to-back calls (the stable check):
 *   strings → {"$regex"} on the common prefix/suffix (or {"$type": "string"}), other
 *   values → {"$type": ...}, keys present only once → {"$ignore": true}
 *
 * Works on the escaped golden (after normalizeResult + escapeDirectives) and never looks
 * inside `{"$literal": ...}`. Paths use the matcher format (`structuredContent.at`).
 */
import { appendIndex, appendKey } from '../schema.js'
import type { JsonValue } from '../types.js'
import { escapeRegex } from './args.js'

export type VolatileReason = 'date-time' | 'uuid' | 'epoch-ms' | 'embedded' | 'changed'

export interface Loosened {
  path: string
  reason: VolatileReason
  /** The recorded value that was replaced. */
  was: JsonValue
}

/** RFC 3339 date-time as ajv-formats accepts it (seconds and offset required). */
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/
/** Local date-time (no offset): not a JSON Schema date-time, so matched by $regex. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** 2000-01-01 .. 2100-01-01 in milliseconds. */
const EPOCH_MS_MIN = 946_684_800_000
const EPOCH_MS_MAX = 4_102_444_800_000

const EMBEDDED: Array<{ find: string; pattern: string }> = [
  {
    find: '\\d{4}-\\d{2}-\\d{2}[Tt ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:[Zz]|[+-]\\d{2}(?::?\\d{2})?)?',
    pattern: '\\d{4}-\\d{2}-\\d{2}[Tt ][0-9:.]+(?:[Zz]|[+-][0-9:]+)?',
  },
  {
    find: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    pattern: '[0-9a-fA-F-]{36}',
  },
  { find: '(?<!\\d)[1-4]\\d{12}(?!\\d)', pattern: '\\d{13}' },
]
const EMBEDDED_RE = new RegExp(EMBEDDED.map((e) => `(${e.find})`).join('|'), 'g')

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLiteral(value: Record<string, JsonValue>): boolean {
  return Object.keys(value).length === 1 && value.$literal !== undefined
}

function root(path: string): string {
  return path === '' ? '(root)' : path
}

/** A $regex for a string whose embedded timestamps / UUIDs / epoch-ms vary; undefined if none. */
function embeddedRegex(text: string): string | undefined {
  EMBEDDED_RE.lastIndex = 0
  if (!EMBEDDED_RE.test(text)) return undefined
  EMBEDDED_RE.lastIndex = 0
  let out = '^'
  let last = 0
  for (const match of text.matchAll(EMBEDDED_RE)) {
    const index = match.index ?? 0
    out += escapeRegex(text.slice(last, index))
    const group = match.slice(1).findIndex((g) => g !== undefined)
    out += EMBEDDED[group].pattern
    last = index + match[0].length
  }
  return `${out}${escapeRegex(text.slice(last))}$`
}

function typeName(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** Matcher for a string that changed between calls: common prefix/suffix, else any string. */
function changedString(a: string, b: string): JsonValue {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  if (prefix + suffix < 3) return { $type: 'string' }
  return {
    $regex: `^${escapeRegex(a.slice(0, prefix))}[\\s\\S]*${escapeRegex(a.slice(a.length - suffix))}$`,
  }
}

/**
 * Loosen volatile values in `golden`. `second` is the normalized result of an identical
 * second call (the stable check); leave it undefined to use the patterns only.
 */
export function loosenVolatile(
  golden: JsonValue,
  second?: JsonValue,
): { value: JsonValue; loosened: Loosened[] } {
  const loosened: Loosened[] = []
  const compare = second !== undefined
  const walk = (
    node: JsonValue,
    other: JsonValue | undefined,
    hasOther: boolean,
    path: string,
  ): JsonValue => {
    if (typeof node === 'string') {
      if (DATE_TIME.test(node)) {
        loosened.push({ path: root(path), reason: 'date-time', was: node })
        return { $schema: { type: 'string', format: 'date-time' } }
      }
      if (UUID.test(node)) {
        loosened.push({ path: root(path), reason: 'uuid', was: node })
        return { $schema: { type: 'string', format: 'uuid' } }
      }
      if (LOCAL_DATE_TIME.test(node)) {
        loosened.push({ path: root(path), reason: 'date-time', was: node })
        return { $regex: '^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+$' }
      }
      const embedded = embeddedRegex(node)
      if (embedded) {
        loosened.push({ path: root(path), reason: 'embedded', was: node })
        return { $regex: embedded }
      }
      if (compare && hasOther && typeof other === 'string' && other !== node) {
        loosened.push({ path: root(path), reason: 'changed', was: node })
        return changedString(node, other)
      }
    } else if (typeof node === 'number') {
      if (Number.isInteger(node) && node >= EPOCH_MS_MIN && node <= EPOCH_MS_MAX) {
        loosened.push({ path: root(path), reason: 'epoch-ms', was: node })
        return { $type: 'integer' }
      }
      if (compare && hasOther && typeof other === 'number' && other !== node) {
        loosened.push({ path: root(path), reason: 'changed', was: node })
        return { $type: Number.isInteger(node) && Number.isInteger(other) ? 'integer' : 'number' }
      }
    } else if (Array.isArray(node)) {
      if (compare && hasOther && Array.isArray(other) && other.length !== node.length) {
        loosened.push({ path: root(path), reason: 'changed', was: node })
        return { $type: 'array' }
      }
      const others = Array.isArray(other) ? other : []
      return node.map((item, i) =>
        walk(item, others[i], hasOther && Array.isArray(other), appendIndex(path, i)),
      )
    } else if (isObject(node)) {
      if (isLiteral(node)) return node
      const others = isObject(other) ? other : {}
      const out: Record<string, JsonValue> = {}
      for (const [key, child] of Object.entries(node)) {
        if (key === '$partial') {
          out[key] = child
          continue
        }
        const present = hasOther && isObject(other) && Object.hasOwn(others, key)
        if (compare && hasOther && isObject(other) && !present) {
          loosened.push({ path: root(appendKey(path, key)), reason: 'changed', was: child })
          out[key] = { $ignore: true }
          continue
        }
        out[key] = walk(child, others[key], present, appendKey(path, key))
      }
      return out
    } else if (
      typeof node === 'boolean' &&
      compare &&
      hasOther &&
      typeof other === 'boolean' &&
      other !== node
    ) {
      loosened.push({ path: root(path), reason: 'changed', was: node })
      return { $type: 'boolean' }
    }
    if (compare && hasOther && other !== undefined && typeName(other) !== typeName(node)) {
      loosened.push({ path: root(path), reason: 'changed', was: node })
      return { $any: true }
    }
    return node
  }
  return { value: walk(golden, second, compare, ''), loosened }
}

/** `loosened 2 volatile fields (structuredContent.at, content[0].text)`. */
export function loosenedSummary(loosened: Loosened[]): string {
  const paths = loosened.slice(0, 4).map((l) => l.path)
  const more = loosened.length > paths.length ? `, +${loosened.length - paths.length} more` : ''
  return `loosened ${loosened.length} volatile field${loosened.length === 1 ? '' : 's'} (${paths.join(', ')}${more})`
}

export const VOLATILE_DOCS = 'docs/CASES.md#generated-ids-and-timestamps'
