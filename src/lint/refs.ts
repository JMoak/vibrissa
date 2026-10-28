/**
 * Offline `$ref` resolution check for JSON Schema 2020-12 (draft-07 `definitions`
 * works too). Pure: never fetches anything. A ref resolves when it points at a
 * JSON pointer, `$anchor`/`$dynamicAnchor`, or embedded `$id` inside the same
 * document. Anything else is reported, because MCP clients validate offline.
 */

export interface RefProblem {
  /** JSON pointer of the `$ref` keyword inside the schema, e.g. `/properties/a/$ref`. */
  at: string
  ref: string
  message: string
}

const DEFAULT_BASE = 'https://vibrissa.invalid/schema.json'

/** Keywords whose value is a subschema. */
const SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'additionalItems',
  'items',
  'contentSchema',
])
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])
/** Keywords whose value is a map of name -> subschema. */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
])

interface Resource {
  root: unknown
  anchors: Set<string>
}

interface PendingRef {
  at: string
  ref: string
  base: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function escapePointer(token: string): string {
  return token.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function stripHash(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

function resolveUrl(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href
  } catch {
    return undefined
  }
}

/** Resolve a JSON pointer (already URI-decoded) against a document. */
export function resolvePointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: doc }
  if (!pointer.startsWith('/')) return { found: false }
  let node: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token) || Number(token) >= node.length) return { found: false }
      node = node[Number(token)]
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      node = node[token]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: node }
}

/** Every `$ref` / `$dynamicRef` in `schema` that cannot be resolved inside the document. */
export function findUnresolvedRefs(schema: unknown): RefProblem[] {
  const resources = new Map<string, Resource>()
  const pending: PendingRef[] = []
  const seen = new Set<unknown>()

  const visit = (node: unknown, at: string, base: string, depth: number): void => {
    if (!isRecord(node) || depth > 64 || seen.has(node)) return
    seen.add(node)
    let here = base
    if (typeof node.$id === 'string') {
      const id = resolveUrl(node.$id, base)
      if (id) {
        here = stripHash(id)
        if (!resources.has(here)) resources.set(here, { root: node, anchors: new Set() })
      }
    }
    const resource = resources.get(here)
    for (const key of ['$anchor', '$dynamicAnchor'] as const) {
      if (typeof node[key] === 'string') resource?.anchors.add(node[key] as string)
    }
    for (const key of ['$ref', '$dynamicRef'] as const) {
      if (typeof node[key] === 'string')
        pending.push({ at: `${at}/${key}`, ref: node[key] as string, base: here })
    }
    for (const [k, v] of Object.entries(node)) {
      const path = `${at}/${escapePointer(k)}`
      if (SCHEMA_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) {
        v.forEach((item, i) => visit(item, `${path}/${i}`, here, depth + 1))
      } else if (SCHEMA_MAP_KEYWORDS.has(k) && isRecord(v)) {
        for (const [name, sub] of Object.entries(v)) {
          visit(sub, `${path}/${escapePointer(name)}`, here, depth + 1)
        }
      } else if (SCHEMA_KEYWORDS.has(k)) {
        visit(v, path, here, depth + 1)
      }
    }
  }

  resources.set(DEFAULT_BASE, { root: schema, anchors: new Set() })
  visit(schema, '', DEFAULT_BASE, 0)

  const problems: RefProblem[] = []
  for (const p of pending) {
    const target = resolveUrl(p.ref, p.base)
    if (!target) {
      problems.push({ at: p.at || '/', ref: p.ref, message: 'is not a valid URI reference' })
      continue
    }
    const hashAt = target.indexOf('#')
    const doc = stripHash(target)
    const fragment = hashAt === -1 ? '' : target.slice(hashAt + 1)
    const resource = resources.get(doc)
    if (!resource) {
      problems.push({
        at: p.at,
        ref: p.ref,
        message: 'points outside this schema (MCP clients do not fetch remote schemas)',
      })
      continue
    }
    let decoded = fragment
    try {
      decoded = decodeURIComponent(fragment)
    } catch {
      // keep raw fragment
    }
    if (decoded === '' || decoded.startsWith('/')) {
      if (!resolvePointer(resource.root, decoded).found) {
        problems.push({
          at: p.at,
          ref: p.ref,
          message: 'does not resolve to anything in this schema',
        })
      }
    } else if (!resource.anchors.has(decoded)) {
      problems.push({ at: p.at, ref: p.ref, message: `names an unknown anchor "${decoded}"` })
    }
  }
  return problems
}
