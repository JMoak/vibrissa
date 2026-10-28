/**
 * Tiny regex-to-string generator for the `pattern` keyword. Covers the patterns MCP tool
 * schemas actually use: anchors, literals, `.`, classes (`[a-z0-9_-]`, `[^...]`), the
 * escapes `\d \w \s \D \W \S \t \n \xHH \uHHHH`, groups `(...)` / `(?:...)` / `(?<n>...)`,
 * alternation and the quantifiers `* + ? {n} {n,} {n,m}` (lazy `?` accepted).
 *
 * Lookarounds, backreferences, `\b`, `\p{...}` and anything else throw
 * `UnsupportedPatternError`; callers fall back to examples/defaults. Output is always
 * re-checked with the real `RegExp`, so an approximation never yields a wrong "valid" value.
 */
import type { Rng } from './random.js'

export class UnsupportedPatternError extends Error {
  constructor(pattern: string, reason: string) {
    super(`unsupported pattern /${pattern}/: ${reason}`)
    this.name = 'UnsupportedPatternError'
  }
}

type RNode =
  | { t: 'seq'; items: RNode[] }
  | { t: 'alt'; options: RNode[] }
  | { t: 'chars'; set: string[] }
  | { t: 'repeat'; node: RNode; min: number; max: number }
  | { t: 'empty' }

const DIGITS = Array.from('0123456789')
const LOWER = Array.from('abcdefghijklmnopqrstuvwxyz')
const UPPER = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
const WORD = [...LOWER, ...UPPER, ...DIGITS, '_']
const PRINTABLE = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i))
/** `.` excludes line terminators; keep it to visible ASCII so values stay readable. */
const DOT = PRINTABLE.filter((c) => c !== ' ')

function complement(set: string[]): string[] {
  const banned = new Set(set)
  return PRINTABLE.filter((c) => !banned.has(c))
}

class Parser {
  private i = 0
  constructor(private readonly src: string) {}

  parse(): RNode {
    const node = this.alt()
    if (this.i < this.src.length) this.fail(`unexpected "${this.src[this.i]}"`)
    return node
  }

  private fail(reason: string): never {
    throw new UnsupportedPatternError(this.src, reason)
  }

  private peek(): string | undefined {
    return this.src[this.i]
  }

  private alt(): RNode {
    const options = [this.seq()]
    while (this.peek() === '|') {
      this.i++
      options.push(this.seq())
    }
    return options.length === 1 ? (options[0] as RNode) : { t: 'alt', options }
  }

  private seq(): RNode {
    const items: RNode[] = []
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom()
      items.push(this.quantified(atom))
    }
    return { t: 'seq', items }
  }

  private quantified(atom: RNode): RNode {
    const c = this.peek()
    let min: number
    let max: number
    if (c === '*') {
      min = 0
      max = Number.POSITIVE_INFINITY
      this.i++
    } else if (c === '+') {
      min = 1
      max = Number.POSITIVE_INFINITY
      this.i++
    } else if (c === '?') {
      min = 0
      max = 1
      this.i++
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i))
      if (!m) return atom // a literal "{" (non-unicode regexes allow it)
      min = Number(m[1])
      max = m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3])
      this.i += m[0].length
    } else {
      return atom
    }
    if (this.peek() === '?') this.i++ // lazy modifier: same language
    return { t: 'repeat', node: atom, min, max }
  }

  private atom(): RNode {
    const c = this.src[this.i++] as string
    switch (c) {
      case '^':
      case '$':
        return { t: 'empty' }
      case '.':
        return { t: 'chars', set: DOT }
      case '(':
        return this.group()
      case '[':
        return { t: 'chars', set: this.charClass() }
      case '\\':
        return this.escape(false)
      case '*':
      case '+':
      case '?':
        return this.fail(`nothing to repeat before "${c}"`)
      default:
        return { t: 'chars', set: [c] }
    }
  }

  private group(): RNode {
    if (this.peek() === '?') {
      const rest = this.src.slice(this.i)
      if (rest.startsWith('?:')) this.i += 2
      else if (/^\?<[A-Za-z_$][\w$]*>/.test(rest)) this.i = this.src.indexOf('>', this.i) + 1
      else this.fail('lookarounds are not supported')
    }
    const inner = this.alt()
    if (this.peek() !== ')') this.fail('unterminated group')
    this.i++
    return inner
  }

  private charClass(): string[] {
    let negate = false
    if (this.peek() === '^') {
      negate = true
      this.i++
    }
    const set: string[] = []
    let first = true
    while (this.i < this.src.length && (this.peek() !== ']' || first)) {
      first = false
      let lo: string[]
      const c = this.src[this.i++] as string
      if (c === '\\') {
        const esc = this.escape(true)
        lo = esc.t === 'chars' ? esc.set : []
      } else {
        lo = [c]
      }
      const isRange =
        lo.length === 1 &&
        this.peek() === '-' &&
        this.i + 1 < this.src.length &&
        this.src[this.i + 1] !== ']'
      if (isRange) {
        this.i++ // '-'
        let hiChar = this.src[this.i++] as string
        if (hiChar === '\\') {
          const esc = this.escape(true)
          if (esc.t !== 'chars' || esc.set.length !== 1) {
            this.fail('class ranges must be between single characters')
          }
          hiChar = esc.set[0] as string
        }
        const from = (lo[0] as string).codePointAt(0) as number
        const to = hiChar.codePointAt(0) as number
        if (to < from) this.fail('class range out of order')
        // Cap huge ranges (e.g. \u0000-￿) to keep the set small.
        const top = Math.min(to, from + 512)
        for (let cp = from; cp <= top; cp++) set.push(String.fromCodePoint(cp))
      } else {
        set.push(...lo)
      }
    }
    if (this.peek() !== ']') this.fail('unterminated character class')
    this.i++
    const unique = [...new Set(set)]
    return negate ? complement(unique) : unique
  }

  private escape(inClass: boolean): RNode {
    const c = this.src[this.i++]
    if (c === undefined) return this.fail('trailing backslash')
    switch (c) {
      case 'd':
        return { t: 'chars', set: DIGITS }
      case 'D':
        return { t: 'chars', set: LOWER }
      case 'w':
        return { t: 'chars', set: WORD }
      case 'W':
        return { t: 'chars', set: ['-', '.', ' '] }
      case 's':
        return { t: 'chars', set: [' '] }
      case 'S':
        return { t: 'chars', set: LOWER }
      case 't':
        return { t: 'chars', set: ['\t'] }
      case 'n':
        return { t: 'chars', set: ['\n'] }
      case 'r':
        return { t: 'chars', set: ['\r'] }
      case 'f':
        return { t: 'chars', set: ['\f'] }
      case 'v':
        return { t: 'chars', set: ['\v'] }
      case '0':
        return { t: 'chars', set: ['\u0000'] }
      case 'x': {
        const hex = this.src.slice(this.i, this.i + 2)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('bad \\x escape')
        this.i += 2
        return { t: 'chars', set: [String.fromCharCode(Number.parseInt(hex, 16))] }
      }
      case 'u': {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.i))
        if (braced) {
          this.i += braced[0].length
          return {
            t: 'chars',
            set: [String.fromCodePoint(Number.parseInt(braced[1] as string, 16))],
          }
        }
        const hex = this.src.slice(this.i, this.i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape')
        this.i += 4
        return { t: 'chars', set: [String.fromCharCode(Number.parseInt(hex, 16))] }
      }
      case 'b':
        if (inClass) return { t: 'chars', set: ['\b'] }
        return this.fail('word boundaries (\\b) are not supported')
      case 'B':
      case 'p':
      case 'P':
      case 'k':
        return this.fail(`\\${c} is not supported`)
      default:
        if (/[1-9]/.test(c)) return this.fail('backreferences are not supported')
        return { t: 'chars', set: [c] }
    }
  }
}

const astCache = new Map<string, RNode | UnsupportedPatternError>()

function parsePattern(pattern: string): RNode {
  let cached = astCache.get(pattern)
  if (!cached) {
    try {
      cached = new Parser(pattern).parse()
    } catch (err) {
      if (!(err instanceof UnsupportedPatternError)) throw err
      cached = err
    }
    astCache.set(pattern, cached)
  }
  if (cached instanceof UnsupportedPatternError) throw cached
  return cached
}

export interface PatternGenOptions {
  /** Use the fewest repetitions every quantifier allows (used to fit under maxLength). */
  short?: boolean
  /** Extra repetitions allowed above a quantifier's minimum (default 4). */
  spread?: number
}

/**
 * Produce one string matching `pattern` (approximately; verify with `testPattern`).
 * Throws `UnsupportedPatternError` for constructs this generator does not model.
 */
export function stringFromPattern(pattern: string, rng: Rng, opts: PatternGenOptions = {}): string {
  const ast = parsePattern(pattern)
  const spread = opts.short ? 0 : (opts.spread ?? 4)
  const emit = (node: RNode): string => {
    switch (node.t) {
      case 'empty':
        return ''
      case 'chars':
        return node.set.length === 0 ? '' : rng.pick(node.set)
      case 'seq':
        return node.items.map(emit).join('')
      case 'alt':
        return emit(rng.pick(node.options))
      case 'repeat': {
        const top = Math.min(node.max, node.min + spread)
        const n = rng.int(node.min, top)
        let out = ''
        for (let k = 0; k < n; k++) out += emit(node.node)
        return out
      }
    }
  }
  return emit(ast)
}

const regexCache = new Map<string, RegExp | null>()

/** Compile a JSON Schema pattern the way Ajv does (`u` flag, falling back to none). */
export function compilePattern(pattern: string): RegExp | null {
  const hit = regexCache.get(pattern)
  if (hit !== undefined) return hit
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, 'u')
  } catch {
    try {
      re = new RegExp(pattern)
    } catch {
      re = null
    }
  }
  regexCache.set(pattern, re)
  return re
}

/** JSON Schema `pattern` semantics: unanchored search. Unparseable patterns never match. */
export function testPattern(pattern: string, value: string): boolean {
  const re = compilePattern(pattern)
  return re ? re.test(value) : false
}
