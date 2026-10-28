/**
 * Shared plumbing for lint rules and spec checks: allow-listing, severity
 * overrides, grouping findings into CheckOutcomes, sorting and summarizing.
 */
import type { CheckOutcome } from '../events.js'

export type Severity = 'failed' | 'warned'

export interface LintOptions {
  /**
   * Check ids to skip. Each entry is one of:
   * - an exact id: `desc/long-description`
   * - a prefix wildcard: `desc/*`
   * - an id scoped to one subject: `desc/sensitive-paths:ssh.list_keys`
   *   (subject = tool / prompt name, resource URI, or `instructions`)
   */
  allow?: string[]
  /** Per-check severity override for findings, e.g. `{ "desc/embedded-url": "failed" }`. */
  severity?: Record<string, Severity>
}

/** Static metadata every rule / check carries. */
export interface RuleMeta {
  id: string
  title: string
  severity: Severity
}

/** One problem found by a rule. Findings with the same subject merge into one outcome. */
export interface Finding {
  /** Human label: `tool "add"`, `prompt "helper"`, `server instructions`. */
  subject?: string
  /** Allow-list key for `id:key` entries. */
  key?: string
  message: string
  /** Overrides the rule's default severity (e.g. era-dependent spec checks). */
  severity?: Severity
  /** A note that a check was skipped / not applicable. Always `warned`; never escalated. */
  informational?: boolean
}

const MAX_MESSAGES = 6

export function isAllowed(allow: readonly string[] | undefined, id: string, key?: string): boolean {
  if (!allow?.length) return false
  for (const entry of allow) {
    const colon = entry.indexOf(':')
    const idPart = colon === -1 ? entry : entry.slice(0, colon)
    const keyPart = colon === -1 ? undefined : entry.slice(colon + 1)
    const idMatches =
      idPart === id ||
      idPart === '*' ||
      (idPart.endsWith('/*') && id.startsWith(idPart.slice(0, -1)))
    if (!idMatches) continue
    if (keyPart === undefined || keyPart === key) return true
  }
  return false
}

function effectiveSeverity(rule: RuleMeta, f: Finding, opts: LintOptions): Severity {
  if (f.informational) return 'warned'
  return opts.severity?.[rule.id] ?? f.severity ?? rule.severity
}

/**
 * Turn a rule's findings into outcomes: one `passed` outcome when there are none,
 * otherwise one outcome per subject (all of that subject's messages joined).
 * Returns [] when the whole rule is allow-listed.
 */
export function buildOutcomes(
  rule: RuleMeta,
  findings: readonly Finding[],
  opts: LintOptions = {},
  passDetail?: string,
): CheckOutcome[] {
  if (isAllowed(opts.allow, rule.id)) return []
  const kept = findings.filter((f) => !isAllowed(opts.allow, rule.id, f.key))
  if (kept.length === 0) {
    const allowed = findings.length - kept.length
    const notes = [passDetail, allowed ? `${allowed} finding(s) allow-listed` : undefined].filter(
      Boolean,
    )
    return [
      {
        id: rule.id,
        title: rule.title,
        status: 'passed',
        ...(notes.length ? { detail: notes.join('; ') } : {}),
      },
    ]
  }
  const groups = new Map<string, Finding[]>()
  for (const f of kept) {
    const k = f.subject ?? ''
    const g = groups.get(k)
    if (g) g.push(f)
    else groups.set(k, [f])
  }
  const out: CheckOutcome[] = []
  for (const [subject, group] of groups) {
    const status = group.some((f) => effectiveSeverity(rule, f, opts) === 'failed')
      ? 'failed'
      : 'warned'
    const messages = [...new Set(group.map((f) => f.message))]
    const shown = messages.slice(0, MAX_MESSAGES)
    if (messages.length > shown.length) shown.push(`(+${messages.length - shown.length} more)`)
    const body = shown.join('; ')
    out.push({
      id: rule.id,
      title: rule.title,
      status,
      detail: subject ? `${subject}: ${body}` : body,
    })
  }
  return out
}

const STATUS_RANK: Record<CheckOutcome['status'], number> = { failed: 0, warned: 1, passed: 2 }

/** failed -> warned -> passed, then by id; stable for equal keys. Returns a new array. */
export function sortOutcomes(outcomes: readonly CheckOutcome[]): CheckOutcome[] {
  return [...outcomes].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id.localeCompare(b.id),
  )
}

export function summarizeChecks(outcomes: readonly CheckOutcome[]): {
  failed: number
  warned: number
  passed: number
} {
  const summary = { failed: 0, warned: 0, passed: 0 }
  for (const o of outcomes) summary[o.status]++
  return summary
}
