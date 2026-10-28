import { describe, expect, it } from 'vitest'
import { defaultNormalizeConfig, matchesGlob, normalizeResult } from '../src/normalize'
import type { JsonValue } from '../src/types'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const modernResult: JsonValue = {
  resultType: 'complete',
  content: [
    {
      type: 'text',
      text: 'hi',
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: 't1' } },
    },
  ],
  structuredContent: { echoed: 'hi' },
  _meta: {
    'io.modelcontextprotocol/serverInfo': { name: 'echo', version: '2.4.0' },
    'com.example/trace': 'abc',
  },
}

describe('defaults', () => {
  it('exposes the documented defaults', () => {
    expect(defaultNormalizeConfig).toEqual({
      stripMeta: ['io.modelcontextprotocol/*'],
      dropKeys: ['resultType'],
      ttlMs: 'ignore',
    })
    expect(Object.isFrozen(defaultNormalizeConfig)).toBe(true)
    expect(Object.isFrozen(defaultNormalizeConfig.stripMeta)).toBe(true)
  })

  it('strips protocol meta everywhere, drops resultType, keeps other meta', () => {
    expect(normalizeResult(modernResult, {})).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      structuredContent: { echoed: 'hi' },
      _meta: { 'com.example/trace': 'abc' },
    })
  })

  it('uses the defaults when no config is given', () => {
    expect(normalizeResult(modernResult)).toEqual(normalizeResult(modernResult, {}))
  })

  it('makes a 2026-era result equal to its 2025-era golden', () => {
    const legacy = { content: [{ type: 'text', text: 'hi' }], structuredContent: { echoed: 'hi' } }
    const modern = {
      ...legacy,
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'echo', version: '9.9.9' } },
    }
    expect(normalizeResult(modern, {})).toEqual(legacy)
  })
})

describe('stripMeta', () => {
  it('removes an emptied _meta object but keeps one that was already empty', () => {
    expect(normalizeResult({ a: 1, _meta: { 'io.modelcontextprotocol/x': 1 } }, {})).toEqual({
      a: 1,
    })
    expect(normalizeResult({ a: 1, _meta: {} }, {})).toEqual({ a: 1, _meta: {} })
  })

  it('reaches _meta inside arrays and nested objects', () => {
    const input: JsonValue = {
      tools: [
        { name: 'a', _meta: { 'io.modelcontextprotocol/ui': { x: 1 }, keep: true } },
        { name: 'b', nested: { deeper: { _meta: { 'io.modelcontextprotocol/y': 2 } } } },
      ],
    }
    expect(normalizeResult(input, {})).toEqual({
      tools: [
        { name: 'a', _meta: { keep: true } },
        { name: 'b', nested: { deeper: {} } },
      ],
    })
  })

  it('strips inside values of kept _meta keys too', () => {
    const input = { _meta: { keep: { _meta: { 'io.modelcontextprotocol/z': 1, ok: 2 } } } }
    expect(normalizeResult(input, {})).toEqual({ _meta: { keep: { _meta: { ok: 2 } } } })
  })

  it('only touches keys of _meta objects, not other keys that look similar', () => {
    const input = { structuredContent: { 'io.modelcontextprotocol/serverInfo': 'data' } }
    expect(normalizeResult(input, {})).toEqual(input)
  })

  it('ignores a non-object _meta', () => {
    expect(normalizeResult({ _meta: 'weird' }, {})).toEqual({ _meta: 'weird' })
  })

  it('supports custom patterns, multiple stars and exact names', () => {
    const input = {
      _meta: {
        'com.acme/trace-id': 1,
        'com.acme/span': 2,
        'org.other/trace-id': 3,
        exact: 4,
        'io.modelcontextprotocol/serverInfo': 5,
      },
    }
    expect(normalizeResult(input, { stripMeta: ['*/trace-*', 'exact'] })).toEqual({
      _meta: { 'com.acme/span': 2, 'io.modelcontextprotocol/serverInfo': 5 },
    })
  })

  it('can be disabled with an empty list', () => {
    const input = { _meta: { 'io.modelcontextprotocol/serverInfo': 1 } }
    expect(normalizeResult(input, { stripMeta: [] })).toEqual(input)
  })
})

describe('matchesGlob', () => {
  it('treats * as any run of characters, including / and nothing', () => {
    expect(matchesGlob('io.modelcontextprotocol/*', 'io.modelcontextprotocol/serverInfo')).toBe(
      true,
    )
    expect(matchesGlob('io.modelcontextprotocol/*', 'io.modelcontextprotocol/a/b')).toBe(true)
    expect(matchesGlob('io.modelcontextprotocol/*', 'io.modelcontextprotocol/')).toBe(true)
    expect(matchesGlob('*', '')).toBe(true)
  })

  it('anchors the whole key', () => {
    expect(matchesGlob('trace', 'trace-id')).toBe(false)
    expect(matchesGlob('trace*', 'x-trace')).toBe(false)
  })

  it('treats other characters, including regex metacharacters and ?, literally', () => {
    expect(matchesGlob('io.x/*', 'ioAx/y')).toBe(false)
    expect(matchesGlob('a?b', 'axb')).toBe(false)
    expect(matchesGlob('a?b', 'a?b')).toBe(true)
    expect(matchesGlob('(x)+[y]', '(x)+[y]')).toBe(true)
    expect(matchesGlob('^$', '^$')).toBe(true)
  })
})

describe('dropKeys and ttlMs', () => {
  const listResult = {
    tools: [{ name: 'echo' }],
    ttlMs: 60000,
    cacheScope: 'session',
    resultType: 'complete',
  }

  it('removes ttlMs and cacheScope at the top level by default', () => {
    expect(normalizeResult(listResult, {})).toEqual({ tools: [{ name: 'echo' }] })
  })

  it('keeps them with ttlMs: keep', () => {
    expect(normalizeResult(listResult, { ttlMs: 'keep' })).toEqual({
      tools: [{ name: 'echo' }],
      ttlMs: 60000,
      cacheScope: 'session',
    })
  })

  it('only drops top-level keys', () => {
    const input = { structuredContent: { resultType: 'mine', ttlMs: 5 }, resultType: 'complete' }
    expect(normalizeResult(input, {})).toEqual({
      structuredContent: { resultType: 'mine', ttlMs: 5 },
    })
  })

  it('supports custom dropKeys and can disable them', () => {
    expect(normalizeResult({ a: 1, b: 2, resultType: 'x' }, { dropKeys: ['b'] })).toEqual({
      a: 1,
      resultType: 'x',
    })
    expect(normalizeResult({ resultType: 'x' }, { dropKeys: [], ttlMs: 'keep' })).toEqual({
      resultType: 'x',
    })
  })

  it('leaves non-object results alone apart from meta stripping', () => {
    expect(normalizeResult(null, {})).toBeNull()
    expect(normalizeResult('text', {})).toBe('text')
    expect(
      normalizeResult([{ resultType: 'x', _meta: { 'io.modelcontextprotocol/a': 1 } }], {}),
    ).toEqual([{ resultType: 'x' }])
  })
})

describe('purity', () => {
  it('never mutates its input', () => {
    const input = deepFreeze(structuredClone(modernResult))
    expect(() => normalizeResult(input, {})).not.toThrow()
    expect(input).toEqual(modernResult)
  })

  it('is idempotent', () => {
    const samples: JsonValue[] = [
      modernResult,
      { _meta: {}, a: [{ _meta: { 'io.modelcontextprotocol/a': 1, b: { _meta: {} } } }] },
      { ttlMs: 1, cacheScope: 'x', tools: [] },
      [1, 'two', null],
    ]
    const configs = [{}, { stripMeta: ['*'] }, { ttlMs: 'keep' as const, dropKeys: ['tools'] }]
    for (const sample of samples) {
      for (const cfg of configs) {
        const once = normalizeResult(sample, cfg)
        expect(normalizeResult(once, cfg)).toEqual(once)
      }
    }
  })

  it('returns new objects rather than aliasing the input', () => {
    const input = { a: { b: 1 }, resultType: 'x' }
    const out = normalizeResult(input, {}) as { a: { b: number } }
    expect(out.a).toEqual(input.a)
    expect(out.a).not.toBe(input.a)
  })
})
