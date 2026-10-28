import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  InterpolationError,
  type LoadedCase,
  caseAsStep,
  caseIdFor,
  filterCases,
  getPath,
  interpolate,
  loadCaseFile,
  loadCases,
  loadCasesSync,
  parsePath,
  planSteps,
  shardCases,
  validateCaseShape,
} from '../src/cases'

const FIXTURE = path.join(process.cwd(), 'tests/fixtures/echo-server')

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-cases-'))
}

function write(dir: string, rel: string, data: unknown): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return file
}

function load(
  dir: string,
  rel: string,
  data: unknown,
  opts: Partial<Parameters<typeof loadCaseFile>[1]> = {},
): LoadedCase {
  return loadCaseFile(write(dir, rel, data), { rootDir: dir, ...opts })
}

describe('loadCases', () => {
  it('loads the fixture suite with root-relative ids, sorted, line 1', async () => {
    const { cases, matched, warnings } = await loadCases({
      rootDir: FIXTURE,
      globs: ['cases/**/*.json', '!cases/**/*.fail.json'],
      defaultServer: 'echo',
      servers: ['echo'],
    })
    expect(matched).toBe(cases.length)
    expect(warnings).toEqual([])
    const ids = cases.map((c) => c.ref.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toContain('cases/echo.basic.json')
    expect(ids.some((id) => id.endsWith('.fail.json'))).toBe(false)
    for (const c of cases) {
      expect(c.error, c.ref.id).toBeUndefined()
      expect(c.ref.line).toBe(1)
      expect(c.ref.server).toBe('echo')
      expect(c.ref.file).toBe(c.ref.id)
    }
    const flow = cases.find((c) => c.ref.id === 'cases/flow.capture.json')
    expect(flow?.ref.tags).toEqual(['flow', 'smoke'])
    expect(flow?.ref.name).toBe('flow: capture a value and reuse it')
    const skipped = cases.find((c) => c.ref.id === 'cases/skip.example.json')
    expect(skipped?.skip).toBe('the fixture has no streaming tool yet')
  })

  it('has a synchronous twin with the same result', async () => {
    const opts = { rootDir: FIXTURE, globs: ['cases/*.json'], defaultServer: 'echo' }
    const asyncIds = (await loadCases(opts)).cases.map((c) => c.ref.id)
    expect(loadCasesSync(opts).cases.map((c) => c.ref.id)).toEqual(asyncIds)
  })

  it('expands $ref fragments relative to the case file', async () => {
    const { cases } = await loadCases({
      rootDir: FIXTURE,
      globs: ['cases/resource-template.user.json'],
    })
    expect(cases[0].data?.expect).toEqual({
      contents: [
        {
          $partial: true,
          mimeType: 'application/json',
          text: { $regex: '^\\{"id":"\\d+","name":"user-\\d+"\\}$' },
        },
      ],
    })
    // The source keeps the $ref (that is what --update would rewrite).
    expect(cases[0].source?.expect).toEqual({
      contents: [{ $ref: '../shared/user-json-content.json' }],
    })
  })

  it('reports broken files as load errors instead of throwing', async () => {
    const dir = mkTmpDir()
    write(dir, 'cases/a-broken.json', '{ not json')
    write(dir, 'cases/b-ok.json', { tool: 'echo', args: { text: 'x' } })
    const { cases } = await loadCases({ rootDir: dir, globs: ['cases/*.json'] })
    expect(cases.map((c) => c.ref.id)).toEqual(['cases/a-broken.json', 'cases/b-ok.json'])
    expect(cases[0].error).toMatch(/^cases\/a-broken\.json: invalid JSON \(.+\)\. Fix the syntax/)
    expect(cases[1].error).toBeUndefined()
  })

  it('reads JSONC (comments and trailing commas)', () => {
    const dir = mkTmpDir()
    const loaded = load(
      dir,
      'c.jsonc',
      '// a comment\n{ "tool": "echo", /* inline */ "args": { "text": "x", }, }\n',
    )
    expect(loaded.error).toBeUndefined()
    expect(loaded.data).toMatchObject({ tool: 'echo', args: { text: 'x' } })
    expect(loaded.ref.name).toBe('c')
  })

  it('uses absolute posix ids for files outside rootDir', () => {
    const dir = mkTmpDir()
    const file = write(dir, 'x.json', { tool: 'echo' })
    expect(caseIdFor(file, FIXTURE)).toBe(path.resolve(file).replace(/\\/g, '/'))
    expect(caseIdFor(file, dir)).toBe('x.json')
  })

  it('skips $ref fragments matched by the globs (referenced, or in shared/ / fragments/)', async () => {
    const dir = mkTmpDir()
    write(dir, 'tests/integration/echo.json', {
      tool: 'echo',
      args: { text: 'x' },
      expect: { content: [{ $ref: './parts/text-block.json' }] },
    })
    write(dir, 'tests/integration/parts/text-block.json', { type: 'text', text: 'x' }) // referenced
    write(dir, 'tests/integration/shared/user.json', { $partial: true, id: { $type: 'string' } })
    write(dir, 'tests/integration/fragments/list.json', [{ a: 1 }])
    write(dir, 'tests/integration/stray.json', { name: 'forgot the tool' }) // still a load error
    const { cases, matched, fragments } = await loadCases({
      rootDir: dir,
      globs: ['tests/integration/**/*.json'],
    })
    expect(fragments).toEqual([
      'tests/integration/fragments/list.json',
      'tests/integration/parts/text-block.json',
      'tests/integration/shared/user.json',
    ])
    expect(cases.map((c) => [c.ref.id, c.error === undefined])).toEqual([
      ['tests/integration/echo.json', true],
      ['tests/integration/stray.json', false],
    ])
    expect(matched).toBe(2)
    // A real case living in shared/ is still a case (it has an operation).
    write(dir, 'tests/integration/shared/real.json', { tool: 'echo', args: { text: 'y' } })
    const again = loadCasesSync({ rootDir: dir, globs: ['tests/integration/**/*.json'] })
    expect(again.cases.map((c) => c.ref.id)).toContain('tests/integration/shared/real.json')
  })

  it('never loads manifest locks as cases, even when the globs match them', async () => {
    const dir = mkTmpDir()
    const lock = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tests/__manifest__.json'), 'utf8'))
    write(dir, 'tests/integration/__manifest__.json', lock)
    write(dir, 'tests/integration/__manifest__.staging.json', lock)
    write(dir, 'tests/integration/old-lock-copy.json', lock) // caught by shape, not by path
    write(dir, 'tests/integration/custom.lock.json', { not: 'a manifest' })
    write(dir, 'tests/integration/echo.json', { tool: 'echo', args: { text: 'x' } })
    const base = {
      rootDir: dir,
      globs: ['tests/integration/**/*.json'],
      defaultServer: 'local',
      servers: ['local', 'staging'],
    }
    const { cases, matched } = await loadCases(base)
    expect(cases.map((c) => c.ref.id)).toEqual([
      'tests/integration/custom.lock.json',
      'tests/integration/echo.json',
    ])
    expect(matched).toBe(2)
    expect(
      loadCasesSync({ ...base, exclude: ['tests/integration/custom.lock.json'] }).cases.map(
        (c) => c.ref.id,
      ),
    ).toEqual(['tests/integration/echo.json'])

    // A configured manifest path is excluded by path too (even if it no longer parses).
    write(dir, 'locks/main.json', '{ broken')
    const custom = await loadCases({
      ...base,
      globs: ['locks/*.json'],
      manifest: 'locks/main.json',
    })
    expect(custom.cases).toEqual([])
  })
})

describe('case validation', () => {
  const dir = mkTmpDir()

  it('suggests the right key for typos', () => {
    const loaded = load(dir, 'typo.json', { tool: 'echo', expcet: {} })
    expect(loaded.error).toBe('typo.json: "expcet" is not a case key. Did you mean "expect"?')
  })

  it('rejects cases without an operation and with two operations', () => {
    expect(load(dir, 'none.json', { name: 'x' }).error).toMatch(
      /^none\.json: no operation\. Add one of "tool", "resource", "resourceTemplate" or "prompt" \(or "steps" for a flow\)/,
    )
    expect(load(dir, 'two.json', { tool: 'echo', prompt: 'greet' }).error).toMatch(
      /"tool" and "prompt" are all set; a case runs exactly one operation\. Split it into "steps"/,
    )
  })

  it('validates nested steps with their location', () => {
    const loaded = load(dir, 'steps.json', {
      steps: [{ tool: 'echo' }, { tool: 42 }, { tool: 'echo', tags: ['x'] }],
    })
    expect(loaded.error).toContain('steps[1]: "tool" must be a non-empty string, got 42')
    expect(loaded.error).toContain(
      'steps[2]: "tags" is not allowed in a step; it only works at the case level.',
    )
    expect(load(dir, 'empty.json', { steps: [] }).error).toMatch(/"steps" is empty/)
  })

  it('rejects expect + expectError and malformed expectError', () => {
    expect(load(dir, 'both.json', { tool: 'echo', expect: {}, expectError: {} }).error).toMatch(
      /"expect" and "expectError" are both set/,
    )
    expect(load(dir, 'code.json', { tool: 'echo', expectError: { code: true } }).error).toMatch(
      /expectError: "code" must be a code name or number, got true/,
    )
  })

  it('rejects unknown $ matcher keys with a did-you-mean', () => {
    const typo = load(dir, 'partail.json', {
      tool: 'echo',
      expect: { $partail: true, content: [{ text: { $regx: 'a' } }] },
    })
    expect(typo.error).toContain(
      'expect at (root): "$partail" is not a matcher; did you mean "$partial"? Use {"$literal": ...} for data with a literal $-key',
    )
    expect(typo.error).toContain(
      'expect at content[0].text: "$regx" is not a matcher; did you mean "$regex"?',
    )
    // Data that really has $-keys is fine inside $literal; a string $schema is data.
    const literal = load(dir, 'literal.json', {
      tool: 'echo',
      expect: { schema: { $literal: { $id: 'x', $defs: {} } }, $schema: 'https://example.com/s' },
    })
    expect(literal.error).toBeUndefined()
  })

  it('rejects unknown expectError code names with a did-you-mean', () => {
    expect(
      load(dir, 'code1.json', { tool: 'echo', expectError: { code: 'InvalidParam' } }).error,
    ).toMatch(
      /expectError: "code" "InvalidParam" is not a known error code; did you mean "InvalidParams"\? Use the numeric JSON-RPC code/,
    )
    for (const code of ['InvalidParams', 'RequestTimedOut', 'ResourceNotFound', -32000]) {
      expect(load(dir, 'code2.json', { tool: 'echo', expectError: { code } }).error).toBeUndefined()
    }
  })

  it('lints matchers when the case loads', () => {
    const loaded = load(dir, 'regex.json', {
      tool: 'echo',
      expect: { content: [{ text: { $regex: '(' } }] },
    })
    expect(loaded.error).toMatch(
      /^regex\.json: expect at content\[0\]\.text: invalid \$regex pattern/,
    )
  })

  it('rejects unknown servers when the server list is known', () => {
    const loaded = load(dir, 'srv.json', { tool: 'echo', server: 'nope' }, { servers: ['echo'] })
    expect(loaded.error).toBe(
      'srv.json: unknown server "nope" (have: echo). Add it to "servers" in vibrissa.json, or fix "server".',
    )
    expect(loaded.ref.server).toBe('nope')
  })

  it('reports $ref failures with the expectation path', () => {
    const loaded = load(dir, 'ref.json', {
      tool: 'echo',
      expect: { content: { $ref: './missing.json' } },
    })
    expect(loaded.error).toMatch(
      /^ref\.json: expect: Cannot resolve \$ref "\.\/missing\.json" at content/,
    )
  })

  it('checks {{placeholders}} against earlier captures, env, and suite hooks', () => {
    const never = load(dir, 'never.json', {
      steps: [
        { tool: 'echo', args: { text: '{{sid}}' } },
        { tool: 'echo', capture: { sid: 'x' } },
      ],
    })
    expect(never.error).toMatch(
      /steps\[0\]\.args\.text: \{\{sid\}\} is never captured before this step/,
    )
    const env = load(
      dir,
      'env.json',
      { tool: 'echo', args: { text: '{{env.VIBRISSA_NOPE_X}}' } },
      { env: {} },
    )
    expect(env.error).toMatch(/environment variable VIBRISSA_NOPE_X, which is not set/)
    const teardown = load(dir, 'teardown.json', {
      steps: [{ tool: 'echo', capture: { sid: 'content[0].text' } }],
      teardown: [{ tool: 'echo', args: { text: '{{sid}}' } }],
    })
    expect(teardown.error).toBeUndefined()
    const hooked = load(
      dir,
      'hooked.json',
      { tool: 'echo', args: { text: '{{token}}' } },
      { hooks: { setup: [{ tool: 'echo', capture: { token: 'content[0].text' } }] } },
    )
    expect(hooked.error).toBeUndefined()
  })

  it('warns when a flow also has top-level operation fields', () => {
    const { problems, warnings } = validateCaseShape({ tool: 'echo', steps: [{ tool: 'echo' }] })
    expect(problems).toEqual([])
    expect(warnings).toEqual([
      'top-level "tool" is ignored because "steps" is present; move it into a step',
    ])
  })

  it('accepts every fixture case (including .fail ones)', () => {
    for (const file of fs.readdirSync(path.join(FIXTURE, 'cases'))) {
      const loaded = loadCaseFile(path.join(FIXTURE, 'cases', file), { rootDir: FIXTURE })
      expect({ file, error: loaded.error }).toEqual({ file, error: undefined })
    }
  })
})

describe('filters', () => {
  function fake(id: string, tags: string[] = [], name = id): LoadedCase {
    return {
      ref: { id, name, file: id, tags, server: 'default', line: 1 },
      path: id,
      data: { tool: 'echo' },
      source: { tool: 'echo' },
    }
  }
  const cases = [
    fake('cases/c.json', ['smoke']),
    fake('cases/a.json', ['smoke', 'slow']),
    fake('cases/b.json', [], 'beta case'),
    fake('cases/d.json', ['slow']),
  ]

  it('sorts by id and filters by tag / exclude-tag / grep', () => {
    expect(filterCases(cases, {}).map((c) => c.ref.id)).toEqual([
      'cases/a.json',
      'cases/b.json',
      'cases/c.json',
      'cases/d.json',
    ])
    expect(filterCases(cases, { tags: ['smoke'] }).map((c) => c.ref.id)).toEqual([
      'cases/a.json',
      'cases/c.json',
    ])
    expect(
      filterCases(cases, { tags: ['smoke'], excludeTags: ['slow'] }).map((c) => c.ref.id),
    ).toEqual(['cases/c.json'])
    expect(filterCases(cases, { grep: 'BETA' }).map((c) => c.ref.id)).toEqual(['cases/b.json'])
    expect(filterCases(cases, { grep: '[cd]\\.json$' }).map((c) => c.ref.id)).toEqual([
      'cases/c.json',
      'cases/d.json',
    ])
    // An invalid regex falls back to a substring match.
    expect(filterCases([fake('cases/x(.json')], { grep: 'x(' })).toHaveLength(1)
  })

  it('keeps unparseable files regardless of tag filters', () => {
    const broken: LoadedCase = {
      ...fake('cases/z.json'),
      data: undefined,
      source: undefined,
      error: 'bad',
    }
    expect(filterCases([...cases, broken], { tags: ['smoke'] }).map((c) => c.ref.id)).toContain(
      'cases/z.json',
    )
  })

  it('shards stably: every case lands in exactly one shard', () => {
    const sorted = filterCases(cases, {})
    const shards = [1, 2, 3].map((index) =>
      filterCases(cases, { shard: { index, total: 3 } }).map((c) => c.ref.id),
    )
    expect(shards.flat().sort()).toEqual(sorted.map((c) => c.ref.id))
    expect(shards[0]).toEqual(['cases/a.json', 'cases/d.json'])
    expect(shardCases([1, 2, 3], { index: 2, total: 2 })).toEqual([2])
    expect(shardCases([1, 2, 3], undefined)).toEqual([1, 2, 3])
  })
})

describe('interpolation', () => {
  const scope = { vars: { sid: 'abc', n: 5, obj: { a: [1, 2] } }, env: { TOKEN: 't0k' } }

  it('replaces an exact placeholder with the raw JSON value', () => {
    expect(interpolate('{{n}}', scope)).toBe(5)
    expect(interpolate('{{ obj }}', scope)).toEqual({ a: [1, 2] })
    expect(interpolate({ id: '{{sid}}', list: ['{{n}}'] }, scope)).toEqual({ id: 'abc', list: [5] })
  })

  it('inlines values inside longer strings (non-strings as JSON)', () => {
    expect(interpolate('id={{sid}} n={{n}} o={{obj}}', scope)).toBe('id=abc n=5 o={"a":[1,2]}')
    expect(interpolate('Bearer {{env.TOKEN}}', scope)).toBe('Bearer t0k')
    expect(interpolate('no placeholders {single}', scope)).toBe('no placeholders {single}')
  })

  it('leaves keys alone and throws on unknown names with the location', () => {
    expect(interpolate({ '{{sid}}': 1 }, scope)).toEqual({ '{{sid}}': 1 })
    expect(() => interpolate({ args: { x: '{{nope}}' } }, scope, 'steps[1]')).toThrow(
      InterpolationError,
    )
    expect(() => interpolate({ x: '{{nope}}' }, scope, 'steps[1].args')).toThrow(
      /Interpolation failed at steps\[1\]\.args\.x: \{\{nope\}\} has no captured value \(captured so far: sid, n, obj\)/,
    )
    expect(() => interpolate('{{env.MISSING}}', scope)).toThrow(/MISSING, which is not set/)
  })
})

describe('paths and plans', () => {
  it('reads dotted paths with dots or brackets', () => {
    const value = { structuredContent: { items: [{ id: 'x' }] }, 'a.b': 1 }
    expect(parsePath('structuredContent.items[0].id')).toEqual([
      'structuredContent',
      'items',
      '0',
      'id',
    ])
    expect(getPath(value, 'structuredContent.items[0].id')).toBe('x')
    expect(getPath(value, 'structuredContent.items.0.id')).toBe('x')
    expect(getPath(value, 'structuredContent.missing')).toBeUndefined()
    expect(getPath(value, 'structuredContent.items.first')).toBeUndefined()
    expect(getPath(value, '')).toEqual(value)
  })

  it('plans setup → steps (or the op) → teardown', () => {
    const plan = planSteps({
      setup: [{ tool: 'a' }],
      steps: [{ tool: 'b' }, { tool: 'c' }],
      teardown: [{ tool: 'd' }],
    })
    expect(plan.map((p) => [p.phase, p.at, p.source])).toEqual([
      ['setup', 'setup[0]', ['setup', 0]],
      ['main', 'steps[0]', ['steps', 0]],
      ['main', 'steps[1]', ['steps', 1]],
      ['teardown', 'teardown[0]', ['teardown', 0]],
    ])
    const single = planSteps({ tool: 'echo', tags: ['x'], budgetMs: 5, expect: {} })
    expect(single).toHaveLength(1)
    expect(single[0].source).toEqual([])
    expect(caseAsStep({ tool: 'echo', tags: ['x'], budgetMs: 5, server: 's' })).toEqual({
      tool: 'echo',
    })
  })
})
