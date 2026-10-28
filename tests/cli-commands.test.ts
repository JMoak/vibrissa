import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { describeError, endSentence, main } from '../src/cli'
import { callCommand } from '../src/cli/call'
import { checkCommand } from '../src/cli/check'
import { discoverCommand } from '../src/cli/discover'
import { explainCommand } from '../src/cli/explain'
import { fuzzCommand } from '../src/cli/fuzz'
import { getPromptCommand } from '../src/cli/get-prompt'
import { initCommand } from '../src/cli/init'
import { conformanceCommand } from '../src/cli/inspect'
import { migrateCommand } from '../src/cli/migrate'
import { promptsCommand } from '../src/cli/prompts'
import { readCommand } from '../src/cli/read'
import { recordCommand } from '../src/cli/record'
import { resourcesCommand } from '../src/cli/resources'
import { toolsCommand } from '../src/cli/tools'
import { loadConfig } from '../src/config'
import { SessionStartError } from '../src/session/index'
import type { TestCase } from '../src/types'

const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/echo-server')
const fixtureConfig = path.join(FIXTURE_DIR, 'vibrissa.json')
const CONFIRM_ACCEPT = '{"elicitation/create":{"action":"accept","content":{"confirm":true}}}'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-cli-'))
}

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

/** Silence console output; `json()` parses the last console.log call as JSON. */
function capture() {
  for (const spy of spies.splice(0)) spy.mockRestore()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  spies.push(log, err, warn)
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test payloads are inspected structurally
    json: (): any => JSON.parse(String(log.mock.calls[log.mock.calls.length - 1][0])),
    out: () => log.mock.calls.map((c) => String(c[0])).join('\n'),
    err: () => err.mock.calls.map((c) => String(c[0])).join('\n'),
    warn: () => warn.mock.calls.map((c) => String(c[0])).join('\n'),
  }
}

function readJson(file: string): TestCase {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TestCase
}

describe('explore commands', () => {
  it('discover --json emits the DiscoverInfo', async () => {
    const io = capture()
    expect(await discoverCommand(['--config', fixtureConfig, '--json'])).toBe(0)
    const info = io.json()
    expect(info).toMatchObject({
      era: 'modern',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'vibrissa-echo-fixture', version: '2.0.0' },
      synthesized: false,
    })
    expect(info.extensions).toContain('io.modelcontextprotocol/tasks')
    expect(info.instructions).toMatch(/Fixture server/)
    expect(info.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  })

  it('discover pretty output names era, server and capabilities (legacy too)', async () => {
    const io = capture()
    expect(await discoverCommand(['--config', fixtureConfig, '--protocol', 'legacy'])).toBe(0)
    const text = io.out()
    expect(text).toMatch(/server\s+vibrissa-echo-fixture 2\.0\.0/)
    expect(text).toMatch(/legacy era, from initialize/)
    expect(text).toMatch(/capabilities\s+.*tools/)
    expect(text).toContain('Fixture server for Vibrissa tests.')
  })

  it('tools --json lists every tool with list cache metadata', async () => {
    const io = capture()
    expect(await toolsCommand(['--config', fixtureConfig, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload.tools.map((t: { name: string }) => t.name)).toEqual([
      'echo',
      'fail',
      'confirm',
      'slow',
      'typed',
      'sleep',
    ])
    expect(
      payload.tools.find((t: { name: string }) => t.name === 'typed').outputSchema,
    ).toBeDefined()
    expect(payload.listMeta.tools).toMatchObject({ ttlMs: 60000, cacheScope: 'public' })
  })

  it('tools prints a table with arg summaries and hints', async () => {
    const io = capture()
    expect(await toolsCommand(['--config', fixtureConfig])).toBe(0)
    const text = io.out()
    expect(text).toMatch(/6 tools {2}cache: 60000 ms \(public\)/)
    expect(text).toMatch(
      /echo\s+Echo\s+Echo text back, optionally uppercased\s+text\*: string, uppercase: boolean\s+read-only/,
    )
    expect(text).toMatch(/typed .*a\*: number, b\*: number, broken: boolean\s+structured/)
  })

  it('resources --json lists resources and templates', async () => {
    const io = capture()
    expect(await resourcesCommand(['--config', fixtureConfig, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload.resources).toEqual([
      expect.objectContaining({ uri: 'fixture://readme', mimeType: 'text/plain' }),
    ])
    expect(payload.resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'fixture://users/{id}' }),
    ])
    expect(payload.listMeta).toHaveProperty('resources')
    expect(payload.listMeta).toHaveProperty('resourceTemplates')
  })

  it('prompts --json lists prompts with arguments', async () => {
    const io = capture()
    expect(await promptsCommand(['--config', fixtureConfig, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload.prompts[0]).toMatchObject({
      name: 'greet',
      arguments: [
        { name: 'name', required: true },
        { name: 'style', required: false },
      ],
    })
    expect(payload.listMeta).toHaveProperty('prompts')
  })
})

describe('probe commands', () => {
  it('call returns the normalized tool result', async () => {
    const io = capture()
    const code = await callCommand([
      'echo',
      '--config',
      fixtureConfig,
      '--args',
      '{"text":"hi","uppercase":true}',
      '--json',
    ])
    expect(code).toBe(0)
    const payload = io.json()
    expect(payload).toMatchObject({
      ok: true,
      kind: 'result',
      operation: 'tool',
      target: 'echo',
      normalized: true,
    })
    expect(payload.result).toEqual({ content: [{ type: 'text', text: 'HI' }] })
  })

  it('call --raw keeps the wire envelope', async () => {
    const io = capture()
    expect(
      await callCommand(['echo', '--config', fixtureConfig, '--arg', 'text=x', '--raw', '--json']),
    ).toBe(0)
    expect(io.json().result.resultType).toBe('complete')
  })

  it('call reports an unanswered input request with a ready --respond hint', async () => {
    const io = capture()
    expect(
      await callCommand(['confirm', '--config', fixtureConfig, '--arg', 'action=deploy', '--json']),
    ).toBe(1)
    const payload = io.json()
    expect(payload.kind).toBe('input_required')
    expect(payload.requests.confirm).toMatchObject({
      method: 'elicitation/create',
      params: { message: 'Proceed with deploy?' },
    })
    expect(payload.hint).toContain(
      `--respond '{"elicitation/create":{"action":"accept","content":{"confirm":true}}}'`,
    )
  })

  it('call --respond answers the input request', async () => {
    const io = capture()
    expect(
      await callCommand([
        'confirm',
        '--config',
        fixtureConfig,
        '--arg',
        'action=deploy',
        '--respond',
        CONFIRM_ACCEPT,
        '--json',
      ]),
    ).toBe(0)
    const payload = io.json()
    expect(payload.result).toEqual({ content: [{ type: 'text', text: 'confirmed: deploy' }] })
    expect(payload.inputRequests).toHaveLength(1)
  })

  it('call --await polls a task to completion', async () => {
    const io = capture()
    expect(
      await callCommand([
        'slow',
        '--config',
        fixtureConfig,
        '--args',
        '{"ms":30,"text":"job"}',
        '--await',
        '--json',
      ]),
    ).toBe(0)
    const payload = io.json()
    expect(payload.result).toEqual({ content: [{ type: 'text', text: 'done: job' }] })
    expect(payload.task).toMatchObject({ taskId: expect.any(String) })
  })

  it('call --validate checks structuredContent against outputSchema', async () => {
    let io = capture()
    expect(
      await callCommand([
        'typed',
        '--config',
        fixtureConfig,
        '--args',
        '{"a":1,"b":2}',
        '--validate',
        '--json',
      ]),
    ).toBe(0)
    expect(io.json().validation).toEqual({ checked: true, ok: true })
    io = capture()
    expect(
      await callCommand([
        'typed',
        '--config',
        fixtureConfig,
        '--args',
        '{"a":1,"b":2,"broken":true}',
        '--validate',
        '--json',
      ]),
    ).toBe(1)
    const payload = io.json()
    expect(payload.ok).toBe(false)
    expect(payload.validation).toMatchObject({ checked: true, ok: false })
    expect(payload.validation.errors[0].path).toBe('structuredContent.sum')
  })

  it('call reports protocol errors with a hint and exit 1', async () => {
    const io = capture()
    expect(await callCommand(['echo', '--config', fixtureConfig, '--json'])).toBe(1)
    const payload = io.json()
    expect(payload.error).toMatchObject({
      kind: 'protocol',
      code: -32602,
      codeName: 'InvalidParams',
      type: 'ToolError',
    })
    expect(payload.error.hint).toMatch(/inputSchema/)
    expect(payload.hint).toBeUndefined()
  })

  it('read reads a resource and expands templates', async () => {
    let io = capture()
    expect(await readCommand(['fixture://readme', '--config', fixtureConfig, '--json'])).toBe(0)
    expect(io.json().result.contents[0]).toMatchObject({
      uri: 'fixture://readme',
      text: 'Vibrissa echo fixture',
    })
    io = capture()
    expect(
      await readCommand([
        'fixture://users/{id}',
        '--arg',
        'id=42',
        '--config',
        fixtureConfig,
        '--json',
      ]),
    ).toBe(0)
    const payload = io.json()
    expect(payload).toMatchObject({ operation: 'resourceTemplate', uri: 'fixture://users/42' })
    expect(JSON.parse(payload.result.contents[0].text)).toEqual({ id: '42', name: 'user-42' })
  })

  it('get-prompt returns prompt messages (args sent as strings)', async () => {
    const io = capture()
    expect(
      await getPromptCommand([
        'greet',
        '--arg',
        'name=Jordan',
        '--arg',
        'style=terse',
        '--config',
        fixtureConfig,
        '--json',
      ]),
    ).toBe(0)
    expect(io.json().result.messages[0].content.text).toBe('Say hello to Jordan in a terse way.')
  })
})

describe('record', () => {
  it('record writes a case file from a live call', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'echo.recorded.json')
    const io = capture()
    const code = await recordCommand([
      'echo',
      '--config',
      fixtureConfig,
      '--arg',
      'text=hello',
      '--name',
      'echo recorded',
      '--out',
      out,
      '--json',
    ])
    expect(code).toBe(0)
    const written = readJson(out)
    expect(written).toMatchObject({ name: 'echo recorded', tool: 'echo', args: { text: 'hello' } })
    expect(written.expect).toEqual({ content: [{ type: 'text', text: 'hello' }] })
    expect(written.$schema).toMatch(/@jmoak\/vibrissa\/schema\/case\.schema\.json$/)
    expect(io.json()).toMatchObject({ ok: true, path: out })
  })

  it('record refuses to overwrite without --force', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'exists.json')
    fs.writeFileSync(out, '{}\n', 'utf8')
    capture()
    await expect(
      recordCommand(['echo', '--config', fixtureConfig, '--arg', 'text=x', '--out', out]),
    ).rejects.toThrow(/--force/)
    expect(fs.readFileSync(out, 'utf8')).toBe('{}\n')
  })

  it('record captures errors into expectError', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'fail.json')
    capture()
    expect(
      await recordCommand([
        'fail',
        '--config',
        fixtureConfig,
        '--arg',
        'message=boom goes',
        '--out',
        out,
      ]),
    ).toBe(0)
    expect(readJson(out).expectError).toEqual({ message: { $regex: 'boom goes' } })
    const bad = path.join(tmp, 'bad.json')
    expect(await recordCommand(['echo', '--config', fixtureConfig, '--out', bad])).toBe(0)
    expect(readJson(bad).expectError).toMatchObject({ code: 'InvalidParams' })
  })

  it('record --resource, --resource-template and --prompt', async () => {
    const tmp = mkTmpDir()
    capture()
    const res = path.join(tmp, 'res.json')
    expect(
      await recordCommand([
        '--resource',
        'fixture://readme',
        '--config',
        fixtureConfig,
        '--out',
        res,
      ]),
    ).toBe(0)
    expect(readJson(res)).toMatchObject({
      resource: 'fixture://readme',
      expect: {
        contents: [
          { uri: 'fixture://readme', mimeType: 'text/plain', text: 'Vibrissa echo fixture' },
        ],
      },
    })
    const tpl = path.join(tmp, 'tpl.json')
    expect(
      await recordCommand([
        '--resource-template',
        'fixture://users/{id}',
        '--arg',
        'id=7',
        '--config',
        fixtureConfig,
        '--out',
        tpl,
      ]),
    ).toBe(0)
    expect(readJson(tpl)).toMatchObject({
      resourceTemplate: 'fixture://users/{id}',
      args: { id: 7 },
    })
    const missing = path.join(tmp, 'missing.json')
    expect(
      await recordCommand([
        '--resource-template',
        'fixture://users/{id}',
        '--arg',
        'id=404',
        '--config',
        fixtureConfig,
        '--out',
        missing,
      ]),
    ).toBe(0)
    expect(readJson(missing).expectError).toMatchObject({ code: 'ResourceNotFound' })
    const prompt = path.join(tmp, 'prompt.json')
    expect(
      await recordCommand([
        '--prompt',
        'greet',
        '--arg',
        'name=Jo',
        '--config',
        fixtureConfig,
        '--out',
        prompt,
        '--partial',
      ]),
    ).toBe(0)
    const written = readJson(prompt)
    expect(written).toMatchObject({ prompt: 'greet', args: { name: 'Jo' } })
    expect(written.expect).toMatchObject({ $partial: true, messages: [{ role: 'user' }] })
  })

  it('record with --respond writes respond + expectInputRequired (method view)', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'confirm.json')
    capture()
    expect(
      await recordCommand([
        'confirm',
        '--arg',
        'action=deploy',
        '--respond',
        CONFIRM_ACCEPT,
        '--config',
        fixtureConfig,
        '--out',
        out,
      ]),
    ).toBe(0)
    const written = readJson(out)
    expect(written.respond).toEqual(JSON.parse(CONFIRM_ACCEPT))
    expect(written.expectInputRequired).toMatchObject({
      'elicitation/create': { message: 'Proceed with deploy?' },
    })
    expect(written.expect).toEqual({ content: [{ type: 'text', text: 'confirmed: deploy' }] })
  })

  it('record fails non-interactively on an unanswered input request, with a hint', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'confirm.json')
    const io = capture()
    expect(
      await recordCommand(
        ['confirm', '--arg', 'action=x', '--config', fixtureConfig, '--out', out, '--json'],
        { interactive: false },
      ),
    ).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
    expect(io.json()).toMatchObject({ ok: false, kind: 'input_required' })
    expect(io.json().hint).toMatch(/--respond/)
  })

  it('record asks for input interactively; Enter accepts the suggested answer', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'confirm.json')
    capture()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    spies.push(stderr)
    const stdin = Readable.from(['\n'])
    const code = await recordCommand(
      ['confirm', '--arg', 'action=deploy', '--config', fixtureConfig, '--out', out],
      { stdin, interactive: true },
    )
    expect(code).toBe(0)
    const prompts = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(prompts).toContain('the server asks for input')
    expect(prompts).toContain('Proceed with deploy?')
    const written = readJson(out)
    expect(written.respond).toEqual(JSON.parse(CONFIRM_ACCEPT))
    expect(written.expect).toEqual({ content: [{ type: 'text', text: 'confirmed: deploy' }] })
  })

  it('record --flow interactively accepts tool lines and retries bad input', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'flow.json')
    const io = capture()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    spies.push(stderr)
    const stdin = Readable.from([
      'echo text=one\n',
      'echo text\n',
      'echo text=two uppercase=true\n',
      '\n',
    ])
    expect(
      await recordCommand(['--flow', '--config', fixtureConfig, '--out', out], {
        stdin,
        interactive: true,
      }),
    ).toBe(0)
    const written = readJson(out)
    expect(written.steps?.map((s) => s.args)).toEqual([
      { text: 'one' },
      { text: 'two', uppercase: true },
    ])
    expect(written.steps?.[1].expect).toEqual({ content: [{ type: 'text', text: 'TWO' }] })
    expect(io.out()).toMatch(/expected key=value/)
  })

  it('record --await records the final task result', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'slow.json')
    capture()
    expect(
      await recordCommand([
        'slow',
        '--args',
        '{"ms":20,"text":"job"}',
        '--await',
        '--config',
        fixtureConfig,
        '--out',
        out,
      ]),
    ).toBe(0)
    expect(readJson(out)).toMatchObject({
      await: true,
      expect: { content: [{ type: 'text', text: 'done: job' }] },
    })
    const noAwait = path.join(tmp, 'slow-task.json')
    expect(
      await recordCommand([
        'slow',
        '--args',
        '{"ms":20}',
        '--config',
        fixtureConfig,
        '--out',
        noAwait,
      ]),
    ).toBe(0)
    const task = readJson(noAwait)
    expect(task.expectTask).toMatchObject({ $partial: true, taskId: { $type: 'string' } })
    expect(task.expect).toBeUndefined()
  })

  it('record --flow reads NDJSON steps from stdin', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'flow.json')
    const io = capture()
    const stdin = Readable.from([
      '{"tool": "echo", "args": {"text": "hello"}}\n',
      'typed {"a": 2, "b": 3}\n',
      `{"tool": "confirm", "args": {"action": "ship"}, "respond": ${CONFIRM_ACCEPT}}\n`,
      '\n',
    ])
    expect(
      await recordCommand(
        ['--flow', '--name', 'my flow', '--config', fixtureConfig, '--out', out, '--json'],
        { stdin, interactive: false },
      ),
    ).toBe(0)
    const written = readJson(out)
    expect(written.name).toBe('my flow')
    expect(written.steps).toHaveLength(3)
    expect(written.steps?.[0]).toMatchObject({
      tool: 'echo',
      expect: { content: [{ text: 'hello' }] },
    })
    expect(written.steps?.[1]).toMatchObject({
      tool: 'typed',
      expect: { structuredContent: { sum: 5 } },
    })
    expect(written.steps?.[2]).toMatchObject({
      tool: 'confirm',
      respond: JSON.parse(CONFIRM_ACCEPT),
      expect: { content: [{ text: 'confirmed: ship' }] },
    })
    expect(io.json()).toMatchObject({ ok: true, path: out })
  })

  it('record --flow fails with a hint when a step needs input and has no respond', async () => {
    const tmp = mkTmpDir()
    const out = path.join(tmp, 'flow.json')
    const io = capture()
    const stdin = Readable.from(['{"tool": "confirm", "args": {}}\n'])
    expect(
      await recordCommand(['--flow', '--config', fixtureConfig, '--out', out, '--json'], {
        stdin,
        interactive: false,
      }),
    ).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
    expect(io.json().hint).toMatch(/"respond"/)
  })
})

describe('check', () => {
  it('check --json reports outcomes grouped by status', async () => {
    const io = capture()
    const code = await checkCommand(['--config', fixtureConfig, '--json'])
    const payload = io.json()
    expect(code).toBe(payload.ok ? 0 : 1)
    expect(payload).toMatchObject({
      server: 'echo',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'vibrissa-echo-fixture' },
    })
    expect(payload.summary.passed).toBeGreaterThan(0)
    const ids = payload.outcomes.map((o: { id: string }) => o.id)
    expect(ids).toContain('spec/tools-list-stable')
    expect(ids).toContain('desc/hidden-instructions')
    expect(payload.outcomes.every((o: { server: string }) => o.server === 'echo')).toBe(true)
    const stable = payload.outcomes.find((o: { id: string }) => o.id === 'spec/tools-list-stable')
    expect(stable.status).toBe('passed')
  })

  it('check honors "checks" from the resolved config (base + profile), without warnings', async () => {
    // A 2025-era server: spec/list-cache-metadata reports an informational "skipped" warning.
    const crashy = path.join(process.cwd(), 'tests/fixtures/cli/crashy-server.js')
    const tmp = mkTmpDir()
    const config = path.join(tmp, 'vibrissa.json')
    const write = (extra: Record<string, unknown>) =>
      fs.writeFileSync(
        config,
        JSON.stringify({
          servers: { crashy: { cmd: 'node', args: [crashy], protocol: 'legacy' } },
          ...extra,
        }),
      )
    const statusOf = (payload: { outcomes: Array<{ id: string; status: string }> }, id: string) =>
      payload.outcomes.find((o) => o.id === id)?.status
    write({})
    let io = capture()
    await checkCommand(['--config', config, '--json'])
    expect(statusOf(io.json(), 'spec/list-cache-metadata')).toBe('warned')

    write({
      checks: { allow: ['spec/server-identity'] },
      profiles: { quiet: { checks: { allow: ['spec/list-cache-metadata'] } } },
    })
    io = capture()
    await checkCommand(['--config', config, '--json'])
    expect(statusOf(io.json(), 'spec/list-cache-metadata')).toBe('warned')
    expect(io.warn()).not.toMatch(/Unknown config key/)
    io = capture()
    await checkCommand(['--config', config, '--profile', 'quiet', '--json'])
    // profile allow lists accumulate over the base list
    expect(statusOf(io.json(), 'spec/list-cache-metadata')).not.toBe('warned')
    expect(io.warn()).not.toMatch(/Unknown config key/)
  })

  it('check --allow skips checks; --list lists them', async () => {
    let io = capture()
    await checkCommand([
      '--config',
      fixtureConfig,
      '--json',
      '--allow',
      'spec/*',
      '--allow',
      'desc/*',
    ])
    expect(io.json().summary.failed).toBe(0)
    io = capture()
    expect(await checkCommand(['--list', '--json'])).toBe(0)
    expect(io.json().checks.map((c: { id: string }) => c.id)).toContain('desc/tool-shadowing')
  })
})

describe('fuzz', () => {
  it('fuzz passes a tool that validates its inputs (exit 0)', async () => {
    const io = capture()
    const code = await fuzzCommand([
      'echo',
      '--runs',
      '30',
      '--seed',
      '7',
      '--config',
      fixtureConfig,
      '--json',
    ])
    const payload = io.json()
    expect(payload).toMatchObject({
      ok: true,
      tool: 'echo',
      seed: '7',
      runs: 30,
      strategies: ['valid', 'boundary', 'invalid'],
      failures: [],
    })
    expect(code).toBe(0)
    expect(payload.generated).toBeGreaterThan(5)
    expect(payload.cases).toHaveLength(payload.generated)
    const rows = new Map(payload.invariants.map((r: { id: string }) => [r.id, r]))
    expect(rows.get('invalid-args-yield-invalid-params')).toMatchObject({ failed: 0 })
    expect(
      (rows.get('invalid-args-yield-invalid-params') as { passed: number }).passed,
    ).toBeGreaterThan(0)
    expect(payload.runChecks).toEqual([
      expect.objectContaining({ id: 'server-alive', ok: true }),
      expect.objectContaining({ id: 'tools-list-unchanged', ok: true }),
    ])
    expect(payload.reproduce).toBe('vib fuzz echo --seed 7 --runs 30')
  }, 60_000)

  it('fuzz reports outputSchema violations with reproduce commands (exit 1)', async () => {
    const io = capture()
    const code = await fuzzCommand([
      'typed',
      '--runs',
      '30',
      '--seed',
      '7',
      '--config',
      fixtureConfig,
      '--json',
    ])
    const payload = io.json()
    expect(code).toBe(1)
    expect(payload.ok).toBe(false)
    // `typed` returns a string sum when broken: true, violating its outputSchema.
    const broken = payload.failures.find((f: { failed: Array<{ invariant: string }> }) =>
      f.failed.some((v) => v.invariant === 'output-matches-output-schema'),
    )
    expect(broken).toBeDefined()
    expect(broken.args.broken).toBe(true)
    expect(broken.reproduce).toBe(`vib fuzz typed --seed 7 --runs 30 --id ${broken.id}`)
    const row = payload.invariants.find(
      (r: { id: string }) => r.id === 'output-matches-output-schema',
    )
    expect(row.failed).toBeGreaterThan(0)
  }, 60_000)

  it('fuzz --id reproduces one case; --record-failures writes replayable cases', async () => {
    let io = capture()
    await fuzzCommand(['typed', '--runs', '30', '--seed', '7', '--config', fixtureConfig, '--json'])
    const failure = io
      .json()
      .failures.find((f: { failed: Array<{ level: string }> }) =>
        f.failed.some((v) => v.level === 'error'),
      )
    io = capture()
    const tmp = mkTmpDir()
    const code = await fuzzCommand([
      'typed',
      '--runs',
      '30',
      '--seed',
      '7',
      '--id',
      failure.id,
      '--record-failures',
      '--out-dir',
      tmp,
      '--config',
      fixtureConfig,
      '--json',
    ])
    expect(code).toBe(1)
    const payload = io.json()
    expect(payload.cases).toHaveLength(1)
    expect(payload.cases[0].id).toBe(failure.id)
    expect(payload.recorded).toEqual([
      { path: path.join(tmp, `typed-${failure.id}.json`), inSuite: false },
    ])
    expect(payload.notes[0]).toMatch(/outside the suite globs/)
    const written = readJson(payload.recorded[0].path)
    expect(written).toMatchObject({
      name: `fuzz ${failure.id}: ${failure.reason}`,
      tags: ['fuzz'],
      tool: 'typed',
      args: failure.args,
      // schema-valid args: the regression case expects a (schema-valid) success
      expect: { $partial: true },
    })
    expect(written.$schema).toMatch(/case\.schema\.json$/)
  }, 60_000)

  it('fuzz detects crashes, restarts the server and keeps going', async () => {
    const crashy = path.join(process.cwd(), 'tests/fixtures/cli/crashy-server.js')
    const io = capture()
    const code = await fuzzCommand([
      'fragile',
      '--runs',
      '12',
      '--seed',
      '1',
      '--config',
      fixtureConfig,
      '--server',
      `node "${crashy}"`,
      '--protocol',
      'legacy',
      '--json',
    ])
    expect(code).toBe(1)
    const payload = io.json()
    expect(payload.restarts).toBeGreaterThan(0)
    const crashes = payload.cases.filter(
      (c: { outcome: { kind: string } }) => c.outcome.kind === 'crash',
    )
    expect(crashes.length).toBe(payload.restarts)
    expect(crashes.every((c: { args: { crash: boolean } }) => c.args.crash === true)).toBe(true)
    const neverCrash = payload.invariants.find((r: { id: string }) => r.id === 'never-crash')
    expect(neverCrash.failed).toBe(crashes.length)
    // Cases after a crash still ran against the restarted server.
    expect(payload.cases.length).toBe(payload.generated)
    expect(payload.runChecks.find((r: { id: string }) => r.id === 'server-alive').ok).toBe(true)
  }, 60_000)

  it('fuzz flags outputSchema violations and unknown tools', async () => {
    capture()
    await expect(fuzzCommand(['ecoh', '--config', fixtureConfig])).rejects.toThrow(
      /Did you mean "echo"/,
    )
  })
})

describe('migrate', () => {
  function v1Project(): string {
    const tmp = mkTmpDir()
    fs.writeFileSync(
      path.join(tmp, 'vibrissa.json'),
      JSON.stringify({
        $schema: './node_modules/vibrissa/schema/vibrissa.schema.json',
        server: { cmd: 'node', args: [path.join(FIXTURE_DIR, 'server/index.js')] },
        globs: ['tests/integration/**/*.json'],
        timeoutMs: 3000,
      }),
    )
    const cases = path.join(tmp, 'tests', 'integration')
    fs.mkdirSync(path.join(cases, 'shared'), { recursive: true })
    fs.writeFileSync(
      path.join(cases, 'echo.json'),
      JSON.stringify({
        $schema: '../../node_modules/vibrissa/schema/case.schema.json',
        name: 'echo',
        tool: 'echo',
        args: { text: 'hi' },
        expect: { content: [{ type: 'text', text: 'hi' }] },
      }),
    )
    fs.writeFileSync(
      path.join(cases, 'slow.json'),
      JSON.stringify({
        name: 'slow',
        tool: 'sleep',
        args: { ms: 10 },
        expectError: { code: 'RequestTimedOut' },
      }),
    )
    fs.writeFileSync(
      path.join(cases, 'shared', 'fragment.json'),
      JSON.stringify({ $partial: true }),
    )
    return tmp
  }

  it('rewrites a v1 config and cases in place, then changes nothing', async () => {
    const tmp = v1Project()
    let io = capture()
    expect(await migrateCommand(['--config', path.join(tmp, 'vibrissa.json'), '--json'])).toBe(0)
    let payload = io.json()
    expect(payload.changes.map((c: { kind: string }) => c.kind).sort()).toEqual([
      'case',
      'case',
      'config',
    ])
    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'vibrissa.json'), 'utf8'))
    expect(config.server).toBeUndefined()
    expect(config.servers.default.cmd).toBe('node')
    expect(config.defaultServer).toBe('default')
    expect(config.$schema).toBe('https://unpkg.com/@jmoak/vibrissa/schema/vibrissa.schema.json')
    expect(readJson(path.join(tmp, 'tests/integration/slow.json')).expectError).toEqual({
      code: 'RequestTimeout',
    })
    expect(readJson(path.join(tmp, 'tests/integration/echo.json')).$schema).toBe(
      'https://unpkg.com/@jmoak/vibrissa/schema/case.schema.json',
    )
    // fragment files are not cases
    expect(
      JSON.parse(fs.readFileSync(path.join(tmp, 'tests/integration/shared/fragment.json'), 'utf8')),
    ).toEqual({ $partial: true })
    io = capture()
    expect(await migrateCommand(['--config', path.join(tmp, 'vibrissa.json'), '--json'])).toBe(0)
    payload = io.json()
    expect(payload.changes).toEqual([])
    expect(payload.unchanged).toBe(2)
  })

  it('--dry-run writes nothing; --manifest records the lock', async () => {
    const tmp = v1Project()
    const before = fs.readFileSync(path.join(tmp, 'vibrissa.json'), 'utf8')
    let io = capture()
    expect(
      await migrateCommand(['--config', path.join(tmp, 'vibrissa.json'), '--dry-run', '--json']),
    ).toBe(0)
    expect(io.json()).toMatchObject({ dryRun: true, hint: expect.stringMatching(/Dry run/) })
    expect(fs.readFileSync(path.join(tmp, 'vibrissa.json'), 'utf8')).toBe(before)
    io = capture()
    expect(await migrateCommand(['--config', path.join(tmp, 'vibrissa.json'), '--manifest'])).toBe(
      0,
    )
    expect(fs.existsSync(path.join(tmp, 'tests/integration/__manifest__.json'))).toBe(true)
  })
})

describe('init', () => {
  it('init scaffolds a v2 config, sample case and flow', async () => {
    const tmp = mkTmpDir()
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.0.0', scripts: {} }),
      'utf8',
    )
    capture()
    const code = await initCommand(['--dir', tmp, '--server', 'node server/index.js'])
    expect(code).toBe(0)
    // The server does not exist here, so the sample is a skipped placeholder.
    const sample = readJson(path.join(tmp, 'tests/integration/sample.json'))
    expect(sample.skip).toMatch(/^edit args for your server \(the server did not start/)
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toBe('reports/\n')
    const flow = readJson(path.join(tmp, 'tests/integration/flow.sample.json'))
    expect(flow.steps?.[0].capture).toEqual({ noteId: 'structuredContent.id' })
    expect(flow.skip).toMatch(/sample/)
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:integration']).toBe('vib run')
    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'vibrissa.json'), 'utf8'))
    expect(config.servers).toEqual({
      default: { cmd: 'node', args: ['server/index.js'], cwd: '.' },
    })
    expect(config.defaultServer).toBe('default')
    expect(config.profiles.ci).toEqual({
      reporters: ['console', 'github', 'junit', 'json'],
      check: true,
      requireManifest: true,
    })
    expect(fs.existsSync(path.join(tmp, '.github'))).toBe(false)
  })

  it('init --ci writes a GitHub workflow that runs the scaffolded ci profile', async () => {
    const tmp = mkTmpDir()
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"demo"}')
    const io = capture()
    expect(await initCommand(['--dir', tmp, '--ci', '--no-call', '--json'])).toBe(0)
    const workflow = fs.readFileSync(path.join(tmp, '.github/workflows/vibrissa.yml'), 'utf8')
    expect(workflow).toContain('- run: npm ci')
    expect(workflow).toContain('- run: npx vib run --profile ci\n')
    expect(workflow).toMatch(/upload-artifact@v4\n {8}if: failure\(\)\n[\s\S]*path: reports\//)
    expect(io.json().files.map((f: { what: string }) => f.what)).toContain('ci')
    // The ci profile resolves to the same reporters the workflow passes.
    const { options, warnings } = loadConfig(tmp, { profile: 'ci' })
    expect(warnings).toEqual([])
    expect(options.reporters).toEqual(['console', 'github', 'junit', 'json'])
    expect(options.check).toBe(true)
  })

  it('init --from-claude-config reads .mcp.json; Python and Go servers are detected', async () => {
    const claude = mkTmpDir()
    fs.writeFileSync(
      path.join(claude, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          notes: { command: 'uv', args: ['run', 'notes-mcp'], env: { NOTES_TOKEN: 'shh' } },
          web: { type: 'http', url: 'https://x.example/mcp' },
        },
      }),
    )
    let io = capture()
    expect(
      await initCommand(['--dir', claude, '--from-claude-config', '--no-call', '--json']),
    ).toBe(0)
    let payload = io.json()
    expect(payload.servers.notes).toEqual({
      cmd: 'uv',
      args: ['run', 'notes-mcp'],
      env: { NOTES_TOKEN: '${NOTES_TOKEN}' },
    })
    expect(payload.servers.web).toEqual({ url: 'https://x.example/mcp' })
    expect(payload.defaultServer).toBe('notes')

    const py = mkTmpDir()
    fs.writeFileSync(path.join(py, 'pyproject.toml'), '[project]\nname = "weather-mcp"\n')
    io = capture()
    expect(await initCommand(['--dir', py, '--no-call', '--json'])).toBe(0)
    payload = io.json()
    expect(payload.servers.default).toEqual({
      cmd: 'python',
      args: ['-m', 'weather_mcp'],
      cwd: '.',
    })

    const go = mkTmpDir()
    fs.writeFileSync(path.join(go, 'go.mod'), 'module example.com/srv\n')
    io = capture()
    expect(await initCommand(['--dir', go, '--no-call', '--json'])).toBe(0)
    expect(io.json().servers.default).toEqual({ cmd: 'go', args: ['run', '.'], cwd: '.' })
  })
})

describe('explain, conformance, dispatcher', () => {
  it('explain --json describes fixture cases', async () => {
    const io = capture()
    const files = ['flow.capture.json', 'mrtr.confirm-accept.json', 'task.slow.json'].map((f) =>
      path.join(FIXTURE_DIR, 'cases', f),
    )
    expect(await explainCommand([...files, '--json'])).toBe(0)
    const { cases } = io.json()
    expect(cases).toHaveLength(3)
    expect(cases[0]).toMatchObject({ kind: 'flow', tags: ['flow', 'smoke'] })
    expect(cases[0].steps[0].captures).toEqual(['captures {{handle}} = content[0].text'])
    expect(cases[0].steps[1].uses).toEqual(['handle'])
    expect(cases[1].steps[0].respond[0]).toMatch(/^answers elicitation\/create/)
    expect(cases[1].steps[0].expectInputRequired[0].path).toBe('(root)')
    expect(cases[2].steps[0].notes.join(' ')).toMatch(/polls the task/)
  })

  it('explain prints a readable paraphrase', async () => {
    const io = capture()
    expect(await explainCommand([path.join(FIXTURE_DIR, 'cases/match.unordered.json')])).toBe(0)
    expect(io.out()).toMatch(/Calls tool/)
    expect(io.out()).toMatch(/has this item \(any position\) \(and nothing else\)/)
  })

  it('conformance points stdio servers at vib check', async () => {
    const io = capture()
    expect(await conformanceCommand(['--config', fixtureConfig, '--json'])).toBe(2)
    expect(io.json()).toMatchObject({ ok: false, hint: expect.stringMatching(/vib check/) })
  })

  it('main dispatches commands and maps connection errors to exit 2', async () => {
    let io = capture()
    expect(await main(['tools', '--config', fixtureConfig, '--json'])).toBe(0)
    expect(io.json().tools).toHaveLength(6)
    io = capture()
    expect(
      await main([
        'tools',
        '--config',
        fixtureConfig,
        '--server',
        'definitely-not-a-command-xyz',
        '--json',
      ]),
    ).toBe(2)
    expect(io.json()).toMatchObject({
      ok: false,
      error: { type: 'SessionStartError', code: expect.any(String), hint: expect.any(String) },
    })
    // Under --json the error is only the JSON envelope (nothing duplicated on stderr).
    expect(io.err()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Dogfood round
// ---------------------------------------------------------------------------

const ECHO_SERVER = path.join(FIXTURE_DIR, 'server/index.js')
const VOLATILE_SERVER = path.join(process.cwd(), 'tests/fixtures/cli/volatile-server.js')

describe('HTTP servers: the CLI exits cleanly (Windows UV_HANDLE_CLOSING regression)', () => {
  let server: ChildProcess
  let url = ''
  let bundle = ''

  beforeAll(async () => {
    const dir = path.join(process.cwd(), 'node_modules', '.cache', 'vibrissa-cli-test')
    fs.mkdirSync(dir, { recursive: true })
    bundle = path.join(dir, 'cli.mjs')
    buildSync({
      entryPoints: [path.join(process.cwd(), 'src/cli.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'error',
    })
    server = spawn(process.execPath, [ECHO_SERVER, '--http', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    url = await new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(
        () => reject(new Error(`no URL from the HTTP fixture: ${text}`)),
        10_000,
      )
      server.stderr?.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        const match = /listening (http:\/\/\S+)/.exec(text)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
    })
  }, 30_000)

  afterAll(() => {
    server?.kill()
  })

  function vib(...args: string[]) {
    return spawnSync(process.execPath, [bundle, ...args, '--server', url, '--json'], {
      encoding: 'utf8',
      timeout: 20_000,
    })
  }

  it.each([['discover'], ['tools'], ['call', 'echo', '--arg', 'text=over http']])(
    'vib %s exits 0 with an ok envelope',
    (...args) => {
      const run = vib(...args)
      expect(run.stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/)
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout).ok).toBe(true)
    },
  )

  it('discover over HTTP reports the transport', () => {
    const payload = JSON.parse(vib('discover').stdout)
    expect(payload.transport).toEqual({ type: 'http', url })
    expect(payload.raw).toBeUndefined()
  })
})

describe('target validation and output checks', () => {
  it('tools <name> shows one tool; unknown names exit 2 with did-you-mean', async () => {
    let io = capture()
    expect(await main(['tools', 'echo', '--config', fixtureConfig, '--json'])).toBe(0)
    expect(io.json()).toMatchObject({ ok: true, tool: { name: 'echo', title: 'Echo' } })
    io = capture()
    expect(await main(['tools', 'echo', '--config', fixtureConfig])).toBe(0)
    expect(io.out()).toMatch(/Description\n {2}Echo text back/)
    expect(io.out()).toContain('inputSchema')
    io = capture()
    expect(await main(['tools', 'ecoh', '--config', fixtureConfig, '--json'])).toBe(2)
    expect(io.json().error).toMatchObject({ code: 'unknown-tool' })
    expect(io.json().error.hint).toMatch(/Did you mean "echo"\?/)
  })

  it('call / read / get-prompt check names against the server lists', async () => {
    let io = capture()
    expect(await main(['call', 'ecoh', '--config', fixtureConfig, '--json'])).toBe(2)
    expect(io.json().error.code).toBe('unknown-tool')
    io = capture()
    // --expect-missing sends it anyway: the server answers an error (exit 1).
    expect(
      await main(['call', 'ecoh', '--expect-missing', '--config', fixtureConfig, '--json']),
    ).toBe(1)
    expect(io.json()).toMatchObject({ ok: false, kind: 'error', error: { code: -32602 } })
    io = capture()
    expect(await main(['read', 'fixture://readm', '--config', fixtureConfig, '--json'])).toBe(2)
    expect(io.json().error).toMatchObject({ code: 'unknown-resource' })
    expect(io.json().error.hint).toMatch(/fixture:\/\/readme/)
    io = capture()
    // A URI matching a listed template is fine.
    expect(await main(['read', 'fixture://users/9', '--config', fixtureConfig, '--json'])).toBe(0)
    io = capture()
    expect(await main(['get-prompt', 'grete', '--config', fixtureConfig, '--json'])).toBe(2)
    expect(io.json().error).toMatchObject({ code: 'unknown-prompt' })
    expect(io.json().error.hint).toMatch(/Did you mean "greet"\?/)
  })

  it('call warns about outputSchema violations by default; --validate fails', async () => {
    const io = capture()
    const argv = [
      'typed',
      '--config',
      fixtureConfig,
      '--args',
      '{"a":1,"b":2,"broken":true}',
      '--json',
    ]
    expect(await callCommand(argv)).toBe(0)
    const payload = io.json()
    expect(payload.ok).toBe(true)
    expect(payload.validation).toMatchObject({ checked: true, ok: false })
    expect(payload.warnings[0]).toMatch(
      /structuredContent does not match the outputSchema of "typed"/,
    )
  })

  it('discover --json carries transport and next, not raw; input_required has no inputRequests', async () => {
    let io = capture()
    expect(await discoverCommand(['--config', fixtureConfig, '--json'])).toBe(0)
    const info = io.json()
    expect(info.ok).toBe(true)
    expect(info.raw).toBeUndefined()
    expect(info.transport).toEqual({ type: 'stdio', command: 'node server/index.js' })
    expect(info.next).toContain('vib tools')
    io = capture()
    await callCommand(['confirm', '--config', fixtureConfig, '--json'])
    expect(io.json().requests).toBeDefined()
    expect(io.json().inputRequests).toBeUndefined()
  })
})

describe('record: suite paths, names, volatility, output checks', () => {
  function project(): { dir: string; config: string } {
    const dir = mkTmpDir()
    const config = path.join(dir, 'vibrissa.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        servers: {
          default: { cmd: 'node', args: [VOLATILE_SERVER], protocol: 'legacy' },
          other: { cmd: 'node', args: [VOLATILE_SERVER], protocol: 'legacy' },
          echo: { cmd: 'node', args: [ECHO_SERVER] },
        },
        defaultServer: 'default',
        globs: ['cases/**/*.json'],
        timeoutMs: 5000,
      }),
    )
    return { dir, config }
  }

  it('loosens timestamps, UUIDs and epoch-ms, writes into the suite dir, and the golden replays', async () => {
    const { dir, config } = project()
    let io = capture()
    expect(await recordCommand(['stamp', '--config', config, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload).toMatchObject({
      ok: true,
      inSuite: true,
      path: path.join(dir, 'cases', 'stamp.json'),
    })
    expect(payload.loosened.map((l: { path: string }) => l.path)).toEqual([
      'content[0].text',
      'structuredContent.at',
      'structuredContent.id',
      'structuredContent.ms',
    ])
    expect(payload.notes[0]).toMatch(
      /^loosened 4 volatile fields .* docs\/CASES\.md#generated-ids-and-timestamps/,
    )
    const written = readJson(payload.path)
    expect(written.name).toBe('stamp')
    expect(written.expect).toMatchObject({
      structuredContent: {
        at: { $schema: { type: 'string', format: 'date-time' } },
        id: { $schema: { type: 'string', format: 'uuid' } },
        ms: { $type: 'integer' },
        stable: 'same',
      },
    })
    // A second recording gets a fresh file name.
    io = capture()
    expect(await recordCommand(['stamp', '--config', config, '--json'])).toBe(0)
    expect(io.json().path).toBe(path.join(dir, 'cases', 'stamp-2.json'))
    // The loosened golden passes on a fresh run.
    io = capture()
    expect(await main(['run', '--config', config, '--cases', payload.path, '--allow-empty'])).toBe(
      0,
    )
  }, 60_000)

  it('the stable check loosens values that change between calls; --no-stable-check / --exact keep them', async () => {
    const { config, dir } = project()
    let io = capture()
    expect(await recordCommand(['counter', '--config', config, '--json'])).toBe(0)
    expect(io.json().loosened).toEqual([
      { path: 'content[0].text', reason: 'changed', was: 'call #1' },
    ])
    expect(readJson(io.json().path).expect).toEqual({
      content: [{ type: 'text', text: { $regex: '^call #[\\s\\S]*$' } }],
    })
    io = capture()
    expect(
      await recordCommand([
        'counter',
        '--no-stable-check',
        '--config',
        config,
        '--out',
        path.join(dir, 'cases', 'c1.json'),
        '--json',
      ]),
    ).toBe(0)
    expect(readJson(io.json().path).expect).toEqual({
      content: [{ type: 'text', text: 'call #1' }],
    })
    io = capture()
    expect(
      await recordCommand([
        'stamp',
        '--exact',
        '--config',
        config,
        '--out',
        path.join(dir, 'cases', 'exact.json'),
        '--json',
      ]),
    ).toBe(0)
    expect(io.json().loosened).toBeUndefined()
    expect(
      typeof (readJson(io.json().path).expect as { structuredContent: { at: unknown } })
        .structuredContent.at,
    ).toBe('string')
    io = capture()
    expect(await recordCommand(['wipe', '--config', config, '--json'])).toBe(0)
    expect(io.json().notes.join(' ')).toMatch(
      /Stable check skipped: "wipe" is annotated destructive/,
    )
  }, 60_000)

  it('refuses goldens that violate the outputSchema unless --allow-invalid-output', async () => {
    const { config, dir } = project()
    let io = capture()
    expect(await recordCommand(['broken', '--config', config, '--json'])).toBe(1)
    expect(io.json()).toMatchObject({ ok: false, error: { code: 'invalid-output' } })
    expect(fs.existsSync(path.join(dir, 'cases'))).toBe(false)
    io = capture()
    expect(
      await recordCommand(['broken', '--allow-invalid-output', '--config', config, '--json']),
    ).toBe(0)
    expect(io.json().notes.join(' ')).toMatch(/violates the outputSchema/)
  }, 30_000)

  it('writes "server" for a non-default --server; default names summarize args; outside-suite --out warns', async () => {
    const { config, dir } = project()
    let io = capture()
    expect(
      await recordCommand(['counter', '--server', 'other', '--config', config, '--json']),
    ).toBe(0)
    expect(readJson(io.json().path).server).toBe('other')
    io = capture()
    expect(
      await recordCommand([
        'echo',
        '--arg',
        'text=hello',
        '--server',
        'echo',
        '--config',
        config,
        '--json',
      ]),
    ).toBe(0)
    expect(io.json().path).toBe(path.join(dir, 'cases', 'echo-text-hello.json'))
    expect(readJson(io.json().path)).toMatchObject({ name: 'echo text=hello', server: 'echo' })
    io = capture()
    expect(
      await recordCommand([
        'counter',
        '--config',
        config,
        '--out',
        path.join(dir, 'elsewhere', 'x.json'),
        '--json',
      ]),
    ).toBe(0)
    expect(io.json().inSuite).toBe(false)
    expect(io.json().notes.join(' ')).toMatch(/outside the suite globs \(cases\/\*\*\/\*\.json\)/)
    io = capture()
    expect(await main(['record', 'countr', '--config', config, '--json'])).toBe(2)
    expect(io.json().error.hint).toMatch(/Did you mean "counter"\?/)
  }, 60_000)
})

describe('explain on the real loader', () => {
  function suite(): { dir: string; config: string } {
    const dir = mkTmpDir()
    const config = path.join(dir, 'vibrissa.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        servers: { default: { cmd: 'node', args: ['x.js'] } },
        globs: ['cases/**/*.json'],
      }),
    )
    const cases = path.join(dir, 'cases')
    // Fragments live outside the case globs (vib run would load them as cases otherwise).
    fs.mkdirSync(path.join(dir, 'shared'), { recursive: true })
    fs.mkdirSync(cases, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'shared', 'text.json'),
      JSON.stringify({ type: 'text', text: { $regex: '^hi' } }),
    )
    fs.writeFileSync(
      path.join(cases, 'good.json'),
      JSON.stringify({
        name: 'good one',
        tool: 'echo',
        args: { text: 'hi' },
        expect: { content: [{ $ref: '../shared/text.json' }] },
      }),
    )
    fs.writeFileSync(
      path.join(cases, 'weak.json'),
      JSON.stringify({ name: 'weak one', tool: 'echo', expectError: {} }),
    )
    fs.writeFileSync(
      path.join(cases, 'bad.json'),
      JSON.stringify({ name: 'bad one', tool: 'echo', expct: {} }),
    )
    return { dir, config }
  }

  it('no arguments explains the whole suite with load errors and weak-assertion flags', async () => {
    const { config } = suite()
    const io = capture()
    expect(await explainCommand(['--config', config, '--json'])).toBe(1)
    const payload = io.json()
    expect(payload.ok).toBe(false)
    expect(payload.summary).toEqual({ cases: 3, errors: 1, flagged: 1 })
    const byName = new Map(payload.cases.map((c: { name: string }) => [c.name, c]))
    expect((byName.get('bad one') as { errors: string[] }).errors[0]).toMatch(/expct/)
    expect((byName.get('weak one') as { flags: Array<{ code: string }> }).flags).toEqual([
      { code: 'any-error', at: 'case', message: expect.stringMatching(/accepts any error/) },
    ])
    const good = byName.get('good one') as {
      refs: unknown
      flags?: unknown
      errors?: unknown
      steps: Array<{ expect: Array<{ path: string; text: string }> }>
    }
    expect(good.refs).toEqual([{ path: 'expect.content[0]', ref: '../shared/text.json' }])
    expect(good.flags).toBeUndefined() // empty arrays are dropped from --json
    expect(good.errors).toBeUndefined()
    expect(good.steps[0].expect.map((a) => `${a.path} ${a.text}`)).toContain(
      'content[0].text matches /^hi/',
    )
  })

  it('accepts a case name; --brief shows only problems', async () => {
    const { config } = suite()
    let io = capture()
    expect(await explainCommand(['good one', '--config', config])).toBe(0)
    expect(io.out()).toMatch(/good one/)
    expect(io.out()).toMatch(/is inlined from the fragment \.\.\/shared\/text\.json/)
    io = capture()
    expect(await explainCommand(['--config', config, '--brief'])).toBe(1)
    expect(io.out()).not.toMatch(/good one/)
    expect(io.out()).toMatch(/weak one[\s\S]*expectError \{\} accepts any error/)
    io = capture()
    await expect(explainCommand(['god one', '--config', config])).rejects.toThrow(
      /Did you mean "good one"\?/,
    )
  })
})

describe('fuzz, migrate, init, spawn hints', () => {
  it('fuzz output: expectation counts, n/a rows, no inject row, grouped root causes, --brief', async () => {
    let io = capture()
    await fuzzCommand(['echo', '--runs', '20', '--config', fixtureConfig])
    let text = io.out()
    expect(text).toMatch(/by expectation: \d+ should succeed · \d+ should be rejected/)
    expect(text).toMatch(
      /output-matches-output-schema\s+error\s+n\/a\s+-\s+-\s+\(the tool declares no outputSchema\)/,
    )
    expect(text).not.toMatch(/no-echo-of-injection-payload/)
    io = capture()
    await fuzzCommand(['typed', '--runs', '30', '--seed', '7', '--config', fixtureConfig])
    text = io.out()
    expect(text).toMatch(/Failures \(1 root cause, \d+ cases\)/)
    expect(text).toMatch(/✗ output-matches-output-schema · \d+ cases/)
    expect(text).toMatch(/also: /)
    io = capture()
    await fuzzCommand([
      'typed',
      '--runs',
      '30',
      '--seed',
      '7',
      '--brief',
      '--config',
      fixtureConfig,
    ])
    expect(io.out()).not.toMatch(/INVARIANT/)
    expect(io.out()).toMatch(/Failures \(1 root cause/)
  }, 60_000)

  it('migrate reports leftover v1 keys and exits 1 on unreadable case files', async () => {
    const dir = mkTmpDir()
    const config = path.join(dir, 'vibrissa.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        server: { cmd: 'node', args: ['x.js'] },
        display: 'pretty',
        globs: ['cases/*.json'],
      }),
    )
    fs.mkdirSync(path.join(dir, 'cases'))
    fs.writeFileSync(path.join(dir, 'cases', 'broken.json'), '{ "tool": ')
    const io = capture()
    expect(await migrateCommand(['--config', config, '--json'])).toBe(1)
    const payload = io.json()
    expect(payload.ok).toBe(false)
    expect(payload.skipped).toHaveLength(1)
    expect(payload.notes.join(' ')).toMatch(/display has no effect in v2/)
  })

  it('init records a real sample from a server that starts; --ci later writes only the workflow', async () => {
    const dir = mkTmpDir()
    let io = capture()
    expect(await initCommand(['--dir', dir, '--server', `node "${ECHO_SERVER}"`, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload.sample).toEqual({ recorded: true, tool: 'echo' })
    const sample = readJson(path.join(dir, 'tests/integration/echo-text-hello.json'))
    expect(sample).toMatchObject({
      name: 'echo text=hello',
      tool: 'echo',
      args: { text: 'hello' },
      expect: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(sample.skip).toBeUndefined()
    fs.rmSync(path.join(dir, 'tests/integration/flow.sample.json'))
    io = capture()
    expect(await initCommand(['--dir', dir, '--ci', '--json'])).toBe(0)
    expect(
      io.json().files.map((f: { what: string; status: string }) => `${f.what}:${f.status}`),
    ).toEqual(['ci:wrote', 'profile:present'])
    expect(fs.existsSync(path.join(dir, 'tests/integration/flow.sample.json'))).toBe(false)
  }, 30_000)

  it('without vibrissa.json, connection errors say how to configure the server', async () => {
    const dir = mkTmpDir()
    const cwd = process.cwd()
    const io = capture()
    process.chdir(dir)
    const sentence =
      /No vibrissa\.json found; using the default server command `node dist\/index\.js`/g
    try {
      // Human output: the note once (on stderr), not repeated in the error.
      expect(await main(['tools'])).toBe(2)
      const human = `${io.warn()}\n${io.err()}`
      expect(human.match(sentence)).toHaveLength(1)
      expect(io.warn()).toMatch(/note: No vibrissa\.json found/)
      expect(io.err()).toMatch(/error: Server/)
      // --json: no note, so the hint lives once in the error envelope.
      const json = capture()
      expect(await main(['tools', '--json'])).toBe(2)
      expect(json.warn()).toBe('')
      expect(JSON.stringify(json.json()).match(sentence)).toHaveLength(1)
    } finally {
      process.chdir(cwd)
    }
  }, 30_000)
})

describe('docs-agent verification fixes', () => {
  it('explain skips $ref fragments under the globs like vib run, with an info line', async () => {
    const dir = mkTmpDir()
    const config = path.join(dir, 'vibrissa.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        servers: { default: { cmd: 'node', args: ['x.js'] } },
        globs: ['cases/**/*.json'],
      }),
    )
    fs.mkdirSync(path.join(dir, 'cases', 'shared'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'cases', 'shared', 'text.json'),
      JSON.stringify({ type: 'text', text: 'hi' }),
    )
    fs.writeFileSync(
      path.join(dir, 'cases', 'echo.json'),
      JSON.stringify({
        name: 'echo hi',
        tool: 'echo',
        args: { text: 'hi' },
        expect: { content: [{ $ref: './shared/text.json' }] },
      }),
    )
    let io = capture()
    expect(await explainCommand(['--config', config, '--json'])).toBe(0)
    const payload = io.json()
    expect(payload).toMatchObject({
      ok: true,
      summary: { cases: 1, errors: 0 },
      fragments: ['cases/shared/text.json'],
    })
    expect(payload.cases.map((c: { name: string }) => c.name)).toEqual(['echo hi'])
    io = capture()
    expect(await explainCommand(['--config', config])).toBe(0)
    expect(io.out()).toMatch(
      /info: skipped 1 \$ref fragment file \(not cases\): cases\/shared\/text\.json/,
    )
    expect(io.out()).not.toMatch(/load error/)
  })

  it('check --list --json carries ok: true', async () => {
    const io = capture()
    expect(await checkCommand(['--list', '--json'])).toBe(0)
    expect(io.json()).toMatchObject({ ok: true, checks: expect.any(Array) })
  })

  it('server start errors end as a sentence and point at the server command, not --help', async () => {
    let io = capture()
    expect(
      await main(['fuzz', 'echo', '--config', fixtureConfig, '--server', 'nonexistent-cmd-xyz']),
    ).toBe(2)
    const human = io.err()
    expect(human).not.toMatch(/--help for usage/)
    expect(human).not.toMatch(/,\s+Fix the server command/)
    expect(human).toMatch(
      /[.!?)"'`] Fix the server command in vibrissa\.json, or try one with --server/,
    )
    io = capture()
    expect(
      await main([
        'fuzz',
        'echo',
        '--config',
        fixtureConfig,
        '--server',
        'nonexistent-cmd-xyz',
        '--json',
      ]),
    ).toBe(2)
    const { error } = io.json()
    expect(error.message).toMatch(/[.!?)"'`]$/)
    expect(error.hint).toMatch(/^Fix the server command/)
  }, 30_000)

  it('endSentence closes trailing commas and colons', () => {
    expect(endSentence("'x' is not recognized as an internal or external command,")).toBe(
      "'x' is not recognized as an internal or external command.",
    )
    expect(endSentence('failed: ')).toBe('failed.')
    expect(endSentence('Done.')).toBe('Done.')
    expect(
      describeError(new SessionStartError('Server failed: boom,', 'spawn'), 'fuzz').human,
    ).toBe(
      'Server failed: boom. Fix the server command in vibrissa.json, or try one with --server "<cmd> <args>" (vib init --server "<cmd>" writes it to the config).',
    )
  })
})
