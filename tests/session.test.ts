import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type InputResponder,
  McpSession,
  type Outcome,
  SessionStartError,
  errorMatchesCode,
  expandUriTemplate,
} from '../src/session/index'
import type { JsonValue, ServerConfig, TranscriptEntry } from '../src/types'

const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/echo-server/server')
const ECHO = path.join(FIXTURE_DIR, 'index.js')
const LEGACY_STRICT = path.join(FIXTURE_DIR, 'legacy-strict.js')

function stdio(extra: Partial<ServerConfig> = {}): ServerConfig {
  return { cmd: 'node', args: [ECHO], ...extra } as ServerConfig
}

function start(server: ServerConfig, opts: Partial<Parameters<typeof McpSession.start>[1]> = {}) {
  return McpSession.start(server, { timeoutMs: 5000, stderr: 'capture', ...opts })
}

function textOf(outcome: Outcome): string {
  if (outcome.kind !== 'result') throw new Error(`expected result, got ${JSON.stringify(outcome)}`)
  const content = (outcome.result as { content?: Array<{ text?: string }> }).content ?? []
  return content.map((c) => c.text ?? '').join('\n')
}

const ACCEPT_CONFIRM = { action: 'accept', content: { confirm: true } }

describe('McpSession (modern era, stdio)', () => {
  let session: McpSession

  beforeAll(async () => {
    session = await start(stdio())
  })
  afterAll(async () => {
    await session?.close()
  })

  it('negotiates the 2026-07-28 era by default (protocol: auto)', () => {
    expect(session.era).toBe('modern')
    expect(session.protocolVersion).toBe('2026-07-28')
  })

  it('discover() returns server/discover data', async () => {
    const info = await session.discover()
    expect(info.era).toBe('modern')
    expect(info.synthesized).toBe(false)
    expect(info.supportedVersions).toContain('2026-07-28')
    expect(info.serverInfo).toMatchObject({ name: 'vibrissa-echo-fixture', version: '2.0.0' })
    expect(info.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} })
    expect(info.extensions).toContain('io.modelcontextprotocol/tasks')
    expect(info.instructions).toMatch(/Fixture server/)
    expect((info.raw as { resultType?: string }).resultType).toBe('complete')
  })

  it('lists tools with schemas, annotations and list-level cache hints', async () => {
    const list = await session.listToolsResult()
    expect(list.items.map((t) => t.name)).toEqual([
      'echo',
      'fail',
      'confirm',
      'slow',
      'typed',
      'sleep',
    ])
    expect(list.ttlMs).toBe(60000)
    expect(list.cacheScope).toBe('public')
    const echo = list.items.find((t) => t.name === 'echo')
    expect(echo).toMatchObject({
      title: 'Echo',
      description: 'Echo text back, optionally uppercased',
      inputSchema: { type: 'object', required: ['text'] },
      annotations: { readOnlyHint: true },
    })
    const typed = list.items.find((t) => t.name === 'typed')
    expect(typed?.outputSchema).toMatchObject({ type: 'object', required: ['sum'] })
  })

  it('lists resources, resource templates and prompts', async () => {
    expect(await session.listResources()).toEqual([
      { uri: 'fixture://readme', name: 'readme', title: 'Readme', mimeType: 'text/plain' },
    ])
    expect(await session.listResourceTemplates()).toEqual([
      {
        uriTemplate: 'fixture://users/{id}',
        name: 'user',
        description: 'A user by id',
        mimeType: 'application/json',
      },
    ])
    const prompts = await session.listPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      name: 'greet',
      title: 'Greeting',
      arguments: [
        { name: 'name', required: true },
        { name: 'style', required: false },
      ],
    })
  })

  it('callTool returns the raw wire result (resultType and _meta included)', async () => {
    const outcome = await session.callTool('echo', { text: 'hello', uppercase: true })
    expect(outcome.kind).toBe('result')
    if (outcome.kind !== 'result') return
    expect(outcome.result).toEqual({
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'vibrissa-echo-fixture', version: '2.0.0' },
      },
      content: [{ type: 'text', text: 'HELLO' }],
      resultType: 'complete',
    })
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    expect(outcome.inputRequests).toBeUndefined()
  })

  it('maps isError results to tool errors and keeps the raw result', async () => {
    const outcome = await session.callTool('fail', { message: 'boom goes the reactor' })
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.error).toEqual({ kind: 'tool', message: 'boom goes the reactor' })
    expect((outcome.result as { isError?: boolean }).isError).toBe(true)
  })

  it('maps JSON-RPC errors to protocol errors with stable code names', async () => {
    const outcome = await session.callTool('echo', { uppercase: true })
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.error).toMatchObject({
      kind: 'protocol',
      code: -32602,
      codeName: 'InvalidParams',
      message: 'Invalid arguments for echo: "text" is required and must be a string',
    })
    expect(outcome.error.local).toBeUndefined()
    expect(errorMatchesCode(outcome.error, 'InvalidParams')).toBe(true)
    expect(errorMatchesCode(outcome.error, -32602)).toBe(true)
    expect(errorMatchesCode(outcome.error, 'MethodNotFound')).toBe(false)
  })

  it('fixture validates every tool against its inputSchema (InvalidParams on violations)', async () => {
    const cases: Array<[string, Record<string, JsonValue>, RegExp]> = [
      ['echo', { text: 'x', uppercase: 'true' }, /"uppercase" must be a boolean/],
      ['typed', { a: '1', b: 2 }, /"a" must be a number/],
      ['typed', { a: 1 }, /"b" is required and must be a number/],
      ['sleep', { ms: 'soon' }, /"ms" must be a number/],
      ['fail', { message: 42 }, /"message" must be a string/],
    ]
    for (const [tool, args, message] of cases) {
      const outcome = await session.callTool(tool, args)
      expect(outcome.kind === 'error' && outcome.error).toMatchObject({
        kind: 'protocol',
        codeName: 'InvalidParams',
        message: expect.stringMatching(message),
      })
    }
    expect(textOf(await session.callTool('echo', { text: 'ok', uppercase: false }))).toBe('ok')
  })

  it('never validates structuredContent itself (the runner owns outputSchema checks)', async () => {
    await session.listTools() // primes the SDK-side definition the session hands over
    const outcome = await session.callTool('typed', { a: 1, b: 2, broken: true })
    expect(outcome.kind).toBe('result')
    if (outcome.kind !== 'result') return
    expect((outcome.result as { structuredContent?: unknown }).structuredContent).toEqual({
      sum: '3',
    })
    const ok = await session.callTool('typed', { a: 1, b: 2 })
    expect(
      ok.kind === 'result' && (ok.result as { structuredContent?: unknown }).structuredContent,
    ).toEqual({
      sum: 3,
    })
  })

  it('reads static resources and templates; not-found keeps the 2026 shape', async () => {
    const readme = await session.readResource('fixture://readme')
    expect(readme.kind).toBe('result')
    expect(readme.kind === 'result' && readme.result).toMatchObject({
      contents: [
        { uri: 'fixture://readme', mimeType: 'text/plain', text: 'Vibrissa echo fixture' },
      ],
      resultType: 'complete',
    })

    expect(expandUriTemplate('fixture://users/{id}', { id: 42 })).toBe('fixture://users/42')
    const user = await session.readResourceTemplate('fixture://users/{id}', { id: '42' })
    expect(user.kind === 'result' && user.result).toMatchObject({
      contents: [{ uri: 'fixture://users/42', text: '{"id":"42","name":"user-42"}' }],
    })

    const missing = await session.readResource('fixture://users/404')
    expect(missing.kind).toBe('error')
    if (missing.kind !== 'error') return
    expect(missing.error).toMatchObject({
      kind: 'protocol',
      code: -32602,
      codeName: 'InvalidParams',
      data: { uri: 'fixture://users/404' },
    })
    expect(errorMatchesCode(missing.error, 'ResourceNotFound')).toBe(true)
  })

  it('gets prompts', async () => {
    const outcome = await session.getPrompt('greet', { name: 'Ada', style: 'terse' })
    expect(outcome.kind === 'result' && outcome.result).toMatchObject({
      messages: [
        { role: 'user', content: { type: 'text', text: 'Say hello to Ada in a terse way.' } },
      ],
    })
    const bad = await session.getPrompt('greet', {})
    expect(bad.kind === 'error' && bad.error.codeName).toBe('InvalidParams')
  })

  it('MRTR: answers input_required from a per-call respond map and reports the rounds', async () => {
    const outcome = await session.callTool(
      'confirm',
      { action: 'deploy' },
      { respond: { 'elicitation/create': ACCEPT_CONFIRM } },
    )
    expect(textOf(outcome)).toBe('confirmed: deploy')
    expect(outcome.inputRequests).toHaveLength(1)
    expect(outcome.inputRequests?.[0]).toMatchObject({
      confirm: { method: 'elicitation/create', params: { message: 'Proceed with deploy?' } },
    })

    const declined = await session.callTool(
      'confirm',
      { action: 'deploy' },
      { respond: { 'elicitation/create': { action: 'accept', content: { confirm: false } } } },
    )
    expect(textOf(declined)).toBe('cancelled: deploy')
  })

  it('MRTR: without an answer the call stops at input_required (no retry)', async () => {
    const transcript: TranscriptEntry[] = []
    const watched = await start(stdio(), { transcript: (e) => transcript.push(e) })
    try {
      const outcome = await watched.callTool('confirm', { action: 'drop tables' })
      expect(outcome.kind).toBe('input_required')
      if (outcome.kind !== 'input_required') return
      expect(outcome.requests).toMatchObject({
        confirm: {
          method: 'elicitation/create',
          params: {
            message: 'Proceed with drop tables?',
            requestedSchema: { required: ['confirm'] },
          },
        },
      })
      const calls = transcript.filter(
        (e) => e.dir === 'out' && (e.message as { method?: string })?.method === 'tools/call',
      )
      expect(calls).toHaveLength(1) // no retry leg was sent
    } finally {
      await watched.close()
    }
  })

  it('MRTR: a session-level responder is the fallback for per-call responders', async () => {
    const seen: string[] = []
    const responder: InputResponder = (method) => {
      seen.push(method)
      return method === 'elicitation/create' ? ACCEPT_CONFIRM : undefined
    }
    const withResponder = await start(stdio(), { inputResponder: responder })
    try {
      expect(textOf(await withResponder.callTool('confirm', { action: 'ship' }))).toBe(
        'confirmed: ship',
      )
      const perCall = await withResponder.callTool(
        'confirm',
        { action: 'ship' },
        { respond: () => ({ action: 'decline' }) },
      )
      expect(textOf(perCall)).toBe('decline: ship')
      expect(seen).toEqual(['elicitation/create'])
    } finally {
      await withResponder.close()
    }
  })

  it('tasks: returns the CreateTaskResult without await, polls to completion with await', async () => {
    const handle = await session.callTool('slow', { ms: 30, text: 'job' })
    expect(handle.kind).toBe('result')
    expect(handle.task).toMatchObject({ resultType: 'task', status: 'working' })
    expect(handle.kind === 'result' && handle.result).toMatchObject({ resultType: 'task' })

    const done = await session.callTool('slow', { ms: 30, text: 'job' }, { await: { pollMs: 10 } })
    expect(textOf(done)).toBe('done: job')
    expect(done.task).toMatchObject({ resultType: 'task', taskId: expect.stringMatching(/^task-/) })

    const failed = await session.callTool('slow', { ms: 10, fail: true }, { await: true })
    expect(failed.kind).toBe('error')
    expect(failed.kind === 'error' && failed.error).toMatchObject({
      kind: 'protocol',
      code: -32603,
      codeName: 'InternalError',
      message: 'slow work failed',
    })

    const tooSlow = await session.callTool(
      'slow',
      { ms: 2000 },
      { await: { pollMs: 10, timeoutMs: 100 } },
    )
    expect(tooSlow.kind === 'error' && tooSlow.error).toMatchObject({
      kind: 'timeout',
      codeName: 'RequestTimeout',
    })
  })

  it('times out slow calls with a timeout error and stays usable', async () => {
    const outcome = await session.callTool('sleep', { ms: 1500 }, { timeoutMs: 150 })
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.error).toMatchObject({
      kind: 'timeout',
      codeName: 'RequestTimeout',
      local: true,
    })
    expect(outcome.error.message).toMatch(/tools\/call "sleep".*150ms/)
    expect(textOf(await session.callTool('echo', { text: 'still alive' }))).toBe('still alive')
    expect(await session.ping()).toBe(true)
  })
})

describe('McpSession transcript hook', () => {
  it('records every JSON-RPC message in and out, with timestamps', async () => {
    const entries: TranscriptEntry[] = []
    const session = await start(stdio({ protocol: 'legacy' }), {
      transcript: (e) => entries.push(e),
    })
    try {
      await session.callTool('echo', { text: 'traced' })
    } finally {
      await session.close()
    }
    const methods = entries
      .filter((e) => e.dir === 'out')
      .map((e) => (e.message as { method?: string }).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    const responses = entries.filter(
      (e) => e.dir === 'in' && (e.message as { result?: unknown }).result,
    )
    expect(responses).toHaveLength(2)
    expect(responses[1].message).toMatchObject({ result: { content: [{ text: 'traced' }] } })
    expect(entries.every((e) => typeof e.ts === 'number' && e.ts > 0)).toBe(true)
    expect(entries.some((e) => e.dir === 'stderr' && /ready/.test(e.text ?? ''))).toBe(true)
  })
})

describe('McpSession (legacy era)', () => {
  let session: McpSession

  beforeAll(async () => {
    session = await start(stdio({ protocol: 'legacy' }))
  })
  afterAll(async () => {
    await session?.close()
  })

  it('connects with the 2025 initialize handshake', () => {
    expect(session.era).toBe('legacy')
    expect(session.protocolVersion).toBe('2025-11-25')
  })

  it('synthesizes discover() from the initialize result', async () => {
    const info = await session.discover()
    expect(info).toMatchObject({
      era: 'legacy',
      protocolVersion: '2025-11-25',
      supportedVersions: ['2025-11-25'],
      serverInfo: { name: 'vibrissa-echo-fixture', version: '2.0.0' },
      capabilities: { tools: {}, prompts: {}, resources: {} },
      synthesized: true,
      instructions: 'Fixture server for Vibrissa tests.',
    })
  })

  it('returns legacy results without 2026 envelope fields', async () => {
    const outcome = await session.callTool('echo', { text: 'old school' })
    expect(outcome.kind === 'result' && outcome.result).toEqual({
      content: [{ type: 'text', text: 'old school' }],
    })
    expect(await session.ping()).toBe(true)
  })

  it('answers server→client elicitation from the responder (legacy MRTR shim)', async () => {
    const outcome = await session.callTool(
      'confirm',
      { action: 'rollback' },
      { respond: { 'elicitation/create': ACCEPT_CONFIRM } },
    )
    expect(textOf(outcome)).toBe('confirmed: rollback')
    expect(outcome.inputRequests).toHaveLength(1)
  })

  it('surfaces an unanswered server→client request as input_required', async () => {
    const outcome = await session.callTool('confirm', { action: 'rollback' })
    expect(outcome.kind).toBe('input_required')
    if (outcome.kind !== 'input_required') return
    const entries = Object.values(outcome.requests as Record<string, JsonValue>)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      method: 'elicitation/create',
      params: { message: 'Proceed with rollback?' },
    })
  })

  it('does not get tasks on legacy connections (slow answers synchronously)', async () => {
    const outcome = await session.callTool('slow', { ms: 10, text: 'sync' }, { await: true })
    expect(textOf(outcome)).toBe('done: sync')
    expect(outcome.task).toBeUndefined()
  })
})

describe('McpSession era probing (protocol: auto)', () => {
  it('falls back to initialize for a legacy server that exits on unknown requests', async () => {
    const session = await start({ cmd: 'node', args: [LEGACY_STRICT] })
    try {
      expect(session.era).toBe('legacy')
      expect(session.protocolVersion).toBe('2025-06-18')
      const tools = await session.listTools()
      // Raw wire: unknown annotation keys survive (the SDK's schemas would strip them).
      expect(tools).toEqual([
        {
          name: 'ping',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, vendorHint: 'kept' },
        },
      ])
      expect(textOf(await session.callTool('ping'))).toBe('pong')
      const info = await session.discover()
      expect(info.serverInfo).toMatchObject({ name: 'legacy-strict' })
    } finally {
      await session.close()
    }
  })

  it('pinning the modern era against a legacy-only server fails loudly', async () => {
    await expect(
      start({ cmd: 'node', args: [LEGACY_STRICT], protocol: 'modern' }),
    ).rejects.toBeInstanceOf(SessionStartError)
  })
})

describe('McpSession start failures', () => {
  it('reports a server that exits before the handshake', async () => {
    const failure = start({
      cmd: 'node',
      args: ['-e', 'process.stderr.write("bad config\\n"); process.exit(2)'],
    })
    await expect(failure).rejects.toMatchObject({
      name: 'SessionStartError',
      code: 'exited',
      message: expect.stringMatching(
        /Server exited early before completing MCP initialization.*bad config/,
      ),
    })
  })

  it('reports a command that does not exist', async () => {
    await expect(start({ cmd: 'definitely-not-a-real-binary-vib' })).rejects.toMatchObject({
      code: 'spawn',
      message: expect.stringMatching(/Server failed to start.*command not found \(ENOENT\)/),
    })
  })

  it.each(['auto', 'legacy'] as const)(
    'reports a missing executable path as ENOENT (protocol: %s)',
    async (protocol) => {
      const missing = path.join(FIXTURE_DIR, 'no-such-server.exe')
      await expect(start({ cmd: missing, protocol })).rejects.toMatchObject({
        name: 'SessionStartError',
        code: 'spawn',
        message: expect.stringMatching(/ENOENT/),
      })
    },
  )

  it('reports a server that never answers as a spawn timeout', async () => {
    const silent = {
      cmd: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      protocol: 'legacy',
      spawnTimeoutMs: 400,
    }
    await expect(start(silent as ServerConfig)).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringMatching(/Server spawn timeout.*400ms/),
    })
  })

  it('rejects an invalid protocol setting before spawning', async () => {
    await expect(start(stdio({ protocol: 'newest' as never }))).rejects.toMatchObject({
      code: 'config',
    })
  })
})

describe('McpSession over Streamable HTTP', () => {
  let child: ChildProcess
  let url: string

  beforeAll(async () => {
    child = spawn('node', [ECHO, '--http', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture http server did not start')), 10000)
      child.stderr?.on('data', (chunk) => {
        const match = String(chunk).match(/listening (\S+)/)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
    })
  })
  afterAll(() => {
    child?.kill()
  })

  it('connects modern by default and runs MRTR over HTTP', async () => {
    const session = await start({ url, headers: { 'X-Test': 'yes' } })
    try {
      expect(session.era).toBe('modern')
      expect(textOf(await session.callTool('echo', { text: 'over http' }))).toBe('over http')
      const confirmed = await session.callTool(
        'confirm',
        { action: 'http' },
        { respond: { 'elicitation/create': ACCEPT_CONFIRM } },
      )
      expect(textOf(confirmed)).toBe('confirmed: http')
      expect((await session.discover()).serverInfo).toMatchObject({ name: 'vibrissa-echo-fixture' })
      const done = await session.callTool(
        'slow',
        { ms: 20, text: 'remote' },
        { await: { pollMs: 10 } },
      )
      expect(textOf(done)).toBe('done: remote')
    } finally {
      await session.close()
    }
  })

  it('speaks the legacy era over HTTP when asked', async () => {
    const session = await start({ url, protocol: 'legacy' })
    try {
      expect(session.era).toBe('legacy')
      expect(textOf(await session.callTool('echo', { text: 'legacy http' }))).toBe('legacy http')
    } finally {
      await session.close()
    }
  })

  it('reports an unreachable URL as a connection failure', async () => {
    await expect(
      start({ url: 'http://127.0.0.1:9/mcp', spawnTimeoutMs: 2000 }),
    ).rejects.toMatchObject({
      name: 'SessionStartError',
      code: 'http',
      message: expect.stringMatching(
        /Server connection failed at server url http:\/\/127\.0\.0\.1:9\/mcp/,
      ),
    })
  })
})
