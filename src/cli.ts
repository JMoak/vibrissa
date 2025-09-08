#!/usr/bin/env node
import { runCases } from './index.js'

function printHelp(): void {
  const text = [
    'mcp-test - JSON-driven MCP integration runner',
    '',
    'Usage:',
    '  mcp-test --server "<cmd>" --cases "<glob>" [options]',
    '',
    'Options:',
    '  --server        Command to start the MCP server',
    '  --cases         Glob of JSON test files',
    '  --concurrency   Number of concurrent tests (default: 1)',
    '  --timeout       Per-test timeout in ms (default: 15000)',
    '  --fail-fast     Stop on first failure',
    '  -h, --help      Show help',
  ].join('\n')
  console.log(text)
}

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
  printHelp()
  process.exit(0)
}

await runCases({})
process.exit(0)
