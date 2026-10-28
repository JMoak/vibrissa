/**
 * Small seeded PRNG (mulberry32) plus string hashing. Everything in the fuzz module
 * that needs randomness takes an `Rng` so a run is fully reproducible from its seed.
 */

export interface Rng {
  /** The 32-bit seed this generator started from. */
  readonly seed: number
  /** Next float in [0, 1). */
  next(): number
  /** Integer in [min, max] (inclusive). Swaps the bounds if given in the wrong order. */
  int(min: number, max: number): number
  /** Float in [min, max). */
  float(min: number, max: number): number
  /** A random element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T
  /** true with probability `p` (default 0.5). */
  bool(p?: number): boolean
  /** true with probability `p`, 0..1. Alias of `bool(p)` that reads better in conditions. */
  chance(p: number): boolean
  /**
   * A string of exactly `length` code points drawn from `alphabet` (a string, split by
   * code point, or an array of strings each counted as one unit). Default: [a-z0-9].
   */
  string(length: number, alphabet?: string | readonly string[]): string
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[]
  /** An independent generator derived from this one's seed and `label`. Does not advance this one. */
  fork(label: string): Rng
}

const DEFAULT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 32-bit seed from any string (cyrb53, folded). Stable across platforms and Node versions,
 * so `--seed my-branch-name` reproduces the same run everywhere.
 */
export function seedFromString(text: string): number {
  const [h1, h2] = cyrb53(text, 0)
  return (h1 ^ h2) >>> 0
}

/** Hex hash of a string (up to 32 hex chars from two cyrb53 passes), used for stable case ids. */
export function hashString(text: string, length = 12): string {
  const [a, b] = cyrb53(text, 0x9e3779b9)
  const [c, d] = cyrb53(text, 0x85ebca6b)
  const hex =
    (a >>> 0).toString(16).padStart(8, '0') +
    (c >>> 0).toString(16).padStart(8, '0') +
    (d >>> 0).toString(16).padStart(8, '0') +
    (b >>> 0).toString(16).padStart(8, '0')
  return hex.slice(0, Math.max(1, Math.min(length, hex.length)))
}

function cyrb53(text: string, seed: number): [number, number] {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return [h1 >>> 0, h2 >>> 0]
}

/** Normalize a user seed (number or string) to a 32-bit unsigned integer. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff
      ? seed >>> 0
      : seedFromString(String(seed))
  }
  return seedFromString(String(seed))
}

/** Create a seeded generator. Same seed, same sequence. */
export function createRng(seed: number | string): Rng {
  const start = normalizeSeed(seed)
  let state = start
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    seed: start,
    next,
    int(min, max) {
      let lo = Math.ceil(Math.min(min, max))
      let hi = Math.floor(Math.max(min, max))
      if (hi < lo) [lo, hi] = [hi, lo]
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    float(min, max) {
      return min + next() * (max - min)
    },
    pick(items) {
      if (items.length === 0) throw new Error('Rng.pick: cannot pick from an empty array')
      return items[Math.floor(next() * items.length)] as (typeof items)[number]
    },
    bool(p = 0.5) {
      return next() < p
    },
    chance(p) {
      return next() < p
    },
    string(length, alphabet = DEFAULT_ALPHABET) {
      const units = typeof alphabet === 'string' ? Array.from(alphabet) : alphabet
      if (units.length === 0 || length <= 0) return ''
      let out = ''
      for (let i = 0; i < length; i++) out += units[Math.floor(next() * units.length)]
      return out
    },
    shuffle(items) {
      const copy = items.slice()
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = copy[i] as (typeof copy)[number]
        copy[i] = copy[j] as (typeof copy)[number]
        copy[j] = tmp
      }
      return copy
    },
    fork(label) {
      return createRng(seedFromString(`${start}:${label}`))
    },
  }
  return rng
}
