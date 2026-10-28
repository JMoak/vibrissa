import addFormatsImport from 'ajv-formats'
/**
 * Thin Ajv 8 wrapper used by the `$schema` matcher, `outputSchema` enforcement and the
 * lint module. JSON Schema 2020-12 is the default dialect (MCP's default); schemas that
 * declare draft-07 / draft-06 / 2019-09 via `$schema` are validated with the matching
 * Ajv class, and unknown dialects fall back to 2020-12. Unknown keywords and formats are
 * tolerated (strict: false), and nothing is ever logged.
 *
 * Paths in every error use the matcher's path format: `content[0].text`, `_meta["a/b"]`,
 * with '' for the validated value itself.
 */
import { Ajv2019 } from 'ajv/dist/2019.js'
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  MissingRefError,
  type ValidateFunction,
} from 'ajv/dist/2020.js'
import { Ajv as AjvDraft07 } from 'ajv/dist/ajv.js'
import type { JsonValue } from './types.js'

export interface SchemaIssue {
  /** Location in the validated value (matcher path format; '' = the value itself). */
  path: string
  message: string
  /** The JSON Schema keyword that failed (e.g. `type`, `required`). */
  keyword?: string
  /** Pointer into the schema, e.g. `#/properties/id/type`. */
  schemaPath?: string
}

export interface ValidationResult {
  ok: boolean
  errors: SchemaIssue[]
  /** Set when the schema itself could not be compiled; `errors` then holds one entry. */
  schemaError?: string
}

/**
 * Hook for `$ref`s that point outside the schema document. Receives the ref URI resolved
 * against the schema's `$id` (as written when there is no `$id`), without its `#fragment`.
 * Return the referenced schema document, or `undefined` if it cannot be found.
 */
export type SchemaRefResolver = (ref: string) => JsonValue | undefined

export interface CompileOptions {
  resolve?: SchemaRefResolver
}

export type Validator = (value: unknown) => ValidationResult

export class SchemaCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaCompileError'
  }
}

// ---------------------------------------------------------------------------
// Paths (shared with src/match.ts so matcher and schema errors read the same)
// ---------------------------------------------------------------------------

const BARE_KEY = /^[A-Za-z_$][\w$-]*$/

/** Append an object key to a matcher path: `a.b`, or `a["io.x/y"]` for unusual keys. */
export function appendKey(path: string, key: string): string {
  if (BARE_KEY.test(key)) return path === '' ? key : `${path}.${key}`
  return `${path}[${JSON.stringify(key)}]`
}

/** Append an array index to a matcher path: `content[0]`. */
export function appendIndex(path: string, index: number): string {
  return `${path}[${index}]`
}

/**
 * Convert a JSON Pointer (`/content/0/text`, Ajv's `instancePath`) to a matcher path
 * (`content[0].text`). When `root` is given, the value is walked so numeric object keys
 * are distinguished from array indices.
 */
export function formatInstancePath(pointer: string, root?: unknown): string {
  if (pointer === '' || pointer === '#') return ''
  const segments = pointer
    .replace(/^#/, '')
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  let path = ''
  let node: unknown = root
  let known = root !== undefined
  for (const segment of segments) {
    const isIndex = /^(0|[1-9]\d*)$/.test(segment)
    if (known && Array.isArray(node)) {
      path = appendIndex(path, Number(segment))
      node = node[Number(segment)]
    } else if (known && node !== null && typeof node === 'object') {
      path = appendKey(path, segment)
      node = (node as Record<string, unknown>)[segment]
    } else {
      known = false
      path = isIndex ? appendIndex(path, Number(segment)) : appendKey(path, segment)
    }
  }
  return path
}

function valueAtPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  let node: unknown = root
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

// ---------------------------------------------------------------------------
// Ajv instances
// ---------------------------------------------------------------------------

type Dialect = '2020-12' | '2019-09' | 'draft-07'

interface AjvLike {
  compile(schema: AnySchema): ValidateFunction
  addSchema(schema: AnySchema, key?: string): unknown
  removeSchema(schema: AnySchema | string): unknown
  validateSchema(schema: AnySchema): boolean | Promise<unknown>
  errors?: ErrorObject[] | null
}

type FormatsPlugin = (ajv: unknown) => unknown

// ajv-formats is CommonJS; depending on the loader the default import is either the
// plugin itself or the module object carrying it as `.default`.
const addFormats: FormatsPlugin = (() => {
  const mod = addFormatsImport as unknown as FormatsPlugin & { default?: FormatsPlugin }
  return typeof mod.default === 'function' ? mod.default : mod
})()

const AJV_OPTIONS = {
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  validateFormats: true,
  logger: false,
} as const

function createAjv(dialect: Dialect): AjvLike {
  let ajv: AjvLike
  if (dialect === '2019-09') ajv = new Ajv2019(AJV_OPTIONS) as unknown as AjvLike
  else if (dialect === 'draft-07') ajv = new AjvDraft07(AJV_OPTIONS) as unknown as AjvLike
  else ajv = new Ajv2020(AJV_OPTIONS) as unknown as AjvLike
  addFormats(ajv)
  return ajv
}

const shared = new Map<Dialect, AjvLike>()

function sharedAjv(dialect: Dialect): AjvLike {
  let ajv = shared.get(dialect)
  if (!ajv) {
    ajv = createAjv(dialect)
    shared.set(dialect, ajv)
  }
  return ajv
}

/**
 * Pick the dialect from a root `$schema`. Returns the schema to hand to Ajv. Older drafts
 * (04 / 06) have their `$schema` removed and run as draft-07, their closest supported
 * relative; unknown dialects (custom metaschemas) run as 2020-12 rather than being rejected.
 */
function detectDialect(schema: JsonValue): { dialect: Dialect; schema: JsonValue } {
  if (!isObject(schema) || typeof schema.$schema !== 'string') {
    return { dialect: '2020-12', schema }
  }
  const uri = schema.$schema
  if (/json-schema\.org\/draft\/2020-12\/schema/.test(uri)) return { dialect: '2020-12', schema }
  if (/json-schema\.org\/draft\/2019-09\/schema/.test(uri)) return { dialect: '2019-09', schema }
  if (/json-schema\.org\/draft-07\/schema/.test(uri)) return { dialect: 'draft-07', schema }
  const { $schema: _ignored, ...rest } = schema
  if (/json-schema\.org\/draft-0[46]\/schema/.test(uri))
    return { dialect: 'draft-07', schema: rest }
  return { dialect: '2020-12', schema: rest }
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function compileWith(
  ajv: AjvLike,
  schema: JsonValue,
  resolve?: SchemaRefResolver,
): ValidateFunction {
  const added = new Set<string>()
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return ajv.compile(schema as AnySchema)
    } catch (err) {
      if (!(err instanceof MissingRefError)) throw err
      const ref = err.missingSchema
      if (!resolve || added.has(ref)) {
        throw new SchemaCompileError(
          `cannot resolve $ref "${err.missingRef}". Define it under "$defs" and reference it as "#/$defs/<name>"${resolve ? ', or make sure the external ref resolver can load it' : ''}.`,
        )
      }
      let doc: JsonValue | undefined
      try {
        doc = resolve(ref)
      } catch (loadErr) {
        throw new SchemaCompileError(`cannot load external $ref "${ref}": ${errorText(loadErr)}`)
      }
      if (doc === undefined) {
        throw new SchemaCompileError(
          `cannot resolve external $ref "${ref}": resolver returned nothing.`,
        )
      }
      ajv.addSchema(doc as AnySchema, ref)
      added.add(ref)
    }
  }
  throw new SchemaCompileError('too many external $refs while compiling schema')
}

// ---------------------------------------------------------------------------
// Compile / validate
// ---------------------------------------------------------------------------

const plainCache = new WeakMap<object, Validator>()
const resolverCache = new WeakMap<object, WeakMap<SchemaRefResolver, Validator>>()
const booleanValidators = new Map<boolean, Validator>()

function isSchemaShape(schema: unknown): schema is boolean | Record<string, JsonValue> {
  return typeof schema === 'boolean' || isObject(schema)
}

/**
 * Compile a JSON Schema into a reusable validator. Results are cached by schema object
 * identity (and resolver identity, when one is given), so compiling the same schema
 * object repeatedly is cheap. Throws `SchemaCompileError` if the schema is unusable.
 */
export function compileSchema(schema: JsonValue, opts: CompileOptions = {}): Validator {
  if (typeof schema === 'boolean') {
    let cached = booleanValidators.get(schema)
    if (!cached) {
      cached = schema
        ? () => ({ ok: true, errors: [] })
        : () => ({
            ok: false,
            errors: [
              {
                path: '',
                message: 'no value is allowed (schema is false)',
                keyword: 'false schema',
                schemaPath: '#',
              },
            ],
          })
      booleanValidators.set(schema, cached)
    }
    return cached
  }
  if (!isSchemaShape(schema)) {
    throw new SchemaCompileError(
      `a JSON Schema must be an object or a boolean, got ${Array.isArray(schema) ? 'array' : schema === null ? 'null' : typeof schema}`,
    )
  }
  const { resolve } = opts
  const cached = resolve ? resolverCache.get(schema)?.get(resolve) : plainCache.get(schema)
  if (cached) return cached

  const validator = buildValidator(schema, resolve)
  if (resolve) {
    let byResolver = resolverCache.get(schema)
    if (!byResolver) {
      byResolver = new WeakMap()
      resolverCache.set(schema, byResolver)
    }
    byResolver.set(resolve, validator)
  } else {
    plainCache.set(schema, validator)
  }
  return validator
}

function buildValidator(schema: Record<string, JsonValue>, resolve?: SchemaRefResolver): Validator {
  const { dialect, schema: prepared } = detectDialect(schema)
  let fn: ValidateFunction
  try {
    if (resolve) {
      // External documents are registered on the instance, so use a private one.
      fn = compileWith(createAjv(dialect), prepared, resolve)
    } else {
      const ajv = sharedAjv(dialect)
      try {
        fn = compileWith(ajv, prepared)
      } catch (err) {
        // An `$id` already registered by another schema: compile in isolation instead.
        if (!/already exists|resolves to more than one schema/.test(errorText(err))) throw err
        fn = compileWith(createAjv(dialect), prepared)
      } finally {
        // Keep the shared instance free of `$id` registrations (and their memory).
        try {
          ajv.removeSchema(prepared as AnySchema)
        } catch {
          // not registered; nothing to clean up
        }
      }
    }
  } catch (err) {
    if (err instanceof SchemaCompileError) throw err
    throw new SchemaCompileError(errorText(err))
  }
  return (value: unknown) => {
    const ok = fn(value) as boolean
    if (ok) return { ok: true, errors: [] }
    return { ok: false, errors: toIssues(fn.errors ?? [], value) }
  }
}

/** Validate `value` against `schema`. Never throws; compile failures set `schemaError`. */
export function validate(
  schema: JsonValue,
  value: unknown,
  opts?: CompileOptions,
): ValidationResult {
  let validator: Validator
  try {
    validator = compileSchema(schema, opts)
  } catch (err) {
    const message = errorText(err)
    return {
      ok: false,
      errors: [{ path: '', message: `invalid schema: ${message}` }],
      schemaError: message,
    }
  }
  return validator(value)
}

/**
 * Meta-validate a schema (is it a well-formed schema for its dialect?) and check that it
 * compiles, i.e. every `$ref` resolves. Error paths point into the schema document.
 */
export function isValidSchema(
  schema: JsonValue,
  opts?: CompileOptions,
): { ok: boolean; errors: SchemaIssue[] } {
  if (typeof schema === 'boolean') return { ok: true, errors: [] }
  if (!isSchemaShape(schema)) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: `a JSON Schema must be an object or a boolean, got ${Array.isArray(schema) ? 'array' : schema === null ? 'null' : typeof schema}`,
        },
      ],
    }
  }
  const { dialect, schema: prepared } = detectDialect(schema)
  const ajv = sharedAjv(dialect)
  let metaOk: boolean
  try {
    metaOk = ajv.validateSchema(prepared as AnySchema) === true
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: errorText(err) }] }
  }
  if (!metaOk) return { ok: false, errors: toIssues(ajv.errors ?? [], prepared) }
  try {
    compileSchema(schema, opts)
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: errorText(err), keyword: '$ref' }] }
  }
  return { ok: true, errors: [] }
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function describeType(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

function short(value: unknown, max = 60): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function issueMessage(error: ErrorObject, root: unknown): string {
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'type':
      return `must be ${Array.isArray(params.type) ? (params.type as string[]).join(' or ') : String(params.type)}, got ${describeType(valueAtPointer(root, error.instancePath))}`
    case 'required':
      return `must have required property ${JSON.stringify(params.missingProperty)}`
    case 'additionalProperties':
      return `must NOT have additional property ${JSON.stringify(params.additionalProperty)}`
    case 'unevaluatedProperties':
      return `must NOT have unevaluated property ${JSON.stringify(params.unevaluatedProperty)}`
    case 'enum':
      return `must be one of ${short(params.allowedValues, 120)}, got ${short(valueAtPointer(root, error.instancePath))}`
    case 'const':
      return `must be ${short(params.allowedValue)}, got ${short(valueAtPointer(root, error.instancePath))}`
    case 'format':
      return `must match format ${JSON.stringify(params.format)}, got ${short(valueAtPointer(root, error.instancePath))}`
    case 'pattern':
      return `must match pattern /${String(params.pattern)}/, got ${short(valueAtPointer(root, error.instancePath))}`
    default:
      return error.message ?? `failed "${error.keyword}"`
  }
}

function toIssues(errors: ErrorObject[], root: unknown): SchemaIssue[] {
  const seen = new Set<string>()
  const issues: SchemaIssue[] = []
  for (const error of errors) {
    const issue: SchemaIssue = {
      path: formatInstancePath(error.instancePath, root),
      message: issueMessage(error, root),
      keyword: error.keyword,
      schemaPath: error.schemaPath,
    }
    const key = `${issue.path}\u0000${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push(issue)
  }
  return issues
}
