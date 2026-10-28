import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CASES_CHEATSHEET, COMMANDS, formatGlobalHelp, main } from '../src/cli'
import {
  UsageError,
  argsSummary,
  assertKnownFlags,
  closest,
  flagTokens,
  normalizeArgv,
  parseArgValue,
  parseEnvPairs,
  parseRespond,
  parseToolArgs,
  positionals,
  printJson,
  pruneEmpty,
  schemaRefFor,
  slugify,
  splitAtDoubleDash,
  splitCommandLine,
  stringifyArgs,
  suiteLayout,
  takeNumberFlag,
  takeOptionalFlag,
  uniquePath,
  unknownNameError,
} from '../src/cli/args'
import { help as diffHelpText } from '../src/cli/diff'
import { describeExpectation, explainCase, weakAssertions } from '../src/cli/explain'
import {
  acceptedFlags,
  argSummary,
  renderTable,
  sampleRespond,
  schemaTypeLabel,
} from '../src/cli/format'
import { groupRootCauses, rootCauseKey } from '../src/cli/fuzz'
import { ciWorkflow, pyprojectName, serversFromMcpConfig } from '../src/cli/init'
import { help as manifestHelpText } from '../src/cli/manifest'
import { looksLikeCase, migrateCase, migrateConfig } from '../src/cli/migrate'
import {
  dottedPath,
  expectErrorFrom,
  inferCaptures,
  inputRequiredExpectation,
  parseFlowLine,
} from '../src/cli/record'
import { help as runHelpText } from '../src/cli/run'
import { loosenVolatile, loosenedSummary } from '../src/cli/volatile'
import { suggestRespond } from '../src/respond-hint'
import type { JsonValue, Step } from '../src/types'

describe('cli args helpers', () => {
  it('splits quoted server command lines', () => {
    expect(splitCommandLine('node dist/index.js')).toEqual({
      cmd: 'node',
      args: ['dist/index.js'],
    })
    expect(splitCommandLine('node "path with spaces/server.js" --flag')).toEqual({
      cmd: 'node',
      args: ['path with spaces/server.js', '--flag'],
    })
  })

  it('parses env pairs', () => {
    expect(parseEnvPairs(['FOO=bar', 'A=b=c'])).toEqual({ FOO: 'bar', A: 'b=c' })
    expect(() => parseEnvPairs(['NOVALUE'])).toThrow(/KEY=VALUE/)
  })

  it('parses tool args from JSON and key=value pairs', () => {
    expect(
      parseToolArgs(['--args', '{"text":"hi"}', '--arg', 'uppercase=true', '--arg', 'n=2']),
    ).toEqual({ text: 'hi', uppercase: true, n: 2 })
    expect(parseArgValue('null')).toBeNull()
    expect(parseArgValue('[1,2]')).toEqual([1, 2])
  })

  it('finds positionals around value flags and stops at --', () => {
    expect(positionals(['--config', 'x.json', 'echo', '--json', '--arg', 'a=1'])).toEqual(['echo'])
    expect(positionals(['a.json', 'b.json', '--full'])).toEqual(['a.json', 'b.json'])
    expect(positionals(['--', 'node', 'server.js'])).toEqual([])
  })

  it('normalizes --flag=value for known value flags only', () => {
    expect(normalizeArgv(['fuzz', 'echo', '--runs=5', '--seed=abc', '--inject'])).toEqual([
      'fuzz',
      'echo',
      '--runs',
      '5',
      '--seed',
      'abc',
      '--inject',
    ])
    expect(normalizeArgv(['--arg=text=hi'])).toEqual(['--arg', 'text=hi'])
    expect(normalizeArgv(['--unknown=1'])).toEqual(['--unknown=1'])
    expect(normalizeArgv(['tap', '--', 'node', '--runs=5'])).toEqual([
      'tap',
      '--',
      'node',
      '--runs=5',
    ])
  })

  it('lists flag tokens (skipping values) and splits at --', () => {
    expect(flagTokens(['echo', '--arg', '--weird', '--json', '--', '--x'])).toEqual([
      '--arg',
      '--json',
    ])
    expect(splitAtDoubleDash(['--out', 'f', '--', 'node', 's.js'])).toEqual([
      ['--out', 'f'],
      ['node', 's.js'],
    ])
  })

  it('suggests close matches', () => {
    expect(closest('--valdiate', ['--validate', '--raw', '--json'])).toBe('--validate')
    expect(closest('tols', ['tools', 'call'])).toBe('tools')
    expect(closest('zzzzzz', ['tools', 'call'])).toBeUndefined()
  })

  it('parses --respond maps and --respond-key pairs', () => {
    expect(parseRespond([])).toBeUndefined()
    expect(
      parseRespond([
        '--respond',
        '{"elicitation/create":{"action":"accept"}}',
        '--respond-key',
        'roots/list={"roots":[]}',
      ]),
    ).toEqual({ 'elicitation/create': { action: 'accept' }, 'roots/list': { roots: [] } })
    expect(() => parseRespond(['--respond', '[1]'])).toThrow(UsageError)
    expect(() => parseRespond(['--respond', '{oops'])).toThrow(/Invalid --respond JSON/)
    expect(() => parseRespond(['--respond-key', 'nope'])).toThrow(/method=<json>/)
  })

  it('validates numeric flags with a hint', () => {
    expect(takeNumberFlag(['--runs', '5'], '--runs', { min: 1, integer: true })).toBe(5)
    expect(takeNumberFlag([], '--runs')).toBeUndefined()
    expect(() => takeNumberFlag(['--runs', 'x'], '--runs', { min: 1, integer: true })).toThrow(
      /Invalid --runs value "x": expected an integer >= 1/,
    )
  })

  it('reads optional-value flags', () => {
    expect(takeOptionalFlag(['--from-claude-config'], '--from-claude-config')).toBe('')
    expect(takeOptionalFlag(['--from-claude-config', '--ci'], '--from-claude-config')).toBe('')
    expect(takeOptionalFlag(['--from-claude-config', 'a.json'], '--from-claude-config')).toBe(
      'a.json',
    )
    expect(takeOptionalFlag([], '--from-claude-config')).toBeUndefined()
  })

  it('stringifies prompt args and slugifies names', () => {
    expect(stringifyArgs({ a: 'x', n: 3, b: true })).toEqual({ a: 'x', n: '3', b: 'true' })
    expect(slugify('Echo: Hello World!')).toBe('echo-hello-world')
  })

  it('points $schema at the installed @jmoak/vibrissa schema, else unpkg', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vib-schema-'))
    const file = path.join(tmp, 'tests', 'integration', 'a.json')
    expect(schemaRefFor(file, tmp, 'case.schema.json')).toBe(
      'https://unpkg.com/@jmoak/vibrissa/schema/case.schema.json',
    )
    const local = path.join(tmp, 'node_modules', '@jmoak', 'vibrissa', 'schema')
    fs.mkdirSync(local, { recursive: true })
    fs.writeFileSync(path.join(local, 'case.schema.json'), '{}')
    expect(schemaRefFor(file, tmp, 'case.schema.json')).toBe(
      '../../node_modules/@jmoak/vibrissa/schema/case.schema.json',
    )
  })
})

describe('cli format helpers', () => {
  it('summarizes schemas for tables', () => {
    expect(schemaTypeLabel({ type: 'string' })).toBe('string')
    expect(schemaTypeLabel({ type: 'array', items: { type: 'integer' } })).toBe('integer[]')
    expect(schemaTypeLabel({ enum: ['a', 'b'] })).toBe('"a"|"b"')
    expect(schemaTypeLabel({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string|null')
    expect(
      argSummary({
        type: 'object',
        properties: { text: { type: 'string' }, uppercase: { type: 'boolean' } },
        required: ['text'],
      }),
    ).toBe('text*: string, uppercase: boolean')
    expect(argSummary({ type: 'object' })).toBe('')
  })

  it('renders aligned tables and truncates the flex column', () => {
    const table = renderTable(
      [{ header: 'NAME' }, { header: 'DESCRIPTION', flex: true }],
      [
        ['echo', 'x'.repeat(200)],
        ['fail', 'short'],
      ],
      60,
    )
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/^NAME\s+DESCRIPTION$/)
    expect(lines[1].length).toBeLessThanOrEqual(60)
    expect(lines[1].endsWith('…')).toBe(true)
    expect(lines[2]).toBe('fail  short')
  })

  it('builds a sample --respond from an InputRequests map', () => {
    expect(
      sampleRespond({
        confirm: {
          method: 'elicitation/create',
          params: {
            message: 'Proceed?',
            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } },
          },
        },
      }),
    ).toEqual({ 'elicitation/create': { action: 'accept', content: { confirm: true } } })
  })

  it('derives accepted flags from help', () => {
    const flags = acceptedFlags(COMMANDS.call)
    expect(flags.has('--respond')).toBe(true)
    expect(flags.has('--config')).toBe(true)
    expect(flags.has('--validate')).toBe(true)
    expect(flags.has('--help')).toBe(true)
  })
})

describe('record helpers', () => {
  const normalize = { stripMeta: ['io.modelcontextprotocol/*'], dropKeys: ['resultType'] }

  it('maps errors to expectError with stable names', () => {
    expect(
      expectErrorFrom({
        kind: 'protocol',
        code: -32602,
        codeName: 'InvalidParams',
        message: 'bad "text"\nmore',
      }),
    ).toEqual({
      code: 'InvalidParams',
      message: { $regex: 'bad "text"' },
    })
    expect(
      expectErrorFrom({
        kind: 'protocol',
        code: -32602,
        codeName: 'InvalidParams',
        message: 'nope',
        data: { uri: 'x://y' },
      }),
    ).toMatchObject({ code: 'ResourceNotFound' })
    expect(
      expectErrorFrom({
        kind: 'timeout',
        codeName: 'RequestTimeout',
        message: 'long local text',
        local: true,
      }),
    ).toEqual({
      code: 'RequestTimeout',
    })
    expect(expectErrorFrom({ kind: 'tool', message: 'boom (1+1)' })).toEqual({
      message: { $regex: 'boom \\(1\\+1\\)' },
    })
  })

  it('writes expectInputRequired in the era-portable method view', () => {
    const rounds: JsonValue[] = [
      {
        confirm: {
          method: 'elicitation/create',
          params: { message: 'Proceed?', _meta: { 'io.modelcontextprotocol/x': 1 } },
        },
      },
      { again: { method: 'elicitation/create', params: { message: 'Sure?' } } },
    ]
    expect(inputRequiredExpectation(rounds, normalize)).toEqual({
      'elicitation/create': [{ message: 'Proceed?' }, { message: 'Sure?' }],
    })
  })

  it('parses flow lines', () => {
    expect(parseFlowLine('echo {"text": "hi"}')).toEqual({ tool: 'echo', args: { text: 'hi' } })
    expect(parseFlowLine('echo text=hi uppercase=true')).toEqual({
      tool: 'echo',
      args: { text: 'hi', uppercase: true },
    })
    expect(parseFlowLine('{"resource": "fixture://readme"}')).toEqual({
      resource: 'fixture://readme',
    })
    expect(() => parseFlowLine('{"tool": "a", "prompt": "b"}')).toThrow(/exactly one/)
    expect(() => parseFlowLine('echo text')).toThrow(/key=value/)
  })

  it('infers captures for server-minted handles', () => {
    const steps: Step[] = [
      {
        tool: 'session.create',
        args: { user: 'jordan' },
        expect: {
          structuredContent: { sessionId: 'sess-8f2a91', user: 'jordan' },
          content: [{ type: 'text', text: 'created sess-8f2a91' }],
        },
      },
      {
        tool: 'session.get',
        args: { sessionId: 'sess-8f2a91' },
        expect: { content: [{ type: 'text', text: 'session sess-8f2a91 for jordan' }] },
      },
      { tool: 'echo', args: { text: 'jordan' } },
    ]
    const results: JsonValue[] = [
      {
        structuredContent: { sessionId: 'sess-8f2a91', user: 'jordan' },
        content: [{ type: 'text', text: 'created sess-8f2a91' }],
      },
      { content: [{ type: 'text', text: 'session sess-8f2a91 for jordan' }] },
      { content: [{ type: 'text', text: 'jordan' }] },
    ]
    const notes = inferCaptures(steps, results)
    expect(notes).toHaveLength(1)
    expect(steps[0].capture).toEqual({ sessionId: 'structuredContent.sessionId' })
    expect(steps[1].args).toEqual({ sessionId: '{{sessionId}}' })
    expect(steps[1].expect).toEqual({
      content: [{ type: 'text', text: 'session {{sessionId}} for jordan' }],
    })
    expect(steps[0].expect).toEqual({
      structuredContent: { sessionId: { $type: 'string' }, user: 'jordan' },
      content: [{ type: 'text', text: { $wildcard: 'created *' } }],
    })
    // "jordan" was an input of step 1, so it is not a minted handle.
    expect(steps[2].args).toEqual({ text: 'jordan' })
    expect(dottedPath(['content', 0, 'text'])).toBe('content[0].text')
  })
})

describe('explain', () => {
  it('names matchers in plain words', () => {
    const lines = describeExpectation({
      $partial: true,
      content: { $contains: { type: 'text', text: { $regex: '^Saved', flags: 'i' } } },
      id: { $type: 'string', $length: { min: 3 } },
      count: { $number: { gte: 0, lt: 10 } },
      status: { $oneOf: ['queued', { $wildcard: 'run*' }] },
      debug: { $ignore: true },
      user: { $ref: './shared/user.json' },
    }).map((a) => `${a.path} ${a.text}`)
    expect(lines).toContain(
      '(root) is an object with at least: content, id, count, status, debug, user (extra keys allowed)',
    )
    expect(lines).toContain('content contains at least one item matching:')
    expect(lines).toContain('content[*].text matches /^Saved/i')
    expect(lines).toContain('id is of type string and has length at least 3')
    expect(lines).toContain('count is a number >= 0 and < 10')
    expect(lines).toContain('status matches any one of 2 alternatives:')
    expect(lines).toContain(
      'status #2 matches the pattern "run*" (* = anything, ? = one character)',
    )
    expect(lines).toContain('debug is ignored (may be missing)')
    expect(lines).toContain('user matches the shared fragment "./shared/user.json"')
  })

  it('explains flows with captures, placeholders and respond', () => {
    const ex = explainCase(
      {
        name: 'flow',
        tags: ['smoke'],
        steps: [
          { tool: 'a', args: {}, capture: { id: 'structuredContent.id' } },
          {
            tool: 'b',
            args: { id: '{{id}}' },
            respond: { 'elicitation/create': { action: 'accept' } },
            expectError: { code: 'InvalidParams' },
          },
        ],
        teardown: [{ tool: 'c', ignoreErrors: true }],
      },
      'flow.json',
    )
    expect(ex.kind).toBe('flow')
    expect(ex.steps.map((s) => s.phase)).toEqual(['main', 'main', 'teardown'])
    expect(ex.steps[0].captures).toEqual(['captures {{id}} = structuredContent.id'])
    expect(ex.steps[1].uses).toEqual(['id'])
    expect(ex.steps[1].respond[0]).toMatch(/^answers elicitation\/create with/)
    expect(ex.steps[1].expectError).toMatch(/code InvalidParams/)
    expect(ex.steps[2].notes).toContain('never fails the case (ignoreErrors)')
  })
})

describe('migrate transforms', () => {
  it('moves server to servers.default and fixes $schema, idempotently', () => {
    const v1 = {
      $schema: './node_modules/vibrissa/schema/vibrissa.schema.json',
      server: { cmd: 'node', args: ['dist/index.js'] },
      globs: ['tests/**/*.json'],
      profiles: { ci: { server: { args: ['dist/ci.js'] } } },
    }
    const once = migrateConfig(v1, {
      schema: 'https://unpkg.com/@jmoak/vibrissa/schema/vibrissa.schema.json',
    })
    expect(once.value).toEqual({
      $schema: 'https://unpkg.com/@jmoak/vibrissa/schema/vibrissa.schema.json',
      servers: { default: { cmd: 'node', args: ['dist/index.js'] } },
      defaultServer: 'default',
      globs: ['tests/**/*.json'],
      profiles: { ci: { servers: { default: { args: ['dist/ci.js'] } } } },
    })
    expect(once.edits.length).toBe(3)
    const twice = migrateConfig(once.value, {
      schema: 'https://unpkg.com/@jmoak/vibrissa/schema/vibrissa.schema.json',
    })
    expect(twice.edits).toEqual([])
    expect(twice.value).toEqual(once.value)
  })

  it('renames error-code aliases and v1 numeric codes in cases and steps', () => {
    const { value, edits } = migrateCase({
      tool: 'x',
      expectError: { code: 'RequestTimedOut' },
      steps: [
        { tool: 'y', expectError: { code: -32002 } },
        { tool: 'z', expectError: { code: -32602 } },
      ],
    })
    expect(value.expectError).toEqual({ code: 'RequestTimeout' })
    expect((value.steps as Step[])[0].expectError).toEqual({ code: 'ResourceNotFound' })
    expect((value.steps as Step[])[1].expectError).toEqual({ code: -32602 })
    expect(edits).toHaveLength(2)
    expect(migrateCase(value).edits).toEqual([])
    expect(looksLikeCase({ vibrissa: 2, tools: [] })).toBe(false)
  })
})

describe('init helpers', () => {
  it('reads the project name from pyproject.toml', () => {
    expect(
      pyprojectName(
        '[build-system]\nrequires = []\n\n[project]\nname = "my-mcp-server"\nversion = "1"\n',
      ),
    ).toBe('my-mcp-server')
    expect(pyprojectName('[tool.poetry]\nname = "x"\n')).toBeUndefined()
  })

  it('maps Claude mcpServers and scrubs literal secrets', () => {
    const notes: string[] = []
    const servers = serversFromMcpConfig(
      {
        files: {
          command: 'npx',
          args: ['-y', 'files-mcp'],
          env: { API_TOKEN: 'abc123', MODE: 'dev', KEY_REF: '${MY_KEY}' },
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer xyz' },
        },
        broken: { args: [] },
      },
      notes,
    )
    expect(servers.files).toEqual({
      cmd: 'npx',
      args: ['-y', 'files-mcp'],
      env: { API_TOKEN: '${API_TOKEN}', MODE: 'dev', KEY_REF: '${MY_KEY}' },
    })
    expect(servers.remote).toEqual({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: '${REMOTE_AUTHORIZATION}' },
    })
    expect(servers.broken).toBeUndefined()
    expect(notes.join('\n')).toMatch(/API_TOKEN.*\$\{API_TOKEN\}/)
  })

  it('writes a CI workflow that runs the ci profile with --check and uploads reports on failure', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vib-ci-'))
    const bare = ciWorkflow(tmp)
    // The ci profile carries --check / reporters / requireManifest; the workflow adds no flags.
    expect(bare).toContain('- run: npx --yes --package @jmoak/vibrissa vib run --profile ci\n')
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}')
    const node = ciWorkflow(tmp)
    expect(node).toContain('- run: npm ci')
    expect(node).toContain('- run: npm run build --if-present')
    expect(node).toContain('- run: npx vib run --profile ci\n')
    expect(node).toMatch(/upload-artifact@v4\n {8}if: failure\(\)\n[\s\S]*path: reports\//)
  })
})

describe('dispatcher', () => {
  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })
  function capture() {
    for (const spy of spies.splice(0)) spy.mockRestore()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    spies.push(log, err)
    return {
      out: () => log.mock.calls.map((c) => String(c[0])).join('\n'),
      err: () => err.mock.calls.map((c) => String(c[0])).join('\n'),
    }
  }

  it('prints grouped global help', async () => {
    const io = capture()
    expect(await main(['--help'])).toBe(0)
    const text = io.out()
    for (const heading of ['Explore', 'Probe', 'Capture', 'Gate', 'Harden', 'Wrappers']) {
      expect(text).toContain(heading)
    }
    for (const name of [
      'discover',
      'tools',
      'resources',
      'prompts',
      'call',
      'read',
      'get-prompt',
      'record',
      'manifest',
      'check',
      'fuzz',
      'tap',
      'diff',
      'migrate',
      'explain',
      'init',
      'inspect',
      'conformance',
      'run',
    ]) {
      expect(text).toMatch(new RegExp(`\\n  ${name}\\s`))
    }
  })

  it('prints per-command help for every command', async () => {
    for (const name of Object.keys(COMMANDS)) {
      const io = capture()
      expect(await main([name, '--help'])).toBe(0)
      expect(io.out()).toContain(`vib ${name}`)
      expect(io.out()).toContain('Usage:')
    }
    const io = capture()
    expect(await main(['help', 'fuzz'])).toBe(0)
    expect(io.out()).toContain('--record-failures')
  })

  it('prints the full runner-owned help for run, manifest and diff', async () => {
    let io = capture()
    expect(await main(['run', '--help'])).toBe(0)
    for (const flag of [
      '--shard',
      '--baseline',
      '--repeat',
      '--concurrency',
      '--trace',
      '--update-manifest',
      '--out-dir',
    ]) {
      expect(io.out()).toContain(flag)
    }
    io = capture()
    expect(await main(['manifest', '--help'])).toBe(0)
    expect(io.out()).toContain('vib manifest show')
    expect(io.out()).toContain('--out <path>')
    io = capture()
    expect(await main(['diff', '--help'])).toBe(0)
    expect(io.out()).toContain('--manifest-only')
    expect(io.out()).toContain('--cases')
    io = capture()
    expect(await main(['--help'])).toBe(0)
    expect(io.out()).toContain('docs/CLI.md')
    expect(io.out()).not.toContain('README')
    // The dispatcher prints exactly the help the runner-owned commands export.
    for (const [name, text] of [
      ['run', runHelpText],
      ['manifest', manifestHelpText],
      ['diff', diffHelpText],
    ] as const) {
      io = capture()
      expect(await main([name, '--help'])).toBe(0)
      expect(io.out()).toBe(text)
    }
  })

  it('rejects unknown commands and flags with a suggestion (exit 2)', async () => {
    let io = capture()
    expect(await main(['tols'])).toBe(2)
    expect(io.err()).toContain('Did you mean "vib tools"?')
    io = capture()
    expect(await main(['call', 'echo', '--valdiate'])).toBe(2)
    expect(io.err()).toMatch(/Unknown option --valdiate for vib call\. Did you mean --validate\?/)
    io = capture()
    expect(await main(['fuzz'])).toBe(2)
    expect(io.err()).toMatch(/Missing tool name/)
  })

  it('emits a JSON error object under --json', async () => {
    const io = capture()
    expect(
      await main(['explain', path.join(os.tmpdir(), 'nope-does-not-exist.json'), '--json']),
    ).toBe(2)
    const payload = JSON.parse(io.out()) as {
      ok: boolean
      error: { type: string; message: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error.type).toBe('UsageError')
    expect(payload.error.message).toMatch(/Case file not found/)
  })
})

describe('suite layout and naming helpers', () => {
  it('derives the case directory and suffix from the first positive glob', () => {
    expect(suiteLayout(['cases/**/*.json', '!cases/**/*.fail.json'])).toEqual({
      dir: 'cases',
      suffix: '.json',
    })
    expect(suiteLayout(['!x/**', 'tests/integration/**/*.case.json'])).toEqual({
      dir: 'tests/integration',
      suffix: '.case.json',
    })
    expect(suiteLayout(['**/*.json'])).toEqual({ dir: '.', suffix: '.json' })
    expect(suiteLayout([])).toEqual({ dir: 'tests/integration', suffix: '.json' })
  })

  it('deduplicates file names and summarizes args', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vib-uniq-'))
    const file = path.join(tmp, 'echo.json')
    expect(uniquePath(file)).toBe(file)
    fs.writeFileSync(file, '{}')
    expect(uniquePath(file)).toBe(path.join(tmp, 'echo-2.json'))
    fs.writeFileSync(path.join(tmp, 'echo-2.json'), '{}')
    expect(uniquePath(file)).toBe(path.join(tmp, 'echo-3.json'))
    expect(argsSummary({ text: 'hello', uppercase: true, n: 3 })).toBe(
      'text=hello uppercase=true n=3',
    )
    expect(argsSummary({})).toBe('')
    expect(pruneEmpty({ a: [], b: { c: [], d: 1 }, e: [1] })).toEqual({ b: { d: 1 }, e: [1] })
  })

  it('exports the unknown-option / did-you-mean machinery', () => {
    expect(() => assertKnownFlags(['--json', '--arg', 'x=1'], ['--arg'], 'call')).not.toThrow()
    let error: UsageError | undefined
    try {
      assertKnownFlags(['--valdiate'], ['--validate', '--raw'], 'call')
    } catch (err) {
      error = err as UsageError
    }
    expect(error).toBeInstanceOf(UsageError)
    expect(error?.code).toBe('unknown-option')
    expect(error?.hint).toBe('Did you mean --validate? Run vib call --help for its options.')
    expect(error?.next).toEqual(['vib call --help'])
    const missing = unknownNameError('tool', 'ecoh', ['echo', 'fail'], 'vib tools')
    expect(missing.code).toBe('unknown-tool')
    expect(missing.hint).toMatch(/^Did you mean "echo"\? Available: echo, fail\./)
  })
})

describe('volatile-field loosening', () => {
  it('replaces timestamps, UUIDs, epoch-ms and embedded values by pattern', () => {
    const uuid = '4b1d2c3e-1f2a-4b5c-9d8e-0123456789ab'
    const { value, loosened } = loosenVolatile({
      content: [{ type: 'text', text: `created ${uuid} at 2026-10-28T12:00:00.000Z` }],
      structuredContent: {
        at: '2026-10-28T12:00:00Z',
        local: '2026-10-28T12:00:00',
        id: uuid,
        ms: 1793178451428,
        small: 42,
        name: 'stable',
      },
    })
    const sc = (value as Record<string, Record<string, JsonValue>>).structuredContent
    expect(sc).toEqual({
      at: { $schema: { type: 'string', format: 'date-time' } },
      local: { $regex: '^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+$' },
      id: { $schema: { type: 'string', format: 'uuid' } },
      ms: { $type: 'integer' },
      small: 42,
      name: 'stable',
    })
    expect(loosened.map((l) => [l.path, l.reason])).toEqual([
      ['content[0].text', 'embedded'],
      ['structuredContent.at', 'date-time'],
      ['structuredContent.local', 'date-time'],
      ['structuredContent.id', 'uuid'],
      ['structuredContent.ms', 'epoch-ms'],
    ])
    const text = (value as { content: Array<{ text: { $regex: string } }> }).content[0].text.$regex
    const re = new RegExp(text)
    expect(re.test(`created ${uuid} at 2026-10-28T12:00:00.000Z`)).toBe(true)
    expect(
      re.test('created 00000000-1111-2222-3333-444444444444 at 2027-01-01T00:00:00.5+02:00'),
    ).toBe(true)
    expect(re.test('deleted 00000000-1111-2222-3333-444444444444 at 2027-01-01T00:00:00Z')).toBe(
      false,
    )
  })

  it('loosens values that changed between two calls (stable check)', () => {
    const { value, loosened } = loosenVolatile(
      { text: 'call #1 done', n: 3, flag: true, gone: 'x', same: 'y', list: [1, 2] },
      { text: 'call #2 done', n: 4, flag: false, same: 'y', list: [1, 2, 3] },
    )
    const out = value as Record<string, JsonValue>
    expect(out.n).toEqual({ $type: 'integer' })
    expect(out.flag).toEqual({ $type: 'boolean' })
    expect(out.gone).toEqual({ $ignore: true })
    expect(out.same).toBe('y')
    expect(out.list).toEqual({ $type: 'array' })
    const regex = (out.text as { $regex: string }).$regex
    expect(new RegExp(regex).test('call #99 done')).toBe(true)
    expect(new RegExp(regex).test('other')).toBe(false)
    expect(loosened.every((l) => l.reason === 'changed')).toBe(true)
    expect(loosenedSummary(loosened)).toBe(
      'loosened 5 volatile fields (text, n, flag, gone, +1 more)',
    )
  })

  it('leaves $literal-escaped data alone', () => {
    const golden = { $literal: { at: '2026-10-28T12:00:00Z' } }
    expect(loosenVolatile(golden).value).toEqual(golden)
  })
})

describe('respond suggestions, root causes, weak assertions', () => {
  it('suggestRespond answers every method once', () => {
    expect(
      suggestRespond({
        a: {
          method: 'elicitation/create',
          params: {
            requestedSchema: {
              properties: { n: { type: 'integer', minimum: 2 }, c: { enum: ['x', 'y'] } },
            },
          },
        },
        b: { method: 'roots/list', params: {} },
        c: { method: 'sampling/createMessage', params: {} },
      }),
    ).toEqual({
      'elicitation/create': { action: 'accept', content: { n: 2, c: 'x' } },
      'roots/list': { roots: [] },
      'sampling/createMessage': {
        role: 'assistant',
        content: { type: 'text', text: '...' },
        model: 'scripted',
      },
    })
  })

  it('groups fuzz failures by root cause', () => {
    const verdict = (detail: string) => ({
      ok: false,
      invariant: 'invalid-args-yield-invalid-params',
      title: 't',
      level: 'error' as const,
      detail,
    })
    const report = (id: string, detail: string) => ({
      r: { id } as never,
      failed: [verdict(detail)],
    })
    const causes = groupRootCauses([
      report(
        'a',
        "invalid args were accepted silently (wrong type for 'x': expected boolean). Validate arguments.",
      ),
      report(
        'b',
        "invalid args were accepted silently (null for non-nullable 'y'). Validate arguments.",
      ),
      report('c', 'invalid args (missing) caused InternalError (-32603): boom'),
    ])
    expect(causes.map((cause) => cause.cases)).toEqual([['a', 'b'], ['c']])
    expect(rootCauseKey(verdict("x (y 'z') more"))).toBe(
      'invalid-args-yield-invalid-params: x more',
    )
  })

  it('flags weak assertions', () => {
    const flags = weakAssertions({
      skip: 'later',
      steps: [
        { tool: 'a', expectError: {} },
        { tool: 'b', expect: { $partial: true } },
        { tool: 'c' },
        { tool: 'd', expect: {}, validateOutput: false, ignoreErrors: true },
      ],
      teardown: [{ tool: 'e', ignoreErrors: true }],
    })
    expect(flags.map((f) => `${f.at} ${f.code}`)).toEqual([
      'case skipped',
      'step 1 any-error',
      'step 2 bare-partial',
      'step 3 no-expectation',
      'step 4 no-output-validation',
      'step 4 ignore-errors',
    ])
  })
})

describe('dispatcher --json error contract', () => {
  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })
  function capture() {
    for (const spy of spies.splice(0)) spy.mockRestore()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    spies.push(log, err)
    return {
      // biome-ignore lint/suspicious/noExplicitAny: structural assertions
      json: (): any => JSON.parse(String(log.mock.calls.at(-1)?.[0])),
      lines: () => log.mock.calls.length,
      err: () => err.mock.calls.map((c) => String(c[0])).join('\n'),
    }
  }

  it.each([
    [['nope', '--json'], 'unknown-command'],
    [['tools', '--bogus', '--json'], 'unknown-option'],
    [['--bogus', '--json'], 'unknown-option'],
    [['call', 'echo', '--arg', 'text', '--json'], 'invalid-argument'],
    [['call', 'echo', '--args', '{bad', '--json'], 'invalid-argument'],
    [['discover', '--protocol', 'bogus', '--json'], 'invalid-argument'],
    [['discover', '--timeout', 'soon', '--json'], 'invalid-argument'],
    [['help', 'casez', '--json'], 'unknown-topic'],
  ])('%j exits 2 with one JSON envelope and nothing on stderr', async (argv, code) => {
    const io = capture()
    expect(await main(argv)).toBe(2)
    expect(io.lines()).toBe(1)
    const payload = io.json()
    expect(payload).toMatchObject({ ok: false, error: { type: 'UsageError', code } })
    expect(typeof payload.error.message).toBe('string')
    expect(typeof payload.error.hint).toBe('string')
    expect(io.err()).toBe('')
  })

  it('bare vib rejects unknown flags like any command', async () => {
    const io = capture()
    expect(await main(['--bogus'])).toBe(2)
    expect(io.err()).toMatch(/Unknown option --bogus for vib run\./)
  })

  it('vib help cases prints the ~2 KB cheat sheet', async () => {
    const io = capture()
    expect(await main(['help', 'cases'])).toBe(0)
    expect(CASES_CHEATSHEET.length).toBeLessThan(2600)
    for (const needle of [
      '"expectError"',
      '$partial',
      '"capture"',
      '"respond"',
      '"await"',
      'Examples:',
    ]) {
      expect(CASES_CHEATSHEET).toContain(needle)
    }
    expect(io.lines()).toBe(1)
  })

  it('prints compact JSON when stdout is not a terminal', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    spies.push(log)
    printJson({ a: [1, 2] })
    expect(log.mock.calls[0][0]).toBe('{"a":[1,2]}')
  })

  it('groups setup commands separately', () => {
    expect(COMMANDS.init.group).toBe('setup')
    expect(COMMANDS.migrate.group).toBe('setup')
    expect(formatGlobalHelp()).toMatch(/Setup — [\s\S]*\n {2}init {2,}[\s\S]*\n {2}migrate /)
  })
})
