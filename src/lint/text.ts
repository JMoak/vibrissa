/**
 * Text helpers for the description rules: invisible-character scanning,
 * normalization for pattern matching, sentence splitting and snippet quoting.
 * Pure; no I/O.
 */

export type InvisibleKind = 'tag' | 'variation-selector' | 'bidi-override' | 'bidi' | 'zero-width'

const ZERO_WIDTH = new Set([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x115f, // hangul choseong filler
  0x1160, // hangul jungseong filler
  0x17b4, // khmer vowel inherent aq
  0x17b5, // khmer vowel inherent aa
  0x180e, // mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
  0x2061, // function application
  0x2062, // invisible times
  0x2063, // invisible separator
  0x2064, // invisible plus
  0x3164, // hangul filler
  0xfeff, // zero width no-break space / BOM
  0xffa0, // halfwidth hangul filler
])

export function invisibleKind(cp: number): InvisibleKind | undefined {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag'
  if ((cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xfe00 && cp <= 0xfe0d)) {
    return 'variation-selector'
  }
  if (cp === 0x202d || cp === 0x202e) return 'bidi-override'
  if (
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x061c ||
    (cp >= 0x202a && cp <= 0x202c) ||
    (cp >= 0x2066 && cp <= 0x2069)
  ) {
    return 'bidi'
  }
  if (ZERO_WIDTH.has(cp)) return 'zero-width'
  return undefined
}

const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
const NON_ASCII_LETTER = /^[\p{L}\p{M}]$/u

function isNonAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && (ch.codePointAt(0) ?? 0) > 0x7f && NON_ASCII_LETTER.test(ch)
}

/** Previous code point, skipping emoji modifiers and presentation selectors. */
function prevSignificant(cps: string[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const cp = cps[j].codePointAt(0) ?? 0
    if (cp === 0xfe0f || cp === 0xfe0e || (cp >= 0x1f3fb && cp <= 0x1f3ff)) continue
    return cps[j]
  }
  return undefined
}

/** Legitimate uses: emoji ZWJ sequences, ZWJ/ZWNJ inside non-Latin words, bidi marks in RTL text. */
function isExempt(
  kind: InvisibleKind,
  cp: number,
  cps: string[],
  i: number,
  rtl: boolean,
): boolean {
  if (cp === 0x200d || cp === 0x200c) {
    const prev = prevSignificant(cps, i)
    const next = cps[i + 1]
    if (cp === 0x200d && prev && next && PICTOGRAPHIC.test(prev) && PICTOGRAPHIC.test(next)) {
      return true
    }
    return isNonAsciiLetter(cps[i - 1]) && isNonAsciiLetter(next)
  }
  return kind === 'bidi' && rtl
}

export interface InvisibleHit {
  index: number
  codePoint: number
  kind: InvisibleKind
}

export interface InvisibleScan {
  /** Suspicious invisible characters (legitimate uses already exempted). */
  hits: InvisibleHit[]
  /** ASCII text smuggled via Unicode tag characters (U+E0020..U+E007E), if any. */
  tagText: string
}

export function scanInvisible(raw: string): InvisibleScan {
  const cps = Array.from(raw)
  const rtl = RTL_LETTER.test(raw)
  const hits: InvisibleHit[] = []
  let tagText = ''
  let offset = 0
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]
    const cp = ch.codePointAt(0) ?? 0
    const kind = invisibleKind(cp)
    if (kind) {
      if (kind === 'tag' && cp >= 0xe0020 && cp <= 0xe007e) {
        tagText += String.fromCharCode(cp - 0xe0000)
      }
      if (!isExempt(kind, cp, cps, i, rtl)) hits.push({ index: offset, codePoint: cp, kind })
    }
    offset += ch.length
  }
  return { hits, tagText }
}

export const TAG_TEXT_MARKER = '[invisible tag text]'

/**
 * Normalize model-visible text before pattern matching: drop invisible
 * characters (so "ig​nore" still reads "ignore"), NFKC-fold look-alike
 * forms (fullwidth letters etc.), and append any tag-smuggled ASCII so the
 * phrase rules can see it.
 */
export function normalizeForMatching(raw: string): string {
  let visible = ''
  for (const ch of raw) {
    if (!invisibleKind(ch.codePointAt(0) ?? 0)) visible += ch
  }
  const { tagText } = scanInvisible(raw)
  const out = visible.normalize('NFKC')
  return tagText ? `${out}\n${TAG_TEXT_MARKER} ${tagText}` : out
}

/** Split on sentence punctuation followed by whitespace, and on newlines. Dotted names survive. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function collapse(s: string): string {
  return s.replace(/\s+/gu, ' ').trim()
}

export function clip(s: string, max = 160): string {
  const c = collapse(s)
  return c.length > max ? `${c.slice(0, max - 3)}...` : c
}

/** A short window of `text` around a match, whitespace-collapsed. */
export function excerpt(text: string, index: number, length: number, radius = 32): string {
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + Math.min(length, 100) + radius)
  const body = collapse(text.slice(start, end))
  return `${start > 0 ? '...' : ''}${body}${end < text.length ? '...' : ''}`
}

/** JSON-quote for details (escapes quotes, backslashes, control chars). */
export function quote(s: string): string {
  return JSON.stringify(s)
}

export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}
