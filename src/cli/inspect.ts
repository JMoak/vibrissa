import { spawn } from 'node:child_process'
import { hasFlag } from './args.js'
import { formatSuccessBanner, formatWarnBanner } from './format.js'
import { openSessionOptions, parseCommonFlags } from './resolve.js'

export async function inspectCommand(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--')
  const ownArgs = dash === -1 ? argv : argv.slice(0, dash)
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1)
  const flags = parseCommonFlags(ownArgs)
  const { server } = openSessionOptions(flags)

  const cliMode = hasFlag(ownArgs, '--cli') || passthrough[0] === '--cli'
  const rest = passthrough[0] === '--cli' ? passthrough.slice(1) : passthrough

  const inspectorArgs = [
    '--yes',
    '@modelcontextprotocol/inspector',
    ...(cliMode ? ['--cli'] : []),
    server.cmd,
    ...(server.args ?? []),
    ...rest,
  ]

  console.log(
    formatSuccessBanner(
      `Opening MCP Inspector for: ${server.cmd} ${(server.args ?? []).join(' ')}`.trim(),
    ),
  )
  console.log(
    formatWarnBanner(
      'Inspector = visual exploration · Vibrissa tools/call/record/run = the regression loop',
    ),
  )

  const child = spawn('npx', inspectorArgs, {
    cwd: server.cwd ?? process.cwd(),
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  return await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      console.error(`Failed to launch MCP Inspector: ${err.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1)
        return
      }
      resolve(code ?? 1)
    })
  })
}
