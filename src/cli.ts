#!/usr/bin/env node
import { resolveOptions } from './config.js'
import { runCases } from './index.js'

// Config parsing is handled by resolveOptions

function printHelp(): void {
  const text = [
    'vib-test - JSON-driven MCP integration runner',
    '',
    'Usage:',
    '  vib-test --server "<cmd>" --cases "<glob>" [options]',
    '',
    'Options:',
    '  --config        Path to vibrissa.jsonc or equivalent',
    '  --server        Command to start the MCP server',
    '  --cases         Glob of JSON test files',
    '  --concurrency   Number of concurrent tests (default: 4)',
    '  --timeout       Per-test timeout in ms (default: 15000)',
    '  --fail-fast     Stop on first failure',
    '  -h, --help      Show help',
  ].join('\n')
  console.log(text)
}

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

let cwd = process.cwd()
let configPath: string | undefined
let serverCmd: string | undefined
let serverArgs: string[] | undefined
let casesGlob: string | undefined
let concurrency: number | undefined
let timeoutMs: number | undefined
let failFast: boolean | undefined

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--config') configPath = argv[i + 1]
  if (arg === '--server-cwd') cwd = argv[i + 1]
  if (arg === '--server') {
    serverCmd = argv[i + 1]
    const rest = argv[i + 2]
    if (rest && !rest.startsWith('--')) serverArgs = rest.split(' ')
  }
  if (arg === '--cases') casesGlob = argv[i + 1]
  if (arg === '--concurrency') concurrency = Number(argv[i + 1])
  if (arg === '--timeout') timeoutMs = Number(argv[i + 1])
  if (arg === '--fail-fast') failFast = true
}

const resolved = resolveOptions(cwd, configPath)
const merged = {
  ...resolved,
  server: {
    ...resolved.server,
    ...(serverCmd ? { cmd: serverCmd } : {}),
    ...(serverArgs ? { args: serverArgs } : {}),
  },
  ...(casesGlob ? { globs: [casesGlob] } : {}),
  ...(typeof concurrency === 'number' && Number.isFinite(concurrency) ? { concurrency } : {}),
  ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  ...(failFast ? { failFast: true } : {}),
}

const code = await runCases(merged)
process.exit(code)
