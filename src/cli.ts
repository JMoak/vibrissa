#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
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
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--config') configPath = argv[i + 1]
  if (argv[i] === '--server-cwd') cwd = argv[i + 1]
}

const resolved = resolveOptions(cwd, configPath)
await runCases(resolved)
process.exit(0)
