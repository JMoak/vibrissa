import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { parseCommonFlags } from '../src/cli/resolve'
import {
  ConfigError,
  interpolateEnv,
  loadConfig,
  parseShard,
  resolveOptions,
  stripJsonComments,
  stripTrailingCommas,
} from '../src/config'
import { resolveManifestPath, resolveServerConfig, resolveServerName } from '../src/paths'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-test-'))
}

function writeConfig(dir: string, config: unknown, name = 'vibrissa.json'): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), 'utf8')
  return file
}

describe('config resolution (v1 shapes stay valid)', () => {
  it('loads vibrissa.json and maps `server` to servers.default', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      server: { cmd: 'node', args: ['custom.js'], env: { FOO: 'bar' } },
      globs: ['tests/**/*.json'],
      timeoutMs: 12345,
      failFast: true,
    })

    const resolved = resolveOptions(tmp)

    expect(resolved.rootDir).toBe(tmp)
    expect(resolved.defaultServer).toBe('default')
    expect(resolved.servers).toEqual({
      default: { cmd: 'node', args: ['custom.js'], env: { FOO: 'bar' } },
    })
    expect(resolved.globs).toEqual(['tests/**/*.json'])
    expect(resolved.timeoutMs).toBe(12345)
    expect(resolved.failFast).toBe(true)
    expect(resolved.allowEmpty).toBe(false)
    expect(resolved.reporters).toEqual(['console'])
    expect(resolved.normalize).toEqual({
      stripMeta: ['io.modelcontextprotocol/*'],
      dropKeys: ['resultType'],
      ttlMs: 'ignore',
    })
    expect(resolved.manifest).toBe('tests/integration/__manifest__.json')
  })

  it('sets rootDir to the config file directory for explicit paths (string or object form)', () => {
    const tmp = mkTmpDir()
    const nested = path.join(tmp, 'nested')
    fs.mkdirSync(nested)
    const file = writeConfig(nested, {
      server: { cmd: 'node', args: ['server.js'] },
      globs: ['cases/**/*.json'],
    })

    expect(resolveOptions(tmp, file).rootDir).toBe(nested)
    const resolved = resolveOptions(tmp, { configPath: path.relative(tmp, file) })
    expect(resolved.rootDir).toBe(nested)
    expect(resolved.globs).toEqual(['cases/**/*.json'])
  })

  it('falls back to package.json#vibrissa when no config file exists', () => {
    const tmp = mkTmpDir()
    writeConfig(
      tmp,
      {
        name: 'tmp',
        version: '0.0.0',
        vibrissa: { server: { cmd: 'node', args: ['pkg.js'] }, globs: ['pkg/**/*.json'] },
      },
      'package.json',
    )
    const resolved = resolveOptions(tmp)
    expect(resolved.rootDir).toBe(tmp)
    expect(resolved.servers.default).toEqual({ cmd: 'node', args: ['pkg.js'] })
    expect(resolved.globs).toEqual(['pkg/**/*.json'])
  })

  it('uses built-in defaults when there is no config at all', () => {
    const tmp = mkTmpDir()
    const resolved = resolveOptions(tmp)
    expect(resolved.rootDir).toBe(path.resolve(tmp))
    expect(resolved.servers.default).toMatchObject({ cmd: 'node', args: ['dist/index.js'] })
    expect(resolved.timeoutMs).toBe(15000)
  })

  it('reads JSONC (comments and trailing commas) from vibrissa.jsonc', () => {
    const tmp = mkTmpDir()
    writeConfig(
      tmp,
      `{
        // the server under test
        "server": { "cmd": "node", "args": ["a.js",], },
        /* block comment */ "globs": ["x/**/*.json"],
        "grep": "http://not-a-comment",
      }`,
      'vibrissa.jsonc',
    )
    const resolved = resolveOptions(tmp)
    expect(resolved.servers.default).toEqual({ cmd: 'node', args: ['a.js'] })
    expect(resolved.grep).toBe('http://not-a-comment')
    expect(stripTrailingCommas(stripJsonComments('{"a": "x,}", }'))).toBe('{"a": "x,}" }')
  })
})

describe('config v2: servers, profiles, env', () => {
  const v2 = {
    servers: {
      local: { cmd: 'node', args: ['dist/index.js'], protocol: 'auto' },
      staging: {
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
      },
    },
    defaultServer: 'local',
    reporters: ['console', 'junit'],
    normalize: { dropKeys: ['resultType', 'isError'] },
    budgetMs: 2000,
    profiles: {
      ci: { reporters: ['console', 'junit', 'github'], check: true, repeat: 1 },
      smoke: { tags: ['smoke'], failFast: true, defaultServer: 'staging' },
      legacy: { servers: { local: { protocol: 'legacy' } } },
    },
  }

  it('resolves a servers map with defaultServer and ${ENV} interpolation', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, v2)
    const { options, warnings } = loadConfig(tmp, { env: { MCP_TOKEN: 's3cret' } })
    expect(warnings).toEqual([])
    expect(options.defaultServer).toBe('local')
    expect(options.servers.staging).toEqual({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer s3cret' },
    })
    expect(options.reporters).toEqual(['console', 'junit'])
    expect(options.budgetMs).toBe(2000)
    expect(options.normalize).toEqual({
      stripMeta: ['io.modelcontextprotocol/*'],
      dropKeys: ['resultType', 'isError'],
      ttlMs: 'ignore',
    })
  })

  it('warns (and interpolates "") for unset env vars; supports fallbacks and escapes', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, v2)
    const { options, warnings } = loadConfig(tmp, { env: {} })
    expect(
      (options.servers.staging as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer ')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(
      /Unset environment variable at servers\.staging\.headers\.Authorization: \$\{MCP_TOKEN\}/,
    )

    const out = interpolateEnv(
      { a: '${X:-fallback}', b: '$${LITERAL}', c: ['${Y}-${Y}'], d: 3 },
      { Y: 'y' },
    )
    expect(out).toEqual({ a: 'fallback', b: '${LITERAL}', c: ['y-y'], d: 3 })
  })

  it('merges a profile over the base config', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, v2)
    const ci = resolveOptions(tmp, { profile: 'ci', env: { MCP_TOKEN: 't' } })
    expect(ci.reporters).toEqual(['console', 'junit', 'github'])
    expect(ci.check).toBe(true)
    expect(ci.repeat).toBe(1)
    expect(ci.budgetMs).toBe(2000)

    const smoke = resolveOptions(tmp, { profile: 'smoke', env: { MCP_TOKEN: 't' } })
    expect(smoke.defaultServer).toBe('staging')
    expect(smoke.tags).toEqual(['smoke'])
    expect(smoke.failFast).toBe(true)

    const legacy = resolveOptions(tmp, { profile: 'legacy', env: { MCP_TOKEN: 't' } })
    expect(legacy.servers.local).toEqual({
      cmd: 'node',
      args: ['dist/index.js'],
      protocol: 'legacy',
    })
  })

  it('rejects an unknown profile with the list of known ones', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, v2)
    expect(() => resolveOptions(tmp, { profile: 'nightly' })).toThrow(
      /Unknown profile at --profile: "nightly" is not defined in profiles \(have: ci, smoke, legacy\)/,
    )
  })

  it('applies precedence defaults → file → profile → CLI', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { ...v2, timeoutMs: 5000 })
    const resolved = resolveOptions(tmp, {
      profile: 'ci',
      env: { MCP_TOKEN: 't' },
      overrides: { reporters: ['json'], timeoutMs: 999, protocol: 'legacy', env: { DEBUG: '1' } },
    })
    expect(resolved.reporters).toEqual(['json'])
    expect(resolved.timeoutMs).toBe(999)
    expect(resolved.check).toBe(true) // from the profile, untouched by CLI
    expect(resolved.servers.local).toMatchObject({ protocol: 'legacy', env: { DEBUG: '1' } })
    expect(resolved.servers.staging).toMatchObject({ protocol: 'legacy' })
    expect(resolved.servers.staging).not.toHaveProperty('env')
  })

  it('--server selects a named server, or replaces the selected command / URL', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      ...v2,
      servers: { ...v2.servers, local: { ...v2.servers.local, cwd: 'pkg' } },
    })
    const env = { MCP_TOKEN: 't' }

    expect(resolveOptions(tmp, { env, overrides: { server: 'staging' } }).defaultServer).toBe(
      'staging',
    )

    const cmd = resolveOptions(tmp, {
      env,
      overrides: { server: 'node "build/server with space.js" --stdio' },
    })
    expect(cmd.defaultServer).toBe('local')
    expect(cmd.servers.local).toEqual({
      cmd: 'node',
      args: ['build/server with space.js', '--stdio'],
      cwd: 'pkg',
      protocol: 'auto',
    })

    const url = resolveOptions(tmp, { env, overrides: { server: 'http://127.0.0.1:3000/mcp' } })
    expect(url.servers.local).toEqual({ url: 'http://127.0.0.1:3000/mcp', protocol: 'auto' })
  })

  it('infers defaultServer for a single server and fails loudly when ambiguous', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { servers: { only: { cmd: 'node' } } })
    expect(resolveOptions(tmp).defaultServer).toBe('only')

    writeConfig(tmp, { servers: { a: { cmd: 'node' }, b: { cmd: 'node' } } })
    expect(() => resolveOptions(tmp)).toThrow(
      /Missing defaultServer at vibrissa\.json: servers has a, b/,
    )

    writeConfig(tmp, { servers: { a: { cmd: 'node' } }, defaultServer: 'zzz' })
    expect(() => resolveOptions(tmp)).toThrow(
      /Unknown server at defaultServer: "zzz" is not in servers \(have: a\)/,
    )
  })

  it('validates values with actionable messages; unknown keys are errors', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { timeoutMs: 'soon' })
    expect(() => resolveOptions(tmp)).toThrow(ConfigError)
    expect(() => resolveOptions(tmp)).toThrow(
      /Invalid config at timeoutMs \(vibrissa\.json\): expected a number >= 0, got "soon"\./,
    )

    writeConfig(tmp, { servers: { x: { cmd: 'node', url: 'http://x' } } })
    expect(() => resolveOptions(tmp)).toThrow(
      /servers\.x .*exactly one of "cmd" \(stdio\) or "url"/,
    )

    writeConfig(tmp, { servers: { x: { cmd: 'node', protocol: 'newest' } } })
    expect(() => resolveOptions(tmp)).toThrow(/servers\.x\.protocol/)

    writeConfig(tmp, { server: { cmd: 'node' }, shard: '2/4', display: 'pretty' })
    const { options, warnings } = loadConfig(tmp)
    expect(options.shard).toEqual({ index: 2, total: 4 })
    expect(warnings).toEqual([])

    // An unknown key would silently fall back to a default: it is a ConfigError (exit 2).
    writeConfig(tmp, { server: { cmd: 'node' }, colour: true })
    expect(() => loadConfig(tmp)).toThrow(ConfigError)
    expect(() => loadConfig(tmp)).toThrow(
      /^Unknown config key at colour \(vibrissa\.json\): Check spelling against schema\/vibrissa\.schema\.json\.$/,
    )
  })

  it('suggests the right key and reports every problem at once', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { server: { cmd: 'node', argz: [] }, globz: ['x'], timeoutMS: 5, repeat: 0 })
    let message = ''
    try {
      loadConfig(tmp)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/^Invalid config \(vibrissa\.json\): 4 problems:\n/)
    expect(message).toContain('Unknown config key at globz (vibrissa.json): did you mean "globs"?')
    expect(message).toContain(
      'Unknown config key at timeoutMS (vibrissa.json): did you mean "timeoutMs"?',
    )
    expect(message).toContain('Invalid config at repeat (vibrissa.json): expected an integer >= 1')
    expect(message).toContain(
      'Unknown config key at server.argz (vibrissa.json): did you mean "args"?',
    )

    writeConfig(tmp, { server: { cmd: 'node' }, profiles: { ci: { failfast: true } } })
    expect(() => loadConfig(tmp)).toThrow(
      /Unknown config key at profiles\.ci\.failfast .*"failFast"/,
    )
  })

  it('rejects profiles that patch servers that do not exist', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      server: { cmd: 'node' },
      profiles: { legacy: { servers: { local: { protocol: 'legacy' } } } },
    })
    expect(() => loadConfig(tmp)).toThrow(
      /profile legacy patches unknown server 'local'; servers are: default\./,
    )
    // A profile may define a new server outright.
    writeConfig(tmp, {
      server: { cmd: 'node' },
      profiles: { extra: { servers: { local: { cmd: 'node', args: ['x.js'] } } } },
    })
    expect(loadConfig(tmp, { profile: 'extra' }).options.servers.local).toMatchObject({
      cmd: 'node',
    })
  })

  it('accepts requireManifest (file and profile)', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { server: { cmd: 'node' }, profiles: { ci: { requireManifest: true } } })
    expect(resolveOptions(tmp).requireManifest).toBeUndefined()
    expect(resolveOptions(tmp, { profile: 'ci' }).requireManifest).toBe(true)
    writeConfig(tmp, { server: { cmd: 'node' }, requireManifest: 'yes' })
    expect(() => resolveOptions(tmp)).toThrow(/Invalid config at requireManifest .*true or false/)
  })

  it('accepts protocol shorthands', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      servers: {
        a: { cmd: 'node', protocol: '2026-07-28' },
        b: { cmd: 'node', protocol: { pin: '2026-07-28' } },
        c: { cmd: 'node', protocol: 'modern' },
      },
      defaultServer: 'a',
    })
    const { servers } = resolveOptions(tmp)
    expect(servers.a.protocol).toEqual({ pin: '2026-07-28' })
    expect(servers.b.protocol).toEqual({ pin: '2026-07-28' })
    expect(servers.c.protocol).toBe('modern')
  })

  it('fills checks and manifestIgnore defaults; outDir stays unset (runner default "reports")', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { server: { cmd: 'node' } })
    const { options, warnings } = loadConfig(tmp)
    expect(warnings).toEqual([])
    expect(options.checks).toEqual({})
    expect(options.manifestIgnore).toEqual(['server.version', 'protocolVersion', 'listMeta'])
    expect(options.outDir).toBeUndefined()
  })

  it('merges checks / manifestIgnore / outDir across file, profile and overrides', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      server: { cmd: 'node' },
      checks: { allow: ['lint.url'], severity: { 'spec.ttl': 'warned', 'lint.base64': 'warned' } },
      manifestIgnore: ['server.version', 'tools.*.annotations'],
      outDir: 'out/reports',
      profiles: {
        ci: {
          checks: { allow: ['lint.shadowing', 'lint.url'], severity: { 'spec.ttl': 'failed' } },
          manifestIgnore: 'server.version',
          outDir: 'ci-reports',
        },
      },
    })
    const base = resolveOptions(tmp)
    expect(base.checks).toEqual({
      allow: ['lint.url'],
      severity: { 'spec.ttl': 'warned', 'lint.base64': 'warned' },
    })
    expect(base.manifestIgnore).toEqual(['server.version', 'tools.*.annotations'])
    expect(base.outDir).toBe('out/reports')

    const ci = resolveOptions(tmp, { profile: 'ci' })
    expect(ci.checks).toEqual({
      allow: ['lint.url', 'lint.shadowing'],
      severity: { 'spec.ttl': 'failed', 'lint.base64': 'warned' },
    })
    expect(ci.manifestIgnore).toEqual(['server.version'])
    expect(ci.outDir).toBe('ci-reports')

    const cli = resolveOptions(tmp, {
      profile: 'ci',
      overrides: { outDir: '/abs/out', manifestIgnore: [], checks: { allow: ['spec.order'] } },
    })
    expect(cli.outDir).toBe('/abs/out')
    expect(cli.manifestIgnore).toEqual([])
    expect(cli.checks?.allow).toEqual(['lint.url', 'lint.shadowing', 'spec.order'])
  })

  it('validates checks values', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, { checks: { severity: { 'spec.ttl': 'error' } } })
    expect(() => resolveOptions(tmp)).toThrow(
      /Invalid config at checks\.severity\.spec\.ttl .*"failed" or "warned"/,
    )
    writeConfig(tmp, { checks: { allow: [1] } })
    expect(() => resolveOptions(tmp)).toThrow(/checks\.allow/)
    writeConfig(tmp, { outDir: 3 })
    expect(() => resolveOptions(tmp)).toThrow(/Invalid config at outDir/)
  })

  it('parses shard specs', () => {
    expect(parseShard('1/3')).toEqual({ index: 1, total: 3 })
    expect(parseShard({ index: 3, total: 3 })).toEqual({ index: 3, total: 3 })
    expect(parseShard('4/3')).toBeUndefined()
    expect(parseShard('0/3')).toBeUndefined()
  })
})

describe('paths', () => {
  it('resolves stdio cwd against rootDir and leaves HTTP servers alone', () => {
    const tmp = mkTmpDir()
    writeConfig(tmp, {
      servers: { local: { cmd: 'node', cwd: 'srv' }, remote: { url: 'https://x.test/mcp' } },
      defaultServer: 'local',
    })
    const options = resolveOptions(tmp)
    expect(resolveServerConfig(options)).toMatchObject({ cmd: 'node', cwd: path.join(tmp, 'srv') })
    expect(resolveServerConfig(options, 'remote')).toEqual({ url: 'https://x.test/mcp' })
    expect(() => resolveServerName(options, 'nope')).toThrow(
      /Unknown server at case\.server: "nope"/,
    )
    expect(resolveManifestPath(options)).toBe(path.join(tmp, 'tests/integration/__manifest__.json'))
  })
})

describe('CLI common flags', () => {
  it('parses --server, --profile and --protocol', () => {
    const flags = parseCommonFlags([
      '--server',
      'node dist/index.js',
      '--profile',
      'ci',
      '--protocol',
      '2026-07-28',
      '--env',
      'A=1',
    ])
    expect(flags).toMatchObject({
      server: 'node dist/index.js',
      serverCmd: 'node',
      serverArgs: ['dist/index.js'],
      profile: 'ci',
      protocol: { pin: '2026-07-28' },
      env: { A: '1' },
    })
    expect(parseCommonFlags(['--protocol', 'legacy']).protocol).toBe('legacy')
    expect(parseCommonFlags(['--server', 'https://x.test/mcp']).serverCmd).toBeUndefined()
    expect(() => parseCommonFlags(['--protocol', 'newest'])).toThrow(
      /Invalid --protocol value "newest"/,
    )
  })
})

describe('JSON schemas', () => {
  const schemaDir = path.join(process.cwd(), 'schema')
  const load = (name: string) => JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validateConfig = ajv.compile(load('vibrissa.schema.json'))
  const validateCase = ajv.compile(load('case.schema.json'))

  function undocumented(schema: unknown, at = '#'): string[] {
    if (typeof schema !== 'object' || schema === null) return []
    const node = schema as Record<string, unknown>
    const missing: string[] = []
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, prop] of Object.entries(
        node.properties as Record<string, Record<string, unknown>>,
      )) {
        if (typeof prop.description !== 'string' && typeof prop.$ref !== 'string')
          missing.push(`${at}/${key}`)
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child))
        child.forEach((c, i) => missing.push(...undocumented(c, `${at}/${key}/${i}`)))
      else if (typeof child === 'object') missing.push(...undocumented(child, `${at}/${key}`))
    }
    return missing
  }

  it('documents every key with a description', () => {
    expect(undocumented(load('vibrissa.schema.json'))).toEqual([])
    expect(undocumented(load('case.schema.json'))).toEqual([])
  })

  it('accepts the v1 fixture config and every v1 fixture case', () => {
    const fixture = path.join(process.cwd(), 'tests/fixtures/echo-server')
    expect(
      validateConfig(JSON.parse(fs.readFileSync(path.join(fixture, 'vibrissa.json'), 'utf8'))),
    ).toBe(true)
    for (const file of fs.readdirSync(path.join(fixture, 'cases'))) {
      const data = JSON.parse(fs.readFileSync(path.join(fixture, 'cases', file), 'utf8'))
      expect({ file, valid: validateCase(data), errors: validateCase.errors }).toMatchObject({
        valid: true,
      })
    }
  })

  it('accepts v2 configs and cases', () => {
    const config = {
      $schema: './node_modules/@jmoak/vibrissa/schema/vibrissa.schema.json',
      servers: {
        local: { cmd: 'node', args: ['dist/index.js'], protocol: 'auto' },
        pinned: { cmd: 'node', protocol: { pin: '2026-07-28' } },
        staging: {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
        },
      },
      defaultServer: 'local',
      globs: ['tests/integration/**/*.json'],
      manifest: 'tests/integration/__manifest__.json',
      normalize: {
        stripMeta: ['io.modelcontextprotocol/*'],
        dropKeys: ['resultType'],
        ttlMs: 'ignore',
      },
      timeoutMs: 15000,
      budgetMs: 2000,
      reporters: ['console', 'junit'],
      shard: '1/4',
      checks: { allow: ['lint.url'], severity: { 'spec.ttl': 'warned' } },
      manifestIgnore: ['server.version'],
      outDir: 'reports',
      profiles: {
        ci: {
          reporters: ['console', 'junit', 'github'],
          check: true,
          repeat: 1,
          checks: { severity: { 'spec.ttl': 'failed' } },
          outDir: 'ci-reports',
          manifestIgnore: [],
        },
        smoke: { tags: ['smoke'], failFast: true, servers: { local: { protocol: 'legacy' } } },
      },
      hooks: { setup: [{ tool: 'reset' }], teardown: [] },
    }
    expect(validateConfig({ checks: { severity: { x: 'error' } } })).toBe(false)
    expect({ valid: validateConfig(config), errors: validateConfig.errors }).toMatchObject({
      valid: true,
    })

    const flow = {
      name: 'create then fetch',
      tags: ['smoke'],
      steps: [
        {
          tool: 'session.create',
          args: { user: 'jordan' },
          capture: { sid: 'structuredContent.sessionId' },
        },
        {
          tool: 'deploy',
          args: { env: 'prod' },
          respond: { 'elicitation/create': { action: 'accept', content: { confirm: true } } },
          expectInputRequired: { $partial: true },
          await: { pollMs: 500, timeoutMs: 30000 },
          expectError: { code: -32602, message: { $regex: 'nope', flags: 'i' } },
          normalize: false,
        },
        { resource: 'file:///README.md', expect: { contents: [] } },
        { resourceTemplate: 'users://{id}', args: { id: '42' } },
        { prompt: 'summarize', args: { style: 'terse' }, budgetMs: 800 },
      ],
      teardown: [{ tool: 'session.close', args: { sessionId: '{{sid}}' }, ignoreErrors: true }],
    }
    expect({ valid: validateCase(flow), errors: validateCase.errors }).toMatchObject({
      valid: true,
    })
  })

  it('rejects typos and empty cases', () => {
    expect(validateConfig({ timeoutMS: 5 })).toBe(false)
    expect(validateConfig({ servers: { x: { cmd: 'node', url: 'http://x' } } })).toBe(false)
    expect(validateCase({ name: 'no operation' })).toBe(false)
    expect(validateCase({ tool: 'echo', expct: {} })).toBe(false)
  })
})
