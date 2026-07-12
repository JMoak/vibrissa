import { McpSession } from '../mcp-session.js'
import { printJson } from './args.js'
import { formatToolList } from './format.js'
import { openSessionOptions, parseCommonFlags } from './resolve.js'

export async function toolsCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const { server, timeoutMs } = openSessionOptions(flags)
  const spawnTimeoutMs = Math.max(2000, Math.min(10000, timeoutMs))
  const session = await McpSession.start(server, spawnTimeoutMs)
  try {
    const tools = await session.listTools()
    if (flags.json) printJson(tools)
    else console.log(formatToolList(tools))
    return 0
  } finally {
    await session.close()
  }
}
