import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Manifest,
  ManifestFileError,
  buildManifest,
  captureManifest,
  diffManifest,
  formatDiff,
  manifestFrom,
  manifestPathFor,
  readManifest,
  summarizeDiff,
  writeManifest,
} from '../src/manifest'
import { McpSession } from '../src/session'
import type { JsonValue } from '../src/types'

const FIXTURE = path.join(process.cwd(), 'tests/fixtures/echo-server')
const SERVER = path.join(FIXTURE, 'server/index.js')
const LOCK = path.join(FIXTURE, 'tests/__manifest__.json')

function base(): Manifest {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/lint/clean-manifest.json'), 'utf8'),
  ) as Manifest
}

function clone(m: Manifest): Manifest {
  return structuredClone(m)
}

describe('diffManifest', () => {
  it('is identical for the same manifest, regardless of key order', () => {
    const a = base()
    const b = clone(a)
    const schema = b.tools[0].inputSchema as Record<string, unknown>
    b.tools[0].inputSchema = Object.fromEntries(Object.entries(schema).reverse()) as never
    b.tools.reverse()
    const diff = diffManifest(a, b)
    expect(diff.identical).toBe(true)
    expect(summarizeDiff(diff)).toBe('no changes')
    expect(formatDiff(diff)).toBe('Manifest: no changes.')
  })

  it('reports sub-path tool changes with a breaking flag and word-level prose diffs', () => {
    const a = base()
    const b = clone(a)
    const search = b.tools.find((t) => t.name === 'notes.search')
    if (!search) throw new Error('fixture changed')
    search.description = (search.description ?? '').replace('Full-text search', 'Fuzzy search')
    search.annotations = { readOnlyHint: false }
    search.title = 'Find'
    ;(search.inputSchema as { required?: string[] }).required = ['query', 'limit']
    const diff = diffManifest(a, b)
    expect(diff).toMatchObject({ identical: false, breaking: true })
    expect(diff.tools?.added).toBeUndefined()
    expect(diff.tools?.removed).toBeUndefined()
    expect(diff.resources).toBeUndefined()
    expect(diff.changes).toBeUndefined()
    const change = diff.tools?.changed?.[0]
    expect(change).toMatchObject({ key: 'notes.search', breaking: true })
    expect(change?.fields.map((f) => [f.path, f.breaking])).toEqual([
      ['annotations.openWorldHint', false],
      ['annotations.readOnlyHint', false],
      ['description', false],
      ['inputSchema.required', true],
      ['title', false],
    ])
    expect(change?.fields[3]).toEqual({
      path: 'inputSchema.required',
      before: ['query'],
      after: ['query', 'limit'],
      breaking: true,
    })
    expect(summarizeDiff(diff)).toBe(
      '1 tool changed (notes.search: annotations.openWorldHint, annotations.readOnlyHint, description, inputSchema.required, +1 more) (breaking)',
    )
    const text = formatDiff(diff)
    expect(text).toContain('  tools:\n    ~ notes.search')
    expect(text).toContain('description: [-Full-text-]{+Fuzzy+} search over notes.')
    expect(text).toContain('inputSchema.required: ["query"] -> ["query","limit"]  (breaking)')
    expect(text).not.toContain('resources:')
    expect(text).not.toContain('@@')
  })

  it('classifies breaking schema changes', () => {
    const breakingOf = (edit: (m: Manifest) => void) => {
      const a = base()
      const b = clone(a)
      edit(b)
      return diffManifest(a, b).breaking
    }
    const search = (m: Manifest) =>
      m.tools.find((t) => t.name === 'notes.search')?.inputSchema as {
        properties: Record<string, { type?: string; description?: string }>
        required: string[]
      }
    const props = (m: Manifest) => search(m).properties
    // removed property
    expect(
      breakingOf((m) => {
        const { cursor: _removed, ...rest } = props(m)
        search(m).properties = rest
      }),
    ).toBe(true)
    // type change
    expect(
      breakingOf((m) => {
        props(m).limit.type = 'number'
      }),
    ).toBe(true)
    expect(
      breakingOf((m) => {
        props(m).extra = { type: 'string' }
      }),
    ).toBe(false)
    expect(
      breakingOf((m) => {
        props(m).query.description = 'Terms.'
      }),
    ).toBe(false)
    // relaxed: nothing is required any more
    expect(
      breakingOf((m) => {
        search(m).required = []
      }),
    ).toBe(false)
    expect(
      breakingOf((m) => {
        m.tools[0].outputSchema = { type: 'object' }
      }),
    ).toBe(true)
    expect(
      breakingOf((m) => {
        m.prompts[0].arguments?.push({ name: 'lang', required: true })
      }),
    ).toBe(true)
    expect(
      breakingOf((m) => {
        m.tools[0].annotations = { readOnlyHint: true }
      }),
    ).toBe(false)
  })

  it('reports added / removed items in every section; removals are breaking', () => {
    const a = base()
    const b = clone(a)
    b.tools = b.tools.filter((t) => t.name !== 'notes.export')
    b.tools.push({ name: 'notes.purge', inputSchema: { type: 'object' } })
    b.prompts = []
    b.resources.push({ uri: 'notes://archive', name: 'archive' })
    const diff = diffManifest(a, b)
    expect(diff.tools).toEqual({ added: ['notes.purge'], removed: ['notes.export'] })
    expect(diff.prompts).toEqual({ removed: ['summarize'] })
    expect(diff.resources).toEqual({ added: ['notes://archive'] })
    expect(diff.resourceTemplates).toBeUndefined()
    expect(diff.breaking).toBe(true)
    expect(summarizeDiff(diff)).toBe(
      '1 tool added (notes.purge); 1 tool removed (notes.export); 1 resource added (notes://archive); 1 prompt removed (summarize) (breaking)',
    )
    expect(formatDiff(diff)).toContain(
      '    + notes.purge (added)\n    - notes.export (removed)  (breaking)',
    )
    const additive = clone(a)
    additive.tools.push({ name: 'notes.purge', inputSchema: { type: 'object' } })
    expect(diffManifest(a, additive).breaking).toBe(false)
  })

  it('ignores release / era noise by default (server.version, protocolVersion, listMeta)', () => {
    const a = base()
    const b = clone(a)
    b.server = { ...b.server, version: '9.9.9' }
    b.protocolVersion = '2025-11-25'
    b.listMeta = {}
    expect(diffManifest(a, b).identical).toBe(true)
    const strict = diffManifest(a, b, { ignore: [] })
    expect(strict.changes?.map((c) => [c.path, c.breaking])).toEqual([
      ['protocolVersion', true],
      ['server.version', false],
      ['listMeta.prompts', false],
      ['listMeta.resourceTemplates', false],
      ['listMeta.resources', false],
      ['listMeta.tools', false],
    ])
    const { completions: _dropped, ...caps } = b.capabilities as Record<string, JsonValue>
    b.capabilities = { ...caps, logging: {} }
    b.instructions = 'changed'
    const diff = diffManifest(a, b)
    expect(diff.changes).toEqual([
      expect.objectContaining({ path: 'instructions', breaking: false }),
      expect.objectContaining({ path: 'capabilities.completions', before: {}, breaking: true }),
      { path: 'capabilities.logging', after: {}, breaking: false },
    ])
    expect(summarizeDiff(diff)).toBe(
      'instructions, capabilities.completions, capabilities.logging changed (breaking)',
    )
  })

  it('honors ignore paths with wildcards and dotted item keys', () => {
    const a = base()
    const b = clone(a)
    for (const tool of b.tools) tool.annotations = { readOnlyHint: true }
    const search = b.tools.find((t) => t.name === 'notes.search')
    if (search) search.description = 'changed'
    expect(diffManifest(a, b, { ignore: ['tools.*.annotations'] }).tools?.changed).toEqual([
      expect.objectContaining({
        key: 'notes.search',
        fields: [expect.objectContaining({ path: 'description' })],
      }),
    ])
    expect(
      diffManifest(a, b, { ignore: ['tools.*.annotations', 'tools.notes.search.description'] })
        .identical,
    ).toBe(true)
    b.listMeta = {}
    expect(diffManifest(a, b, { ignore: ['tools', 'listMeta'] }).identical).toBe(true)
  })
})

describe('manifest files', () => {
  it('builds manifests with stable order and without per-version _meta', () => {
    const manifest = manifestFrom({
      protocolVersion: '2026-07-28',
      discover: {
        serverInfo: { name: 's', version: '1', title: 'ignored' },
        capabilities: { tools: {} },
      },
      tools: {
        items: [
          {
            inputSchema: { type: 'object' },
            description: 'b tool',
            name: 'b',
            _meta: { 'io.modelcontextprotocol/serverInfo': {}, keep: 1 },
          },
          { name: 'a', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ],
        ttlMs: 1000,
        cacheScope: 'public',
      },
    })
    expect(manifest.server).toEqual({ name: 's', version: '1' })
    expect(manifest.tools.map((t) => t.name)).toEqual(['a', 'b'])
    expect(Object.keys(manifest.tools[1])).toEqual(['name', 'description', 'inputSchema', '_meta'])
    expect(manifest.tools[1]._meta).toEqual({ keep: 1 })
    expect(manifest.listMeta).toEqual({ tools: { ttlMs: 1000, cacheScope: 'public' } })
    expect(manifest.resources).toEqual([])
  })

  it('derives lock paths per server', () => {
    const options = { manifest: 'tests/__manifest__.json', rootDir: FIXTURE, defaultServer: 'echo' }
    expect(manifestPathFor(options)).toBe(path.join(FIXTURE, 'tests/__manifest__.json'))
    expect(manifestPathFor(options, 'staging')).toBe(
      path.join(FIXTURE, 'tests/__manifest__.staging.json'),
    )
    expect(manifestPathFor({ rootDir: FIXTURE, defaultServer: 'x' })).toBe(
      path.join(FIXTURE, 'tests/integration/__manifest__.json'),
    )
  })

  it('reads, writes and rejects manifest files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-manifest-'))
    const file = path.join(dir, 'nested/__manifest__.json')
    writeManifest(file, base())
    expect(fs.readFileSync(file, 'utf8').endsWith('}\n')).toBe(true)
    expect(diffManifest(readManifest(file), base(), { ignore: [] }).identical).toBe(true)
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"tools": []}')
    expect(() => readManifest(path.join(dir, 'bad.json'))).toThrow(ManifestFileError)
    expect(() => readManifest(path.join(dir, 'bad.json'))).toThrow(
      /expected \{ "vibrissa": 2, "tools": \[\.\.\.\], \.\.\. \}, got an object with keys tools\. Re-create it with "vib manifest record"/,
    )
    fs.writeFileSync(path.join(dir, 'broken.json'), '{')
    expect(() => readManifest(path.join(dir, 'broken.json'))).toThrow(/^Invalid manifest at/)
  })
})

describe('live manifests (fixture server)', () => {
  let modern: McpSession
  let legacy: McpSession

  beforeAll(async () => {
    modern = await McpSession.start(
      { cmd: 'node', args: [SERVER], cwd: FIXTURE },
      { timeoutMs: 5000, stderr: 'ignore' },
    )
    legacy = await McpSession.start(
      { cmd: 'node', args: [SERVER], cwd: FIXTURE, protocol: 'legacy' },
      { timeoutMs: 5000, stderr: 'ignore' },
    )
  })

  afterAll(async () => {
    await modern?.close()
    await legacy?.close()
  })

  it('matches the committed lock exactly, and one lock serves both eras by default', async () => {
    const live = await buildManifest(modern)
    expect(live.protocolVersion).toBe('2026-07-28')
    expect(live.tools.map((t) => t.name)).toEqual([
      'confirm',
      'echo',
      'fail',
      'sleep',
      'slow',
      'typed',
    ])
    expect(live.listMeta.tools).toEqual({ ttlMs: 60000, cacheScope: 'public' })
    expect(diffManifest(readManifest(LOCK), live, { ignore: [] })).toMatchObject({
      identical: true,
    })

    const old = await buildManifest(legacy)
    expect(old.protocolVersion).not.toBe('2026-07-28')
    expect(diffManifest(readManifest(LOCK), old).identical).toBe(true)
    const strict = diffManifest(readManifest(LOCK), old, { ignore: [] })
    expect(strict.identical).toBe(false)
    expect(strict.changes?.map((c) => c.path)).toContain('protocolVersion')
    expect(strict.changes?.some((c) => c.path.startsWith('listMeta.'))).toBe(true)
  })

  it('collects tools/list samples for the stability check', async () => {
    const captured = await captureManifest(modern, { toolsListSamples: 2 })
    expect(captured.toolsListSamples).toHaveLength(2)
    expect(captured.toolsListSamples[0].map((t) => t.name)).toEqual(
      captured.toolsListSamples[1].map((t) => t.name),
    )
    expect(captured.discover.era).toBe('modern')
  })
})
