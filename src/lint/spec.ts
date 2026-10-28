/**
 * Deterministic spec-sanity checks over a recorded manifest (the Layer 0 subset
 * Vibrissa can run on stdio): protocol version, tools/list determinism, list
 * cache metadata, JSON Schema validity and local `$ref` resolution, server
 * identity and capabilities. Pure: takes data, never opens a session.
 *
 * Also exports `errorCodeExpectations`, the per-era error-code table the live
 * runner uses to assert error behavior.
 */
import type { CheckOutcome } from '../events.js'
import { isValidSchema } from '../schema.js'
import type { JsonValue } from '../types.js'
import {
  type Finding,
  type LintOptions,
  type RuleMeta,
  buildOutcomes,
  isAllowed,
  sortOutcomes,
} from './outcomes.js'
import { findUnresolvedRefs } from './refs.js'
import { clip } from './text.js'
import type { ListMeta, ManifestLike, ToolSummary } from './types.js'

// ---------------------------------------------------------------------------
// Protocol versions & eras
// ---------------------------------------------------------------------------

export const KNOWN_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

export type Era = 'legacy' | 'modern'

/** `modern` for 2026-07-28 and later (date-shaped versions compare lexically), else `legacy`. */
export function eraOf(protocolVersion: string | undefined): Era | undefined {
  if (typeof protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(protocolVersion)) {
    return undefined
  }
  return protocolVersion >= MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy'
}

// ---------------------------------------------------------------------------
// Error-code expectations (for the phase-2 live runner)
// ---------------------------------------------------------------------------

export interface ExpectedCode {
  code: number
  name: string
  /** Other codes a tolerant assertion should accept (backwards compatibility). */
  alsoAccept?: number[]
}

export interface ErrorCodeExpectation {
  situation: string
  /** 2026-07-28 and later. */
  modern: ExpectedCode
  /** 2025-era revisions; null when the situation has no JSON-RPC error there. */
  legacy: ExpectedCode | null
  note?: string
}

export type ErrorSituation =
  | 'unsupportedProtocolVersion'
  | 'headerMismatch'
  | 'missingRequiredClientCapability'
  | 'resourceNotFound'
  | 'unknownTool'
  | 'invalidParams'
  | 'methodNotFound'

export const errorCodeExpectations: Readonly<Record<ErrorSituation, ErrorCodeExpectation>> = {
  unsupportedProtocolVersion: {
    situation: 'Request names a protocol version the server does not support',
    modern: { code: -32022, name: 'UnsupportedProtocolVersion' },
    legacy: null,
    note: '2025-era servers answer initialize with a version they do support instead of erroring.',
  },
  headerMismatch: {
    situation: 'HTTP Mcp-* headers disagree with the JSON-RPC body (Streamable HTTP)',
    modern: { code: -32020, name: 'HeaderMismatch' },
    legacy: null,
    note: '2025-era HTTP servers reject with a plain 400 and no assigned JSON-RPC code.',
  },
  missingRequiredClientCapability: {
    situation: 'Request needs a client capability the client did not declare',
    modern: { code: -32021, name: 'MissingRequiredClientCapability' },
    legacy: null,
  },
  resourceNotFound: {
    situation: 'resources/read for a URI the server does not have',
    modern: { code: -32602, name: 'InvalidParams' },
    legacy: { code: -32002, name: 'ResourceNotFound', alsoAccept: [-32602] },
    note: 'Renumbered in 2026-07-28. SDK v2 servers emit -32602 on every revision, so legacy assertions also accept it.',
  },
  unknownTool: {
    situation: 'tools/call names a tool that does not exist',
    modern: { code: -32602, name: 'InvalidParams' },
    legacy: { code: -32602, name: 'InvalidParams' },
  },
  invalidParams: {
    situation: 'Request params fail the method schema',
    modern: { code: -32602, name: 'InvalidParams' },
    legacy: { code: -32602, name: 'InvalidParams' },
  },
  methodNotFound: {
    situation: 'Unknown JSON-RPC method (or capability not offered)',
    modern: { code: -32601, name: 'MethodNotFound' },
    legacy: { code: -32601, name: 'MethodNotFound' },
  },
}

/** The code to expect for `situation` under `protocolVersion`; undefined when none applies. */
export function expectedErrorCode(
  situation: ErrorSituation,
  protocolVersion: string,
): ExpectedCode | undefined {
  const row = errorCodeExpectations[situation]
  const era = eraOf(protocolVersion) ?? 'modern'
  return (era === 'modern' ? row.modern : row.legacy) ?? undefined
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type SchemaValidator = (schema: JsonValue) => {
  ok: boolean
  /** `keyword` is the failing JSON Schema keyword when known (`$ref` for unresolved refs). */
  errors: Array<{ path: string; message: string; keyword?: string }>
}

export interface SpecInput extends ManifestLike {
  /** Two or more consecutive tools/list results, in call order. */
  toolsListSamples?: ToolSummary[][]
}

export interface SpecOptions extends LintOptions {
  /** Defaults to `isValidSchema` from src/schema.ts (Ajv 2020-12). */
  validateSchema?: SchemaValidator
}

interface SpecContext {
  version?: string
  era?: Era
  validate: SchemaValidator
}

interface CheckResult {
  findings: Finding[]
  passDetail?: string
}

export interface SpecCheck extends RuleMeta {
  run(input: SpecInput, ctx: SpecContext): CheckResult
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function q(s: string): string {
  return JSON.stringify(s)
}

function toolList(v: unknown): ToolSummary[] {
  return Array.isArray(v) ? (v.filter(isRecord) as unknown as ToolSummary[]) : []
}

function toolSubject(t: ToolSummary, i: number): { subject: string; key: string } {
  return typeof t.name === 'string' && t.name !== ''
    ? { subject: `tool ${q(t.name)}`, key: t.name }
    : { subject: `tools[${i}]`, key: `#${i}` }
}

/** Key-order-insensitive canonical JSON. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isRecord(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${q(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

const SCHEMA_FIELDS = ['inputSchema', 'outputSchema'] as const
const DIALECT_2020_12 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/u

function foreignDialect(schema: unknown): string | undefined {
  if (!isRecord(schema) || typeof schema.$schema !== 'string') return undefined
  return DIALECT_2020_12.test(schema.$schema) ? undefined : schema.$schema
}

function eachSchema(
  input: SpecInput,
  fn: (schema: unknown, field: string, who: { subject: string; key: string }) => void,
): number {
  let n = 0
  toolList(input.tools).forEach((tool, i) => {
    for (const field of SCHEMA_FIELDS) {
      const schema = tool[field]
      if (schema === undefined) continue
      n++
      fn(schema, field, toolSubject(tool, i))
    }
  })
  return n
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function protocolVersion(input: SpecInput): CheckResult {
  const v = input.protocolVersion
  if (typeof v !== 'string' || v === '') {
    return {
      findings: [
        { message: 'no protocolVersion reported; server/discover (or initialize) did not succeed' },
      ],
    }
  }
  if ((KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(v)) {
    return { findings: [], passDetail: `${v} (${eraOf(v)} era)` }
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(v) && v > MODERN_PROTOCOL_VERSION) {
    return {
      findings: [
        {
          message: `protocolVersion ${q(v)} is newer than this Vibrissa knows (${MODERN_PROTOCOL_VERSION}); checks use ${MODERN_PROTOCOL_VERSION} rules`,
          informational: true,
        },
      ],
    }
  }
  return {
    findings: [
      {
        message: `protocolVersion ${q(v)} is not a recognized MCP revision (${KNOWN_PROTOCOL_VERSIONS.join(', ')})`,
      },
    ],
  }
}

function describeToolDiff(a: ToolSummary, b: ToolSummary): string[] {
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()
  return keys.filter((k) => canonical(ra[k]) !== canonical(rb[k]))
}

function toolsListStable(input: SpecInput, ctx: SpecContext): CheckResult {
  const samples = Array.isArray(input.toolsListSamples) ? input.toolsListSamples.map(toolList) : []
  if (samples.length < 2) {
    return {
      findings: [
        {
          message: 'not checked: needs two consecutive tools/list results (toolsListSamples)',
          informational: true,
        },
      ],
    }
  }
  // Determinism is a MUST from 2026-07-28; on older eras it is advice.
  const severity = ctx.era === 'legacy' ? ('warned' as const) : undefined
  const eraNote =
    ctx.era === 'legacy' ? ` (${ctx.version} does not require determinism; 2026-07-28 does)` : ''
  const findings: Finding[] = []
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const next = samples[i]
    const label = `calls ${i} and ${i + 1}`
    const pn = prev.map((t) => String(t.name))
    const nn = next.map((t) => String(t.name))
    const added = nn.filter((n) => !pn.includes(n))
    const removed = pn.filter((n) => !nn.includes(n))
    if (added.length || removed.length || pn.length !== nn.length) {
      const parts = [
        added.length ? `added ${added.map(q).join(', ')}` : '',
        removed.length ? `removed ${removed.map(q).join(', ')}` : '',
      ].filter(Boolean)
      findings.push({
        message: `tool set changed between ${label}: ${parts.join('; ') || `${pn.length} vs ${nn.length} entries`}${eraNote}`,
        severity,
      })
      continue
    }
    const at = pn.findIndex((n, j) => n !== nn[j])
    if (at !== -1) {
      findings.push({
        message: `order changed between ${label} at index ${at}: ${q(pn[at])} then ${q(nn[at])}${eraNote}`,
        severity,
      })
      continue
    }
    prev.forEach((t, j) => {
      const fields = describeToolDiff(t, next[j])
      if (fields.length) {
        findings.push({
          subject: `tool ${q(pn[j])}`,
          key: pn[j],
          message: `definition changed between ${label} (${fields.join(', ')})${eraNote}`,
          severity,
        })
      }
    })
  }
  return {
    findings,
    passDetail: `${samples.length} samples, ${samples[0].length} tool(s), identical`,
  }
}

const LISTS: Array<keyof ListMeta> = ['tools', 'resources', 'resourceTemplates', 'prompts']
const LIST_METHOD: Record<keyof ListMeta, string> = {
  tools: 'tools/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list',
  prompts: 'prompts/list',
}

function listCacheMetadata(input: SpecInput, ctx: SpecContext): CheckResult {
  if (ctx.era !== 'modern') {
    const why = ctx.version ? `server negotiated ${ctx.version}` : 'protocol version unknown'
    return {
      findings: [
        {
          message: `skipped: ttlMs/cacheScope are required from ${MODERN_PROTOCOL_VERSION}; ${why}`,
          informational: true,
        },
      ],
    }
  }
  const meta = isRecord(input.listMeta) ? (input.listMeta as ListMeta) : undefined
  const checked = LISTS.filter((l) => meta?.[l] !== undefined)
  if (!meta || checked.length === 0) {
    return {
      findings: [
        {
          message: 'not checked: no list metadata supplied (listMeta)',
          informational: true,
        },
      ],
    }
  }
  const findings: Finding[] = []
  const seen: string[] = []
  for (const list of checked) {
    const entry = meta[list]
    const method = LIST_METHOD[list]
    if (!isRecord(entry)) {
      findings.push({ subject: method, key: list, message: 'list metadata is not an object' })
      continue
    }
    const { ttlMs, cacheScope } = entry
    if (ttlMs === undefined) {
      findings.push({ subject: method, key: list, message: 'result is missing ttlMs' })
    } else if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      findings.push({
        subject: method,
        key: list,
        message: `ttlMs is ${JSON.stringify(ttlMs)}; expected a number >= 0`,
      })
    }
    if (cacheScope === undefined) {
      findings.push({ subject: method, key: list, message: 'result is missing cacheScope' })
    } else if (cacheScope !== 'public' && cacheScope !== 'private') {
      findings.push({
        subject: method,
        key: list,
        message: `cacheScope is ${JSON.stringify(cacheScope)}; expected "public" or "private"`,
      })
    }
    seen.push(`${method} ttlMs=${JSON.stringify(ttlMs)} cacheScope=${JSON.stringify(cacheScope)}`)
  }
  return { findings, passDetail: seen.join('; ') }
}

function schemaValid(input: SpecInput, ctx: SpecContext): CheckResult {
  const findings: Finding[] = []
  const total = eachSchema(input, (schema, field, who) => {
    let result: ReturnType<SchemaValidator>
    try {
      result = ctx.validate(schema as JsonValue)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      findings.push({ ...who, message: `${field} could not be compiled: ${msg}` })
      return
    }
    if (result.ok) return
    // The validator also compiles $refs; unresolved ones are reported once, by spec/schema-refs.
    const onlyRefErrors =
      result.errors.length > 0 && result.errors.every((e) => e.keyword === '$ref')
    if (onlyRefErrors && findUnresolvedRefs(schema).length > 0) return
    const errs = result.errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`)
    const more = result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ''
    const dialect = foreignDialect(schema)
      ? `JSON Schema (${foreignDialect(schema)})`
      : 'JSON Schema 2020-12'
    findings.push({
      ...who,
      message: `${field} is not a valid ${dialect}: ${errs.join('; ') || 'invalid'}${more}`,
    })
  })
  return { findings, passDetail: `${total} schema(s) valid` }
}

function schemaDialect(input: SpecInput): CheckResult {
  const findings: Finding[] = []
  eachSchema(input, (schema, field, who) => {
    const d = foreignDialect(schema)
    if (d) {
      findings.push({
        ...who,
        message: `${field} declares $schema ${q(d)}; MCP's default dialect is 2020-12 and clients may not support others`,
      })
    }
  })
  return { findings }
}

function schemaRefs(input: SpecInput): CheckResult {
  const findings: Finding[] = []
  let refsChecked = 0
  eachSchema(input, (schema, field, who) => {
    refsChecked++
    for (const p of findUnresolvedRefs(schema)) {
      findings.push({ ...who, message: `${field}${p.at}: $ref ${q(p.ref)} ${p.message}` })
    }
  })
  return { findings, passDetail: `${refsChecked} schema(s) checked` }
}

const MAX_NOISE_SAMPLES = 3

function stdoutClean(input: SpecInput): CheckResult {
  const noise = input.stdoutNoise as unknown
  if (!isRecord(noise)) {
    if (input.transport === 'stdio') {
      return {
        findings: [
          {
            message: 'not checked: no stdout capture supplied (stdoutNoise)',
            informational: true,
          },
        ],
      }
    }
    const why = input.transport === 'http' ? 'not applicable (http transport)' : 'not checked'
    return { findings: [], passDetail: why }
  }
  const sample = Array.isArray(noise.sample)
    ? noise.sample.filter((s): s is string => typeof s === 'string')
    : []
  const lines =
    typeof noise.lines === 'number' && Number.isFinite(noise.lines) ? noise.lines : sample.length
  if (lines <= 0) return { findings: [], passDetail: 'stdout carried only JSON-RPC' }
  const shown = sample.slice(0, MAX_NOISE_SAMPLES).map((s) => q(clip(s, 120)))
  const more = sample.length > shown.length ? ` (+${sample.length - shown.length} more)` : ''
  const eg = shown.length ? `, e.g. ${shown.join(', ')}${more}` : ''
  return {
    findings: [
      {
        message: `${lines} non-JSON-RPC line(s) on stdout${eg}. Write logs to stderr: on the stdio transport stdout must carry only JSON-RPC messages`,
      },
    ],
  }
}

function serverIdentity(input: SpecInput): CheckResult {
  const s = isRecord(input.server) ? input.server : {}
  const findings: Finding[] = []
  for (const k of ['name', 'version'] as const) {
    if (typeof s[k] !== 'string' || s[k] === '') {
      findings.push({ message: `server ${k} missing (serverInfo.${k})` })
    }
  }
  return { findings, passDetail: `${s.name}@${s.version}` }
}

export const KNOWN_SERVER_CAPABILITIES = [
  'experimental',
  'logging',
  'completions',
  'prompts',
  'resources',
  'tools',
  'tasks',
  'extensions',
] as const

const CAPABILITY_FLAGS: Record<string, readonly string[]> = {
  tools: ['listChanged'],
  prompts: ['listChanged'],
  resources: ['subscribe', 'listChanged'],
}

function capabilities(input: SpecInput): CheckResult {
  const caps = input.capabilities
  if (caps === undefined) return { findings: [{ message: 'no capabilities reported' }] }
  if (!isRecord(caps)) return { findings: [{ message: 'capabilities is not an object' }] }
  const findings: Finding[] = []
  const known = KNOWN_SERVER_CAPABILITIES as readonly string[]
  for (const [k, v] of Object.entries(caps)) {
    if (!known.includes(k)) {
      findings.push({
        message: `unknown top-level capability ${q(k)}; put custom capabilities under "extensions" (or "experimental")`,
      })
      continue
    }
    if (!isRecord(v)) {
      findings.push({ message: `capabilities.${k} is ${JSON.stringify(v)}; expected an object` })
      continue
    }
    for (const flag of CAPABILITY_FLAGS[k] ?? []) {
      if (v[flag] !== undefined && typeof v[flag] !== 'boolean') {
        findings.push({
          message: `capabilities.${k}.${flag} is ${JSON.stringify(v[flag])}; expected a boolean`,
        })
      }
    }
    if (
      (k === 'extensions' || k === 'experimental') &&
      Object.values(v).some((e) => !isRecord(e))
    ) {
      findings.push({ message: `every entry of capabilities.${k} must be an object` })
    }
  }
  const advertised: Array<[string, unknown[] | undefined]> = [
    ['tools', input.tools],
    ['resources', input.resources],
    ['prompts', input.prompts],
  ]
  for (const [cap, items] of advertised) {
    if (Array.isArray(items) && items.length > 0 && caps[cap] === undefined) {
      findings.push({
        message: `server lists ${items.length} ${cap} but does not advertise the "${cap}" capability`,
      })
    }
  }
  return { findings, passDetail: Object.keys(caps).join(', ') || '(none)' }
}

// biome-ignore format: one check per line keeps the table scannable
export const SPEC_CHECKS: readonly SpecCheck[] = [
  { id: 'spec/protocol-version', title: 'Discover reports a recognized protocol version', severity: 'failed', run: protocolVersion },
  { id: 'spec/stdout-clean', title: 'stdio server keeps stdout for JSON-RPC only', severity: 'failed', run: stdoutClean },
  { id: 'spec/tools-list-stable', title: 'tools/list is deterministic across calls', severity: 'failed', run: toolsListStable },
  { id: 'spec/list-cache-metadata', title: 'List results carry ttlMs and cacheScope', severity: 'failed', run: listCacheMetadata },
  { id: 'spec/schema-valid', title: 'Tool schemas are valid JSON Schema 2020-12', severity: 'failed', run: schemaValid },
  { id: 'spec/schema-dialect', title: 'Tool schemas use the 2020-12 dialect', severity: 'warned', run: schemaDialect },
  { id: 'spec/schema-refs', title: 'Every $ref resolves inside its schema', severity: 'failed', run: schemaRefs },
  { id: 'spec/server-identity', title: 'Server reports name and version', severity: 'warned', run: serverIdentity },
  { id: 'spec/capabilities', title: 'Capabilities object is well-formed', severity: 'warned', run: capabilities },
]

/** Run every spec-sanity check over `input`. Pure; sorted failed -> warned -> passed. */
export function checkSpec(input: SpecInput, opts: SpecOptions = {}): CheckOutcome[] {
  const data: SpecInput = isRecord(input) ? input : { tools: [] }
  const version = typeof data.protocolVersion === 'string' ? data.protocolVersion : undefined
  const ctx: SpecContext = {
    version,
    era: eraOf(version),
    validate: opts.validateSchema ?? isValidSchema,
  }
  const out: CheckOutcome[] = []
  for (const check of SPEC_CHECKS) {
    if (isAllowed(opts.allow, check.id)) continue
    const { findings, passDetail } = check.run(data, ctx)
    out.push(...buildOutcomes(check, findings, opts, passDetail))
  }
  return sortOutcomes(out)
}
