/**
 * `vib init`: scaffold a v2 project — vibrissa.json (servers map + ci profile), a sample
 * case and a sample flow, optionally a GitHub workflow (--ci), with servers pre-filled from
 * Claude configs (--from-claude-config) or detected from the project (Node, Python, Go).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { JsonValue } from '../types.js'
import {
  UsageError,
  hasFlag,
  printJson,
  resolvePathFromCwd,
  schemaRefFor,
  splitCommandLine,
  takeFlag,
  takeOptionalFlag,
} from './args.js'
import { colors } from './format.js'
import { parseCommonFlags } from './resolve.js'

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
    `      - run: ${vib} run --profile ci --check --reporter ${CI_REPORTERS.join(',')}`,
    '      - uses: actions/upload-artifact@v4',
    '        if: failure()',
    '        with:',
    '          name: vibrissa-reports',
    '          path: reports/',
    '',
  )
  return lines.join('\n')
}

function sampleCase(file: string, dir: string): Record<string, JsonValue> {
  return {
    $schema: schemaRefFor(file, dir, 'case.schema.json'),
    name: 'echo basic',
    tool: 'echo',
    args: { text: 'hello', uppercase: true },
    expect: { content: [{ type: 'text', text: 'HELLO' }] },
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

export async function initCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const dir = resolvePathFromCwd(takeFlag(argv, '--dir') ?? '.')
  const force = hasFlag(argv, '--force')
  const claude = takeOptionalFlag(argv, '--from-claude-config')

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
  if (flags.protocol !== undefined) {
    for (const entry of Object.values(detected.servers))
      entry.protocol = flags.protocol as JsonValue
  }
  const names = Object.keys(detected.servers)
  const defaultServer = names.includes('default') ? 'default' : names[0]

  const configPath = path.join(dir, 'vibrissa.json')
  const casesDir = path.join(dir, 'tests', 'integration')
  const samplePath = path.join(casesDir, 'echo.basic.json')
  const flowPath = path.join(casesDir, 'flow.sample.json')
  const config = {
    $schema: schemaRefFor(configPath, dir, 'vibrissa.schema.json'),
    servers: detected.servers,
    defaultServer,
    globs: ['tests/integration/**/*.json', '!tests/integration/**/__manifest__*.json'],
    manifest: 'tests/integration/__manifest__.json',
    timeoutMs: flags.timeoutMs ?? 15000,
    reporters: ['console'],
    profiles: {
      ci: { reporters: [...CI_REPORTERS], check: true },
    },
  }

  const files: Array<{ path: string; status: WriteStatus; what: string }> = []
  files.push({
    what: 'config',
    path: configPath,
    status: writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, force),
  })
  files.push({
    what: 'sample',
    path: samplePath,
    status: writeFile(
      samplePath,
      `${JSON.stringify(sampleCase(samplePath, dir), null, 2)}\n`,
      force,
    ),
  })
  files.push({
    what: 'flow',
    path: flowPath,
    status: writeFile(flowPath, `${JSON.stringify(sampleFlow(flowPath, dir), null, 2)}\n`, force),
  })
  if (hasFlag(argv, '--ci')) {
    const workflow = path.join(dir, '.github', 'workflows', 'vibrissa.yml')
    files.push({ what: 'ci', path: workflow, status: writeFile(workflow, ciWorkflow(dir), force) })
  }

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
      package: pkgNote,
      notes: detected.notes,
      next,
    })
    return 0
  }
  const c = colors()
  console.log(
    c.green(c.bold('vib init')) + c.dim(` · servers from ${detected.source}: ${names.join(', ')}`),
  )
  for (const f of files)
    console.log(
      `  ${f.what.padEnd(7)} ${(f.status === 'wrote' ? c.green : c.yellow)(f.status.padEnd(7))} ${f.path}`,
    )
  console.log(`  package ${pkgNote}`)
  for (const note of detected.notes) console.log(c.yellow(`note: ${note}`))
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
