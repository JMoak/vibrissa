import { McpSession } from '../mcp-session.js'
import { parseToolArgs, printJson } from './args.js'
import { formatCallHeader, formatErrorBanner, formatSuccessBanner } from './format.js'
import { openSessionOptions, parseCommonFlags } from './resolve.js'

export async function callCommand(argv: string[]): Promise<number> {
  const tool = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  if (!tool) {
    console.error('Usage: vib-test call <tool> [--args \'{"key":"value"}\'] [--arg key=value]')
    return 1
  }
  const flags = parseCommonFlags(argv.slice(1))
  const args = parseToolArgs(argv.slice(1))
  const { server, timeoutMs } = openSessionOptions(flags)
  const spawnTimeoutMs = Math.max(2000, Math.min(10000, timeoutMs))
  const session = await McpSession.start(server, spawnTimeoutMs)
  try {
    if (!flags.json) console.log(formatCallHeader(tool, args))
    const outcome = await session.callTool(tool, args, timeoutMs)
    if (outcome.kind === 'error') {
      if (flags.json) {
        printJson({ ok: false, error: outcome.error })
      } else {
        const label = outcome.error.codeName ? ` [${outcome.error.codeName}]` : ''
        console.error(
          formatErrorBanner(`error${label} (${outcome.error.kind}): ${outcome.error.message}`),
        )
      }
      return 1
    }
    if (flags.json) printJson({ ok: true, result: outcome.result })
    else {
      console.log(formatSuccessBanner('ok'))
      printJson(outcome.result)
    }
    return 0
  } finally {
    await session.close()
  }
}
