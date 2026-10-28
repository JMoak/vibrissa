import { printJson } from './args.js'
import { formatToolList } from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'
import { metaOf } from './resources.js'

export async function toolsCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const { session } = await startSession(flags)
  try {
    const list = await session.listToolsResult()
    const meta = metaOf(list)
    if (flags.json) printJson({ tools: list.items, listMeta: { tools: meta } })
    else console.log(formatToolList(list.items, meta))
    return 0
  } finally {
    await session.close()
  }
}
