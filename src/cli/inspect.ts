/**
 * Wrappers around official tools: `vib inspect` (MCP Inspector) and `vib conformance`
 * (the official conformance suite, HTTP servers only). Vibrissa adds the server from
 * config so you never retype it.
 */
import { spawn } from 'node:child_process'
import { isHttpServerConfig } from '../types.js'
import { UsageError, hasFlag, printJson, splitAtDoubleDash } from './args.js'
import { colors } from './format.js'
import { describeServerTarget, openSessionOptions, parseCommonFlags } from './resolve.js'

function runNpx(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  label: string,
): Promise<number> {
  const child = spawn('npx', args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return new Promise<number>((resolve) => {
    child.on('error', (err) => {
      console.error(
        `Failed to launch ${label}: ${err.message}. Is npx on your PATH (Node.js ≥ 20)?`,
      )
      resolve(2)
    })
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

export async function inspectCommand(argv: string[]): Promise<number> {
  const [own, passthrough] = splitAtDoubleDash(argv)
  const flags = parseCommonFlags(own)
  const { server } = openSessionOptions(flags)
  const cliMode = hasFlag(own, '--cli') || passthrough[0] === '--cli'
  const rest = passthrough[0] === '--cli' ? passthrough.slice(1) : passthrough
  const c = colors()

  let inspectorArgs: string[]
  let cwd = process.cwd()
  let env: Record<string, string> = {}
  if (isHttpServerConfig(server)) {
    inspectorArgs = cliMode
      ? [
          '--yes',
          '@modelcontextprotocol/inspector',
          '--cli',
          server.url,
          '--transport',
          'http',
          ...rest,
        ]
      : ['--yes', '@modelcontextprotocol/inspector', ...rest]
    if (!cliMode) {
      console.log(
        c.yellow(`In the Inspector UI choose "Streamable HTTP" and connect to ${server.url}`),
      )
      if (server.headers && Object.keys(server.headers).length > 0) {
        console.log(
          c.yellow(
            `and add the headers from vibrissa.json (${Object.keys(server.headers).join(', ')}).`,
          ),
        )
      }
    }
  } else {
    inspectorArgs = [
      '--yes',
      '@modelcontextprotocol/inspector',
      ...(cliMode ? ['--cli'] : []),
      server.cmd,
      ...(server.args ?? []),
      ...rest,
    ]
    cwd = server.cwd ?? cwd
    env = server.env ?? {}
  }
  console.log(c.green(`Opening MCP Inspector for ${describeServerTarget(server)}`))
  console.log(
    c.dim('Inspector = visual exploration · vib tools/call/record/run = the regression loop'),
  )
  return runNpx(inspectorArgs, cwd, env, 'MCP Inspector')
}

/**
 * `vib conformance`: run `npx @modelcontextprotocol/conformance server --url <url>` against
 * the configured HTTP server. The official suite is HTTP-first; stdio servers get
 * pointed at `vib check`, which runs the deterministic subset over stdio.
 */
export async function conformanceCommand(argv: string[]): Promise<number> {
  const [own, passthrough] = splitAtDoubleDash(argv)
  const flags = parseCommonFlags(own)
  const { server, serverName } = openSessionOptions(flags)
  if (!isHttpServerConfig(server)) {
    const message = `vib conformance needs an HTTP server: the official suite (@modelcontextprotocol/conformance) connects by URL, and "${serverName}" is a stdio server (${describeServerTarget(server)}).`
    const hint =
      'Run vib check for the deterministic spec-sanity subset over stdio, or start the server over HTTP and pass --server http://127.0.0.1:<port>/mcp.'
    if (flags.json) {
      printJson({ ok: false, error: { code: 'stdio-server', message }, hint })
      return 2
    }
    throw new UsageError(`${message} ${hint}`)
  }
  const args = [
    '--yes',
    '@modelcontextprotocol/conformance',
    'server',
    '--url',
    server.url,
    ...passthrough,
  ]
  if (!flags.json) {
    console.log(colors().green(`Running the official MCP conformance suite against ${server.url}`))
    console.log(colors().dim(`npx ${args.join(' ')}`))
  }
  return runNpx(args, process.cwd(), {}, 'the MCP conformance suite')
}
