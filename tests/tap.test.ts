import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { recordCommand, tapCallStatus } from '../src/cli/record'
import { McpSession } from '../src/session/index'
import {
  type TapEntry,
  parseTapText,
  readTapFile,
  reconstructCalls,
  selectCalls,
} from '../src/tap/entries'
import { FrameParser, TapRecorder, lastSeq, runTapProxy } from '../src/tap/proxy'
import type { ServerConfig, TestCase } from '../src/types'

const ROOT = process.cwd()
const ECHO = path.join(ROOT, 'tests/fixtures/echo-server/server/index.js')
const FIXTURE_CONFIG = path.join(ROOT, 'tests/fixtures/echo-server/vibrissa.json')
const CONFIRM = { 'elicitation/create': { action: 'accept', content: { confirm: true } } }

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-tap-'))
}

describe('FrameParser', () => {
  function collect(chunks: Array<string | Buffer>): unknown[] {
    const out: unknown[] = []
    const parser = new FrameParser((m) => out.push(m))
    for (const chunk of chunks) parser.push(chunk)
    return out
  }

  it('parses newline-delimited JSON split across chunks and several per chunk', () => {
    expect(collect(['{"id":1,', '"method":"a"}\n{"id":2}\n{"id"', ':3}\r\n'])).toEqual([
      { id: 1, method: 'a' },
      { id: 2 },
      { id: 3 },
    ])
  })

  it('parses Content-Length framing, including partial headers and bodies', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { é: 'ü' } })
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    const bytes = Buffer.from(frame + frame)
    const out = collect([
      bytes.subarray(0, 5),
      bytes.subarray(5, 30),
      bytes.subarray(30, 70),
      bytes.subarray(70),
    ])
    expect(out).toEqual([JSON.parse(body), JSON.parse(body)])
    expect(collect(['content-length: 2\r\nContent-Type: x\r\n\r\n{}'])).toEqual([{}])
  })

  it('skips non-JSON lines and expands batches', () => {
    expect(collect(['log noise\n[{"id":1},{"id":2}]\n\n'])).toEqual([{ id: 1 }, { id: 2 }])
  })
})

describe('TapRecorder', () => {
  it('pairs requests with responses in both directions; flushes pending as incomplete', () => {
    const entries: TapEntry[] = []
    const recorder = new TapRecorder((e) => entries.push(e))
    recorder.observe('client', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x' } },
    })
    recorder.observe('client', { jsonrpc: '2.0', method: 'notifications/initialized' })
    recorder.observe('server', {
      jsonrpc: '2.0',
      id: 9,
      method: 'elicitation/create',
      params: { message: 'ok?' },
    })
    recorder.observe('client', { jsonrpc: '2.0', id: 9, result: { action: 'accept' } })
    recorder.observe('server', { jsonrpc: '2.0', id: 1, result: { content: [] } })
    recorder.observe('client', { jsonrpc: '2.0', id: 2, method: 'ping' }) // not tapped
    recorder.observe('client', {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'greet' },
    })
    recorder.flush()
    expect(entries.map((e) => [e.from, e.method, e.seq])).toEqual([
      ['server', 'elicitation/create', 2],
      ['client', 'tools/call', 1],
      ['client', 'prompts/get', 3],
    ])
    expect(entries[0].result).toEqual({ action: 'accept' })
    expect(entries[1]).toMatchObject({ params: { name: 'echo' }, result: { content: [] } })
    expect(entries[2]).toMatchObject({
      incomplete: true,
      error: { message: expect.stringMatching(/no response/) },
    })
  })
})

describe('reconstructCalls / selectCalls', () => {
  const ts = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString()
  const entries: TapEntry[] = [
    {
      ts: ts(0),
      seq: 1,
      from: 'client',
      method: 'initialize',
      id: 0,
      params: {},
      result: {},
      durationMs: 1,
    },
    // 2026 MRTR: input_required, then a retry carrying inputResponses
    {
      ts: ts(10),
      seq: 2,
      from: 'client',
      method: 'tools/call',
      id: 1,
      durationMs: 2,
      params: { name: 'confirm', arguments: { action: 'go' } },
      result: {
        resultType: 'input_required',
        inputRequests: {
          confirm: { method: 'elicitation/create', params: { message: 'Proceed?' } },
        },
      },
    },
    {
      ts: ts(20),
      seq: 3,
      from: 'client',
      method: 'tools/call',
      id: 2,
      durationMs: 2,
      params: {
        name: 'confirm',
        arguments: { action: 'go' },
        inputResponses: { confirm: { action: 'accept' } },
      },
      result: { content: [{ type: 'text', text: 'confirmed: go' }] },
    },
    // tasks: created, then polled to completion
    {
      ts: ts(30),
      seq: 4,
      from: 'client',
      method: 'tools/call',
      id: 3,
      durationMs: 1,
      params: { name: 'slow', arguments: {} },
      result: { resultType: 'task', taskId: 't1', status: 'working' },
    },
    {
      ts: ts(40),
      seq: 5,
      from: 'client',
      method: 'tasks/get',
      id: 4,
      durationMs: 1,
      params: { taskId: 't1' },
      result: { taskId: 't1', status: 'working' },
    },
    {
      ts: ts(50),
      seq: 6,
      from: 'client',
      method: 'tasks/get',
      id: 5,
      durationMs: 1,
      params: { taskId: 't1' },
      result: {
        taskId: 't1',
        status: 'completed',
        result: { content: [{ type: 'text', text: 'done' }] },
      },
    },
    // 2025 elicitation: a server→client request while the call is pending
    {
      ts: ts(61),
      seq: 8,
      from: 'server',
      method: 'elicitation/create',
      id: 0,
      durationMs: 1,
      params: { message: 'Sure?' },
      result: { action: 'decline' },
    },
    {
      ts: ts(60),
      seq: 7,
      from: 'client',
      method: 'tools/call',
      id: 6,
      durationMs: 5,
      params: { name: 'legacy', arguments: {} },
      result: { content: [] },
    },
    {
      ts: ts(70),
      seq: 9,
      from: 'client',
      method: 'resources/read',
      id: 7,
      durationMs: 1,
      params: { uri: 'fixture://readme' },
      result: { contents: [] },
    },
  ]

  it('merges MRTR retries, task polls and legacy server requests into calls', () => {
    const calls = reconstructCalls(entries)
    expect(calls.map((c) => [c.index, c.method, c.target])).toEqual([
      [1, 'tools/call', 'confirm'],
      [2, 'tools/call', 'slow'],
      [3, 'tools/call', 'legacy'],
      [4, 'resources/read', 'fixture://readme'],
    ])
    expect(calls[0]).toMatchObject({
      respond: { 'elicitation/create': { action: 'accept' } },
      inputRequests: [{ confirm: { method: 'elicitation/create' } }],
      result: { content: [{ text: 'confirmed: go' }] },
    })
    expect(calls[1]).toMatchObject({ taskAwaited: true, result: { content: [{ text: 'done' }] } })
    expect(calls[2]).toMatchObject({ respond: { 'elicitation/create': { action: 'decline' } } })
    expect(calls[2].inputRequests).toHaveLength(1)
  })

  it('selects by index, range, name and all', () => {
    const calls = reconstructCalls(entries)
    expect(selectCalls(calls, ['1,4']).picked.map((c) => c.index)).toEqual([1, 4])
    expect(selectCalls(calls, ['2-3']).picked.map((c) => c.index)).toEqual([2, 3])
    expect(selectCalls(calls, ['slow']).picked.map((c) => c.index)).toEqual([2])
    expect(selectCalls(calls, ['all']).picked).toHaveLength(4)
    expect(selectCalls(calls, ['nope', '9']).unmatched).toEqual(['nope', '9'])
  })

  it('parses capture text and reports bad lines', () => {
    const parsed = parseTapText(`${JSON.stringify(entries[0])}\nnot json\n\n{"x":1}\n`)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.badLines).toEqual([2, 4])
  })
})

describe('runTapProxy (in-process streams)', () => {
  it('forwards bytes unchanged both ways and records calls', async () => {
    const out = path.join(tmpDir(), 'cap.ndjson')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const received: Buffer[] = []
    stdout.on('data', (c: Buffer) => received.push(c))
    const done = runTapProxy({ cmd: 'node', args: [ECHO], out, stdin, stdout, stderr, quiet: true })
    const request = (id: number, method: string, params: unknown, meta = true) =>
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: meta
          ? {
              ...(params as object),
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
              },
            }
          : params,
      })}\n`
    // split one message across writes to exercise partial-line handling
    const call = request(1, 'tools/call', { name: 'echo', arguments: { text: 'raw bytes' } })
    stdin.write(call.slice(0, 17))
    stdin.write(call.slice(17))
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain('raw bytes'), {
      timeout: 5000,
    })
    stdin.end()
    const result = await done
    expect(result.exitCode).toBe(0)
    const response = JSON.parse(Buffer.concat(received).toString().trim().split('\n')[0])
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'raw bytes' }] },
    })
    const { entries } = readTapFile(out)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      from: 'client',
      method: 'tools/call',
      id: 1,
      params: { name: 'echo' },
      result: { content: [{ text: 'raw bytes' }] },
    })
  }, 20_000)

  it('exits 127 with a hint when the command cannot start', async () => {
    const stderr = new PassThrough()
    let text = ''
    stderr.on('data', (c: Buffer) => {
      text += c.toString()
    })
    const result = await runTapProxy({
      cmd: 'definitely-not-a-real-command-xyz',
      out: path.join(tmpDir(), 'x.ndjson'),
      stdin: Readable.from([]),
      stdout: new PassThrough(),
      stderr,
    })
    expect(result.exitCode).not.toBe(0)
    if (process.platform !== 'win32') expect(text).toMatch(/could not start/)
  }, 20_000)
})

describe('vib tap with a real McpSession client', () => {
  let bundle: string

  beforeAll(() => {
    // Bundle the tap command so a child `node` process can run it (vitest transforms TS
    // only in-process). Dependencies stay external and resolve from the repo's node_modules.
    const dir = path.join(ROOT, 'node_modules', '.cache', 'vibrissa-tap-test')
    fs.mkdirSync(dir, { recursive: true })
    const entry = path.join(dir, 'entry.ts')
    const tapModule = JSON.stringify(path.join(ROOT, 'src/cli/tap.ts').replace(/\\/g, '/'))
    fs.writeFileSync(
      entry,
      `import { tapCommand } from ${tapModule}\ntapCommand(process.argv.slice(2)).then((code) => process.exit(code))\n`,
    )
    bundle = path.join(dir, 'tap.mjs')
    buildSync({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'error',
    })
  })

  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  async function session(out: string, protocol: 'modern' | 'legacy'): Promise<McpSession> {
    const server: ServerConfig = {
      cmd: 'node',
      args: [bundle, '--out', out, '--', 'node', ECHO],
      protocol,
    }
    return McpSession.start(server, { timeoutMs: 8000, stderr: 'capture' })
  }

  async function entriesWhen(out: string, ready: (e: TapEntry[]) => boolean): Promise<TapEntry[]> {
    let entries: TapEntry[] = []
    await vi.waitFor(
      () => {
        entries = fs.existsSync(out) ? readTapFile(out).entries : []
        expect(ready(entries)).toBe(true)
      },
      { timeout: 5000 },
    )
    return entries
  }

  it('captures tools/call, resources/read, prompts/get and context (2026 era)', async () => {
    const dir = tmpDir()
    const out = path.join(dir, 'capture.ndjson')
    const s = await session(out, 'modern')
    try {
      expect(s.era).toBe('modern')
      expect((await s.callTool('echo', { text: 'through the tap' })).kind).toBe('result')
      expect((await s.readResource('fixture://readme')).kind).toBe('result')
      expect((await s.getPrompt('greet', { name: 'Jo' })).kind).toBe('result')
      const confirmed = await s.callTool('confirm', { action: 'ship' }, { respond: CONFIRM })
      expect(confirmed.kind).toBe('result')
      expect((await s.callTool('echo', {})).kind).toBe('error')
    } finally {
      await s.close()
    }
    const entries = await entriesWhen(
      out,
      (e) => e.filter((x) => x.method === 'tools/call').length >= 4,
    )
    const methods = entries.map((e) => e.method)
    expect(methods).toEqual(
      expect.arrayContaining(['server/discover', 'tools/call', 'resources/read', 'prompts/get']),
    )
    const echo = entries.find(
      (e) => e.method === 'tools/call' && (e.params as { name: string }).name === 'echo',
    )
    expect(echo).toMatchObject({
      from: 'client',
      result: { content: [{ type: 'text', text: 'through the tap' }] },
    })
    expect(typeof echo?.durationMs).toBe('number')
    expect(Date.parse(echo?.ts ?? '')).not.toBeNaN()
    expect(
      entries.some((e) => e.error !== undefined && (e.error as { code: number }).code === -32602),
    ).toBe(true)

    const calls = reconstructCalls(entries)
    const confirm = calls.find((c) => c.target === 'confirm')
    expect(confirm).toMatchObject({
      respond: CONFIRM,
      result: { content: [{ text: 'confirmed: ship' }] },
    })

    // ...and record --from-tap turns them into cases.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    spies.push(log)
    // Without --select: list the calls (1-based) and write nothing.
    expect(await recordCommand(['--from-tap', out, '--config', FIXTURE_CONFIG, '--json'])).toBe(0)
    const listing = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      calls: Array<{ index: number; target: string }>
      written: unknown[]
      hint: string
    }
    expect(listing.calls.map((c) => c.index)).toEqual(listing.calls.map((_, i) => i + 1))
    expect(listing.calls.map((c) => c.target)).toEqual(
      expect.arrayContaining(['echo', 'fixture://readme', 'greet', 'confirm']),
    )
    expect(listing.written).toEqual([])
    expect(listing.hint).toMatch(/--select/)
    const casesDir = path.join(dir, 'cases')
    const code = await recordCommand([
      '--from-tap',
      out,
      '--select',
      'all',
      '--out-dir',
      casesDir,
      '--config',
      FIXTURE_CONFIG,
      '--json',
    ])
    expect(code).toBe(0)
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      written: Array<{ path: string; case: TestCase }>
    }
    const byTarget = new Map(
      report.written.map((w) => [w.case.tool ?? w.case.resource ?? w.case.prompt, w.case]),
    )
    expect(byTarget.get('fixture://readme')?.expect).toMatchObject({
      contents: [{ text: 'Vibrissa echo fixture' }],
    })
    expect(byTarget.get('greet')).toMatchObject({ prompt: 'greet', args: { name: 'Jo' } })
    expect(byTarget.get('confirm')).toMatchObject({
      respond: CONFIRM,
      expectInputRequired: { 'elicitation/create': { message: 'Proceed with ship?' } },
      expect: { content: [{ type: 'text', text: 'confirmed: ship' }] },
    })
    const files = fs.readdirSync(casesDir)
    expect(files.length).toBe(report.written.length)
    const echoCases = report.written.filter((w) => w.case.tool === 'echo').map((w) => w.case)
    expect(echoCases.some((c) => c.expectError?.code === 'InvalidParams')).toBe(true)
    expect(echoCases.some((c) => c.expect !== undefined && c.tags?.includes('tap'))).toBe(true)
  }, 30_000)

  it('captures 2025-era server→client elicitation requests', async () => {
    const out = path.join(tmpDir(), 'legacy.ndjson')
    const s = await session(out, 'legacy')
    try {
      expect(s.era).toBe('legacy')
      expect((await s.callTool('confirm', { action: 'old' }, { respond: CONFIRM })).kind).toBe(
        'result',
      )
    } finally {
      await s.close()
    }
    const entries = await entriesWhen(out, (e) => e.some((x) => x.method === 'tools/call'))
    expect(entries.map((e) => e.method)).toContain('initialize')
    const calls = reconstructCalls(entries)
    expect(calls).toHaveLength(1)
    expect(calls[0].respond).toEqual(CONFIRM)
    expect(calls[0].result).toMatchObject({ content: [{ text: 'confirmed: old' }] })
  }, 30_000)
})

describe('tap capture file housekeeping', () => {
  it('creates the capture even when nothing is captured, and says so', async () => {
    const out = path.join(tmpDir(), 'nested', 'empty.ndjson')
    const stderr = new PassThrough()
    let text = ''
    stderr.on('data', (c: Buffer) => {
      text += c.toString()
    })
    const stdin = new PassThrough()
    const done = runTapProxy({
      cmd: 'node',
      args: [ECHO],
      out,
      stdin,
      stdout: new PassThrough(),
      stderr,
    })
    stdin.end()
    const result = await done
    expect(result.entries).toBe(0)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.readFileSync(out, 'utf8')).toBe('')
    expect(text).toMatch(/nothing captured/)
  }, 20_000)

  it('continues seq when appending to an existing capture', async () => {
    const out = path.join(tmpDir(), 'seq.ndjson')
    fs.writeFileSync(
      out,
      `${JSON.stringify({ ts: new Date().toISOString(), seq: 41, from: 'client', method: 'tools/list', id: 1, result: {}, durationMs: 1 })}\n`,
    )
    expect(lastSeq(out)).toBe(41)
    const recorder = new TapRecorder(() => {}, lastSeq(out))
    const entries: TapEntry[] = []
    const r2 = new TapRecorder((e) => entries.push(e), lastSeq(out))
    r2.observe('client', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })
    r2.observe('server', { jsonrpc: '2.0', id: 1, result: {} })
    expect(entries[0].seq).toBe(42)
    expect(recorder).toBeDefined()
    expect(lastSeq(path.join(tmpDir(), 'missing.ndjson'))).toBe(0)
  })

  it('lists isError results as errors in --from-tap', () => {
    const calls = reconstructCalls([
      {
        ts: new Date().toISOString(),
        seq: 1,
        from: 'client',
        method: 'tools/call',
        id: 1,
        params: { name: 'fail', arguments: {} },
        result: { content: [{ type: 'text', text: 'nope' }], isError: true },
        durationMs: 1,
      },
    ])
    expect(tapCallStatus(calls[0])).toBe('error')
  })
})
