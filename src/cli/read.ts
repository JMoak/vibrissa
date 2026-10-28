import { parseToolArgs } from './args.js'
import { type OneShotSpec, runOneShot } from './call.js'

export const READ_SPEC: OneShotSpec = {
  command: 'read',
  usage: "vib read <uri> | vib read '<uri-template>' --arg key=value [--raw]",
  build: (uri, argv) => {
    const args = parseToolArgs(argv)
    // A URI with {placeholders} is an RFC 6570 template: expand it with --arg values.
    if (/\{[^}]+\}/.test(uri)) return { kind: 'resourceTemplate', target: uri, args }
    return { kind: 'resource', target: uri, args: {} }
  },
}

export async function readCommand(argv: string[]): Promise<number> {
  return runOneShot(READ_SPEC, argv)
}
