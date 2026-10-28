import { parseToolArgs } from './args.js'
import { type OneShotSpec, runOneShot } from './call.js'

export const GET_PROMPT_SPEC: OneShotSpec = {
  command: 'get-prompt',
  usage: 'vib get-prompt <name> [--args \'{"key":"value"}\'] [--arg key=value] [--raw]',
  build: (name, argv) => ({ kind: 'prompt', target: name, args: parseToolArgs(argv) }),
}

export async function getPromptCommand(argv: string[]): Promise<number> {
  return runOneShot(GET_PROMPT_SPEC, argv)
}
