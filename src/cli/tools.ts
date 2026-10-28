import { UsageError, hasFlag, positionals, printJson, unknownNameError } from './args.js'
import { formatToolDetail, formatToolList } from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'
import { metaOf } from './resources.js'

export async function toolsCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const [name, extra] = positionals(argv)
  if (extra !== undefined) {
    throw new UsageError(`Unexpected argument "${extra}".`, {
      code: 'invalid-argument',
      hint: 'Usage: vib tools [<name>].',
    })
  }
  const { session } = await startSession(flags)
  try {
    const list = await session.listToolsResult()
    const meta = metaOf(list)
    if (name === undefined) {
      if (flags.json) printJson({ ok: true, tools: list.items, listMeta: { tools: meta } })
      else console.log(formatToolList(list.items, meta))
      return 0
    }
    const tool = list.items.find((t) => t.name === name)
    if (!tool) {
      if (hasFlag(argv, '--expect-missing')) {
        if (flags.json) printJson({ ok: true, tool: null, missing: name })
        else console.log(`Tool "${name}" is not listed (as expected).`)
        return 0
      }
      throw unknownNameError(
        'tool',
        name,
        list.items.map((t) => t.name),
        'vib tools',
      )
    }
    if (flags.json) printJson({ ok: true, tool })
    else console.log(formatToolDetail(tool))
    return 0
  } finally {
    await session.close()
  }
}
