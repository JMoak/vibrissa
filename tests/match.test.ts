import { describe, expect, it } from 'vitest'
import { matchValue, matches } from '../src/match'
import type { JsonValue } from '../src/types'

function firstMismatch(expected: JsonValue, actual: unknown) {
  const result = matchValue(expected, actual)
  expect(result.length).toBeGreaterThan(0)
  return result[0]
}

describe('exact matching', () => {
  it('matches identical primitives', () => {
    expect(matches('a', 'a')).toBe(true)
    expect(matches(42, 42)).toBe(true)
    expect(matches(true, true)).toBe(true)
    expect(matches(null, null)).toBe(true)
  })

  it('rejects differing primitives with values in the mismatch', () => {
    const m = firstMismatch('a', 'b')
    expect(m.path).toBe('(root)')
    expect(m.message).toContain('"a"')
    expect(m.message).toContain('"b"')
  })

  it('matches deep structures independent of key order', () => {
    expect(matches({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
  })

  it('rejects extra keys in exact mode and suggests $partial', () => {
    const m = firstMismatch({ a: 1 }, { a: 1, b: 2 })
    expect(m.message).toContain('"b"')
    expect(m.message).toContain('$partial')
  })

  it('reports missing keys with a dotted path', () => {
    const m = firstMismatch({ a: { b: 1 } }, { a: {} })
    expect(m.path).toBe('a.b')
    expect(m.message).toContain('missing')
  })

  it('reports array index paths', () => {
    const m = firstMismatch(
      { content: [{ type: 'text', text: 'x' }] },
      {
        content: [{ type: 'text', text: 'y' }],
      },
    )
    expect(m.path).toBe('content[0].text')
  })

  it('rejects array length differences', () => {
    const m = firstMismatch([1, 2], [1, 2, 3])
    expect(m.message).toContain('length 2')
    expect(m.message).toContain('got 3')
  })

  it('rejects type mismatches', () => {
    expect(firstMismatch({ a: 1 }, 'nope').message).toContain('expected an object, got string')
    expect(firstMismatch([1], { 0: 1 }).message).toContain('expected an array, got object')
    expect(firstMismatch({ a: 1 }, null).message).toContain('expected an object, got null')
  })

  it('collects multiple mismatches', () => {
    const result = matchValue({ a: 1, b: 2 }, { a: 9, b: 8 })
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.path).sort()).toEqual(['a', 'b'])
  })
})

describe('$partial', () => {
  it('allows extra keys where declared', () => {
    expect(matches({ $partial: true, a: 1 }, { a: 1, b: 2 })).toBe(true)
  })

  it('cascades to nested objects', () => {
    const expected = { $partial: true, content: [{ type: 'text' }] }
    const actual = { content: [{ type: 'text', text: 'hello' }], isError: false }
    expect(matches(expected, actual)).toBe(true)
  })

  it('allows extra trailing array elements', () => {
    const expected = { $partial: true, content: [{ type: 'text' }] }
    const actual = { content: [{ type: 'text' }, { type: 'image' }] }
    expect(matches(expected, actual)).toBe(true)
  })

  it('still asserts the fields that are provided', () => {
    const m = firstMismatch({ $partial: true, a: 1 }, { a: 2, b: 3 })
    expect(m.path).toBe('a')
  })

  it('does not leak partial mode to siblings outside the declaring subtree', () => {
    const expected = { strict: { a: 1 }, loose: { $partial: true, a: 1 } }
    const actual = { strict: { a: 1, extra: true }, loose: { a: 1, extra: true } }
    const result = matchValue(expected, actual)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('strict')
  })
})

describe('$regex', () => {
  it('matches with pattern and flags', () => {
    expect(matches({ $regex: '^hel+o$', flags: 'i' }, 'HELLO')).toBe(true)
  })

  it('rejects non-matching strings', () => {
    const m = firstMismatch({ $regex: '^hel+o$' }, 'goodbye')
    expect(m.message).toContain('/^hel+o$/')
  })

  it('rejects non-strings', () => {
    const m = firstMismatch({ $regex: 'x' }, 42)
    expect(m.message).toContain('got number')
  })

  it('reports invalid patterns instead of throwing', () => {
    const m = firstMismatch({ $regex: '([' }, 'anything')
    expect(m.message).toContain('invalid $regex pattern')
  })

  it('works nested inside structures', () => {
    const expected = { content: [{ type: 'text', text: { $regex: 'hel+o', flags: 'i' } }] }
    const actual = { content: [{ type: 'text', text: 'Hello world' }] }
    expect(matches(expected, actual)).toBe(true)
  })
})

describe('$wildcard', () => {
  it('supports * and ?', () => {
    expect(matches({ $wildcard: 'hel*o' }, 'hello')).toBe(true)
    expect(matches({ $wildcard: 'hel*o' }, 'helllllllo')).toBe(true)
    expect(matches({ $wildcard: 'h?llo' }, 'hallo')).toBe(true)
    expect(matches({ $wildcard: 'h?llo' }, 'hllo')).toBe(false)
  })

  it('anchors the whole string', () => {
    expect(matches({ $wildcard: 'hel*' }, 'say hello')).toBe(false)
  })

  it('escapes regex metacharacters', () => {
    expect(matches({ $wildcard: 'a.b*' }, 'a.b/c')).toBe(true)
    expect(matches({ $wildcard: 'a.b' }, 'aXb')).toBe(false)
  })

  it('matches across newlines', () => {
    expect(matches({ $wildcard: 'start*end' }, 'start\nmiddle\nend')).toBe(true)
  })

  it('rejects non-strings', () => {
    const m = firstMismatch({ $wildcard: 'x*' }, null)
    expect(m.message).toContain('got null')
  })
})

describe('$unordered', () => {
  it('matches arrays as multisets', () => {
    const expected = { $unordered: true, value: [2, 1, 3] }
    expect(matches(expected, [1, 2, 3])).toBe(true)
  })

  it('respects multiplicity', () => {
    const expected = { $unordered: true, value: [1, 1, 2] }
    expect(matches(expected, [1, 2, 2])).toBe(false)
  })

  it('requires equal length in exact mode', () => {
    const expected = { $unordered: true, value: [1] }
    expect(matches(expected, [1, 2])).toBe(false)
  })

  it('allows extra elements under $partial', () => {
    const expected = { $partial: true, items: { $unordered: true, value: [{ id: 2 }] } }
    const actual = { items: [{ id: 1 }, { id: 2 }], other: true }
    expect(matches(expected, actual)).toBe(true)
  })

  it('backtracks when a greedy assignment would fail', () => {
    const expected = {
      $unordered: true,
      value: [
        { $partial: true, kind: 'a' },
        { $partial: true, kind: 'a', extra: 1 },
      ],
    }
    const actual = [{ kind: 'a', extra: 1 }, { kind: 'a' }]
    expect(matches(expected as JsonValue, actual)).toBe(true)
  })

  it('combines with nested directives', () => {
    const expected = {
      $unordered: true,
      value: [
        { type: 'text', text: { $regex: '^b' } },
        { type: 'text', text: 'apple' },
      ],
    }
    const actual = [
      { type: 'text', text: 'apple' },
      { type: 'text', text: 'banana' },
    ]
    expect(matches(expected as JsonValue, actual)).toBe(true)
  })

  it('reports a clear aggregate mismatch', () => {
    const m = firstMismatch({ $unordered: true, value: ['a', 'b'] }, ['a', 'c'])
    expect(m.message).toContain('no arrangement')
  })

  it('rejects non-arrays', () => {
    const m = firstMismatch({ $unordered: true, value: [1] }, 'nope')
    expect(m.message).toContain('got string')
  })
})
