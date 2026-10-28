import { printJson } from './args.js'
import { formatPromptList } from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'
import { listOptional } from './resources.js'

export async function promptsCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const { session } = await startSession(flags)
  try {
    const info = await session.discover()
    const prompts = await listOptional(info.capabilities, 'prompts', 'prompts/list', () =>
      session.listPromptsResult(),
    )
    if (flags.json) {
      printJson({ ok: true, prompts: prompts.items, listMeta: { prompts: prompts.meta } })
    } else {
      console.log(formatPromptList(prompts.items, prompts.meta, prompts.note ? [prompts.note] : []))
    }
    return 0
  } finally {
    await session.close()
  }
}
