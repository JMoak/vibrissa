/**
 * Internal schema model for the generator. `flatten` turns a JSON Schema into a `Node`:
 * `$ref` (local) and `allOf` are merged in, `oneOf` / `anyOf` are kept as choice groups
 * the generator picks a branch from. Merging is an approximation of intersection (good
 * enough for generation; the real validator in `src/schema.ts` is the source of truth).
 */
import type { JsonValue } from '../types.js'

export type TypeName = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object'
export type JsonObject = { [key: string]: JsonValue }

export const TYPE_NAMES: readonly TypeName[] = [
  'null',
  'boolean',
  'integer',
  'number',
  'string',
  'array',
  'object',
]

export interface ChoiceGroup {
  kind: 'oneOf' | 'anyOf'
  branches: JsonValue[]
}

export interface Node {
  /** Declared types after merging; null = unconstrained. Empty = unsatisfiable. */
  types: TypeName[] | null
  /** A `false` schema (or a contradiction) was merged in. */
  never: boolean
  enum?: JsonValue[]
  const?: { value: JsonValue }
  minLength?: number
  maxLength?: number
  patterns: string[]
  format?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  items?: JsonValue
  prefixItems?: JsonValue[]
  minItems?: number
  maxItems?: number
  uniqueItems: boolean
  contains?: JsonValue
  properties: Record<string, JsonValue>
  required: string[]
  additionalProperties?: JsonValue
  unevaluatedPropertiesFalse: boolean
  patternProperties?: Record<string, JsonValue>
  minProperties?: number
  maxProperties?: number
  dependentRequired?: Record<string, string[]>
  groups: ChoiceGroup[]
  default?: { value: JsonValue }
  examples: JsonValue[]
  /** OpenAPI-style `nullable: true`. Never used to *generate* null, only to avoid claiming null is invalid. */
  nullableHint: boolean
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emptyNode(): Node {
  return {
    types: null,
    never: false,
    patterns: [],
    uniqueItems: false,
    properties: {},
    required: [],
    unevaluatedPropertiesFalse: false,
    groups: [],
    examples: [],
    nullableHint: false,
  }
}

export function jsonType(value: JsonValue): TypeName {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'object') return 'object'
  return typeof value as 'string' | 'boolean'
}

/** Is a value of JSON type `t` accepted by the type list (`integer` ⊂ `number`)? */
export function typeAllowed(types: readonly TypeName[] | null, t: TypeName): boolean {
  if (types === null) return true
  if (types.includes(t)) return true
  return t === 'integer' && types.includes('number')
}

export function intersectTypes(a: TypeName[] | null, b: TypeName[] | null): TypeName[] | null {
  if (a === null) return b
  if (b === null) return a
  const out = new Set<TypeName>()
  for (const t of a) {
    if (b.includes(t)) out.add(t)
    else if (t === 'integer' && b.includes('number')) out.add('integer')
    else if (t === 'number' && b.includes('integer')) out.add('integer')
  }
  return [...out]
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** JSON with sorted object keys, for hashing and de-duplication. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

function num(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegInt(value: JsonValue | undefined): number | undefined {
  const n = num(value)
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined
}

function parseTypes(value: JsonValue | undefined): TypeName[] | null {
  if (typeof value === 'string')
    return (TYPE_NAMES as string[]).includes(value) ? [value as TypeName] : null
  if (Array.isArray(value)) {
    const names = value.filter(
      (v): v is TypeName => typeof v === 'string' && (TYPE_NAMES as string[]).includes(v),
    )
    return names.length > 0 ? [...new Set(names)] : null
  }
  return null
}

/** Build a node from one schema object's own keywords (no $ref / allOf / composition). */
function ownNode(schema: JsonObject): Node {
  const node = emptyNode()
  node.types = parseTypes(schema.type)
  if (Array.isArray(schema.enum)) node.enum = schema.enum.slice()
  if ('const' in schema) node.const = { value: schema.const as JsonValue }
  node.minLength = nonNegInt(schema.minLength)
  node.maxLength = nonNegInt(schema.maxLength)
  if (typeof schema.pattern === 'string') node.patterns = [schema.pattern]
  if (typeof schema.format === 'string') node.format = schema.format
  node.minimum = num(schema.minimum)
  node.maximum = num(schema.maximum)
  // 2020-12 numeric exclusives, plus the draft-04 boolean form.
  if (schema.exclusiveMinimum === true && node.minimum !== undefined) {
    node.exclusiveMinimum = node.minimum
    node.minimum = undefined
  } else {
    node.exclusiveMinimum = num(schema.exclusiveMinimum)
  }
  if (schema.exclusiveMaximum === true && node.maximum !== undefined) {
    node.exclusiveMaximum = node.maximum
    node.maximum = undefined
  } else {
    node.exclusiveMaximum = num(schema.exclusiveMaximum)
  }
  const mult = num(schema.multipleOf)
  if (mult !== undefined && mult > 0) node.multipleOf = mult
  if (Array.isArray(schema.prefixItems)) node.prefixItems = schema.prefixItems.slice()
  if (Array.isArray(schema.items)) {
    // draft-07 tuple form
    node.prefixItems = schema.items.slice()
    if ('additionalItems' in schema) node.items = schema.additionalItems as JsonValue
  } else if ('items' in schema) {
    node.items = schema.items as JsonValue
  }
  node.minItems = nonNegInt(schema.minItems)
  node.maxItems = nonNegInt(schema.maxItems)
  node.uniqueItems = schema.uniqueItems === true
  if ('contains' in schema) node.contains = schema.contains as JsonValue
  if (isObject(schema.properties)) node.properties = { ...schema.properties }
  if (Array.isArray(schema.required)) {
    node.required = [...new Set(schema.required.filter((r): r is string => typeof r === 'string'))]
  }
  if ('additionalProperties' in schema)
    node.additionalProperties = schema.additionalProperties as JsonValue
  node.unevaluatedPropertiesFalse = schema.unevaluatedProperties === false
  if (isObject(schema.patternProperties)) node.patternProperties = { ...schema.patternProperties }
  node.minProperties = nonNegInt(schema.minProperties)
  node.maxProperties = nonNegInt(schema.maxProperties)
  if (isObject(schema.dependentRequired)) {
    const deps: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(schema.dependentRequired)) {
      if (Array.isArray(v)) deps[k] = v.filter((x): x is string => typeof x === 'string')
    }
    node.dependentRequired = deps
  }
  if ('default' in schema) node.default = { value: schema.default as JsonValue }
  if (Array.isArray(schema.examples)) node.examples = schema.examples.slice()
  node.nullableHint = schema.nullable === true
  for (const kind of ['oneOf', 'anyOf'] as const) {
    const branches = schema[kind]
    if (Array.isArray(branches) && branches.length > 0) node.groups.push({ kind, branches })
  }
  return node
}

function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function minDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function allOfSchema(a: JsonValue | undefined, b: JsonValue | undefined): JsonValue | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a === true) return b
  if (b === true) return a
  if (a === false || b === false) return false
  return { allOf: [a, b] }
}

/** Approximate intersection of two nodes (allOf semantics). */
export function mergeNodes(a: Node, b: Node): Node {
  const out = emptyNode()
  out.never = a.never || b.never
  out.types = intersectTypes(a.types, b.types)
  if (a.enum && b.enum) {
    const keys = new Set(b.enum.map(canonicalJson))
    out.enum = a.enum.filter((v) => keys.has(canonicalJson(v)))
  } else {
    out.enum = a.enum ?? b.enum
  }
  if (a.const && b.const && !deepEqual(a.const.value, b.const.value)) out.never = true
  out.const = a.const ?? b.const
  out.minLength = maxDefined(a.minLength, b.minLength)
  out.maxLength = minDefined(a.maxLength, b.maxLength)
  out.patterns = [...a.patterns, ...b.patterns]
  out.format = a.format ?? b.format
  out.minimum = maxDefined(a.minimum, b.minimum)
  out.maximum = minDefined(a.maximum, b.maximum)
  out.exclusiveMinimum = maxDefined(a.exclusiveMinimum, b.exclusiveMinimum)
  out.exclusiveMaximum = minDefined(a.exclusiveMaximum, b.exclusiveMaximum)
  if (a.multipleOf && b.multipleOf) {
    const [x, y] = [a.multipleOf, b.multipleOf]
    out.multipleOf = Number.isInteger(x / y) ? x : Number.isInteger(y / x) ? y : x * y
  } else {
    out.multipleOf = a.multipleOf ?? b.multipleOf
  }
  out.items = allOfSchema(a.items, b.items)
  out.prefixItems = a.prefixItems ?? b.prefixItems
  out.minItems = maxDefined(a.minItems, b.minItems)
  out.maxItems = minDefined(a.maxItems, b.maxItems)
  out.uniqueItems = a.uniqueItems || b.uniqueItems
  out.contains = a.contains ?? b.contains
  out.properties = { ...a.properties }
  for (const [k, v] of Object.entries(b.properties)) {
    out.properties[k] = (k in out.properties ? allOfSchema(out.properties[k], v) : v) as JsonValue
  }
  out.required = [...new Set([...a.required, ...b.required])]
  if (a.additionalProperties === false || b.additionalProperties === false) {
    out.additionalProperties = false
  } else {
    out.additionalProperties = allOfSchema(a.additionalProperties, b.additionalProperties)
  }
  out.unevaluatedPropertiesFalse = a.unevaluatedPropertiesFalse || b.unevaluatedPropertiesFalse
  if (a.patternProperties || b.patternProperties) {
    out.patternProperties = { ...a.patternProperties, ...b.patternProperties }
  }
  out.minProperties = maxDefined(a.minProperties, b.minProperties)
  out.maxProperties = minDefined(a.maxProperties, b.maxProperties)
  if (a.dependentRequired || b.dependentRequired) {
    const deps: Record<string, string[]> = { ...a.dependentRequired }
    for (const [k, v] of Object.entries(b.dependentRequired ?? {})) {
      deps[k] = [...new Set([...(deps[k] ?? []), ...v])]
    }
    out.dependentRequired = deps
  }
  out.groups = [...a.groups, ...b.groups]
  out.default = a.default ?? b.default
  out.examples = [...a.examples, ...b.examples]
  out.nullableHint = a.nullableHint || b.nullableHint
  if (out.types !== null && out.types.length === 0) out.never = true
  if (out.enum && out.enum.length === 0) out.never = true
  return out
}

function unescapePointer(segment: string): string {
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // keep raw
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~')
}

function findAnchor(node: JsonValue, anchor: string, depth = 0): JsonValue | undefined {
  if (depth > 64) return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAnchor(item, anchor, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (!isObject(node)) return undefined
  if (node.$anchor === anchor) return node
  for (const value of Object.values(node)) {
    const hit = findAnchor(value, anchor, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Resolve a local `$ref` against the root schema: `#`, `#/$defs/x`, `#/definitions/x`,
 * any JSON Pointer, or `#anchor`. Remote refs return undefined.
 */
export function resolveRef(root: JsonValue, ref: string): JsonValue | undefined {
  if (ref === '#' || ref === '') return root
  if (ref.startsWith('#/')) {
    let node: JsonValue | undefined = root
    for (const raw of ref.slice(2).split('/')) {
      const key = unescapePointer(raw)
      if (Array.isArray(node)) node = node[Number(key)]
      else if (isObject(node)) node = node[key]
      else return undefined
      if (node === undefined) return undefined
    }
    return node
  }
  if (ref.startsWith('#')) return findAnchor(root, ref.slice(1))
  return undefined
}

export interface FlattenContext {
  root: JsonValue
  memo: Map<object, Node>
}

/** Flatten a schema into a Node (resolving local $ref and allOf). Never throws. */
export function flatten(
  schema: JsonValue | undefined,
  ctx: FlattenContext,
  stack: object[] = [],
): Node {
  if (schema === undefined || schema === true) return emptyNode()
  if (schema === false) {
    const node = emptyNode()
    node.never = true
    return node
  }
  if (!isObject(schema)) return emptyNode()
  const memo = ctx.memo.get(schema)
  if (memo) return memo
  if (stack.includes(schema) || stack.length > 64) return emptyNode() // $ref cycle without progress
  const next = [...stack, schema]
  let node = ownNode(schema)
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(ctx.root, schema.$ref)
    if (target !== undefined) node = mergeNodes(flatten(target, ctx, next), node)
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) node = mergeNodes(node, flatten(sub, ctx, next))
  }
  ctx.memo.set(schema, node)
  return node
}

/** Types a value at this node could have across every oneOf/anyOf branch (null = any). */
export function possibleTypes(node: Node, ctx: FlattenContext, depth = 0): TypeName[] | null {
  let types = node.types
  if (depth > 16) return types
  for (const group of node.groups) {
    const union = new Set<TypeName>()
    let unconstrained = false
    for (const branch of group.branches) {
      const bt = possibleTypes(flatten(branch, ctx), ctx, depth + 1)
      if (bt === null) {
        unconstrained = true
        break
      }
      for (const t of bt) union.add(t)
    }
    if (!unconstrained) types = intersectTypes(types, [...union])
  }
  if (types === null && node.enum) types = [...new Set(node.enum.map(jsonType))]
  if (types === null && node.const) types = [jsonType(node.const.value)]
  return types
}

/** Is `null` acceptable here, as far as the model can tell? */
export function allowsNull(node: Node, ctx: FlattenContext): boolean {
  if (node.nullableHint) return true
  if (node.const) return node.const.value === null
  if (node.enum && !node.enum.some((v) => v === null)) return false
  const types = possibleTypes(node, ctx)
  return types === null || types.includes('null')
}

/** Types the generator should produce when none are declared, inferred from keywords. */
export function inferTypes(node: Node): TypeName[] | null {
  if (node.types !== null) return node.types
  const hasObject =
    Object.keys(node.properties).length > 0 ||
    node.required.length > 0 ||
    isObject(node.additionalProperties) ||
    node.additionalProperties === false ||
    node.minProperties !== undefined ||
    node.maxProperties !== undefined
  if (hasObject) return ['object']
  const hasArray =
    node.items !== undefined ||
    node.prefixItems !== undefined ||
    node.minItems !== undefined ||
    node.maxItems !== undefined ||
    node.contains !== undefined
  if (hasArray) return ['array']
  if (
    node.minLength !== undefined ||
    node.maxLength !== undefined ||
    node.patterns.length > 0 ||
    node.format !== undefined
  ) {
    return ['string']
  }
  if (
    node.minimum !== undefined ||
    node.maximum !== undefined ||
    node.exclusiveMinimum !== undefined ||
    node.exclusiveMaximum !== undefined ||
    node.multipleOf !== undefined
  ) {
    return ['number']
  }
  return null
}

function singleConst(node: Node): JsonValue | undefined {
  if (node.const) return node.const.value
  if (node.enum && node.enum.length === 1) return node.enum[0]
  return undefined
}

/**
 * A choice group is "safe" when picking one branch and mutating inside it cannot make the
 * value match a different branch: a single branch, a nullable wrapper (`anyOf: [X, {type:
 * null}]`), or a discriminated object union (every branch requires the same property with
 * a distinct const).
 */
export function isSafeGroup(group: ChoiceGroup, ctx: FlattenContext): boolean {
  if (group.branches.length <= 1) return true
  const nodes = group.branches.map((b) => flatten(b, ctx))
  const nonNull = nodes.filter((n) => {
    const t = possibleTypes(n, ctx)
    const onlyNull = (t !== null && t.length === 1 && t[0] === 'null') || singleConst(n) === null
    return !onlyNull
  })
  if (nonNull.length <= 1) return true
  // discriminated union?
  const first = nonNull[0] as Node
  for (const key of Object.keys(first.properties)) {
    const seen = new Set<string>()
    let ok = true
    for (const n of nonNull) {
      if (!n.required.includes(key) || !(key in n.properties)) {
        ok = false
        break
      }
      const value = singleConst(flatten(n.properties[key], ctx))
      if (value === undefined) {
        ok = false
        break
      }
      const k = canonicalJson(value)
      if (seen.has(k)) {
        ok = false
        break
      }
      seen.add(k)
    }
    if (ok) return true
  }
  return false
}

/** Is this branch nothing but `null`? (Used to avoid picking it when building rich values.) */
export function isNullBranch(node: Node, ctx: FlattenContext): boolean {
  const t = possibleTypes(node, ctx)
  return (t !== null && t.length === 1 && t[0] === 'null') || singleConst(node) === null
}
