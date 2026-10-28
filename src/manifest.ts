/**
 * Manifest lock: a stable, reviewable snapshot of a server's whole MCP surface
 * (`server/discover` + every list verb), and a structured diff between two snapshots.
 *
 * `vib manifest record` writes it; `vib run` diffs the live manifest against it and fails
 * on drift (added/removed tools, changed schemas, descriptions, annotations, capabilities).
 * It doubles as rug-pull detection: any change to model-visible text shows up in review.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_MANIFEST_IGNORE_PATHS, DEFAULT_MANIFEST_PATH } from './defaults.js'
import type { ListMeta, ListMetaEntry } from './lint/types.js'
import { defaultNormalizeConfig, normalizeResult } from './normalize.js'
import { type McpSession, SessionRequestError } from './session/index.js'
import type {
  DiscoverInfo,
  JsonObject,
  JsonValue,
  ListResult,
  PromptSummary,
  ResourceSummary,
  ResourceTemplateSummary,
  RunOptions,
  ToolSummary,
} from './types.js'

export const MANIFEST_VERSION = 2

/**
 * Dotted paths ignored by diffManifest unless overridden (`manifestIgnore`): the server's
 * release version, and what differs only by protocol era (`protocolVersion`, `listMeta`), so
 * one lock serves both eras. `vib manifest diff --strict` compares everything.
 */
export const DEFAULT_MANIFEST_IGNORE: readonly string[] = DEFAULT_MANIFEST_IGNORE_PATHS

export interface Manifest {
  vibrissa: 2
  protocolVersion: string
  server: { name?: string; version?: string }
  capabilities: JsonValue
  instructions?: string
  /** Sorted by name. */
  tools: ToolSummary[]
  /** Sorted by uri. */
  resources: ResourceSummary[]
  /** Sorted by uriTemplate. */
  resourceTemplates: ResourceTemplateSummary[]
  /** Sorted by name. */
  prompts: PromptSummary[]
  /** `ttlMs` / `cacheScope` of each list result that was fetched. */
  listMeta: ListMeta
}

export interface CaptureManifestOptions {
  /** How many tools/list results to collect for the stability check. Default 1. */
  toolsListSamples?: number
}

export interface CapturedManifest {
  manifest: Manifest
  /** Raw tools/list results in server order (the first one built the manifest). */
  toolsListSamples: ToolSummary[][]
  discover: DiscoverInfo
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const ITEM_NORMALIZE = {
  stripMeta: defaultNormalizeConfig.stripMeta,
  dropKeys: [] as string[],
  ttlMs: 'keep' as const,
}

/** Copy `keys` (in this order, then any others sorted), then strip per-version `_meta`. */
function ordered<T>(source: object, keys: readonly string[]): T {
  const record = source as Record<string, unknown>
  const out: JsonObject = {}
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key] as JsonValue
  }
  for (const key of Object.keys(record).sort()) {
    if (!keys.includes(key) && record[key] !== undefined) out[key] = record[key] as JsonValue
  }
  return normalizeResult(out, ITEM_NORMALIZE) as T
}

const TOOL_KEYS = [
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  'icons',
  'execution',
  '_meta',
]
const RESOURCE_KEYS = [
  'uri',
  'name',
  'title',
  'description',
  'mimeType',
  'size',
  'annotations',
  'icons',
  '_meta',
]
const TEMPLATE_KEYS = [
  'uriTemplate',
  'name',
  'title',
  'description',
  'mimeType',
  'annotations',
  'icons',
  '_meta',
]
const PROMPT_KEYS = ['name', 'title', 'description', 'arguments', 'icons', '_meta']
const PROMPT_ARG_KEYS = ['name', 'title', 'description', 'required']

function metaEntry(list: ListResult<unknown>): ListMetaEntry {
  return {
    ...(list.ttlMs !== undefined ? { ttlMs: list.ttlMs } : {}),
    ...(list.cacheScope !== undefined ? { cacheScope: list.cacheScope } : {}),
  }
}

function declares(capabilities: JsonValue, key: string): boolean {
  return isObject(capabilities) && capabilities[key] !== undefined
}

function isMethodNotFound(err: unknown): boolean {
  return (
    err instanceof SessionRequestError &&
    (err.error.code === -32601 || err.error.codeName === 'MethodNotFound')
  )
}

async function optionalList<T>(
  run: () => Promise<ListResult<T>>,
  wanted: boolean,
): Promise<ListResult<T> | undefined> {
  if (!wanted) return undefined
  try {
    return await run()
  } catch (err) {
    if (isMethodNotFound(err)) return undefined
    throw err
  }
}

/** Assemble a Manifest from already-fetched data (pure). */
export function manifestFrom(input: {
  protocolVersion: string
  discover: Pick<DiscoverInfo, 'serverInfo' | 'capabilities' | 'instructions'>
  tools?: ListResult<ToolSummary>
  resources?: ListResult<ResourceSummary>
  resourceTemplates?: ListResult<ResourceTemplateSummary>
  prompts?: ListResult<PromptSummary>
}): Manifest {
  const info = input.discover.serverInfo
  const listMeta: ListMeta = {}
  if (input.tools) listMeta.tools = metaEntry(input.tools)
  if (input.resources) listMeta.resources = metaEntry(input.resources)
  if (input.resourceTemplates) listMeta.resourceTemplates = metaEntry(input.resourceTemplates)
  if (input.prompts) listMeta.prompts = metaEntry(input.prompts)
  return {
    vibrissa: MANIFEST_VERSION,
    protocolVersion: input.protocolVersion,
    server: {
      ...(typeof info?.name === 'string' ? { name: info.name } : {}),
      ...(typeof info?.version === 'string' ? { version: info.version } : {}),
    },
    capabilities: normalizeResult(input.discover.capabilities ?? {}, ITEM_NORMALIZE),
    ...(input.discover.instructions !== undefined
      ? { instructions: input.discover.instructions }
      : {}),
    tools: (input.tools?.items ?? [])
      .map((tool) => ordered<ToolSummary>(tool, TOOL_KEYS))
      .sort((a, b) => compare(a.name, b.name)),
    resources: (input.resources?.items ?? [])
      .map((r) => ordered<ResourceSummary>(r, RESOURCE_KEYS))
      .sort((a, b) => compare(a.uri, b.uri)),
    resourceTemplates: (input.resourceTemplates?.items ?? [])
      .map((t) => ordered<ResourceTemplateSummary>(t, TEMPLATE_KEYS))
      .sort((a, b) => compare(a.uriTemplate, b.uriTemplate)),
    prompts: (input.prompts?.items ?? [])
      .map((p) =>
        ordered<PromptSummary>(
          {
            ...p,
            ...(p.arguments
              ? { arguments: p.arguments.map((arg) => ordered(arg, PROMPT_ARG_KEYS)) }
              : {}),
          },
          PROMPT_KEYS,
        ),
      )
      .sort((a, b) => compare(a.name, b.name)),
    listMeta,
  }
}

/**
 * Snapshot the live server: discover + tools/list (+ resources, templates, prompts when the
 * server declares them). Lists the server does not implement (MethodNotFound) are empty.
 * Throws SessionRequestError when a list call fails for another reason.
 */
export async function captureManifest(
  session: McpSession,
  opts: CaptureManifestOptions = {},
): Promise<CapturedManifest> {
  const discover = await session.discover()
  const caps = discover.capabilities
  const tools = await optionalList(() => session.listToolsResult(), true)
  const samples: ToolSummary[][] = tools ? [tools.items] : []
  for (let i = 1; i < (opts.toolsListSamples ?? 1) && tools; i++) {
    samples.push((await session.listToolsResult()).items)
  }
  const resources = await optionalList(
    () => session.listResourcesResult(),
    declares(caps, 'resources'),
  )
  const resourceTemplates = await optionalList(
    () => session.listResourceTemplatesResult(),
    declares(caps, 'resources'),
  )
  const prompts = await optionalList(() => session.listPromptsResult(), declares(caps, 'prompts'))
  const manifest = manifestFrom({
    protocolVersion: session.protocolVersion || discover.protocolVersion,
    discover,
    tools,
    resources,
    resourceTemplates,
    prompts,
  })
  return { manifest, toolsListSamples: samples, discover }
}

/** Snapshot the live server's manifest. */
export async function buildManifest(session: McpSession): Promise<Manifest> {
  return (await captureManifest(session)).manifest
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Lock file for `server`: the configured `manifest` path for the default server, and a
 * sibling `<name>.<server>.json` for any other server (e.g. `__manifest__.staging.json`).
 */
export function manifestPathFor(
  options: Pick<RunOptions, 'manifest' | 'rootDir' | 'defaultServer'>,
  server: string = options.defaultServer,
): string {
  const configured = options.manifest ?? DEFAULT_MANIFEST_PATH
  const root = options.rootDir ? path.resolve(options.rootDir) : process.cwd()
  const base = path.isAbsolute(configured) ? configured : path.resolve(root, configured)
  if (server === options.defaultServer) return base
  const ext = path.extname(base)
  const safe = server.replace(/[^A-Za-z0-9_.-]/g, '_')
  return ext ? `${base.slice(0, -ext.length)}.${safe}${ext}` : `${base}.${safe}`
}

export class ManifestFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestFileError'
  }
}

/** Read and sanity-check a manifest lock file. */
export function readManifest(file: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new ManifestFileError(
      `Invalid manifest at ${file}: ${err instanceof Error ? err.message : String(err)}. Re-create it with "vib manifest record".`,
    )
  }
  if (!isObject(raw) || raw.vibrissa !== MANIFEST_VERSION || !Array.isArray(raw.tools)) {
    const got = isObject(raw) ? `an object with keys ${Object.keys(raw).join(', ')}` : typeof raw
    throw new ManifestFileError(
      `Invalid manifest at ${file}: expected { "vibrissa": 2, "tools": [...], ... }, got ${got}. Re-create it with "vib manifest record".`,
    )
  }
  const m = raw as unknown as Manifest
  return {
    ...m,
    server: m.server ?? {},
    capabilities: m.capabilities ?? {},
    resources: m.resources ?? [],
    resourceTemplates: m.resourceTemplates ?? [],
    prompts: m.prompts ?? [],
    listMeta: m.listMeta ?? {},
  }
}

/** Write a manifest as 2-space JSON (creating directories). */
export function writeManifest(file: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface FieldChange {
  /**
   * Dotted sub-path of what changed, as deep as it goes: `description`,
   * `inputSchema.required`, `inputSchema.properties.city.type`, `capabilities.tools`.
   */
  path: string
  /** Absent when the field was added. */
  before?: JsonValue
  /** Absent when the field was removed. */
  after?: JsonValue
  /**
   * Would existing clients / cases break? True for: a removed or renamed input property, a
   * newly required property or prompt argument, a type change, removed enum values, a tightened
   * `additionalProperties`, any outputSchema change, a changed resource mimeType, a removed
   * capability, a protocolVersion change. Descriptions, titles and annotations are not breaking.
   */
  breaking: boolean
}

export interface ItemChange {
  /** Tool / prompt name, resource uri, or uriTemplate. */
  key: string
  /** Any of `fields` is breaking. */
  breaking: boolean
  fields: FieldChange[]
}

/** Only non-empty lists are present. Every removed item is a breaking change. */
export interface SectionDiff {
  added?: string[]
  removed?: string[]
  changed?: ItemChange[]
}

export const MANIFEST_SECTIONS = ['tools', 'resources', 'resourceTemplates', 'prompts'] as const
export type ManifestSection = (typeof MANIFEST_SECTIONS)[number]

/** Machine shape: empty lists and unchanged sections are omitted. */
export interface ManifestDiff {
  identical: boolean
  /** At least one breaking change (see FieldChange.breaking) or removed item. */
  breaking: boolean
  /** Server-level changes: protocolVersion, instructions, server.*, capabilities.*, listMeta.* */
  changes?: FieldChange[]
  tools?: SectionDiff
  resources?: SectionDiff
  resourceTemplates?: SectionDiff
  prompts?: SectionDiff
}

export interface DiffManifestOptions {
  /**
   * Dotted paths to ignore. Sections are keyed by item name / uri (`tools.*.annotations`,
   * `tools.notes.search.description`); prompt arguments by name
   * (`prompts.*.arguments.*.description`); `*` matches any key. Default
   * `["server.version", "protocolVersion", "listMeta"]` (per-release and per-era noise); pass
   * `[]` to compare everything (`vib manifest diff --strict`).
   */
  ignore?: readonly string[]
}

const SECTION_KEY: Record<ManifestSection, string> = {
  tools: 'name',
  resources: 'uri',
  resourceTemplates: 'uriTemplate',
  prompts: 'name',
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Deep equality ignoring object key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function byName(list: unknown): JsonObject | undefined {
  if (!Array.isArray(list)) return undefined
  const out: JsonObject = {}
  for (const item of list) {
    if (isObject(item) && typeof item.name === 'string') out[item.name] = item
  }
  return out
}

/** Manifest → `{ section: { key: item } }` view used for ignore paths and diffing. */
function keyed(manifest: Manifest): JsonObject {
  const out: JsonObject = {
    protocolVersion: manifest.protocolVersion ?? null,
    server: (manifest.server ?? {}) as JsonObject,
    capabilities: manifest.capabilities ?? {},
    ...(manifest.instructions !== undefined ? { instructions: manifest.instructions } : {}),
    listMeta: (manifest.listMeta ?? {}) as JsonObject,
  }
  for (const section of MANIFEST_SECTIONS) {
    const items: JsonObject = {}
    for (const raw of (manifest[section] ?? []) as unknown as JsonObject[]) {
      let item: JsonObject = raw
      if (section === 'prompts' && Array.isArray(raw.arguments)) {
        item = { ...raw, arguments: byName(raw.arguments) ?? {} }
      }
      items[String(raw[SECTION_KEY[section]])] = item
    }
    out[section] = items
  }
  return out
}

/** Remove a dotted path (with `*` wildcards; keys may themselves contain dots). */
function omit(value: JsonValue, segments: string[]): JsonValue | undefined {
  if (segments.length === 0) return undefined
  if (!isObject(value)) return value
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    let next: JsonValue | undefined = child
    for (let k = 1; k <= segments.length && next !== undefined; k++) {
      const head = segments.slice(0, k).join('.')
      if (head === key || (k === 1 && segments[0] === '*')) next = omit(next, segments.slice(k))
    }
    if (next !== undefined) out[key] = next
  }
  return out
}

function applyIgnore(view: JsonObject, ignore: readonly string[]): JsonObject {
  let out: JsonValue = view
  for (const pattern of ignore) {
    const segments = pattern.split('.').filter(Boolean)
    if (segments.length > 0) out = omit(out, segments) ?? {}
  }
  return out as JsonObject
}

function segment(key: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? key : `[${JSON.stringify(key)}]`
}

function joinField(prefix: string, key: string): string {
  const seg = segment(key)
  if (!prefix) return seg
  return seg.startsWith('[') ? `${prefix}${seg}` : `${prefix}.${seg}`
}

interface RawChange {
  path: string
  segments: string[]
  before?: JsonValue
  after?: JsonValue
}

/** Leaf-level changes between two values (objects recurse; arrays and scalars are leaves). */
function leafChanges(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  prefix: string,
  segments: string[],
): RawChange[] {
  if (jsonEqual(before, after)) return []
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compare)
    return keys.flatMap((key) =>
      leafChanges(before[key], after[key], joinField(prefix, key), [...segments, key]),
    )
  }
  return [
    {
      path: prefix,
      segments,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    },
  ]
}

function stringsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function lostValues(before: JsonValue | undefined, after: JsonValue | undefined): boolean {
  if (!Array.isArray(before)) return false
  const kept = Array.isArray(after) ? after.map(canonical) : []
  return before.some((v) => !kept.includes(canonical(v)))
}

/** Breaking-ness of a schema leaf change (input side: stricter is breaking). */
function schemaBreaking(change: RawChange, rel: string[]): boolean {
  if (rel.length === 0) return true // the whole schema appeared / disappeared / changed type
  const last = rel[rel.length - 1]
  const parent = rel[rel.length - 2]
  if (parent === 'properties' && change.after === undefined) return true // removed / renamed
  if (last === 'required') {
    const before = stringsOf(change.before)
    return stringsOf(change.after).some((name) => !before.includes(name))
  }
  if (last === 'type') return change.after !== undefined && !jsonEqual(change.before, change.after)
  if (last === 'enum') return change.after !== undefined && lostValues(change.before, change.after)
  if (last === 'additionalProperties') return change.after === false && change.before !== false
  return false
}

function itemBreaking(section: ManifestSection, change: RawChange): boolean {
  const [field, ...rest] = change.segments
  switch (section) {
    case 'tools':
      if (field === 'outputSchema') return true
      if (field === 'inputSchema') return schemaBreaking(change, rest)
      return false
    case 'resources':
    case 'resourceTemplates':
      return field === 'mimeType'
    case 'prompts':
      if (field !== 'arguments') return false
      if (rest.length === 1) {
        // An argument added as required, or removed.
        if (change.after === undefined) return true
        return (
          change.before === undefined && isObject(change.after) && change.after.required === true
        )
      }
      return rest[1] === 'required' && change.after === true && change.before !== true
  }
}

function serverBreaking(change: RawChange): boolean {
  const [field, ...rest] = change.segments
  if (field === 'protocolVersion') return true
  if (field === 'capabilities') return rest.length === 1 && change.after === undefined
  return false
}

function finalize(change: RawChange, breaking: boolean): FieldChange {
  return {
    path: change.path,
    ...(change.before !== undefined ? { before: change.before } : {}),
    ...(change.after !== undefined ? { after: change.after } : {}),
    breaking,
  }
}

function sectionDiff(
  section: ManifestSection,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): SectionDiff | undefined {
  const a = isObject(before) ? before : {}
  const b = isObject(after) ? after : {}
  const added = Object.keys(b)
    .filter((key) => !Object.hasOwn(a, key))
    .sort(compare)
  const removed = Object.keys(a)
    .filter((key) => !Object.hasOwn(b, key))
    .sort(compare)
  const changed: ItemChange[] = []
  for (const key of Object.keys(a).sort(compare)) {
    if (!Object.hasOwn(b, key) || jsonEqual(a[key], b[key])) continue
    const fields = leafChanges(a[key], b[key], '', []).map((c) =>
      finalize(c, itemBreaking(section, c)),
    )
    changed.push({ key, breaking: fields.some((f) => f.breaking), fields })
  }
  if (added.length + removed.length + changed.length === 0) return undefined
  return {
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(changed.length ? { changed } : {}),
  }
}

/** Structured diff of a locked manifest against the live one. */
export function diffManifest(
  locked: Manifest,
  live: Manifest,
  opts: DiffManifestOptions = {},
): ManifestDiff {
  const ignore = opts.ignore ?? DEFAULT_MANIFEST_IGNORE
  const a = applyIgnore(keyed(locked), ignore)
  const b = applyIgnore(keyed(live), ignore)
  const changes: FieldChange[] = []
  for (const key of ['protocolVersion', 'instructions', 'server', 'capabilities', 'listMeta']) {
    for (const change of leafChanges(a[key], b[key], key, [key])) {
      changes.push(finalize(change, serverBreaking(change)))
    }
  }
  const diff: ManifestDiff = { identical: true, breaking: false }
  if (changes.length) diff.changes = changes
  for (const section of MANIFEST_SECTIONS) {
    const d = sectionDiff(section, a[section], b[section])
    if (d) diff[section] = d
  }
  diff.identical = !diff.changes && MANIFEST_SECTIONS.every((s) => diff[s] === undefined)
  diff.breaking =
    changes.some((c) => c.breaking) ||
    MANIFEST_SECTIONS.some(
      (s) =>
        (diff[s]?.removed?.length ?? 0) > 0 || (diff[s]?.changed ?? []).some((c) => c.breaking),
    )
  return diff
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SECTION_NOUN: Record<ManifestSection, [string, string]> = {
  tools: ['tool', 'tools'],
  resources: ['resource', 'resources'],
  resourceTemplates: ['resource template', 'resource templates'],
  prompts: ['prompt', 'prompts'],
}

function names(list: string[], max = 3): string {
  const shown = list.slice(0, max).join(', ')
  return list.length > max ? `${shown}, +${list.length - max} more` : shown
}

function count(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * One-line summary: `1 tool changed (echo: description); 1 prompt added (greet)`, ending in
 * ` (breaking)` when any change is breaking.
 */
export function summarizeDiff(diff: ManifestDiff): string {
  if (diff.identical) return 'no changes'
  const parts: string[] = []
  for (const section of MANIFEST_SECTIONS) {
    const d = diff[section]
    if (!d) continue
    const noun = SECTION_NOUN[section]
    if (d.added?.length) parts.push(`${count(d.added.length, noun)} added (${names(d.added)})`)
    if (d.removed?.length) {
      parts.push(`${count(d.removed.length, noun)} removed (${names(d.removed)})`)
    }
    if (d.changed?.length) {
      const detail = d.changed
        .slice(0, 3)
        .map(
          (c) =>
            `${c.key}: ${names(
              c.fields.map((f) => f.path),
              4,
            )}`,
        )
        .join('; ')
      const more = d.changed.length > 3 ? `; +${d.changed.length - 3} more` : ''
      parts.push(`${count(d.changed.length, noun)} changed (${detail}${more})`)
    }
  }
  if (diff.changes?.length) parts.push(`${names(diff.changes.map((c) => c.path))} changed`)
  return `${parts.join('; ')}${diff.breaking ? ' (breaking)' : ''}`
}

function short(value: JsonValue | undefined, max = 120): string {
  if (value === undefined) return '(absent)'
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const MAX_WORD_TOKENS = 600

/** Word-level diff in git's `--word-diff=plain` notation: `[-removed-]{+added+}`. */
export function wordDiff(before: string, after: string): string | undefined {
  const a = before.match(/\s+|[^\s]+/g) ?? []
  const b = after.match(/\s+|[^\s]+/g) ?? []
  if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) return undefined
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: Array<['=' | '-' | '+', string]> = []
  const push = (op: '=' | '-' | '+', token: string) => {
    const last = ops[ops.length - 1]
    if (last && last[0] === op) last[1] += token
    else ops.push([op, token])
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('=', a[i])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('-', a[i++])
    else push('+', b[j++])
  }
  while (i < a.length) push('-', a[i++])
  while (j < b.length) push('+', b[j++])

  // Merge change runs separated only by whitespace into one [-...-]{+...+} pair.
  let out = ''
  let k = 0
  while (k < ops.length) {
    if (ops[k][0] === '=') {
      out += ops[k][1]
      k++
      continue
    }
    let removed = ''
    let added = ''
    while (k < ops.length) {
      const [op, text] = ops[k]
      if (op === '-') removed += text
      else if (op === '+') added += text
      else if (/^\s+$/.test(text) && k + 1 < ops.length && ops[k + 1][0] !== '=') {
        removed += text
        added += text
      } else break
      k++
    }
    out += `${removed ? `[-${removed}-]` : ''}${added ? `{+${added}+}` : ''}`
  }
  return out
}

function changeLine(change: FieldChange, indent: string): string {
  const tag = change.breaking ? '  (breaking)' : ''
  const { before, after } = change
  if (typeof before === 'string' && typeof after === 'string' && /\s/.test(before + after)) {
    const words = wordDiff(before, after)
    if (words !== undefined) return `${indent}${change.path}: ${words}${tag}`
  }
  return `${indent}${change.path}: ${short(before)} -> ${short(after)}${tag}`
}

/**
 * Multi-line, uncolored rendering: one line per changed sub-path (word diff for prose),
 * `+` / `-` per added / removed item, `(breaking)` on breaking lines; empty sections omitted.
 */
export function formatDiff(diff: ManifestDiff): string {
  if (diff.identical) return 'Manifest: no changes.'
  const lines: string[] = [`Manifest drift: ${summarizeDiff(diff)}`]
  for (const change of diff.changes ?? []) lines.push(changeLine(change, '  '))
  for (const section of MANIFEST_SECTIONS) {
    const d = diff[section]
    if (!d) continue
    lines.push(`  ${section}:`)
    for (const key of d.added ?? []) lines.push(`    + ${key} (added)`)
    for (const key of d.removed ?? []) lines.push(`    - ${key} (removed)  (breaking)`)
    for (const item of d.changed ?? []) {
      lines.push(`    ~ ${item.key}`)
      for (const change of item.fields) lines.push(changeLine(change, '        '))
    }
  }
  return lines.join('\n')
}
