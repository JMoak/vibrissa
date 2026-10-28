import { describe, expect, it } from 'vitest'
import {
  MAX_MISMATCHES,
  RefResolutionError,
  escapeDirectives,
  lintExpectation,
  matchValue,
  matches,
  resolveRefs,
} from '../src/match'
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

describe('v1 behavior refinements', () => {
  it('quotes unusual keys in paths', () => {
    const m = firstMismatch(
      { _meta: { 'io.example/trace': 'a' } },
      { _meta: { 'io.example/trace': 'b' } },
    )
    expect(m.path).toBe('_meta["io.example/trace"]')
  })

  it('does not treat inherited properties as present', () => {
    const m = firstMismatch({ toString: 1 }, {})
    expect(m.path).toBe('toString')
    expect(m.message).toContain('missing')
  })

  it('caps the number of mismatches', () => {
    const expected: Record<string, JsonValue> = {}
    const actual: Record<string, JsonValue> = {}
    for (let i = 0; i < 40; i++) {
      expected[`k${i}`] = i
      actual[`k${i}`] = -i - 1
    }
    expect(matchValue(expected, actual)).toHaveLength(MAX_MISMATCHES)
  })

  it('accepts a root partial option', () => {
    expect(matches({ a: 1 }, { a: 1, b: 2 }, { partial: true })).toBe(true)
    expect(matches({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('lets "$partial": false switch partial mode back off for a subtree', () => {
    const expected = { $partial: true, inner: { $partial: false, a: 1 } }
    expect(matches(expected, { inner: { a: 1 }, extra: true })).toBe(true)
    const m = firstMismatch(expected, { inner: { a: 1, b: 2 } })
    expect(m.path).toBe('inner')
    expect(m.message).toContain('unexpected key "b"')
  })

  it('reports a non-boolean $partial as an invalid matcher', () => {
    const m = firstMismatch({ $partial: 'yes', a: 1 }, { a: 1 })
    expect(m.message).toContain('invalid matcher')
    expect(m.message).toContain('$partial')
  })

  it('treats a lone $partial object as "any object"', () => {
    expect(matches({ $partial: true }, { anything: [1, 2] })).toBe(true)
    expect(firstMismatch({ $partial: true }, [1]).message).toContain(
      'expected an object, got array',
    )
  })
})

describe('$unordered (v2 additions)', () => {
  it('names the expected element that matches nothing, with the closest candidate', () => {
    const m = firstMismatch({ $unordered: true, value: ['a', 'b'] }, ['a', 'c'])
    expect(m.message).toContain('no arrangement')
    expect(m.message).toContain('value[1] "b" matches no actual element')
    expect(m.message).toContain('closest is [1]: expected "b", got "c"')
  })

  it('explains when elements fit individually but not all at once', () => {
    const expected = { $unordered: true, value: [{ $oneOf: [1, 2] }, { $oneOf: [1, 2] }, 3] }
    expect(matches(expected, [3, 2, 1])).toBe(true)
    const m = firstMismatch(expected, [1, 3, 3])
    expect(m.message).toContain('not all at once')
  })

  it('finds an assignment that a greedy pass would miss', () => {
    const expected = { $unordered: true, value: [{ $wildcard: 'a*' }, 'ab'] }
    expect(matches(expected, ['ab', 'ax'])).toBe(true)
    expect(matches(expected, ['ab', 'zz'])).toBe(false)
  })

  it('accepts "$partial": true on the directive itself', () => {
    const expected = { $unordered: true, $partial: true, value: [{ id: 2 }] }
    expect(
      matches(expected, [
        { id: 1, x: 1 },
        { id: 2, y: 2 },
      ]),
    ).toBe(true)
    expect(matches({ $unordered: true, value: [{ id: 2 }] }, [{ id: 2, y: 2 }])).toBe(false)
  })

  it('contains v2 matchers in its items', () => {
    const expected: JsonValue = {
      $unordered: true,
      value: [{ $type: 'number' }, { $type: 'string' }, { $any: true }],
    }
    expect(matches(expected, [null, 'a', 3])).toBe(true)
    expect(matches(expected, [null, 'a', true])).toBe(false)
  })

  it('handles large arrays without exponential backtracking', () => {
    const value = Array.from({ length: 200 }, (_, i) => ({ id: i }))
    const actual = [...value].reverse()
    const started = Date.now()
    expect(matches({ $unordered: true, value }, actual)).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports malformed $unordered as an invalid matcher', () => {
    expect(firstMismatch({ $unordered: true, value: 'x' }, ['x']).message).toContain(
      'invalid matcher',
    )
    expect(firstMismatch({ $unordered: false, value: [1] }, [1]).message).toContain(
      '"$unordered" must be true',
    )
  })
})

describe('$any', () => {
  it('matches any present value, including null', () => {
    for (const value of ['x', 0, false, null, [], {}] as JsonValue[]) {
      expect(matches({ a: { $any: true } }, { a: value })).toBe(true)
    }
  })

  it('fails when the key is missing', () => {
    const m = firstMismatch({ a: { $any: true } }, {})
    expect(m.path).toBe('a')
    expect(m.message).toBe('missing expected key (expected {"$any":true})')
  })

  it('rejects $any: false as invalid', () => {
    expect(firstMismatch({ $any: false }, 1).message).toContain('"$any" must be true')
  })
})

describe('$type', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['string', 'x', true],
    ['string', 1, false],
    ['number', 1.5, true],
    ['number', 2, true],
    ['integer', 2, true],
    ['integer', 2.5, false],
    ['boolean', false, true],
    ['boolean', 0, false],
    ['object', {}, true],
    ['object', [], false],
    ['object', null, false],
    ['array', [], true],
    ['array', {}, false],
    ['null', null, true],
    ['null', 0, false],
  ]
  it.each(cases)('$type %s vs %j -> %s', (type, actual, ok) => {
    expect(matches({ $type: type }, actual)).toBe(ok)
  })

  it('accepts an array of types', () => {
    expect(matches({ $type: ['string', 'null'] }, null)).toBe(true)
    expect(matches({ $type: ['string', 'null'] }, 'x')).toBe(true)
    expect(firstMismatch({ $type: ['string', 'null'] }, 42).message).toBe(
      'expected type string | null, got number 42',
    )
  })

  it('describes the actual value in the message', () => {
    expect(firstMismatch({ $type: 'integer' }, 1.5).message).toBe(
      'expected type integer, got number 1.5',
    )
    expect(firstMismatch({ $type: 'string' }, [1, 2]).message).toBe(
      'expected type string, got array (2 items)',
    )
  })

  it('reports unknown type names with a $literal hint', () => {
    const m = firstMismatch({ $type: 'Acme.Widget, Acme' }, {})
    expect(m.message).toContain('invalid matcher')
    expect(m.message).toContain('$literal')
    expect(firstMismatch({ $type: 'strnig' }, 'x').message).toContain('"$type" must be one of')
    expect(firstMismatch({ $type: [] }, 'x').message).toContain('invalid matcher')
  })
})

describe('$schema', () => {
  const userSchema = {
    type: 'object',
    required: ['id', 'name'],
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    additionalProperties: false,
  }

  it('validates a subtree against inline JSON Schema', () => {
    const expected = { structuredContent: { $schema: userSchema } }
    expect(matches(expected, { structuredContent: { id: 1, name: 'a' } })).toBe(true)
  })

  it('lists the first errors with full paths', () => {
    const m = firstMismatch(
      { structuredContent: { $schema: userSchema } },
      { structuredContent: { id: 'x', extra: true } },
    )
    expect(m.path).toBe('structuredContent')
    expect(m.message).toContain('value does not match $schema')
    expect(m.message).toContain('structuredContent.id must be integer, got string')
    expect(m.message).toContain('must have required property "name"')
  })

  it('summarizes long error lists', () => {
    const m = firstMismatch(
      { $schema: { type: 'array', items: { type: 'string' } } },
      [1, 2, 3, 4, 5],
    )
    expect(m.message).toContain('[0] must be string, got integer')
    expect(m.message).toContain('(+2 more)')
  })

  it('resolves $defs references within the schema', () => {
    const schema = {
      $defs: {
        item: { type: 'object', required: ['type'], properties: { type: { const: 'text' } } },
      },
      type: 'array',
      items: { $ref: '#/$defs/item' },
    }
    expect(matches({ content: { $schema: schema } }, { content: [{ type: 'text' }] })).toBe(true)
    const m = firstMismatch({ content: { $schema: schema } }, { content: [{ type: 'image' }] })
    expect(m.message).toContain('content[0].type must be "text", got "image"')
  })

  it('reports schemas that cannot compile as invalid matchers', () => {
    const m = firstMismatch({ $schema: { $ref: '#/$defs/missing' } }, 1)
    expect(m.message).toContain('invalid matcher: $schema could not be compiled')
    expect(m.message).toContain('$defs')
  })

  it('supports boolean schemas', () => {
    expect(matches({ $schema: true }, 'anything')).toBe(true)
    expect(matches({ $schema: false }, 'anything')).toBe(false)
  })

  it('treats a string $schema as plain data, not a matcher', () => {
    const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }
    expect(matches(doc, { ...doc })).toBe(true)
    expect(matches(doc, { ...doc, type: 'array' })).toBe(false)
  })

  it('is not loosened by partial mode (the schema decides)', () => {
    const expected = {
      $partial: true,
      a: { $schema: { type: 'object', additionalProperties: false } },
    }
    expect(matches(expected, { a: { x: 1 } })).toBe(false)
  })
})

describe('$oneOf', () => {
  it('matches when any alternative matches', () => {
    const expected = { $oneOf: [{ $regex: '^ok' }, { $regex: '^done' }] }
    expect(matches(expected, 'done!')).toBe(true)
    expect(matches(expected, 'ok')).toBe(true)
    expect(matches(expected, 'nope')).toBe(false)
  })

  it('lists why each alternative failed', () => {
    const m = firstMismatch(
      { status: { $oneOf: ['active', { $type: 'null' }] } },
      { status: 'gone' },
    )
    expect(m.path).toBe('status')
    expect(m.message).toBe(
      'none of 2 $oneOf alternatives matched: #1 expected "active", got "gone"; #2 expected type null, got string "gone"',
    )
  })

  it('names the nested path inside an alternative', () => {
    const m = firstMismatch({ $oneOf: [{ kind: 'a', n: 1 }] }, { kind: 'a', n: 2 })
    expect(m.message).toContain('#1 n: expected 1, got 2')
  })

  it('inherits partial mode, or takes it from its own $partial', () => {
    expect(matches({ $partial: true, x: { $oneOf: [{ a: 1 }] } }, { x: { a: 1, b: 2 } })).toBe(true)
    expect(matches({ $oneOf: [{ a: 1 }] }, { a: 1, b: 2 })).toBe(false)
    expect(matches({ $oneOf: [{ a: 1 }], $partial: true }, { a: 1, b: 2 })).toBe(true)
  })

  it('accepts a missing key when an alternative is $ignore', () => {
    const expected: JsonValue = { a: 1, note: { $oneOf: [{ $type: 'string' }, { $ignore: true }] } }
    expect(matches(expected, { a: 1 })).toBe(true)
    expect(matches({ a: 1, note: { $oneOf: [{ $type: 'string' }] } }, { a: 1 })).toBe(false)
  })

  it('rejects an empty or non-array $oneOf', () => {
    expect(firstMismatch({ $oneOf: [] }, 1).message).toContain('non-empty array')
    expect(firstMismatch({ $oneOf: 'a' }, 'a').message).toContain('invalid matcher')
  })
})

describe('$contains', () => {
  const content = [
    { type: 'text', text: 'hello', annotations: { audience: ['user'] } },
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
  ]

  it('finds an element, partially by default', () => {
    expect(matches({ $contains: { type: 'image' } }, content)).toBe(true)
    expect(matches({ $contains: { type: 'text', text: { $regex: '^hel' } } }, content)).toBe(true)
  })

  it('can require exact element matches', () => {
    expect(matches({ $contains: { type: 'image' }, $partial: false }, content)).toBe(false)
    const exact = {
      $contains: { type: 'image', data: 'AAA', mimeType: 'image/png' },
      $partial: false,
    }
    expect(matches(exact, content)).toBe(true)
  })

  it('reports the closest element when nothing matches', () => {
    const m = firstMismatch({ content: { $contains: { type: 'text', text: 'bye' } } }, { content })
    expect(m.path).toBe('content')
    expect(m.message).toContain('none of 2 elements matched')
    expect(m.message).toContain('closest is content[0].text: expected "bye", got "hello"')
  })

  it('reports empty arrays and non-arrays clearly', () => {
    expect(firstMismatch({ $contains: 1 }, []).message).toContain('the array is empty')
    const m = firstMismatch({ $contains: 'hel' }, 'hello')
    expect(m.message).toContain('got string "hello"')
    expect(m.message).toContain('$wildcard')
  })

  it('supports an exact count', () => {
    const items = [{ t: 'a' }, { t: 'b' }, { t: 'a' }]
    expect(matches({ $contains: { t: 'a' }, count: 2 }, items)).toBe(true)
    expect(firstMismatch({ $contains: { t: 'a' }, count: 1 }, items).message).toBe(
      'expected 1 element(s) matching {"t":"a"}, found 2 (at [0], [2])',
    )
    expect(matches({ $contains: { t: 'z' }, count: 0 }, items)).toBe(true)
  })

  it('supports a count range', () => {
    const items = [1, 2, 3, 4]
    expect(matches({ $contains: { $number: { gt: 1 } }, count: { min: 2, max: 3 } }, items)).toBe(
      true,
    )
    expect(matches({ $contains: { $number: { gt: 0 } }, count: { max: 3 } }, items)).toBe(false)
  })

  it('composes with $partial parents and other matchers', () => {
    const expected = {
      $partial: true,
      content: { $contains: { type: 'text' }, $length: { min: 2 } },
    }
    expect(matches(expected, { content, isError: false })).toBe(true)
    expect(matches(expected, { content: [content[0]] })).toBe(false)
  })

  it('rejects invalid counts', () => {
    expect(firstMismatch({ $contains: 1, count: -1 }, [1]).message).toContain('"count"')
    expect(firstMismatch({ $contains: 1, count: { min: 3, max: 1 } }, [1]).message).toContain(
      'min > max',
    )
  })
})

describe('$length', () => {
  it('checks exact array and string length', () => {
    expect(matches({ $length: 3 }, [1, 2, 3])).toBe(true)
    expect(matches({ $length: 3 }, 'abc')).toBe(true)
    expect(firstMismatch({ $length: 3 }, [1]).message).toBe('expected array length 3, got 1')
  })

  it('checks ranges', () => {
    expect(matches({ $length: { min: 1, max: 10 } }, 'hello')).toBe(true)
    expect(matches({ $length: { min: 1 } }, [])).toBe(false)
    expect(firstMismatch({ $length: { min: 1, max: 2 } }, 'abc').message).toBe(
      'expected string length >= 1 and <= 2, got 3',
    )
    expect(matches({ $length: { max: 0 } }, [])).toBe(true)
  })

  it('counts code points, not UTF-16 units', () => {
    expect(matches({ $length: 2 }, '\u{1F600}\u{1F600}')).toBe(true)
  })

  it('rejects other types', () => {
    expect(firstMismatch({ $length: 1 }, { a: 1 }).message).toBe(
      'expected an array or string with length 1, got object',
    )
  })

  it('rejects malformed specs', () => {
    expect(firstMismatch({ $length: -1 }, []).message).toContain('invalid matcher')
    expect(firstMismatch({ $length: {} }, []).message).toContain('"min" and/or "max"')
    expect(firstMismatch({ $length: { min: 1.5 } }, []).message).toContain('non-negative integers')
    expect(firstMismatch({ $length: { least: 1 } }, []).message).toContain('only accepts')
  })
})

describe('$number', () => {
  it('checks each bound', () => {
    expect(matches({ $number: { gt: 0 } }, 1)).toBe(true)
    expect(matches({ $number: { gt: 0 } }, 0)).toBe(false)
    expect(matches({ $number: { gte: 0 } }, 0)).toBe(true)
    expect(matches({ $number: { lt: 10 } }, 10)).toBe(false)
    expect(matches({ $number: { lte: 10 } }, 10)).toBe(true)
    expect(matches({ $number: { eq: 3 } }, 3)).toBe(true)
    expect(matches({ $number: { eq: 3 } }, 3.1)).toBe(false)
  })

  it('combines bounds and explains failures', () => {
    expect(matches({ $number: { gte: 0, lt: 100 } }, 99.9)).toBe(true)
    expect(firstMismatch({ $number: { gte: 0, lt: 100 } }, 150).message).toBe(
      'expected number >= 0 and < 100, got 150',
    )
  })

  it('rejects non-numbers', () => {
    expect(firstMismatch({ $number: { gte: 0 } }, '5').message).toBe(
      'expected a number >= 0, got string "5"',
    )
  })

  it('composes with $type for integer ranges', () => {
    const expected = { $type: 'integer', $number: { gte: 1 } }
    expect(matches(expected, 3)).toBe(true)
    expect(firstMismatch(expected, 2.5).message).toContain('expected type integer')
    expect(firstMismatch(expected, 0).message).toContain('expected number >= 1')
  })

  it('rejects malformed bounds', () => {
    expect(firstMismatch({ $number: {} }, 1).message).toContain('invalid matcher')
    expect(firstMismatch({ $number: { min: 1 } }, 1).message).toContain('does not support "min"')
    expect(firstMismatch({ $number: { gt: '1' } }, 1).message).toContain('must be a number')
  })
})

describe('$ignore', () => {
  it('matches present values of any kind', () => {
    const expected = { a: 1, ts: { $ignore: true } }
    expect(matches(expected, { a: 1, ts: '2026-10-28T00:00:00Z' })).toBe(true)
    expect(matches(expected, { a: 1, ts: null })).toBe(true)
  })

  it('matches missing keys, even in exact mode', () => {
    expect(matches({ a: 1, ts: { $ignore: true } }, { a: 1 })).toBe(true)
    expect(matches({ a: 1, ts: { $ignore: true } }, { a: 1, other: 2 })).toBe(false)
  })

  it('still counts as an array slot', () => {
    expect(matches([1, { $ignore: true }, 3], [1, 'x', 3])).toBe(true)
    expect(matches([1, { $ignore: true }], [1])).toBe(false)
  })

  it('matches anything at the root', () => {
    expect(matches({ $ignore: true }, { whatever: [1] })).toBe(true)
  })

  it('must stand alone', () => {
    expect(firstMismatch({ $ignore: true, $type: 'string' }, 'x').message).toContain(
      '$ignore must be used on its own',
    )
    expect(firstMismatch({ $ignore: 'yes' }, 'x').message).toContain('"$ignore" must be true')
  })
})

describe('$literal', () => {
  it('matches matcher-looking data as plain data', () => {
    const schemaDoc = { $ref: '#/$defs/user', $defs: { user: { type: 'object' } } }
    expect(matches({ inputSchema: { $literal: schemaDoc } }, { inputSchema: schemaDoc })).toBe(true)
    expect(matches({ $literal: { $type: 'Acme.Widget' } }, { $type: 'Acme.Widget' })).toBe(true)
    expect(matches({ $literal: { $type: 'string' } }, 'x')).toBe(false)
  })

  it('keeps inherited partial mode', () => {
    const actual = { x: { $regex: 'a', flags: 'i' } }
    expect(matches({ $partial: true, x: { $literal: { $regex: 'a' } } }, actual)).toBe(true)
    expect(matches({ x: { $literal: { $regex: 'a' } } }, actual)).toBe(false)
  })

  it('must stand alone', () => {
    expect(firstMismatch({ $literal: 1, $any: true }, 1).message).toContain('invalid matcher')
  })
})

describe('$ref at match time', () => {
  it('reports unresolved refs instead of reading files', () => {
    const m = firstMismatch({ user: { $ref: './shared/user.json' } }, { user: {} })
    expect(m.path).toBe('user')
    expect(m.message).toContain('unresolved $ref "./shared/user.json"')
    expect(m.message).toContain('resolveRefs')
  })
})

describe('directive precedence', () => {
  it('reports plain keys next to a directive as an invalid matcher', () => {
    const m = firstMismatch({ text: { $regex: '^a', note: 'why' } }, { text: 'abc' })
    expect(m.path).toBe('text')
    expect(m.message).toContain('invalid matcher')
    expect(m.message).toContain('"note" cannot sit next to $regex')
  })

  it('rejects options that belong to another directive', () => {
    expect(firstMismatch({ $wildcard: 'a*', flags: 'i' }, 'abc').message).toContain(
      '"flags" cannot sit next to $wildcard',
    )
    expect(firstMismatch({ $partial: true, $type: 'object' }, {}).message).toContain(
      '"$partial" cannot be used with $type',
    )
  })

  it('reports invalid matchers even when the key is missing', () => {
    const m = firstMismatch({ a: { $type: 'strnig' } }, {})
    expect(m.path).toBe('a')
    expect(m.message).toContain('invalid matcher')
  })

  it('ANDs several directives and stops at the first failure', () => {
    const expected = { $type: 'array', $length: { min: 1 }, $contains: 'x' }
    expect(matches(expected, ['a', 'x'])).toBe(true)
    const result = matchValue(expected, 'x')
    expect(result).toHaveLength(1)
    expect(result[0].message).toContain('expected type array')
    expect(firstMismatch(expected, []).message).toContain('length >= 1')
    expect(firstMismatch(expected, ['a']).message).toContain('none of 1 element matched')
  })

  it('composes deeply: $partial + $contains + $oneOf of $regex/$wildcard', () => {
    const expected: JsonValue = {
      $partial: true,
      content: {
        $contains: {
          type: 'text',
          text: { $oneOf: [{ $regex: '^Error' }, { $wildcard: '*failed*' }] },
        },
      },
    }
    const failed = { content: [{ type: 'text', text: 'job failed: x' }], isError: true }
    expect(matches(expected, failed)).toBe(true)
    expect(matches(expected, { content: [{ type: 'text', text: 'all good' }] })).toBe(false)
  })
})

describe('lintExpectation', () => {
  it('returns nothing for a well-formed expectation', () => {
    expect(
      lintExpectation({
        $partial: true,
        content: [{ type: 'text', text: { $regex: '^a', flags: 'i' } }],
        n: { $number: { gte: 0 } },
        s: { $schema: { type: 'string' } },
        r: { $ref: './shared/x.json' },
      }),
    ).toEqual([])
  })

  it('finds problems that matching would never reach', () => {
    const issues = lintExpectation({
      a: { $oneOf: [1, { $type: 'nope' }] },
      b: { $regex: '(' },
      c: { $schema: { $ref: '#/nowhere' } },
      d: { $unordered: true, value: [{ $length: -2 }] },
      e: { $contains: { $any: false } },
      f: { $partial: 'yes' },
    })
    expect(issues.map((i) => i.path)).toEqual([
      'a.$oneOf[1]',
      'b',
      'c',
      'd.value[0]',
      'e.$contains',
      'f',
    ])
    expect(issues[1].message).toContain('invalid $regex pattern')
  })

  it('does not look inside $literal', () => {
    expect(lintExpectation({ $literal: { $type: 'whatever' } })).toEqual([])
  })
})

describe('escapeDirectives', () => {
  it('wraps objects that would be read as matchers', () => {
    const inputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/a',
    }
    const data: JsonValue = {
      name: 'x',
      inputSchema,
      items: [{ $type: 'Acme.Widget' }, { plain: true }],
    }
    const escaped = escapeDirectives(data)
    expect(escaped).toEqual({
      name: 'x',
      inputSchema: { $literal: inputSchema },
      items: [{ $literal: { $type: 'Acme.Widget' } }, { plain: true }],
    })
    expect(matches(escaped, data)).toBe(true)
  })

  it('leaves plain data alone', () => {
    const data = { a: [1, { b: 'c' }], $schema: 'https://json-schema.org/draft/2020-12/schema' }
    expect(escapeDirectives(data)).toEqual(data)
  })
})

describe('resolveRefs', () => {
  function loaderFrom(files: Record<string, JsonValue>) {
    const calls: string[] = []
    const loader = (rel: string): JsonValue => {
      calls.push(rel)
      if (!(rel in files)) throw new Error(`ENOENT: no such file '${rel}'`)
      return files[rel]
    }
    return { loader, calls }
  }

  it('inlines fragments anywhere in the tree', () => {
    const { loader } = loaderFrom({
      'shared/user.json': { $partial: true, id: { $type: 'integer' } },
    })
    const resolved = resolveRefs(
      {
        users: [{ $ref: './shared/user.json' }],
        one: { $oneOf: [{ $ref: './shared/user.json' }] },
      },
      loader,
    )
    expect(resolved).toEqual({
      users: [{ $partial: true, id: { $type: 'integer' } }],
      one: { $oneOf: [{ $partial: true, id: { $type: 'integer' } }] },
    })
    expect(matches(resolved, { users: [{ id: 1, name: 'a' }], one: { id: 2 } })).toBe(true)
  })

  it('resolves nested refs relative to the fragment that contains them', () => {
    const { loader, calls } = loaderFrom({
      'shared/user.json': {
        address: { $ref: './address.json' },
        team: { $ref: '../teams/core.json' },
      },
      'shared/address.json': { city: { $type: 'string' } },
      'teams/core.json': 'core',
    })
    const resolved = resolveRefs({ $ref: 'shared/user.json' }, loader)
    expect(resolved).toEqual({ address: { city: { $type: 'string' } }, team: 'core' })
    expect(calls).toEqual(['shared/user.json', 'shared/address.json', 'teams/core.json'])
  })

  it('normalizes Windows separators', () => {
    const { loader, calls } = loaderFrom({ 'shared/x.json': 1 })
    expect(resolveRefs({ $ref: '.\\shared\\x.json' }, loader)).toBe(1)
    expect(calls).toEqual(['shared/x.json'])
  })

  it('supports JSON pointers into a fragment file and same-file refs inside fragments', () => {
    const { loader } = loaderFrom({
      'shapes.json': { user: { id: { $ref: '#/id' } }, id: { $type: 'integer' } },
    })
    expect(resolveRefs({ $ref: './shapes.json#/user' }, loader)).toEqual({
      id: { $type: 'integer' },
    })
  })

  it('loads each file once', () => {
    const { loader, calls } = loaderFrom({ 'a.json': 1 })
    resolveRefs([{ $ref: './a.json' }, { $ref: 'a.json' }, { $ref: './x/../a.json' }], loader)
    expect(calls).toEqual(['a.json'])
  })

  it('detects cycles with a readable chain', () => {
    const { loader } = loaderFrom({
      'a.json': { next: { $ref: './b.json' } },
      'b.json': { next: { $ref: './a.json' } },
    })
    let error: unknown
    try {
      resolveRefs({ start: { $ref: './a.json' } }, loader)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(RefResolutionError)
    const refError = error as RefResolutionError
    expect(refError.message).toContain('$ref cycle at start.next.next: a.json -> b.json -> a.json')
    expect(refError.chain).toEqual(['a.json', 'b.json'])
    expect(refError.ref).toBe('./a.json')
    expect(refError.path).toBe('start.next.next')
  })

  it('detects a fragment that refers to itself', () => {
    const { loader } = loaderFrom({ 'self.json': { again: { $ref: './self.json' } } })
    expect(() => resolveRefs({ $ref: './self.json' }, loader)).toThrow(/cycle/)
  })

  it('allows the same fragment twice in sibling positions (not a cycle)', () => {
    const { loader } = loaderFrom({ 'a.json': { $ref: './b.json' }, 'b.json': 'leaf' })
    expect(resolveRefs({ x: { $ref: './a.json' }, y: { $ref: './a.json' } }, loader)).toEqual({
      x: 'leaf',
      y: 'leaf',
    })
  })

  it('wraps loader failures with the ref and location', () => {
    const { loader } = loaderFrom({})
    expect(() => resolveRefs({ content: [{ $ref: './missing.json' }] }, loader)).toThrow(
      /Cannot resolve \$ref "\.\/missing\.json" at content\[0\]: failed to load "missing\.json": ENOENT/,
    )
  })

  it('rejects malformed refs', () => {
    const { loader } = loaderFrom({ 'a.json': 1, 'b.json': { x: 1 } })
    expect(() => resolveRefs({ $ref: './a.json', $partial: true }, loader)).toThrow(
      /may only contain "\$ref"/,
    )
    expect(() => resolveRefs({ $ref: 5 }, loader)).toThrow(/must be a path string/)
    expect(() => resolveRefs({ $ref: '#/x' }, loader)).toThrow(/same-document refs/)
    expect(() => resolveRefs({ $ref: './b.json#/y' }, loader)).toThrow(/nothing at pointer "#\/y"/)
  })

  it('leaves $schema bodies and $literal values untouched', () => {
    const { loader, calls } = loaderFrom({})
    const expected = {
      a: { $schema: { $defs: { x: { type: 'string' } }, $ref: '#/$defs/x' } },
      b: { $literal: { $ref: './not-a-file.json' } },
    }
    expect(resolveRefs(expected, loader)).toEqual(expected)
    expect(calls).toEqual([])
  })

  it('does not mutate its input', () => {
    const { loader } = loaderFrom({ 'a.json': { v: 1 } })
    const expected = { x: { $ref: './a.json' } }
    const copy = structuredClone(expected)
    resolveRefs(expected, loader)
    expect(expected).toEqual(copy)
  })
})

describe('directive option validation', () => {
  it('rejects non-boolean $partial options and non-string flags', () => {
    expect(firstMismatch({ $contains: 1, $partial: 'no' }, [1]).message).toContain(
      '"$partial" on $contains must be true or false',
    )
    expect(firstMismatch({ $regex: 'a', flags: 1 }, 'a').message).toContain(
      '"flags" must be a string',
    )
  })

  it('reports $any against nothing at the root', () => {
    expect(firstMismatch({ $any: true }, undefined).message).toBe(
      'expected a value to be present ($any), got nothing',
    )
  })
})
