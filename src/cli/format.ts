/**
 * Human output for the CLI: colors (only on a TTY, honoring NO_COLOR / FORCE_COLOR),
 * aligned tables, schema summaries, and help pages. `--json` output never goes through
 * this module.
 */
import { type Colors, createColors, resolveStyle, visibleLength } from '../reporters/ansi.js'
import type {
  JsonValue,
  PromptSummary,
  ResourceSummary,
  ResourceTemplateSummary,
  ToolSummary,
} from '../types.js'

let cached: Colors | undefined

/** Colors for stdout: enabled on a TTY unless NO_COLOR / TERM=dumb; FORCE_COLOR forces. */
export function colors(): Colors {
  cached ??= createColors(
    resolveStyle(true, process.env, Boolean(process.stdout.isTTY)) === 'pretty',
  )
  return cached
}

/** Reset the cached color decision (tests toggle TTY/env). */
export function resetColors(): void {
  cached = undefined
}

export function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function firstLine(text: string | undefined): string {
  if (!text) return ''
  const trimmed = text.trim()
  const idx = trimmed.search(/\r?\n/)
  return idx === -1 ? trimmed : trimmed.slice(0, idx).trim()
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.length > 0 ? '…' : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Compact one-line JSON, truncated. */
export function preview(value: unknown, max = 80): string {
  const text = value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value))
  return truncate(text, max)
}

/** Terminal width for tables: the TTY's columns, else 120. */
export function terminalWidth(): number {
  const cols = process.stdout.columns
  return typeof cols === 'number' && cols > 40 ? cols : 120
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Column {
  header: string
  /** The column that shrinks (truncated with …) when the table is too wide. */
  flex?: boolean
  paint?: (text: string) => string
}

/**
 * Render rows as an aligned table: a header row, then one line per row. Cells are plain
 * strings (painted after padding, so alignment survives colors). The flex column is
 * truncated so the table fits `width`.
 */
export function renderTable(columns: Column[], rows: string[][], width = terminalWidth()): string {
  const c = colors()
  const gap = 2
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((row) => visibleLength(row[i] ?? ''))),
  )
  const total = widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1)
  const flex = columns.findIndex((col) => col.flex)
  if (flex !== -1 && total > width) {
    widths[flex] = Math.max(columns[flex].header.length, 12, widths[flex] - (total - width))
  }
  const line = (cells: string[], header: boolean) =>
    cells
      .map((cell, i) => {
        const text = truncate(cell ?? '', widths[i])
        const padded = i === cells.length - 1 ? text : text.padEnd(widths[i])
        if (header) return c.dim(padded)
        const paint = columns[i].paint
        return paint ? paint(padded) : padded
      })
      .join(' '.repeat(gap))
      .trimEnd()
  return [
    line(
      columns.map((col) => col.header),
      true,
    ),
    ...rows.map((row) => line(row, false)),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Schema summaries
// ---------------------------------------------------------------------------

/** Short type label for a JSON Schema node: `string`, `integer[]`, `"a"|"b"`, `object`. */
export function schemaTypeLabel(schema: JsonValue | undefined): string {
  if (!isObject(schema)) return schema === true || schema === undefined ? 'any' : 'never'
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, 4).map((v) => JSON.stringify(v))
    return `${values.join('|')}${schema.enum.length > 4 ? '|…' : ''}`
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const type = schema.type
  if (Array.isArray(type)) return type.map(String).join('|')
  if (type === 'array') {
    const items = schema.items
    return `${isObject(items) ? schemaTypeLabel(items) : 'any'}[]`
  }
  if (typeof type === 'string') return type
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) return branches.map((b) => schemaTypeLabel(b)).join('|')
  }
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop() ?? 'ref'
  if (isObject(schema.properties)) return 'object'
  return 'any'
}

/** `text*: string, uppercase: boolean` (required args marked `*`). '' when no properties. */
export function argSummary(inputSchema: JsonValue | undefined, max = 6): string {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return ''
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((v): v is string => typeof v === 'string')
    : []
  const entries = Object.entries(inputSchema.properties)
  const parts = entries
    .slice(0, max)
    .map(([name, prop]) => `${name}${required.includes(name) ? '*' : ''}: ${schemaTypeLabel(prop)}`)
  if (entries.length > max) parts.push(`+${entries.length - max} more`)
  return parts.join(', ')
}

/** `name*, style` from prompt arguments. */
export function promptArgSummary(prompt: PromptSummary): string {
  return (prompt.arguments ?? []).map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ')
}

function toolHints(tool: ToolSummary): string {
  const hints: string[] = []
  const ann = isObject(tool.annotations) ? tool.annotations : {}
  if (ann.readOnlyHint === true) hints.push('read-only')
  if (ann.destructiveHint === true) hints.push('destructive')
  if (ann.idempotentHint === true) hints.push('idempotent')
  if (ann.openWorldHint === true) hints.push('open-world')
  if (tool.outputSchema !== undefined) hints.push('structured')
  const execution = isObject(tool.execution) ? tool.execution : {}
  if (typeof execution.taskSupport === 'string' && execution.taskSupport !== 'forbidden') {
    hints.push(`task:${execution.taskSupport}`)
  }
  return hints.join(' ')
}

export interface ListMetaLike {
  ttlMs?: number
  cacheScope?: string
}

/** `cache: 60000 ms (public)` from list-level ttlMs / cacheScope ('' when neither is set). */
export function formatListMeta(meta: ListMetaLike | undefined): string {
  if (!meta || (meta.ttlMs === undefined && meta.cacheScope === undefined)) return ''
  const ttl = meta.ttlMs !== undefined ? `${meta.ttlMs} ms` : 'no ttl'
  return `cache: ${ttl}${meta.cacheScope !== undefined ? ` (${meta.cacheScope})` : ''}`
}

function heading(text: string, meta?: ListMetaLike): string {
  const c = colors()
  const suffix = formatListMeta(meta)
  return `${c.bold(c.cyan(text))}${suffix ? `  ${c.dim(suffix)}` : ''}`
}

export function formatToolList(tools: ToolSummary[], meta?: ListMetaLike): string {
  if (tools.length === 0) {
    return 'No tools registered on this server. If you expected some, check the server logs (vib discover shows its capabilities).'
  }
  const c = colors()
  const rows = tools.map((tool) => [
    tool.name,
    tool.title ?? '',
    firstLine(tool.description),
    argSummary(tool.inputSchema) || '-',
    toolHints(tool),
  ])
  return [
    heading(plural(tools.length, 'tool'), meta),
    '',
    renderTable(
      [
        { header: 'NAME', paint: (t) => c.bold(t) },
        { header: 'TITLE' },
        { header: 'DESCRIPTION', flex: true, paint: (t) => c.gray(t) },
        { header: 'ARGS (* required)' },
        { header: 'HINTS', paint: (t) => c.dim(t) },
      ],
      rows,
    ),
    '',
    c.dim('Next: vib call <tool> --arg key=value   ·   vib record <tool> --arg key=value'),
  ].join('\n')
}

/** `vib tools <name>`: everything about one tool. */
export function formatToolDetail(tool: ToolSummary): string {
  const c = colors()
  const out: string[] = [`${c.bold(c.cyan(tool.name))}${tool.title ? `  ${tool.title}` : ''}`]
  const hints = toolHints(tool)
  if (hints) out.push(c.dim(hints))
  out.push('')
  out.push(c.bold('Description'))
  out.push(
    ...(tool.description?.trim() ? tool.description.trim().split(/\r?\n/) : ['(none)']).map(
      (line) => `  ${line}`,
    ),
  )
  const schema = isObject(tool.inputSchema) ? tool.inputSchema : {}
  const props = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  out.push('', c.bold('Arguments'))
  if (Object.keys(props).length === 0) out.push('  (none)')
  for (const [name, prop] of Object.entries(props)) {
    const description =
      isObject(prop) && typeof prop.description === 'string' ? `  ${c.gray(prop.description)}` : ''
    out.push(
      `  ${c.bold(name)}${required.includes(name) ? '*' : ''}: ${schemaTypeLabel(prop)}${description}`,
    )
  }
  out.push('', c.bold('inputSchema'), indentJson(tool.inputSchema))
  if (tool.outputSchema !== undefined)
    out.push('', c.bold('outputSchema'), indentJson(tool.outputSchema))
  if (tool.annotations !== undefined)
    out.push('', c.bold('annotations'), indentJson(tool.annotations))
  if (tool.execution !== undefined) out.push('', c.bold('execution'), indentJson(tool.execution))
  out.push(
    '',
    c.dim(
      `Next: vib call ${tool.name} --arg key=value   ·   vib record ${tool.name}   ·   vib fuzz ${tool.name}`,
    ),
  )
  return out.join('\n')
}

export function formatResourceList(
  resources: ResourceSummary[],
  templates: ResourceTemplateSummary[],
  meta: { resources?: ListMetaLike; resourceTemplates?: ListMetaLike } = {},
  notes: string[] = [],
): string {
  const c = colors()
  const out: string[] = []
  out.push(heading(plural(resources.length, 'resource'), meta.resources))
  if (resources.length > 0) {
    out.push(
      '',
      renderTable(
        [
          { header: 'URI', paint: (t) => c.bold(t) },
          { header: 'NAME' },
          { header: 'MIME' },
          { header: 'DESCRIPTION', flex: true, paint: (t) => c.gray(t) },
        ],
        resources.map((r) => [r.uri, r.name, r.mimeType ?? '', firstLine(r.description)]),
      ),
    )
  }
  out.push('', heading(plural(templates.length, 'resource template'), meta.resourceTemplates))
  if (templates.length > 0) {
    out.push(
      '',
      renderTable(
        [
          { header: 'URI TEMPLATE', paint: (t) => c.bold(t) },
          { header: 'NAME' },
          { header: 'MIME' },
          { header: 'DESCRIPTION', flex: true, paint: (t) => c.gray(t) },
        ],
        templates.map((t) => [t.uriTemplate, t.name, t.mimeType ?? '', firstLine(t.description)]),
      ),
    )
  }
  for (const note of notes) out.push('', c.yellow(note))
  out.push(
    '',
    c.dim(
      "Next: vib read <uri>   ·   vib read '<template>' --arg id=42   ·   vib record --resource <uri>",
    ),
  )
  return out.join('\n')
}

export function formatPromptList(
  prompts: PromptSummary[],
  meta?: ListMetaLike,
  notes: string[] = [],
): string {
  const c = colors()
  const out = [heading(plural(prompts.length, 'prompt'), meta)]
  if (prompts.length > 0) {
    out.push(
      '',
      renderTable(
        [
          { header: 'NAME', paint: (t) => c.bold(t) },
          { header: 'TITLE' },
          { header: 'DESCRIPTION', flex: true, paint: (t) => c.gray(t) },
          { header: 'ARGS (* required)' },
        ],
        prompts.map((p) => [p.name, p.title ?? '', firstLine(p.description), promptArgSummary(p)]),
      ),
    )
  }
  for (const note of notes) out.push('', c.yellow(note))
  out.push(
    '',
    c.dim('Next: vib get-prompt <name> --arg key=value   ·   vib record --prompt <name>'),
  )
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export function formatCallHeader(op: string, args: unknown): string {
  const c = colors()
  const shown = args && isObject(args) && Object.keys(args).length === 0 ? '' : preview(args, 200)
  return `${c.cyan('→')} ${c.bold(op)}${shown ? ` ${c.gray(shown)}` : ''}`
}

export function formatSuccessBanner(text: string): string {
  return colors().green(text)
}

export function formatErrorBanner(text: string): string {
  return colors().red(text)
}

export function formatWarnBanner(text: string): string {
  return colors().yellow(text)
}

/** Pretty JSON, indented by `indent` spaces. */
export function indentJson(value: unknown, indent = 2): string {
  const pad = ' '.repeat(indent)
  return (JSON.stringify(value, null, 2) ?? 'undefined')
    .split('\n')
    .map((line) => pad + line)
    .join('\n')
}

/**
 * Describe an InputRequests map ({ key: { method, params } }) for humans: one block per
 * request with the message and requested fields.
 */
export function formatInputRequests(requests: JsonValue): string[] {
  const c = colors()
  const lines: string[] = []
  const entries = isObject(requests) ? Object.entries(requests) : []
  for (const [key, entry] of entries) {
    const request = isObject(entry) ? entry : {}
    const method = typeof request.method === 'string' ? request.method : '(unknown method)'
    const params = isObject(request.params) ? request.params : {}
    lines.push(`  ${c.bold(method)} ${c.dim(`(request "${key}")`)}`)
    if (typeof params.message === 'string') lines.push(`    message: ${params.message}`)
    if (typeof params.url === 'string') lines.push(`    url: ${params.url}`)
    const schema = isObject(params.requestedSchema) ? params.requestedSchema : undefined
    if (schema) lines.push(`    fields: ${argSummary(schema) || preview(schema)}`)
    if (method === 'sampling/createMessage' && Array.isArray(params.messages)) {
      lines.push(`    messages: ${preview(params.messages, 160)}`)
    }
  }
  if (lines.length === 0) lines.push(`  ${preview(requests, 200)}`)
  return lines
}

/** @deprecated name; use `suggestRespond` from src/respond-hint.ts. */
export { suggestRespond, suggestRespond as sampleRespond } from '../respond-hint.js'

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export interface FlagHelp {
  flag: string
  text: string
}

export interface CommandHelp {
  name: string
  group: string
  summary: string
  usage: string[]
  description?: string
  flags?: FlagHelp[]
  /** Include the shared connection flags section (--config, --server, ...). */
  common?: boolean
  examples?: string[]
  /** Accepted flags beyond `flags` / common ones (for unknown-flag checks). */
  extraFlags?: string[]
}

export const COMMON_FLAGS: FlagHelp[] = [
  { flag: '--config <path>', text: 'vibrissa.json / .jsonc / package.json#vibrissa' },
  {
    flag: '--server <name|cmd|url>',
    text: 'A server from config, a command line ("node dist/index.js"), or an http(s) URL',
  },
  { flag: '--profile <name>', text: 'Merge profiles.<name> over the config' },
  { flag: '--protocol <mode>', text: 'auto (default) | legacy | modern | <YYYY-MM-DD>' },
  { flag: '--timeout <ms>', text: 'Per-request timeout (also bounds spawn)' },
  { flag: '--env KEY=VALUE', text: 'Extra env var for stdio servers (repeatable)' },
  { flag: '--server-cwd <dir>', text: 'Working directory for a stdio server' },
  { flag: '--json', text: 'Machine-readable output (one stable JSON object on stdout)' },
  { flag: '--compact', text: 'Single-line JSON even on a terminal (piped output is compact)' },
]

function flagTable(flags: FlagHelp[]): string[] {
  const width = Math.min(30, Math.max(...flags.map((f) => f.flag.length)))
  return flags.map((f) =>
    f.flag.length > width
      ? `  ${f.flag}\n  ${' '.repeat(width)}  ${f.text}`
      : `  ${f.flag.padEnd(width)}  ${f.text}`,
  )
}

export function formatCommandHelp(help: CommandHelp): string {
  const c = colors()
  const out: string[] = [`${c.bold(`vib ${help.name}`)} — ${help.summary}`, '', c.bold('Usage:')]
  for (const usage of help.usage) out.push(`  ${usage}`)
  if (help.description) out.push('', ...help.description.split('\n').map((l) => `  ${l}`.trimEnd()))
  if (help.flags?.length) out.push('', c.bold('Options:'), ...flagTable(help.flags))
  if (help.common) out.push('', c.bold('Connection options:'), ...flagTable(COMMON_FLAGS))
  if (help.examples?.length) {
    out.push('', c.bold('Examples:'), ...help.examples.map((e) => `  ${e}`))
  }
  out.push(
    '',
    c.dim(
      'Exit codes: 0 ok · 1 failed (assertion, check, tool error) · 2 usage/config/connection error',
    ),
  )
  return out.join('\n')
}

/** Every flag a command accepts (for unknown-flag detection). */
export function acceptedFlags(help: CommandHelp): Set<string> {
  const names = new Set<string>(['--help', '--json', '--compact'])
  for (const f of [...(help.flags ?? []), ...(help.common ? COMMON_FLAGS : [])]) {
    for (const raw of f.flag.split(/[\s,/]+/)) {
      // `--update[=all]` → `--update`; `--seed=<n>` → `--seed`
      const token = raw.replace(/\[.*$/, '').replace(/=.*$/, '')
      if (token.startsWith('--')) names.add(token)
    }
  }
  for (const extra of help.extraFlags ?? []) names.add(extra)
  return names
}
