/**
 * Render a manifest:diff payload for humans.
 *
 * The payload is the runner's structured ManifestDiff (see src/manifest.ts), read
 * defensively from JsonValue so reporters keep working while its shape evolves:
 *
 *   { changes?: FieldChange[],
 *     tools?|resources?|resourceTemplates?|prompts?: {
 *       added?: Array<string | { key, breaking? }>, removed?: …same…,
 *       changed?: Array<{ key, breaking?, fields: Array<{ path, before?, after?, breaking? }> }> },
 *     error?: string }
 *
 * Output lines (ASCII, colored in pretty mode):
 *   - removed tool get_forecast (breaking)
 *   + added tool get_alerts
 *   ~ tool get_weather / description (non-breaking)
 *       Get the weather [-for a city-]{+anywhere+}
 *   ~ server server.name
 *       "old" -> "new"
 *
 * Unrecognized payloads return undefined so callers can fall back to a JSON dump.
 */
import type { JsonValue } from '../types.js'
import type { Colors } from './ansi.js'
import { plural, renderDiff, splitLines, truncate } from './shared.js'

type Obj = Record<string, JsonValue>

const SECTIONS: Array<[string, string, string]> = [
  ['tools', 'tool', 'tools'],
  ['resources', 'resource', 'resources'],
  ['resourceTemplates', 'resource template', 'resource templates'],
  ['prompts', 'prompt', 'prompts'],
]

function asObj(value: JsonValue | undefined): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function breakingOf(value: JsonValue | undefined): boolean | undefined {
  const flag = asObj(value)?.breaking
  return typeof flag === 'boolean' ? flag : undefined
}

/** `added` / `removed` entries: plain keys, or `{ key | name | uri, breaking? }`. */
function entries(value: JsonValue | undefined): Array<{ key: string; breaking?: boolean }> {
  const out: Array<{ key: string; breaking?: boolean }> = []
  for (const item of asArray(value)) {
    if (typeof item === 'string') out.push({ key: item })
    else {
      const o = asObj(item)
      const key = o?.key ?? o?.name ?? o?.uri ?? o?.uriTemplate
      if (typeof key === 'string') out.push({ key, breaking: breakingOf(item) })
    }
  }
  return out
}

interface Change {
  key: string
  breaking?: boolean
  fields: Array<{ path: string; before?: JsonValue; after?: JsonValue; breaking?: boolean }>
}

function fieldList(value: JsonValue | undefined): Change['fields'] {
  const out: Change['fields'] = []
  for (const f of asArray(value)) {
    const o = asObj(f)
    if (!o || typeof o.path !== 'string') continue
    out.push({
      path: o.path,
      ...(o.before !== undefined ? { before: o.before } : {}),
      ...(o.after !== undefined ? { after: o.after } : {}),
      breaking: breakingOf(f),
    })
  }
  return out
}

function changes(value: JsonValue | undefined): Change[] {
  const out: Change[] = []
  for (const c of asArray(value)) {
    const o = asObj(c)
    if (!o || typeof o.key !== 'string') continue
    out.push({ key: o.key, breaking: breakingOf(c), fields: fieldList(o.fields) })
  }
  return out
}

/** True when the payload looks like a structured ManifestDiff (or its error form). */
export function isStructuredDrift(diff: JsonValue | undefined): boolean {
  const o = asObj(diff)
  if (!o) return false
  return (
    typeof o.error === 'string' ||
    Array.isArray(o.changes) ||
    SECTIONS.some(([key]) => asObj(o[key]) !== undefined)
  )
}

/** `1 tool changed, 1 prompt added`; undefined for unstructured payloads. */
export function driftSummary(diff: JsonValue | undefined): string | undefined {
  if (!isStructuredDrift(diff)) return undefined
  const o = asObj(diff) as Obj
  if (typeof o.error === 'string') return `error: ${truncate(o.error, 80)}`
  const parts: string[] = []
  for (const [key, one, many] of SECTIONS) {
    const section = asObj(o[key])
    if (!section) continue
    const add = entries(section.added).length
    const rem = entries(section.removed).length
    const chg = changes(section.changed).length
    if (rem) parts.push(`${plural(rem, one, many)} removed`)
    if (chg) parts.push(`${plural(chg, one, many)} changed`)
    if (add) parts.push(`${plural(add, one, many)} added`)
  }
  const server = fieldList(o.changes).length
  if (server) parts.push(`${plural(server, 'server field')} changed`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

const MAX_TOKENS = 400

/** Words with their trailing whitespace (leading whitespace is its own token). */
function tokenize(text: string): string[] {
  const lead = /^\s+/.exec(text)?.[0]
  const words = text.match(/\S+\s*/g) ?? []
  return lead ? [lead, ...words] : words
}

type Op = { op: 'eq' | 'del' | 'ins'; text: string }

/** Words match regardless of the whitespace that follows them. */
const same = (x: string, y: string) => x.trimEnd() === y.trimEnd()

function diffTokens(a: string[], b: string[]): Op[] {
  // LCS table over tokens; descriptions are short, so O(n·m) is fine (capped above).
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = same(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: Op[] = []
  const push = (op: Op['op'], text: string) => {
    const last = ops[ops.length - 1]
    if (last && last.op === op) last.text += text
    else ops.push({ op, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      // Keep the new text's spacing for unchanged words.
      push('eq', b[j++])
      i++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++])
    else push('ins', b[j++])
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('ins', b[j++])
  return ops
}

function splitTrailing(text: string): [string, string] {
  const ws = /\s*$/.exec(text)?.[0] ?? ''
  return [text.slice(0, text.length - ws.length), ws]
}

/**
 * Word-level diff in `git --word-diff=plain` style: `[-removed-]{+added+}`, colored red /
 * green in pretty mode. Undefined when either text is too long to diff usefully.
 */
export function wordDiff(before: string, after: string, c: Colors): string | undefined {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return undefined
  const ops = diffTokens(a, b)
  let out = ''
  for (let k = 0; k < ops.length; k++) {
    const { op, text } = ops[k]
    if (op === 'eq') {
      out += text
      continue
    }
    if (op === 'del' && ops[k + 1]?.op === 'ins') {
      const [delCore, delWs] = splitTrailing(text)
      const [insCore, insWs] = splitTrailing(ops[k + 1].text)
      out += `${c.red(`[-${delCore}-]`)}${c.green(`{+${insCore}+}`)}${insWs || delWs}`
      k++
      continue
    }
    const [core, ws] = splitTrailing(text)
    out += op === 'del' ? c.red(`[-${core}-]`) : c.green(`{+${core}+}`)
    out += ws
  }
  return out
}

// ---------------------------------------------------------------------------
// Drift lines
// ---------------------------------------------------------------------------

function tag(breaking: boolean | undefined, c: Colors): string {
  if (breaking === true) return ` ${c.red('(breaking)')}`
  if (breaking === false) return ` ${c.dim('(non-breaking)')}`
  return ''
}

function short(value: JsonValue | undefined): string {
  return value === undefined ? '(absent)' : truncate(JSON.stringify(value), 100)
}

function valueLines(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  c: Colors,
  indent: string,
): string[] {
  // Word diff for prose (descriptions); single tokens read better as `"a" -> "b"`.
  const prose = (v: string) => /\s/.test(v.trim())
  if (typeof before === 'string' && typeof after === 'string' && (prose(before) || prose(after))) {
    const words = wordDiff(before, after, c)
    if (words !== undefined) return splitLines(words).map((l) => `${indent}${l}`)
  }
  const structured = (v: JsonValue | undefined) => typeof v === 'object' && v !== null
  if (structured(before) && structured(after)) {
    const diff = renderDiff(before, after, c, {
      aAnnotation: 'locked',
      bAnnotation: 'live',
      maxLines: 20,
    })
    if (diff) return diff.map((l) => (l === '' ? '' : `${indent}${l}`))
  }
  return [`${indent}${c.red(short(before))} -> ${c.green(short(after))}`]
}

/** The runner's summary is the full rendering (drift lines + tip) when it spans lines. */
export function isDetailedSummary(summary: string | undefined): boolean {
  return summary !== undefined && /\r?\n/.test(summary.trim())
}

/**
 * Lines to show under a drift summary: nothing when the summary already renders the drift,
 * otherwise our structured rendering. Never a raw JSON dump (results.json keeps the data).
 */
export function driftDetail(
  summary: string | undefined,
  diff: JsonValue | undefined,
  c: Colors,
  maxLines?: number,
): string[] {
  if (isDetailedSummary(summary)) return []
  return renderManifestDrift(diff, c, maxLines) ?? []
}

/**
 * Human-readable drift lines for a structured ManifestDiff; undefined when the payload is
 * not recognizably structured (callers then fall back to a JSON dump).
 */
export function renderManifestDrift(
  diff: JsonValue | undefined,
  c: Colors,
  maxLines = 60,
): string[] | undefined {
  if (!isStructuredDrift(diff)) return undefined
  const o = asObj(diff) as Obj
  const lines: string[] = []
  if (typeof o.error === 'string') lines.push(`${c.red('!')} ${o.error}`)
  for (const [key, one] of SECTIONS) {
    const section = asObj(o[key])
    if (!section) continue
    for (const r of entries(section.removed)) {
      // Removing a tool/prompt/resource breaks callers unless the runner says otherwise.
      lines.push(`${c.red('-')} removed ${one} ${c.bold(r.key)}${tag(r.breaking ?? true, c)}`)
    }
    for (const ch of changes(section.changed)) {
      if (ch.fields.length === 0) {
        lines.push(`${c.yellow('~')} ${one} ${c.bold(ch.key)}${tag(ch.breaking, c)}`)
      }
      for (const f of ch.fields) {
        lines.push(
          `${c.yellow('~')} ${one} ${c.bold(ch.key)} / ${f.path}${tag(f.breaking ?? ch.breaking, c)}`,
        )
        lines.push(...valueLines(f.before, f.after, c, '    '))
      }
    }
    for (const a of entries(section.added)) {
      lines.push(`${c.green('+')} added ${one} ${c.bold(a.key)}${tag(a.breaking, c)}`)
    }
  }
  for (const f of fieldList(o.changes)) {
    lines.push(`${c.yellow('~')} server ${f.path}${tag(f.breaking, c)}`)
    lines.push(...valueLines(f.before, f.after, c, '    '))
  }
  if (lines.length === 0) return undefined
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines
    return [...lines.slice(0, maxLines), c.dim(`... ${plural(hidden, 'more line')}`)]
  }
  return lines
}
