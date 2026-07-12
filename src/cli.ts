#!/usr/bin/env node
import { callCommand } from './cli/call.js'
import { initCommand } from './cli/init.js'
import { inspectCommand } from './cli/inspect.js'
import { recordCommand } from './cli/record.js'
import { runCommand } from './cli/run.js'
import { toolsCommand } from './cli/tools.js'

const COMMANDS = new Set(['run', 'tools', 'call', 'record', 'init', 'inspect'])

function printHelp(): void {
  console.log(
    [
      'vib-test — JSON-driven MCP integration runner + authoring loop',
      '',
      'Usage:',
      '  vib-test run [options]                 Run JSON cases (default)',
      '  vib-test tools [options]               List tools on the server',
      '  vib-test call <tool> [options]         Call a tool and print the result',
      '  vib-test record <tool> [options]       Call a tool and write a case file',
      '  vib-test init [options]                Scaffold vibrissa.json + sample case',
      '  vib-test inspect [options] [-- ...]    Open MCP Inspector with this server',
      '',
      'Shared options:',
      '  --config <path>       vibrissa.json / .jsonc / package.json#vibrissa',
      '  --server "<cmd ...>"  Override server command',
      '  --server-cwd <dir>    Working directory for the server process',
      '  --env KEY=VALUE       Extra env var (repeatable)',
      '  --timeout <ms>        Per-call / spawn timeout',
      '  --json                Machine-readable output (tools/call/record)',
      '',
      'run options:',
      '  --cases <glob>        Case glob (relative to shell cwd)',
      '  --fail-fast           Stop on first failure',
      '  --allow-empty         Exit 0 when no cases match',
      '  --pretty / --no-pretty',
      '',
      'call / record options:',
      "  --args '{...}'        JSON object of tool arguments",
      '  --arg key=value       Tool argument (repeatable; JSON-ish values ok)',
      '',
      'record options:',
      '  --out <path>          Case file path (default: tests/integration/<name>.json)',
      '  --name <string>       Case name',
      '  --partial             Wrap expect in "$partial": true',
      '  --force               Overwrite an existing case file',
      '',
      'init options:',
      '  --dir <path>          Target directory (default: .)',
      '  --force               Overwrite existing scaffold files',
      '',
      'inspect options:',
      '  --cli                 Use Inspector CLI mode',
      '  -- ...                Extra args forwarded after the server command',
      '',
      'Workflow:',
      '  init → tools → call → record → run → inspect (when you want the UI)',
    ].join('\n'),
  )
}

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

let command = 'run'
let rest = argv
if (argv[0] && COMMANDS.has(argv[0])) {
  command = argv[0]
  rest = argv.slice(1)
}

let code = 1
try {
  switch (command) {
    case 'run':
      code = await runCommand(rest)
      break
    case 'tools':
      code = await toolsCommand(rest)
      break
    case 'call':
      code = await callCommand(rest)
      break
    case 'record':
      code = await recordCommand(rest)
      break
    case 'init':
      code = await initCommand(rest)
      break
    case 'inspect':
      code = await inspectCommand(rest)
      break
    default:
      printHelp()
      code = 1
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  code = 1
}
process.exit(code)
