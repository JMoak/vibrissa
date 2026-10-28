/**
 * Tool-description lint: a deterministic, offline smoke detector for tool
 * poisoning, shadowing and exfiltration hints in model-visible text, plus a few
 * quality checks. Pattern-based by design — it catches the well-known shapes of
 * these attacks, not every paraphrase. See docs/CHECKS.md for every rule.
 *
 * Adding a rule = one entry in DESCRIPTION_RULES. Adding a phrase to an existing
 * rule = one entry in its pattern table.
 */
import type { CheckOutcome } from '../events.js'
import {
  type Finding,
  type LintOptions,
  type RuleMeta,
  buildOutcomes,
  isAllowed,
  sortOutcomes,
} from './outcomes.js'
import {
  clip,
  excerpt,
  formatCodePoint,
  normalizeForMatching,
  quote,
  scanInvisible,
  splitSentences,
} from './text.js'
import type {
  PromptSummary,
  ResourceSummary,
  ResourceTemplateSummary,
  ToolSummary,
} from './types.js'

export interface DescriptionLintOptions extends LintOptions {
  /** Also lint these descriptions (pattern rules only; quality rules are tool-only). */
  resources?: ResourceSummary[]
  resourceTemplates?: ResourceTemplateSummary[]
  prompts?: PromptSummary[]
  /** Server instructions from discover/initialize. */
  instructions?: string
  /** Tool names from other servers the same client loads, for cross-server shadowing. */
  knownToolNames?: string[]
  /** Threshold for `desc/long-description`. Default 2000. */
  maxDescriptionLength?: number
}

/** A model-visible string pulled out of the manifest. */
export interface TextSource {
  kind: 'tool' | 'resource' | 'resourceTemplate' | 'prompt' | 'instructions'
  /** `tool "add"`, `prompt "summarize"`, `server instructions`. */
  subject: string
  /** Allow-list key for `rule-id:key` entries. */
  key: string
  /** Location inside the subject, e.g. `inputSchema.properties.a.description`. */
  field: string
  raw: string
  /** normalizeForMatching(raw) */
  text: string
  toolName?: string
}

interface Mention {
  name: string
  re: RegExp
}

export interface LintContext {
  maxDescriptionLength: number
  mentions: Mention[]
}

type TextResult = string | Omit<Finding, 'subject' | 'key'>
type TextCheck = (src: TextSource, ctx: LintContext) => TextResult[]
type ToolCheck = (tool: ToolSummary, ctx: LintContext) => string[]
type ToolsCheck = (tools: ToolSummary[], ctx: LintContext) => Finding[]

export interface DescriptionRule extends RuleMeta {
  /** Runs on every model-visible string (descriptions, titles, schema text, prompts, instructions). */
  text?: TextCheck
  /** Runs once per tool. */
  tool?: ToolCheck
  /** Runs once over the whole tool list. */
  tools?: ToolsCheck
}

export interface Pattern {
  label: string
  re: RegExp
  /** Patterns sharing a group count as one signal in multi-signal rules. Default: label. */
  group?: string
}

// ---------------------------------------------------------------------------
// Pattern tables. Regexes must NOT carry the `g` flag (they are reused).
// ---------------------------------------------------------------------------

/** Any one of these is a strong signal on its own. */
export const HIDDEN_INSTRUCTION_PATTERNS: Pattern[] = [
  {
    label: 'instruction tag',
    re: /<\/?(?:important|system|instructions?|secret|hidden|admin|assistant|sys)\b[^<>]{0,40}>/iu,
  },
  {
    label: 'chat-template token',
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\|>|\[\/?INST\]|<<\/?SYS>>/iu,
  },
  {
    label: '"ignore previous instructions"',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|former|system|safety|original)\s+(?:instructions?|prompts?|rules|directives|guidelines|messages|context)\b/iu,
  },
  {
    label: '"ignore all instructions"',
    re: /\b(?:ignore|disregard|forget)\s+(?:all|any)\s+(?:of\s+)?(?:the\s+|your\s+)?(?:instructions?|prompts?|directives|guidelines)\b/iu,
  },
  {
    label: 'conceal from the user',
    re: /\b(?:do\s+not|don['’]?t|never|must\s+not|should\s+not)\s+(?:tell|mention|inform|reveal|disclose)\s+(?:this\s+|that\s+|it\s+|anything\s+)?(?:to\s+)?(?:the\s+)?users?\b/iu,
  },
  {
    label: 'act without telling the user',
    re: /\bwithout\s+(?:telling|informing)\s+(?:the\s+)?users?\b/iu,
  },
  {
    label: 'hide from the user',
    re: /\b(?:keep|hide)\s+(?:this|it|that)\s+(?:secret\s+|hidden\s+)?from\s+(?:the\s+)?users?\b|\bthe\s+user\s+(?:must|should)\s+(?:not|never)\s+(?:know|see|find\s+out|be\s+told)\b|\b(?:could|might|would|will)\s+(?:even\s+)?upset\s+the\s+user\b/iu,
  },
]

/** Weak signals: each is common in benign text, so the rule needs two different groups. */
export const IMPERATIVE_PATTERNS: Pattern[] = [
  {
    group: 'precondition',
    label: '"before using this tool"',
    re: /\bbefore\s+(?:using|calling|invoking|running|executing)\s+(?:this|the)\s+tool\b/iu,
  },
  {
    group: 'precondition',
    label: '"before calling,"',
    re: /\bbefore\s+(?:using|calling|invoking)(?:\s+it)?\s*,/iu,
  },
  {
    group: 'precondition',
    label: '"you must first/always"',
    re: /\byou\s+must\s+(?:first|always)\b/iu,
  },
  { group: 'secrecy', label: '"without asking"', re: /\bwithout\s+asking\b/iu },
  {
    group: 'secrecy',
    label: '"do not mention this"',
    re: /\b(?:do\s+not|don['’]?t|never)\s+(?:mention|reveal|disclose|explain)\s+(?:this|that|it)\b/iu,
  },
  {
    group: 'secrecy',
    label: '"be gentle/discreet"',
    re: /\bbe\s+(?:very\s+)?(?:gentle|subtle|discreet)\b/iu,
  },
  {
    group: 'coercion',
    label: '"otherwise the tool will not work"',
    re: /\botherwise\s+(?:the|this)\s+tool\s+(?:will\s+not|won['’]?t|cannot|can['’]?t|does\s+not|doesn['’]?t|will\s+fail)\b/iu,
  },
  {
    group: 'coercion',
    label: '"very important"',
    re: /\b(?:very|extremely|critically|vitally)\s+important\b/iu,
  },
  {
    group: 'payload',
    label: '"pass its content as"',
    re: /\bpass\s+(?:its|the|their|this|that|all)\s+(?:full\s+|entire\s+|raw\s+)?contents?\s+(?:as|in|into|to)\b/iu,
  },
  {
    group: 'payload',
    label: 'smuggle into an argument',
    re: /\b(?:include|put|place|insert|embed|append|pass|send|copy)\s+(?:it|them|its\s+contents?|their\s+contents?|the\s+contents?)\s+(?:in|into|as|to)\s+(?:the\s+)?[`'"]?[\w.-]+[`'"]?\s+(?:field|argument|parameter|param)\b/iu,
  },
  {
    group: 'payload',
    label: 'read a local file',
    re: /\b(?:read|cat|open|load)\s+(?:the\s+)?(?:file\s+|contents?\s+of\s+)?[`'"]?(?:~|\$HOME|%USERPROFILE%|\/etc\/)/iu,
  },
  {
    group: 'role',
    label: 'role override',
    re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:an?\s+)?(?:system|admin(?:istrator)?|root)\b|\bdeveloper\s+mode\b|\bnew\s+instructions\s*:/iu,
  },
]

/** Hiding containers. Their content is also scanned by every other rule. */
export const HIDDEN_MARKUP_PATTERNS: Pattern[] = [
  { label: 'HTML comment', re: /<!--[\s\S]*?(?:-->|$)/u },
  {
    label: 'markdown reference-link comment',
    re: /^[ \t]*\[[^\]\n]*\]:\s*(?:#|<>)\s*(?:\([^)\n]*\)|"[^"\n]*")/mu,
  },
]

/**
 * Most specific first: when two patterns hit the same path token
 * (`~/.ssh/id_rsa`), only the earlier one is reported.
 */
export const SENSITIVE_PATH_PATTERNS: Pattern[] = [
  {
    label: 'SSH private key',
    re: /(?<![A-Za-z0-9])id_(?:rsa|dsa|ecdsa|ed25519)(?![A-Za-z0-9])/iu,
  },
  { label: 'SSH directory', re: /(?<![\w.])\.ssh(?![\w-])/iu },
  {
    label: 'cloud credentials',
    re: /\.aws[\\/](?:credentials|config)\b|(?<![\w.])\.(?:azure|kube|gnupg)(?![\w-])|\.config[\\/]gcloud\b|\.docker[\\/]config\.json\b/iu,
  },
  {
    label: 'auth dotfile',
    re: /(?<![\w.])\.(?:netrc|npmrc|pypirc|pgpass|git-credentials|bash_history|zsh_history)(?![\w-])/iu,
  },
  { label: 'system credential file', re: /\/etc\/(?:passwd|shadow|sudoers)\b/iu },
  {
    label: 'agent/MCP client config',
    re: /(?<![\w-])(?:mcp\.json|claude_desktop_config\.json|\.claude\.json)(?!\w)|~[\\/]\.cursor\b/iu,
  },
  { label: '.env file', re: /(?<![\w.$-])\.env(?:\.[\w-]+)?(?![\w-])/iu },
  { label: 'wallet/keychain', re: /\bwallet\.dat\b|[\\/]Keychains?[\\/]|\bLogin Data\b/iu },
]

const SECRET_NOUN = [
  'api[\\s_-]?keys?',
  'access[\\s_-]?tokens?',
  'auth(?:entication)?[\\s_-]?tokens?',
  'bearer[\\s_-]?tokens?',
  'refresh[\\s_-]?tokens?',
  'session[\\s_-]?tokens?',
  'secret[\\s_-]?keys?',
  'private[\\s_-]?keys?',
  'passwords?',
  'passphrases?',
  'credentials?',
  'seed[\\s_-]?phrases?',
  'mnemonics?',
  'ssh[\\s_-]?keys?',
  'client[\\s_-]?secrets?',
].join('|')

const TRANSFER_VERB =
  'pass|send|include|provide|forward|attach|upload|post|share|paste|append|embed|supply|enter'
const TRANSFER_PARTICIPLE =
  'included|sent|passed|forwarded|attached|uploaded|posted|shared|pasted|appended'

/** Secret noun + a verb asking the model to move it, close together. */
export const SECRET_REQUEST_PATTERNS: Pattern[] = [
  {
    label: 'asks for a secret',
    re: new RegExp(`\\b(?:${TRANSFER_VERB})\\b(?:\\W+\\w+){0,6}?\\W+(?:${SECRET_NOUN})\\b`, 'iu'),
  },
  {
    label: 'asks for a secret (passive)',
    re: new RegExp(
      `\\b(?:${SECRET_NOUN})(?:\\W+\\w+){0,4}?\\W+(?:${TRANSFER_PARTICIPLE})\\b`,
      'iu',
    ),
  },
]

/** Same sentence as another tool's name: the description changes how that tool behaves. */
export const SHADOWING_CUES: Pattern[] = [
  { label: '"side effect on"', re: /\bside[\s-]effects?\s+(?:on|for|of|to)\b/iu },
  {
    label: '"when this tool is available"',
    re: /\bwhen\s+this\s+tool\s+is\s+(?:available|present|loaded|installed|enabled|active)\b/iu,
  },
  {
    label: 'redirect directive',
    re: /\b(?:must|should|shall|always)\s+(?:now\s+|also\s+|instead\s+)?(?:send|forward|redirect|route|bcc|cc|copy|proxy|exfiltrate|upload)\b/iu,
  },
  {
    label: '"regardless of"',
    re: /\bregardless\s+of\s+(?:what\s+)?(?:the\s+)?(?:user|instructions?|arguments?|recipient)/iu,
  },
  {
    label: 'target substitution',
    re: /\b(?:instead\s+of|rather\s+than)\s+(?:to\s+)?(?:the\s+)?(?:user['’]?s?|intended|actual|original|specified|requested)\s+(?:recipient|address|destination|account|url|target)\b|\b(?:replace|swap|rewrite|override)\s+(?:the\s+)?(?:recipient|address|destination|account|url|target|amount)\b/iu,
  },
]

/** Same sentence as another tool's name; two different cues needed. */
export const STEERING_CUES: Pattern[] = [
  { label: '"instead"', re: /\binstead\b/iu },
  { label: '"rather than"', re: /\brather\s+than\b/iu },
  { label: '"prefer"', re: /\bprefer(?:red|ably|s)?\b/iu },
  { label: '"override"', re: /\boverrid(?:e|es|ing)\b/iu },
  {
    label: '"do not use/call"',
    re: /\b(?:never|do\s+not|don['’]?t|must\s+not|should\s+not|stop)\s+(?:use|using|call|calling|invoke|invoking|run|running|trust)\b/iu,
  },
  {
    label: 'disparages the tool',
    re: /\b(?:deprecated|broken|unsafe|insecure|outdated|obsolete|compromised|malicious)\b/iu,
  },
  { label: '"always use this"', re: /\balways\s+(?:use|call)\s+this\b/iu },
]

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

interface Hit {
  p: Pattern
  index: number
  length: number
}

const TOKEN_BOUNDARY = /[\s'"`()<>[\]{},;]/u
const MAX_TOKEN_REACH = 200
const MAX_MATCHES_PER_PATTERN = 50
const globalCache = new WeakMap<RegExp, RegExp>()

function globalOf(re: RegExp): RegExp {
  let g = globalCache.get(re)
  if (!g) {
    g = new RegExp(re.source, `${re.flags}g`)
    globalCache.set(re, g)
  }
  return g
}

/** The match widened to the surrounding path-like token (`~/.ssh/id_rsa`), for overlap tests. */
function tokenSpan(text: string, index: number, length: number): [number, number] {
  let start = index
  let end = index + length
  const minStart = Math.max(0, index - MAX_TOKEN_REACH)
  const maxEnd = Math.min(text.length, end + MAX_TOKEN_REACH)
  while (start > minStart && !TOKEN_BOUNDARY.test(text[start - 1])) start--
  while (end < maxEnd && !TOKEN_BOUNDARY.test(text[end])) end++
  return [start, end]
}

/**
 * At most one hit per pattern. Within a group (default: the whole table), a hit
 * whose token overlaps an earlier pattern's hit is dropped, so `~/.ssh/id_rsa`
 * reports "SSH private key" once instead of also "SSH directory". Earlier
 * patterns in a table therefore win: order tables most-specific first.
 */
function collectHits(patterns: Pattern[], text: string, grouped: boolean): Hit[] {
  const kept: Array<Hit & { span: [number, number]; group: string }> = []
  for (const p of patterns) {
    const group = grouped ? (p.group ?? p.label) : ''
    const re = globalOf(p.re)
    re.lastIndex = 0
    let n = 0
    for (const m of text.matchAll(re)) {
      if (++n > MAX_MATCHES_PER_PATTERN) break
      const index = m.index ?? 0
      const span = tokenSpan(text, index, m[0].length)
      const clash = kept.some(
        (k) => k.group === group && span[0] < k.span[1] && k.span[0] < span[1],
      )
      if (clash) continue
      kept.push({ p, index, length: m[0].length, span, group })
      break
    }
  }
  return kept.sort((a, b) => a.index - b.index)
}

/** Fires once per matching pattern (overlapping hits collapse to the most specific). */
function anyPattern(patterns: Pattern[]): TextCheck {
  return (src) =>
    collectHits(patterns, src.text, false).map(
      (h) => `${src.field}: ${h.p.label} in ${quote(excerpt(src.text, h.index, h.length))}`,
    )
}

/** Fires when patterns from at least `min` distinct groups match the same string. */
function patternGroups(patterns: Pattern[], min: number): TextCheck {
  return (src) => {
    const hits = collectHits(patterns, src.text, true)
    if (new Set(hits.map((h) => h.p.group ?? h.p.label)).size < min) return []
    const first = hits[0]
    const labels = hits.map((h) => h.p.label).join(' + ')
    return [`${src.field}: ${labels} in ${quote(excerpt(src.text, first.index, first.length, 48))}`]
  }
}

/** "any other weather tool", "all other tools", "other tools". */
const GENERIC_TOOL_REF_RE =
  /\b(?:any|all|every)\s+other\s+(?:[\w-]+\s+){0,2}?tools?\b|\bother\s+tools\b/iu

/** A tool-like identifier right after a directive: "never use search_web", "instead of `read_doc`". */
const DIRECTIVE_REF_RE =
  /\b(?:(?:never|do\s+not|don['’]?t|must\s+not|should\s+not|stop)\s+(?:use|using|call|calling|invoke|invoking|run|running|trust)|instead\s+of(?:\s+(?:using|calling))?|rather\s+than(?:\s+(?:using|calling))?|prefer\s+this(?:\s+tool)?\s+(?:over|to))\s+(?:the\s+)?[`'"]?([A-Za-z][A-Za-z0-9_.-]*[A-Za-z0-9])/giu

const FILE_LIKE_RE =
  /\.(?:json|ya?ml|toml|md|txt|js|ts|py|sh|env|ini|cfg|conf|xml|html|csv|log|lock)$/iu

/** Case-sensitive on purpose: separator-joined (`search_web`, `notes.get`) or camelCase (`getUser`). */
function isToolLikeIdentifier(s: string): boolean {
  return (
    s.length >= 3 &&
    !FILE_LIKE_RE.test(s) &&
    (/^[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)+$/u.test(s) || /[a-z][A-Z]/u.test(s))
  )
}

/**
 * Other tools a sentence refers to: names from the manifest / knownToolNames,
 * generic "any other ... tool" phrases, and tool-like identifiers that follow a
 * use/call directive even when the tool is not in this manifest (cross-server).
 * Unlisted identifiers only count when the sentence talks about tools at all,
 * so "never use snake_case keys" is not a tool reference.
 */
function referencedTools(sentence: string, ctx: LintContext, self: string | undefined): string[] {
  const selfLower = self?.toLowerCase()
  const refs = ctx.mentions
    .filter((m) => m.name !== self && m.re.test(sentence))
    .map((m) => quote(m.name))
  const known = new Set(ctx.mentions.map((m) => m.name.toLowerCase()))
  const generic = GENERIC_TOOL_REF_RE.exec(sentence)
  if (generic) refs.push(quote(generic[0]))
  if (/\btools?\b/iu.test(sentence)) {
    for (const m of sentence.matchAll(DIRECTIVE_REF_RE)) {
      const id = m[1]
      const lower = id.toLowerCase()
      if (!isToolLikeIdentifier(id) || lower === selfLower || known.has(lower)) continue
      const label = `${quote(id)} (not in this manifest)`
      if (!refs.includes(label)) refs.push(label)
    }
  }
  return refs
}

/** Fires per sentence that refers to another tool together with >= `min` distinct cues. */
function toolMentionRule(cues: Pattern[], min: number): TextCheck {
  return (src, ctx) => {
    if (src.kind !== 'tool') return []
    const out: string[] = []
    for (const sentence of splitSentences(src.text)) {
      const refs = referencedTools(sentence, ctx, src.toolName)
      if (refs.length === 0) continue
      const hits = cues.filter((c) => c.re.test(sentence))
      if (new Set(hits.map((h) => h.group ?? h.label)).size < min) continue
      const labels = hits.map((h) => h.label).join(' + ')
      out.push(`${src.field}: names ${refs.join(', ')} with ${labels} in ${quote(clip(sentence))}`)
    }
    return out
  }
}

/** Sensitive paths double as the "exfiltration target" signal for the imperative rule. */
const EXFIL_TARGET_PATTERNS: Pattern[] = SENSITIVE_PATH_PATTERNS.map((p) => ({
  ...p,
  group: 'target',
  label: `targets ${p.label}`,
}))

function invisibleChars(src: TextSource): TextResult[] {
  const { hits, tagText } = scanInvisible(src.raw)
  if (hits.length === 0) return []
  const counts = new Map<string, number>()
  for (const h of hits) {
    const label = h.kind === 'tag' ? 'tag characters U+E00xx' : formatCodePoint(h.codePoint)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const list = [...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ')
  const before = clip(normalizeForMatching(src.raw.slice(0, hits[0].index)).slice(-40), 40)
  const hidden = tagText ? `; hidden text ${quote(clip(tagText, 120))}` : ''
  return [
    `${src.field}: ${hits.length} invisible character(s) (${list}) after ${quote(before || '(start)')}${hidden}`,
  ]
}

const PAD_SPACES = 40
const PAD_LINES = 8
const NEWLINES = new Set(['\n', ' ', ' '])

/**
 * First whitespace run followed by more text that has >= 40 consecutive
 * horizontal blanks or >= 8 line breaks. A linear scan on purpose: descriptions
 * are attacker-controlled and the equivalent regex backtracks quadratically.
 */
export function findPadding(
  raw: string,
): { end: number; spaces: number; lines: number } | undefined {
  let spaces = 0
  let maxSpaces = 0
  let lines = 0
  let inRun = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (NEWLINES.has(ch)) {
      lines++
      spaces = 0
      inRun = true
    } else if (ch === '\r') {
      inRun = true
    } else if (/\s/u.test(ch)) {
      spaces++
      maxSpaces = Math.max(maxSpaces, spaces)
      inRun = true
    } else {
      if (inRun && (maxSpaces >= PAD_SPACES || lines >= PAD_LINES)) {
        return { end: i, spaces: maxSpaces, lines }
      }
      spaces = 0
      maxSpaces = 0
      lines = 0
      inRun = false
    }
  }
  return undefined
}

function whitespacePadding(src: TextSource): string[] {
  const pad = findPadding(src.raw)
  if (!pad) return []
  const what =
    pad.lines >= PAD_LINES ? `${pad.lines} line breaks` : `${pad.spaces} consecutive blanks`
  return [`${src.field}: ${what} before ${quote(clip(src.raw.slice(pad.end), 80))}`]
}

const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s"'`)\]]+/giu
const TRANSFER_TO_RE =
  /\b(?:send|post|upload|forward|transmit|exfiltrate|report|submit|beacon)\b(?:\W+\w+){0,6}?\W+(?:to|at)\s*$/iu

function suspiciousUrls(src: TextSource): string[] {
  const out: string[] = []
  for (const m of src.text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?>]+$/u, '')
    const index = m.index ?? 0
    const reasons: string[] = []
    if (/\?[^#]*=/u.test(url)) reasons.push('query string')
    if (/[{}<>]|\$\{|%s/u.test(url)) reasons.push('template placeholder')
    if (/^[a-z]+:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/iu.test(url)) {
      reasons.push('IP-literal host')
    }
    if (TRANSFER_TO_RE.test(src.text.slice(Math.max(0, index - 120), index))) {
      reasons.push('data is sent to it')
    }
    if (reasons.length) {
      out.push(`${src.field}: URL with ${reasons.join(', ')}: ${quote(clip(url, 120))}`)
    }
  }
  return out
}

const BLOB_RE = /[A-Za-z0-9+/_-]{40,}={0,2}/gu

function decodeBlob(blob: string): string | undefined {
  const bytes = Buffer.from(blob.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64')
  if (bytes.length < 8) return undefined
  let printable = 0
  for (const b of bytes) if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x09) printable++
  return printable / bytes.length >= 0.9 ? bytes.toString('latin1') : undefined
}

function looksLikeBase64(s: string): boolean {
  if (/^[0-9a-f]+$/iu.test(s)) return false // hex hashes / ids
  if (/[+/]/u.test(s) && /[-_]/u.test(s)) return false // mixes the two base64 alphabets
  if (s.endsWith('=')) return true
  if (!/[A-Z]/u.test(s) || !/[a-z]/u.test(s) || !/\d/u.test(s)) return false
  const dense = (s.match(/[A-Z0-9+/]/gu) ?? []).length / s.length
  return dense >= 0.2 // long camelCase identifiers are mostly lowercase
}

function encodedBlobs(src: TextSource): TextResult[] {
  const out: TextResult[] = []
  for (const m of src.text.replace(URL_RE, ' ').matchAll(BLOB_RE)) {
    const blob = m[0]
    if (!looksLikeBase64(blob)) continue
    const decoded = decodeBlob(blob)
    const dangerous =
      decoded !== undefined &&
      [...HIDDEN_INSTRUCTION_PATTERNS, ...SENSITIVE_PATH_PATTERNS].some((p) => p.re.test(decoded))
    const shown = blob.length > 48 ? `${blob.slice(0, 45)}...` : blob
    const tail = decoded ? ` decodes to ${quote(clip(decoded, 100))}` : ''
    out.push({
      message: `${src.field}: ${blob.length}-char base64-like blob ${quote(shown)}${tail}`,
      ...(dangerous ? { severity: 'failed' as const } : {}),
    })
  }
  return out
}

function missingDescription(tool: ToolSummary): string[] {
  const d = tool.description
  if (typeof d !== 'string') return ['no description']
  return d.trim() === '' ? ['description is empty'] : []
}

function longDescription(tool: ToolSummary, ctx: LintContext): string[] {
  if (typeof tool.description !== 'string') return []
  const len = Array.from(tool.description).length
  return len > ctx.maxDescriptionLength
    ? [
        `description is ${len} chars (limit ${ctx.maxDescriptionLength}); long descriptions cost context and hide content from reviewers`,
      ]
    : []
}

const NAME_CHARS_RE = /^[A-Za-z0-9_.-]+$/u
const COMMON_NAME_LIMIT = 64
const SPEC_NAME_LIMIT = 128

function nameFormat(tool: ToolSummary): string[] {
  const name = tool.name
  if (typeof name !== 'string' || name === '') return ['tool has no name']
  const out: string[] = []
  if (!NAME_CHARS_RE.test(name)) {
    const bad = [...new Set(Array.from(name).filter((c) => !NAME_CHARS_RE.test(c)))]
    out.push(
      `name ${quote(name)} contains ${bad.map((c) => quote(c)).join(' ')}; allowed: A-Z a-z 0-9 _ - .`,
    )
  }
  const len = Array.from(name).length
  if (len > SPEC_NAME_LIMIT) out.push(`name is ${len} chars (spec maximum ${SPEC_NAME_LIMIT})`)
  return out
}

function nameLength(tool: ToolSummary): string[] {
  if (typeof tool.name !== 'string') return []
  const len = Array.from(tool.name).length
  return len > COMMON_NAME_LIMIT && len <= SPEC_NAME_LIMIT
    ? [`name is ${len} chars; many clients and LLM APIs cap tool names at ${COMMON_NAME_LIMIT}`]
    : []
}

function duplicateNames(tools: ToolSummary[]): Finding[] {
  const seen = new Map<string, number[]>()
  tools.forEach((t, i) => {
    if (typeof t.name !== 'string') return
    seen.set(t.name, [...(seen.get(t.name) ?? []), i])
  })
  const out: Finding[] = []
  for (const [name, idx] of seen) {
    if (idx.length < 2) continue
    out.push({
      subject: `tool ${quote(name)}`,
      key: name,
      message: `defined ${idx.length} times (${idx.map((i) => `tools[${i}]`).join(', ')})`,
    })
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function kindOf(v: unknown): string {
  return Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v
}

function inputSchemaType(tool: ToolSummary): string[] {
  const s = tool.inputSchema
  if (s === undefined) return ['no inputSchema (MCP requires an object schema)']
  if (!isRecord(s)) return [`inputSchema is ${kindOf(s)}, not an object schema`]
  if (s.type !== 'object') {
    const got = s.type === undefined ? 'missing' : JSON.stringify(s.type)
    return [`inputSchema.type is ${got}; MCP requires "object"`]
  }
  return []
}

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

function annotationConflict(tool: ToolSummary): string[] {
  const a = tool.annotations
  if (!isRecord(a)) return []
  return a.readOnlyHint === true && a.destructiveHint === true
    ? [
        'readOnlyHint: true contradicts destructiveHint: true (clients may skip confirmation for a destructive tool)',
      ]
    : []
}

function annotationTypes(tool: ToolSummary): string[] {
  const a = tool.annotations
  if (a === undefined) return []
  if (!isRecord(a)) return [`annotations is ${kindOf(a)}, not an object`]
  const out: string[] = []
  for (const h of HINTS) {
    if (a[h] !== undefined && typeof a[h] !== 'boolean') {
      out.push(`annotations.${h} is ${JSON.stringify(a[h])}, expected a boolean`)
    }
  }
  if (a.title !== undefined && typeof a.title !== 'string') {
    out.push('annotations.title is not a string')
  }
  return out
}

// ---------------------------------------------------------------------------
// The rule table. One entry per rule; ids are stable and allow-listable.
// ---------------------------------------------------------------------------

// biome-ignore format: one rule per line keeps the table scannable
export const DESCRIPTION_RULES: readonly DescriptionRule[] = [
  { id: 'desc/hidden-instructions', title: 'Hidden instructions in model-visible text', severity: 'failed', text: anyPattern(HIDDEN_INSTRUCTION_PATTERNS) },
  { id: 'desc/imperative-instructions', title: 'Coercive imperative phrasing (2+ signals)', severity: 'warned', text: patternGroups([...IMPERATIVE_PATTERNS, ...EXFIL_TARGET_PATTERNS], 2) },
  { id: 'desc/invisible-unicode', title: 'Invisible or bidi-override Unicode characters', severity: 'failed', text: invisibleChars },
  { id: 'desc/whitespace-padding', title: 'Whitespace padding pushes text out of view', severity: 'warned', text: whitespacePadding },
  { id: 'desc/html-comment', title: 'Markdown/HTML comment hides text from reviewers', severity: 'warned', text: anyPattern(HIDDEN_MARKUP_PATTERNS) },
  { id: 'desc/tool-shadowing', title: 'Description alters the behavior of another tool', severity: 'failed', text: toolMentionRule(SHADOWING_CUES, 1) },
  { id: 'desc/tool-steering', title: 'Description steers the model away from another tool', severity: 'warned', text: toolMentionRule(STEERING_CUES, 2) },
  { id: 'desc/sensitive-paths', title: 'References credential or secret file paths', severity: 'failed', text: anyPattern(SENSITIVE_PATH_PATTERNS) },
  { id: 'desc/secret-request', title: 'Asks the model to pass secrets through arguments', severity: 'warned', text: anyPattern(SECRET_REQUEST_PATTERNS) },
  { id: 'desc/embedded-url', title: 'Suspicious URL in model-visible text', severity: 'warned', text: suspiciousUrls },
  { id: 'desc/encoded-blob', title: 'Base64-like blob in model-visible text', severity: 'warned', text: encodedBlobs },
  { id: 'desc/missing-description', title: 'Tool has no description', severity: 'warned', tool: missingDescription },
  { id: 'desc/long-description', title: 'Tool description is very long', severity: 'warned', tool: longDescription },
  { id: 'desc/tool-name-format', title: 'Tool name is not a valid MCP tool name', severity: 'failed', tool: nameFormat },
  { id: 'desc/tool-name-length', title: 'Tool name longer than common client limits', severity: 'warned', tool: nameLength },
  { id: 'desc/duplicate-tool-names', title: 'Duplicate tool names', severity: 'failed', tools: duplicateNames },
  { id: 'desc/input-schema-type', title: 'inputSchema is not an object schema', severity: 'warned', tool: inputSchemaType },
  { id: 'desc/annotations-conflict', title: 'Contradictory tool annotations', severity: 'warned', tool: annotationConflict },
  { id: 'desc/annotations-invalid', title: 'Malformed tool annotations', severity: 'warned', tool: annotationTypes },
]

// ---------------------------------------------------------------------------
// Collecting model-visible text
// ---------------------------------------------------------------------------

const SCHEMA_DATA_KEYS = new Set(['const', 'enum', 'default', 'examples', 'example'])
const MAX_DEPTH = 32

/** description/title strings and property names anywhere in a schema (not data keywords). */
function walkSchemaText(
  node: unknown,
  path: string,
  push: (field: string, value: unknown) => void,
  depth = 0,
  seen: Set<unknown> = new Set(),
): void {
  if (depth > MAX_DEPTH || typeof node !== 'object' || node === null || seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkSchemaText(v, `${path}[${i}]`, push, depth + 1, seen))
    return
  }
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_DATA_KEYS.has(k)) continue
    if ((k === 'description' || k === 'title') && typeof v === 'string') {
      push(`${path}.${k}`, v)
      continue
    }
    if (k === 'properties' && isRecord(v)) {
      for (const prop of Object.keys(v)) push(`${path}.properties[${quote(prop)}] (name)`, prop)
    }
    walkSchemaText(v, `${path}.${k}`, push, depth + 1, seen)
  }
}

function toolLabel(tool: ToolSummary, i: number): { subject: string; key: string; name?: string } {
  const name = typeof tool.name === 'string' && tool.name !== '' ? tool.name : undefined
  return name
    ? { subject: `tool ${quote(name)}`, key: name, name }
    : { subject: `tools[${i}]`, key: `#${i}` }
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter(isRecord) as T[]) : []
}

/** Every model-visible string in the tool list (and optional extras), normalized for matching. */
export function collectTextSources(
  tools: ToolSummary[],
  opts: DescriptionLintOptions = {},
): TextSource[] {
  const out: TextSource[] = []
  const add = (
    kind: TextSource['kind'],
    subject: string,
    key: string,
    field: string,
    value: unknown,
    toolName?: string,
  ) => {
    if (typeof value !== 'string' || value === '') return
    out.push({ kind, subject, key, field, raw: value, text: normalizeForMatching(value), toolName })
  }
  asArray<ToolSummary>(tools).forEach((tool, i) => {
    const { subject, key, name } = toolLabel(tool, i)
    const push = (field: string, value: unknown) => add('tool', subject, key, field, value, name)
    push('title', tool.title)
    push('description', tool.description)
    if (isRecord(tool.annotations)) push('annotations.title', tool.annotations.title)
    walkSchemaText(tool.inputSchema, 'inputSchema', push)
    walkSchemaText(tool.outputSchema, 'outputSchema', push)
  })
  for (const r of asArray<ResourceSummary>(opts.resources)) {
    const key = String(r.uri ?? r.name ?? '?')
    add('resource', `resource ${quote(key)}`, key, 'title', r.title)
    add('resource', `resource ${quote(key)}`, key, 'description', r.description)
  }
  for (const r of asArray<ResourceTemplateSummary>(opts.resourceTemplates)) {
    const key = String(r.uriTemplate ?? r.name ?? '?')
    add('resourceTemplate', `resource template ${quote(key)}`, key, 'title', r.title)
    add('resourceTemplate', `resource template ${quote(key)}`, key, 'description', r.description)
  }
  for (const p of asArray<PromptSummary>(opts.prompts)) {
    const key = String(p.name ?? '?')
    const subject = `prompt ${quote(key)}`
    add('prompt', subject, key, 'title', p.title)
    add('prompt', subject, key, 'description', p.description)
    for (const a of asArray<{ name?: string; description?: string }>(p.arguments)) {
      add('prompt', subject, key, `arguments[${quote(String(a.name))}].description`, a.description)
    }
  }
  add('instructions', 'server instructions', 'instructions', 'instructions', opts.instructions)
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * How we decide a tool name is "mentioned". Identifier-looking names
 * (send_email, notes.get, getUser, v2tool) match with alphanumeric boundaries,
 * so prefixed forms like mcp_tool_send_email count. Plain-word names (search,
 * add) only count when quoted/backticked or written as "the search tool".
 */
export function mentionPattern(name: string): RegExp | undefined {
  if (Array.from(name).length < 3) return undefined
  const esc = escapeRegExp(name)
  if (/[_.-]|[a-z][A-Z]|\d/u.test(name)) {
    return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'iu')
  }
  return new RegExp(`[\`'"“”‘’]${esc}[\`'"“”‘’]|\\b${esc}\\s+tool\\b|\\btool\\s+${esc}\\b`, 'iu')
}

function buildContext(tools: ToolSummary[], opts: DescriptionLintOptions): LintContext {
  const names = new Set<string>()
  for (const t of tools) if (typeof t.name === 'string') names.add(t.name)
  for (const n of opts.knownToolNames ?? []) if (typeof n === 'string') names.add(n)
  const mentions: Mention[] = []
  for (const name of names) {
    const re = mentionPattern(name)
    if (re) mentions.push({ name, re })
  }
  return { maxDescriptionLength: opts.maxDescriptionLength ?? 2000, mentions }
}

/**
 * Lint tool descriptions (and, via opts, resource/prompt descriptions and server
 * instructions). Pure. Returns one `passed` outcome per clean rule and one
 * outcome per offending subject otherwise, sorted failed -> warned -> passed.
 */
export function lintDescriptions(
  tools: ToolSummary[] = [],
  opts: DescriptionLintOptions = {},
): CheckOutcome[] {
  const list = asArray<ToolSummary>(tools)
  const ctx = buildContext(list, opts)
  const sources = collectTextSources(list, opts)
  const out: CheckOutcome[] = []
  for (const rule of DESCRIPTION_RULES) {
    if (isAllowed(opts.allow, rule.id)) continue
    const findings: Finding[] = []
    if (rule.text) {
      for (const src of sources) {
        for (const r of rule.text(src, ctx)) {
          const f = typeof r === 'string' ? { message: r } : r
          findings.push({ ...f, subject: src.subject, key: src.key })
        }
      }
    }
    if (rule.tool) {
      const check = rule.tool
      list.forEach((tool, i) => {
        const { subject, key } = toolLabel(tool, i)
        for (const message of check(tool, ctx)) findings.push({ subject, key, message })
      })
    }
    if (rule.tools) findings.push(...rule.tools(list, ctx))
    out.push(...buildOutcomes(rule, findings, opts))
  }
  return sortOutcomes(out)
}
