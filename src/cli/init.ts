/**
 * `vib init`: scaffold a v2 project — vibrissa.json (servers map + ci profile), a sample
 * case and a sample flow, optionally a GitHub workflow (--ci), with servers pre-filled from
 * Claude configs (--from-claude-config) or detected from the project (Node, Python, Go).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { generateArgs, validateAgainstSchema } from '../fuzz/index.js'
import { resolveServerConfig } from '../paths.js'
import { McpSession } from '../session/index.js'
import type { JsonValue, Step, ToolSummary } from '../types.js'
import {
  UsageError,
  hasFlag,
  printJson,
  resolvePathFromCwd,
  schemaRefFor,
  slugify,
  splitCommandLine,
  suiteLayout,
  takeFlag,
  takeOptionalFlag,
  uniquePath,
} from './args.js'
import { type OpSpec, executeOp } from './call.js'
import { colors, firstLine, isObject, preview, truncate } from './format.js'
import { defaultName, observedFromOutcome, stepFromObserved } from './record.js'
import { parseCommonFlags } from './resolve.js'
import { type Loosened, loosenedSummary } from './volatile.js'

type ServerEntry = Record<string, JsonValue>

interface Detected {
  servers: Record<string, ServerEntry>
  source: string
  notes: string[]
}

type WriteStatus = 'wrote' | 'skipped'

function writeFile(file: string, contents: string, force: boolean): WriteStatus {
  if (fs.existsSync(file) && !force) return 'skipped'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
  return 'wrote'
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** `[project] name = "..."` from pyproject.toml (no TOML parser needed for this). */
export function pyprojectName(text: string): string | undefined {
  const section = /^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)
  const body = section ? section[1] : ''
  const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body)
  return match?.[1]
}

/** Guess how to start the server in `dir`: Node (bin/main/dist), Python, Go. */
export function detectServer(dir: string): Detected {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (pkg) {
    const bin = pkg.bin
    const binPath =
      typeof bin === 'string'
        ? bin
        : typeof bin === 'object' && bin !== null
          ? (Object.values(bin as Record<string, unknown>).find((v) => typeof v === 'string') as
              | string
              | undefined)
          : undefined
    for (const candidate of [
      binPath,
      typeof pkg.main === 'string' ? pkg.main : undefined,
      'dist/index.js',
      'build/index.js',
      'src/index.js',
    ]) {
      if (candidate && fs.existsSync(path.join(dir, candidate))) {
        return {
          servers: { default: { cmd: 'node', args: [candidate.replace(/^\.\//, '')], cwd: '.' } },
          source: `package.json (${candidate})`,
          notes: [],
        }
      }
    }
  }
  const pyproject = path.join(dir, 'pyproject.toml')
  if (fs.existsSync(pyproject)) {
    const name = pyprojectName(fs.readFileSync(pyproject, 'utf8'))
    const module = (name ?? path.basename(dir)).replace(/[-.]/g, '_').toLowerCase()
    return {
      servers: { default: { cmd: 'python', args: ['-m', module], cwd: '.' } },
      source: 'pyproject.toml',
      notes: [
        `Guessed "python -m ${module}" from pyproject.toml; adjust servers.default if your entry point differs (e.g. "uv run <script>").`,
      ],
    }
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) {
    return {
      servers: { default: { cmd: 'go', args: ['run', '.'], cwd: '.' } },
      source: 'go.mod',
      notes: [
        'Guessed "go run ." from go.mod; point servers.default at your built binary for faster runs.',
      ],
    }
  }
  return {
    servers: { default: { cmd: 'node', args: ['dist/index.js'], cwd: '.' } },
    source: 'default',
    notes: [
      'No server entry point found; using "node dist/index.js". Edit servers.default in vibrissa.json, or re-run with --server "<cmd>".',
    ],
  }
}

/** Where Claude Desktop keeps its config on this platform. */
export function claudeDesktopConfigPath(platform = process.platform, env = process.env): string {
  if (platform === 'win32') {
    return path.join(
      env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    )
  }
  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    )
  }
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'Claude',
    'claude_desktop_config.json',
  )
}

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|auth|credential|private/i

function envRef(name: string): string {
  return `\${${name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}}`
}

/** Replace literal secrets with `${VAR}` references (vibrissa.json gets committed). */
function scrub(
  values: Record<string, unknown>,
  refName: (key: string) => string,
  notes: string[],
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw)
    if (SECRET_KEY.test(key) && !/\$\{[^}]+\}/.test(value) && value !== '') {
      const ref = envRef(refName(key))
      out[key] = ref
      notes.push(
        `${where}.${key}: replaced a literal secret with ${ref}; export it before running vib.`,
      )
    } else out[key] = value
  }
  return out
}

/** Map a Claude `mcpServers` object to Vibrissa `servers`. */
export function serversFromMcpConfig(
  mcpServers: Record<string, unknown>,
  notes: string[],
): Record<string, ServerEntry> {
  const servers: Record<string, ServerEntry> = {}
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const where = `servers.${name}`
    if (typeof entry.url === 'string') {
      if (entry.type === 'sse')
        notes.push(
          `${where}: legacy SSE transport; Vibrissa speaks Streamable HTTP, which may not work with this server.`,
        )
      servers[name] = {
        url: entry.url,
        ...(typeof entry.headers === 'object' && entry.headers !== null
          ? {
              headers: scrub(
                entry.headers as Record<string, unknown>,
                (k) => `${name}_${k}`,
                notes,
                `${where}.headers`,
              ),
            }
          : {}),
      }
      continue
    }
    if (typeof entry.command !== 'string') {
      notes.push(`${where}: skipped (no "command" or "url").`)
      continue
    }
    servers[name] = {
      cmd: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args.map(String) } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.env === 'object' && entry.env !== null
        ? { env: scrub(entry.env as Record<string, unknown>, (k) => k, notes, `${where}.env`) }
        : {}),
    }
  }
  return servers
}

function fromClaudeConfig(dir: string, explicit: string): Detected {
  const candidates = explicit
    ? [resolvePathFromCwd(explicit)]
    : [path.join(dir, '.mcp.json'), claudeDesktopConfigPath()]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const json = readJson(file)
    const mcpServers = json?.mcpServers
    if (typeof mcpServers !== 'object' || mcpServers === null) {
      if (explicit)
        throw new UsageError(
          `No "mcpServers" object in ${file}. Point --from-claude-config at a .mcp.json or claude_desktop_config.json.`,
        )
      continue
    }
    const notes: string[] = []
    const servers = serversFromMcpConfig(mcpServers as Record<string, unknown>, notes)
    if (Object.keys(servers).length === 0) {
      throw new UsageError(
        `${file} lists no usable servers (each needs "command" or "url"). Add one, or run vib init --server "<cmd>".`,
      )
    }
    const names = Object.keys(servers)
    if (names.length === 1 && names[0] !== 'default') {
      notes.push(`Named the server "default" (it is "${names[0]}" in ${path.basename(file)}).`)
      return { servers: { default: servers[names[0]] }, source: file, notes }
    }
    return { servers, source: file, notes }
  }
  throw new UsageError(
    `No Claude config found (looked for ${candidates.join(' and ')}). Pass the file explicitly: --from-claude-config <path>.`,
  )
}

/** Reporters of the scaffolded `ci` profile; the `--ci` workflow passes the same list. */
export const CI_REPORTERS = ['console', 'github', 'junit', 'json'] as const

/** The GitHub Actions workflow `--ci` writes (uploads reports/ when the run fails). */
export function ciWorkflow(dir: string): string {
  const node = fs.existsSync(path.join(dir, 'package.json'))
  const python = fs.existsSync(path.join(dir, 'pyproject.toml'))
  const go = fs.existsSync(path.join(dir, 'go.mod'))
  const vib = node ? 'npx vib' : 'npx --yes --package @jmoak/vibrissa vib'
  const lines = [
    '# Vibrissa contract tests: cases + manifest lock + spec/description checks.',
    '# Generated by `vib init --ci`. Uses the "ci" profile in vibrissa.json; reports/ is uploaded on failure.',
    'name: vibrissa',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    '  contract:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    ...(node ? ['          cache: npm'] : []),
  ]
  if (python) {
    lines.push(
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
      '      - run: pip install -e .',
    )
  }
  if (go)
    lines.push('      - uses: actions/setup-go@v5', '        with:', '          go-version: stable')
  if (node) lines.push('      - run: npm ci', '      - run: npm run build --if-present')
  lines.push(
    `      - run: ${vib} run --profile ci`,
    '      - uses: actions/upload-artifact@v4',
    '        if: failure()',
    '        with:',
    '          name: vibrissa-reports',
    '          path: reports/',
    '',
  )
  return lines.join('\n')
}

/** Placeholder sample when no real call could be recorded (skipped until edited). */
function skippedSample(
  file: string,
  dir: string,
  tool: string,
  args: Record<string, JsonValue>,
  why: string,
): Record<string, JsonValue> {
  return {
    $schema: schemaRefFor(file, dir, 'case.schema.json'),
    name: `${tool} sample`,
    skip: `edit args for your server (${why}), then delete this line`,
    tool,
    args,
    expect: { $partial: true },
  }
}

function sampleFlow(file: string, dir: string): Record<string, JsonValue> {
  return {
    $schema: schemaRefFor(file, dir, 'case.schema.json'),
    name: 'sample flow: create, read back, clean up',
    skip: 'sample: replace notes.* with your own tools (or record one: vib record --flow), then delete this line',
    tags: ['sample'],
    steps: [
      {
        name: 'create',
        tool: 'notes.create',
        args: { title: 'hello' },
        capture: { noteId: 'structuredContent.id' },
        expect: { $partial: true, structuredContent: { id: { $type: 'string' } } },
      },
      {
        name: 'read back',
        tool: 'notes.get',
        args: { id: '{{noteId}}' },
        expect: { $partial: true, structuredContent: { title: 'hello' } },
      },
    ],
    teardown: [{ tool: 'notes.delete', args: { id: '{{noteId}}' }, ignoreErrors: true }],
  }
}

/** Pick the tool `init` may call: read-only first, never one annotated destructive. */
export function pickSampleTool(tools: ToolSummary[]): ToolSummary | undefined {
  const ann = (t: ToolSummary) => (isObject(t.annotations) ? t.annotations : {})
  return (
    tools.find((t) => ann(t).readOnlyHint === true) ??
    tools.find((t) => ann(t).destructiveHint !== true)
  )
}

/** A readable value for one property: example/default/const/enum, else a plain per-type value. */
function friendlyValue(schema: JsonValue): JsonValue {
  if (!isObject(schema)) return 'hello'
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  switch (type) {
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1
    case 'boolean':
      return true
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return 'hello'
  }
}

/**
 * Minimal schema-valid args for the sample call: readable values for the required
 * properties when they validate, else the fuzz generator's "only required properties" case.
 */
export function minimalArgs(inputSchema: JsonValue): Record<string, JsonValue> {
  const schema = isObject(inputSchema) ? inputSchema : {}
  const props = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  const friendly: Record<string, JsonValue> = {}
  for (const name of required) friendly[name] = friendlyValue(props[name] ?? {})
  if (validateAgainstSchema(inputSchema, friendly).ok) return friendly
  const cases = generateArgs(inputSchema, {
    seed: 'vib-init',
    count: 12,
    strategies: ['valid'],
    selfCheck: true,
  })
  return (cases.find((c) => /only required/i.test(c.reason)) ?? cases[0])?.args ?? {}
}

interface SampleResult {
  path: string
  status: WriteStatus
  /** A real call was recorded (otherwise a skipped placeholder was written). */
  recorded: boolean
  tool?: string
  reason?: string
}

/**
 * Start the configured server, call one tool with minimal generated args and record it as
 * the sample case. Falls back to a skipped placeholder when the server does not start, lists
 * no callable tool, or the call fails.
 */
async function writeSample(
  dir: string,
  configPath: string,
  force: boolean,
  allowCall: boolean,
  notes: string[],
): Promise<SampleResult> {
  const { options } = loadConfig(dir, { configPath })
  const { dir: casesDir, suffix } = suiteLayout(options.globs)
  const placeholder = (
    tool: string,
    args: Record<string, JsonValue>,
    why: string,
  ): SampleResult => {
    const file = path.join(dir, casesDir, `sample${suffix}`)
    const status = writeFile(
      file,
      `${JSON.stringify(skippedSample(file, dir, tool, args, why), null, 2)}\n`,
      force,
    )
    return { path: file, status, recorded: false, tool, reason: why }
  }
  if (!allowCall) return placeholder('echo', { text: 'hello' }, '--no-call')
  let session: McpSession | undefined
  try {
    try {
      session = await McpSession.start(resolveServerConfig(options), {
        timeoutMs: Math.min(options.timeoutMs, 10_000),
        stderr: 'capture',
      })
    } catch (err) {
      const why = err instanceof Error ? firstLine(err.message) : String(err)
      return placeholder(
        'echo',
        { text: 'hello' },
        `the server did not start: ${truncate(why, 120)}`,
      )
    }
    const tools = await session.listTools()
    const tool = pickSampleTool(tools)
    if (!tool) {
      return placeholder(
        tools[0]?.name ?? 'echo',
        {},
        tools.length
          ? 'every tool is annotated destructive, so none was called'
          : 'the server lists no tools',
      )
    }
    const args = minimalArgs(tool.inputSchema)
    const op: OpSpec = { kind: 'tool', target: tool.name, args }
    const outcome = await executeOp(session, op, { timeoutMs: options.timeoutMs })
    const observed = observedFromOutcome(outcome)
    if (observed.kind !== 'result') {
      const why =
        observed.kind === 'error'
          ? `calling ${tool.name} with generated args failed: ${truncate(firstLine(observed.error?.message ?? ''), 100)}`
          : `${tool.name} asked for input`
      return placeholder(tool.name, args, why)
    }
    const second = await executeOp(session, op, { timeoutMs: options.timeoutMs })
    const loosened: Loosened[] = []
    const step = stepFromObserved(
      op,
      observed,
      {
        normalize: options.normalize,
        loosened,
        ...(second.kind === 'result' ? { second: second.result } : {}),
      },
      notes,
    ) as Step
    const name = defaultName(op)
    const file = uniquePath(
      path.join(dir, casesDir, `${slugify(name) || 'sample'}${suffix}`),
      suffix,
    )
    const testCase = { $schema: schemaRefFor(file, dir, 'case.schema.json'), name, ...step }
    const status = writeFile(file, `${JSON.stringify(testCase, null, 2)}\n`, force)
    notes.push(
      `Recorded a real sample by calling ${tool.name} ${preview(args, 80)} (pass --no-call to skip calling tools).`,
    )
    if (loosened.length > 0) notes.push(`${loosenedSummary(loosened)} in the sample.`)
    return { path: file, status, recorded: true, tool: tool.name }
  } catch (err) {
    const why = err instanceof Error ? firstLine(err.message) : String(err)
    return placeholder('echo', { text: 'hello' }, truncate(why, 120))
  } finally {
    await session?.close()
  }
}

const GITIGNORE_LINE = 'reports/'

/** Add `reports/` to .gitignore (created when missing). */
function ensureGitignore(dir: string): 'created' | 'updated' | 'present' {
  const file = path.join(dir, '.gitignore')
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${GITIGNORE_LINE}\n`, 'utf8')
    return 'created'
  }
  const text = fs.readFileSync(file, 'utf8')
  if (/^\/?reports\/?\s*$/m.test(text)) return 'present'
  fs.writeFileSync(
    file,
    `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${GITIGNORE_LINE}\n`,
    'utf8',
  )
  return 'updated'
}

/** The scaffolded `ci` profile: the workflow runs `vib run --profile ci` and nothing else. */
export const CI_PROFILE = { reporters: [...CI_REPORTERS], check: true, requireManifest: true }

/** Ensure an existing vibrissa.json has the `ci` profile the workflow uses. */
function ensureCiProfile(configPath: string, notes: string[]): 'added' | 'present' | 'skipped' {
  const text = fs.readFileSync(configPath, 'utf8')
  let config: Record<string, JsonValue>
  try {
    config = JSON.parse(text) as Record<string, JsonValue>
  } catch {
    notes.push(
      `Add a "ci" profile to ${configPath} by hand: ${JSON.stringify({ ci: CI_PROFILE })}.`,
    )
    return 'skipped'
  }
  const profiles = isObject(config.profiles) ? config.profiles : {}
  if (profiles.ci !== undefined) return 'present'
  config.profiles = { ...profiles, ci: CI_PROFILE }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return 'added'
}

function describeEntry(entry: ServerEntry): string {
  if (typeof entry.url === 'string') return entry.url
  return [entry.cmd, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ')
}

export async function initCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const dir = resolvePathFromCwd(takeFlag(argv, '--dir') ?? '.')
  const force = hasFlag(argv, '--force')
  const ci = hasFlag(argv, '--ci')
  const claude = takeOptionalFlag(argv, '--from-claude-config')
  const configPath = path.join(dir, 'vibrissa.json')
  const files: Array<{ path: string; status: string; what: string }> = []
  const notes: string[] = []
  const c = colors()

  // `vib init --ci` in a configured project: only the workflow (+ the ci profile it uses).
  if (ci && fs.existsSync(configPath) && !force) {
    const workflow = path.join(dir, '.github', 'workflows', 'vibrissa.yml')
    files.push({ what: 'ci', path: workflow, status: writeFile(workflow, ciWorkflow(dir), false) })
    const profile = ensureCiProfile(configPath, notes)
    files.push({
      what: 'profile',
      path: configPath,
      status: profile === 'added' ? 'updated' : profile,
    })
    if (flags.json) {
      printJson({
        ok: true,
        dir,
        files,
        ...(notes.length ? { notes } : {}),
        next: ['vib run --profile ci'],
      })
      return 0
    }
    console.log(
      `${c.green(c.bold('vib init --ci'))} ${c.dim('· vibrissa.json exists; writing CI only')}`,
    )
    for (const f of files) console.log(`  ${f.what.padEnd(7)} ${f.status.padEnd(7)} ${f.path}`)
    for (const note of notes) console.log(c.yellow(`note: ${note}`))
    if (files[0].status === 'skipped')
      console.log(c.yellow('The workflow already exists; re-run with --force to replace it.'))
    return 0
  }

  let detected: Detected
  if (claude !== undefined) detected = fromClaudeConfig(dir, claude)
  else if (flags.server !== undefined) {
    const raw = flags.server.trim()
    if (/^https?:\/\//i.test(raw))
      detected = { servers: { default: { url: raw } }, source: '--server', notes: [] }
    else {
      const { cmd, args } = splitCommandLine(raw)
      detected = { servers: { default: { cmd, args, cwd: '.' } }, source: '--server', notes: [] }
    }
  } else detected = detectServer(dir)
  notes.push(...detected.notes)
  if (flags.protocol !== undefined) {
    for (const entry of Object.values(detected.servers))
      entry.protocol = flags.protocol as JsonValue
  }
  const names = Object.keys(detected.servers)
  const defaultServer = names.includes('default') ? 'default' : names[0]

  const config = {
    $schema: schemaRefFor(configPath, dir, 'vibrissa.schema.json'),
    servers: detected.servers,
    defaultServer,
    globs: ['tests/integration/**/*.json', '!tests/integration/**/__manifest__*.json'],
    manifest: 'tests/integration/__manifest__.json',
    timeoutMs: flags.timeoutMs ?? 15000,
    reporters: ['console'],
    profiles: { ci: CI_PROFILE },
  }
  files.push({
    what: 'config',
    path: configPath,
    status: writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, force),
  })
  const sample = await writeSample(dir, configPath, force, !hasFlag(argv, '--no-call'), notes)
  files.push({ what: 'sample', path: sample.path, status: sample.status })
  const flowPath = path.join(path.dirname(sample.path), 'flow.sample.json')
  files.push({
    what: 'flow',
    path: flowPath,
    status: writeFile(flowPath, `${JSON.stringify(sampleFlow(flowPath, dir), null, 2)}\n`, force),
  })
  if (ci) {
    const workflow = path.join(dir, '.github', 'workflows', 'vibrissa.yml')
    files.push({ what: 'ci', path: workflow, status: writeFile(workflow, ciWorkflow(dir), force) })
  }
  const gitignore = ensureGitignore(dir)
  files.push({ what: 'gitignore', path: path.join(dir, '.gitignore'), status: gitignore })

  const pkgPath = path.join(dir, 'package.json')
  let pkgNote = 'no package.json (skipped the npm script)'
  const pkg = readJson(pkgPath)
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    if (!scripts['test:integration'] || force) {
      pkg.scripts = { ...scripts, 'test:integration': 'vib run' }
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
      pkgNote = 'added scripts.test:integration = "vib run"'
    } else pkgNote = 'scripts.test:integration already present'
  }
  const skipped = files.some((f) => f.status === 'skipped')
  const next = [
    'vib discover          # what the server is and supports',
    'vib tools             # its tools (also: vib resources, vib prompts)',
    'vib record <tool> --arg key=value',
    'vib manifest record   # lock the tool surface',
    'vib run',
  ]

  if (flags.json) {
    printJson({
      ok: true,
      dir,
      servers: detected.servers,
      defaultServer,
      source: detected.source,
      files,
      sample: {
        recorded: sample.recorded,
        ...(sample.tool ? { tool: sample.tool } : {}),
        ...(sample.reason ? { reason: sample.reason } : {}),
      },
      package: pkgNote,
      ...(notes.length ? { notes } : {}),
      next,
    })
    return 0
  }
  const where =
    detected.source === 'default'
      ? 'a guess (no entry point found)'
      : detected.source === '--server'
        ? 'from --server'
        : `detected from ${detected.source}`
  const servers =
    names.length === 1
      ? `server "${names[0]}" = ${describeEntry(detected.servers[names[0]])} (${where})`
      : `${names.length} servers from ${detected.source}: ${names.join(', ')} (default "${defaultServer}")`
  console.log(`${c.green(c.bold('vib init'))} · ${servers}`)
  for (const f of files)
    console.log(
      `  ${f.what.padEnd(9)} ${(f.status === 'skipped' ? c.yellow : c.green)(f.status.padEnd(7))} ${f.path}`,
    )
  console.log(`  ${'package'.padEnd(9)} ${pkgNote}`)
  if (!sample.recorded && sample.reason)
    console.log(c.yellow(`note: wrote a skipped sample: ${sample.reason}.`))
  for (const note of notes) console.log(c.yellow(`note: ${note}`))
  if (skipped)
    console.log(
      c.yellow(
        'Some files already existed and were left alone; re-run with --force to replace them.',
      ),
    )
  console.log('')
  console.log(c.bold('Next:'))
  next.forEach((line, i) => console.log(`  ${i + 1}. ${line}`))
  return 0
}
