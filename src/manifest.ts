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
import { diffLinesUnified } from 'jest-diff'
import { DEFAULT_MANIFEST_PATH } from './defaults.js'
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

/** Dotted paths ignored by diffManifest unless overridden (`manifestIgnore`). */
export const DEFAULT_MANIFEST_IGNORE: readonly string[] = ['server.version']

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
  /** Dotted path of the field (`description`, `server.name`, `capabilities.tools`). */
  path: string
  /** Absent when the field was added. */
  before?: JsonValue
  /** Absent when the field was removed. */
  after?: JsonValue
}

export interface ItemChange {
  /** Tool / prompt name, resource uri, or uriTemplate. */
  key: string
  fields: FieldChange[]
}

export interface SectionDiff {
  added: string[]
  removed: string[]
  changed: ItemChange[]
}

export const MANIFEST_SECTIONS = ['tools', 'resources', 'resourceTemplates', 'prompts'] as const
export type ManifestSection = (typeof MANIFEST_SECTIONS)[number]

export interface ManifestDiff {
  identical: boolean
  /** Server-level changes: protocolVersion, server.*, capabilities.*, instructions, listMeta.* */
  changes: FieldChange[]
  tools: SectionDiff
  resources: SectionDiff
  resourceTemplates: SectionDiff
  prompts: SectionDiff
}

export interface DiffManifestOptions {
  /**
   * Dotted paths to ignore. Sections are keyed by item name / uri: `tools.*.annotations`,
   * `tools.echo.description`, `capabilities.experimental`, `listMeta`. Default
   * `["server.version"]`; pass `[]` to compare everything.
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
    for (const item of (manifest[section] ?? []) as unknown as JsonObject[]) {
      items[String(item[SECTION_KEY[section]])] = item
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

function fieldChanges(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  prefix: string,
): FieldChange[] {
  const a = isObject(before) ? before : {}
  const b = isObject(after) ? after : {}
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compare)
  const changes: FieldChange[] = []
  for (const key of keys) {
    if (jsonEqual(a[key], b[key])) continue
    changes.push({
      path: prefix ? `${prefix}.${key}` : key,
      ...(a[key] !== undefined ? { before: a[key] } : {}),
      ...(b[key] !== undefined ? { after: b[key] } : {}),
    })
  }
  return changes
}

function sectionDiff(before: JsonValue | undefined, after: JsonValue | undefined): SectionDiff {
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
    changed.push({ key, fields: fieldChanges(a[key], b[key], '') })
  }
  return { added, removed, changed }
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
  for (const key of ['protocolVersion', 'instructions']) {
    if (!jsonEqual(a[key], b[key])) {
      changes.push({
        path: key,
        ...(a[key] !== undefined ? { before: a[key] } : {}),
        ...(b[key] !== undefined ? { after: b[key] } : {}),
      })
    }
  }
  for (const key of ['server', 'capabilities', 'listMeta']) {
    changes.push(...fieldChanges(a[key], b[key], key))
  }
  const diff: ManifestDiff = {
    identical: false,
    changes,
    tools: sectionDiff(a.tools, b.tools),
    resources: sectionDiff(a.resources, b.resources),
    resourceTemplates: sectionDiff(a.resourceTemplates, b.resourceTemplates),
    prompts: sectionDiff(a.prompts, b.prompts),
  }
  diff.identical =
    changes.length === 0 &&
    MANIFEST_SECTIONS.every(
      (s) => diff[s].added.length + diff[s].removed.length + diff[s].changed.length === 0,
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

/** One-line summary: `1 tool changed (echo: description); 1 prompt added (greet)`. */
export function summarizeDiff(diff: ManifestDiff): string {
  if (diff.identical) return 'no changes'
  const parts: string[] = []
  for (const section of MANIFEST_SECTIONS) {
    const d = diff[section]
    const noun = SECTION_NOUN[section]
    if (d.added.length) parts.push(`${count(d.added.length, noun)} added (${names(d.added)})`)
    if (d.removed.length) {
      parts.push(`${count(d.removed.length, noun)} removed (${names(d.removed)})`)
    }
    if (d.changed.length) {
      const detail = d.changed
        .slice(0, 3)
        .map((c) => `${c.key}: ${c.fields.map((f) => f.path).join(', ')}`)
        .join('; ')
      const more = d.changed.length > 3 ? `; +${d.changed.length - 3} more` : ''
      parts.push(`${count(d.changed.length, noun)} changed (${detail}${more})`)
    }
  }
  if (diff.changes.length) parts.push(`${names(diff.changes.map((c) => c.path))} changed`)
  return parts.join('; ')
}

function short(value: JsonValue | undefined, max = 100): string {
  if (value === undefined) return '(absent)'
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const plain = (s: string) => s

function changeLines(change: FieldChange, indent: string): string[] {
  const { before, after } = change
  const isStructured = (v: JsonValue | undefined) => isObject(v) || Array.isArray(v)
  if (!isStructured(before) || !isStructured(after)) {
    return [`${indent}${change.path}: ${short(before)} -> ${short(after)}`]
  }
  const unified = diffLinesUnified(
    JSON.stringify(before, null, 2).split('\n'),
    JSON.stringify(after, null, 2).split('\n'),
    {
      aAnnotation: 'locked',
      bAnnotation: 'live',
      expand: false,
      contextLines: 1,
      omitAnnotationLines: true,
      aColor: plain,
      bColor: plain,
      changeColor: plain,
      commonColor: plain,
      patchColor: plain,
    },
  )
  return [`${indent}${change.path}:`, ...unified.split('\n').map((line) => `${indent}  ${line}`)]
}

/** Multi-line, uncolored rendering for the console (`vib manifest diff`, `vib diff`). */
export function formatDiff(diff: ManifestDiff): string {
  if (diff.identical) return 'Manifest: no changes.'
  const lines: string[] = [`Manifest drift: ${summarizeDiff(diff)}`]
  for (const change of diff.changes) lines.push(...changeLines(change, '  '))
  for (const section of MANIFEST_SECTIONS) {
    const d = diff[section]
    if (d.added.length + d.removed.length + d.changed.length === 0) continue
    lines.push(`  ${section}:`)
    for (const key of d.added) lines.push(`    + ${key} (added)`)
    for (const key of d.removed) lines.push(`    - ${key} (removed)`)
    for (const item of d.changed) {
      lines.push(`    ~ ${item.key}`)
      for (const change of item.fields) lines.push(...changeLines(change, '        '))
    }
  }
  return lines.join('\n')
}
