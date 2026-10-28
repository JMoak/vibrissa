import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SchemaCompileError,
  appendIndex,
  appendKey,
  compileSchema,
  formatInstancePath,
  isValidSchema,
  validate,
} from '../src/schema'
import type { JsonValue } from '../src/types'

afterEach(() => {
  vi.restoreAllMocks()
})

const contentSchema = {
  type: 'object',
  required: ['content'],
  properties: {
    content: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'text'],
        properties: { type: { const: 'text' }, text: { type: 'string' } },
      },
    },
  },
}

describe('validate', () => {
  it('accepts valid values', () => {
    expect(validate(contentSchema, { content: [{ type: 'text', text: 'hi' }] })).toEqual({
      ok: true,
      errors: [],
    })
  })

  it('reports errors in matcher path format', () => {
    const result = validate(contentSchema, { content: [{ type: 'text', text: 42 }] })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: 'content[0].text',
        message: 'must be string, got integer',
        keyword: 'type',
      }),
    ])
    expect(result.errors[0].schemaPath).toContain('properties/text/type')
  })

  it('collects all errors and uses readable messages', () => {
    const schema = {
      type: 'object',
      required: ['id'],
      properties: {
        kind: { enum: ['a', 'b'] },
        email: { type: 'string', format: 'email' },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
      additionalProperties: false,
    }
    const result = validate(schema, { kind: 'c', email: 'nope', code: 'abc', extra: 1 })
    const messages = result.errors.map((e) => `${e.path || '(root)'} ${e.message}`)
    expect(messages).toEqual(
      expect.arrayContaining([
        '(root) must have required property "id"',
        '(root) must NOT have additional property "extra"',
        'kind must be one of ["a","b"], got "c"',
        'email must match format "email", got "nope"',
        'code must match pattern /^[A-Z]{3}$/, got "abc"',
      ]),
    )
  })

  it('distinguishes numeric object keys from array indices and quotes odd keys', () => {
    const schema = {
      type: 'object',
      properties: {
        byId: { type: 'object', additionalProperties: { type: 'string' } },
        _meta: { type: 'object', additionalProperties: { type: 'number' } },
      },
    }
    const result = validate(schema, { byId: { '7': 1 }, _meta: { 'io.x/y': 'z' } })
    expect(result.errors.map((e) => e.path).sort()).toEqual(['_meta["io.x/y"]', 'byId["7"]'])
  })

  it('never throws for unusable schemas; reports schemaError instead', () => {
    const result = validate({ type: 'nonsense' }, 1)
    expect(result.ok).toBe(false)
    expect(result.schemaError).toContain('schema is invalid')
    expect(result.errors[0].message).toContain('invalid schema')
    expect(validate('not a schema' as JsonValue, 1).schemaError).toContain(
      'must be an object or a boolean',
    )
  })

  it('handles boolean schemas', () => {
    expect(validate(true, { anything: 1 }).ok).toBe(true)
    const result = validate(false, 1)
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('schema is false')
  })
})

describe('$ref resolution', () => {
  it('resolves #/$defs refs within the document', () => {
    const schema = {
      $defs: { positive: { type: 'integer', minimum: 1 } },
      type: 'object',
      properties: { count: { $ref: '#/$defs/positive' } },
    }
    expect(validate(schema, { count: 3 }).ok).toBe(true)
    expect(validate(schema, { count: 0 }).errors[0]).toMatchObject({
      path: 'count',
      keyword: 'minimum',
    })
  })

  it('supports recursive schemas', () => {
    const schema = {
      $id: 'https://example.com/tree',
      type: 'object',
      properties: { value: { type: 'number' }, children: { type: 'array', items: { $ref: '#' } } },
    }
    const tree = { value: 1, children: [{ value: 2, children: [{ value: 'x' }] }] }
    expect(validate(schema, tree).errors[0].path).toBe('children[0].children[0].value')
  })

  it('reports unresolvable refs with a hint', () => {
    const result = validate({ $ref: '#/$defs/nope' }, 1)
    expect(result.schemaError).toContain('cannot resolve $ref')
    expect(result.schemaError).toContain('$defs')
  })

  it('loads external refs through the resolve hook, including nested ones', () => {
    const files: Record<string, JsonValue> = {
      'user.json': {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' }, address: { $ref: 'address.json' } },
      },
      'address.json': { type: 'object', required: ['city'] },
    }
    const seen: string[] = []
    const resolve = (ref: string) => {
      seen.push(ref)
      return files[ref]
    }
    const schema = { type: 'array', items: { $ref: './user.json' } }
    expect(validate(schema, [{ id: 1, address: { city: 'x' } }], { resolve }).ok).toBe(true)
    const bad = validate(schema, [{ id: 1, address: {} }], { resolve })
    expect(bad.errors[0]).toMatchObject({ path: '[0].address', keyword: 'required' })
    expect(seen).toEqual(['user.json', 'address.json'])
  })

  it('reports external refs the hook cannot find', () => {
    const result = validate({ $ref: 'missing.json' }, 1, { resolve: () => undefined })
    expect(result.schemaError).toContain('cannot resolve external $ref "missing.json"')
    const throwing = validate({ $ref: 'boom.json' }, 1, {
      resolve: () => {
        throw new Error('disk on fire')
      },
    })
    expect(throwing.schemaError).toContain('disk on fire')
  })

  it('compiles different schemas that reuse the same $id', () => {
    const a = { $id: 'https://example.com/shape', type: 'string' }
    const b = { $id: 'https://example.com/shape', type: 'number' }
    expect(validate(a, 'x').ok).toBe(true)
    expect(validate(b, 1).ok).toBe(true)
    expect(validate(b, 'x').ok).toBe(false)
  })
})

describe('tolerance', () => {
  it('ignores unknown keywords and unknown formats without logging', () => {
    const warn = vi.spyOn(console, 'warn')
    const log = vi.spyOn(console, 'log')
    const schema = { type: 'string', format: 'x-vendor-format', 'x-ui': { widget: 'big' } }
    expect(validate(schema, 'anything').ok).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('allows union types', () => {
    expect(validate({ type: ['string', 'null'], minLength: 2 }, null).ok).toBe(true)
    expect(validate({ type: ['string', 'null'], minLength: 2 }, 'a').ok).toBe(false)
  })

  it('validates standard formats', () => {
    expect(validate({ type: 'string', format: 'date-time' }, '2026-10-28T10:00:00Z').ok).toBe(true)
    expect(validate({ type: 'string', format: 'date-time' }, 'yesterday').ok).toBe(false)
    expect(validate({ type: 'string', format: 'uri' }, 'https://example.com').ok).toBe(true)
  })

  it('supports 2020-12 features such as prefixItems and unevaluatedProperties', () => {
    const schema = {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
    }
    expect(validate(schema, ['a', 1]).ok).toBe(true)
    expect(validate(schema, ['a', 1, true]).ok).toBe(false)
    const closed = {
      type: 'object',
      allOf: [{ properties: { a: { type: 'number' } } }],
      unevaluatedProperties: false,
    }
    expect(validate(closed, { a: 1, b: 2 }).errors[0].message).toBe(
      'must NOT have unevaluated property "b"',
    )
  })

  it('validates draft-07 schemas (e.g. zod-to-json-schema output) as draft-07', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      definitions: { id: { type: 'integer' } },
      properties: { id: { $ref: '#/definitions/id' }, pair: { items: [{ type: 'string' }] } },
      additionalProperties: false,
    }
    expect(validate(schema, { id: 1, pair: ['a', 2] }).ok).toBe(true)
    expect(validate(schema, { id: 'x' }).errors[0].path).toBe('id')
    expect(validate(schema, { pair: [1] }).errors[0].path).toBe('pair[0]')
  })

  it('handles 2019-09, older drafts and unknown dialects', () => {
    const s2019 = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'string' }
    expect(validate(s2019, 'x').ok).toBe(true)
    const draft04 = { $schema: 'http://json-schema.org/draft-04/schema#', type: 'number' }
    expect(validate(draft04, 'x').ok).toBe(false)
    expect(validate(draft04, 1).ok).toBe(true)
    const custom = { $schema: 'https://example.com/my-meta', type: 'boolean' }
    expect(validate(custom, true).ok).toBe(true)
    expect(validate(custom, 1).ok).toBe(false)
  })
})

describe('compileSchema', () => {
  it('caches by schema identity', () => {
    const schema = { type: 'string' }
    expect(compileSchema(schema)).toBe(compileSchema(schema))
    expect(compileSchema({ type: 'string' })).not.toBe(compileSchema(schema))
  })

  it('caches per resolver when a resolve hook is given', () => {
    const schema = { $ref: 'x.json' }
    const resolve = () => ({ type: 'string' })
    expect(compileSchema(schema, { resolve })).toBe(compileSchema(schema, { resolve }))
    expect(compileSchema(schema, { resolve })('a').ok).toBe(true)
  })

  it('returns a reusable validator', () => {
    const check = compileSchema({ type: 'integer' })
    expect(check(1).ok).toBe(true)
    expect(check('1').errors[0].message).toBe('must be integer, got string')
  })

  it('throws SchemaCompileError for unusable schemas', () => {
    expect(() => compileSchema({ $ref: '#/nope' })).toThrow(SchemaCompileError)
    expect(() => compileSchema(42)).toThrow(/must be an object or a boolean/)
  })
})

describe('isValidSchema', () => {
  it('accepts valid schemas', () => {
    expect(isValidSchema(contentSchema)).toEqual({ ok: true, errors: [] })
    expect(isValidSchema(true)).toEqual({ ok: true, errors: [] })
  })

  it('reports meta-schema violations with paths into the schema', () => {
    const result = isValidSchema({ type: 'object', properties: { a: { type: 'strnig' } } })
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.path)).toContain('properties.a.type')
  })

  it('reports wrong keyword value types', () => {
    const result = isValidSchema({ type: 'string', minLength: 'three' })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ path: 'minLength' })
  })

  it('reports unresolvable refs', () => {
    const result = isValidSchema({ properties: { a: { $ref: '#/$defs/missing' } } })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('cannot resolve $ref')
  })

  it('checks external refs through the resolve hook', () => {
    expect(isValidSchema({ $ref: 'a.json' }, { resolve: () => ({ type: 'string' }) }).ok).toBe(true)
    expect(isValidSchema({ $ref: 'a.json' }, { resolve: () => undefined }).ok).toBe(false)
  })

  it('rejects values that are not schemas', () => {
    expect(isValidSchema([] as JsonValue).errors[0].message).toContain(
      'must be an object or a boolean, got array',
    )
  })

  it('tolerates unknown keywords', () => {
    expect(isValidSchema({ type: 'string', 'x-extra': true }).ok).toBe(true)
  })
})

describe('path helpers', () => {
  it('formats JSON pointers as matcher paths', () => {
    expect(formatInstancePath('')).toBe('')
    expect(formatInstancePath('/content/0/text')).toBe('content[0].text')
    expect(formatInstancePath('/a~1b/c~0d')).toBe('["a/b"]["c~d"]')
    expect(formatInstancePath('/0', { '0': 1 })).toBe('["0"]')
    expect(formatInstancePath('/0', [1])).toBe('[0]')
  })

  it('builds paths the same way the matcher does', () => {
    expect(appendKey('', 'content')).toBe('content')
    expect(appendKey('a', 'b-c')).toBe('a.b-c')
    expect(appendKey('a', '$oneOf')).toBe('a.$oneOf')
    expect(appendKey('a', 'with space')).toBe('a["with space"]')
    expect(appendKey('', '')).toBe('[""]')
    expect(appendIndex('content', 2)).toBe('content[2]')
  })
})

describe('nested $id reuse', () => {
  it('compiles schemas whose embedded $defs share an $id', () => {
    const a = {
      $defs: { x: { $id: 'https://example.com/x', type: 'string' } },
      $ref: 'https://example.com/x',
    }
    const b = {
      $defs: { x: { $id: 'https://example.com/x', type: 'number' } },
      $ref: 'https://example.com/x',
    }
    expect(validate(a, 'x').ok).toBe(true)
    expect(validate(b, 1).ok).toBe(true)
    expect(validate(b, 'x').ok).toBe(false)
  })
})
