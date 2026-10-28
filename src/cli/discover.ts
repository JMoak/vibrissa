import type { DiscoverInfo, JsonValue } from '../types.js'
import { printJson } from './args.js'
import { colors, isObject, preview } from './format.js'
import { describeServerTarget, parseCommonFlags, startSession } from './resolve.js'

/** Capability names with a short note on their sub-flags (`tools (listChanged)`). */
function capabilityLines(capabilities: JsonValue): string[] {
  if (!isObject(capabilities)) return [preview(capabilities)]
  const lines: string[] = []
  for (const [name, value] of Object.entries(capabilities)) {
    if (name === 'extensions') continue
    const flags = isObject(value)
      ? Object.entries(value)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
      : []
    lines.push(flags.length > 0 ? `${name} (${flags.join(', ')})` : name)
  }
  return lines
}

export function formatDiscover(info: DiscoverInfo, target?: string): string {
  const c = colors()
  const identity = info.serverInfo
  const name = identity?.name ?? '(no name)'
  const version = identity?.version ? ` ${identity.version}` : ''
  const title = identity?.title ? ` — ${identity.title}` : ''
  const rows: Array<[string, string]> = [
    ['server', `${c.bold(name)}${version}${title}`],
    [
      'protocol',
      `${info.protocolVersion || '(unknown)'} ${c.dim(`(${info.era} era${info.synthesized ? ', from initialize' : ', from server/discover'})`)}`,
    ],
  ]
  if (info.supportedVersions.length > 0) rows.push(['supports', info.supportedVersions.join(', ')])
  if (target) rows.push(['transport', target])
  const caps = capabilityLines(info.capabilities)
  rows.push(['capabilities', caps.length > 0 ? caps.join(', ') : c.dim('(none)')])
  rows.push([
    'extensions',
    info.extensions.length > 0 ? info.extensions.join(', ') : c.dim('(none)'),
  ])
  const width = Math.max(...rows.map(([k]) => k.length))
  const out = rows.map(([k, v]) => `${c.dim(k.padEnd(width))}  ${v}`)
  if (info.instructions) {
    out.push('', c.dim('instructions:'))
    for (const line of info.instructions.trim().split(/\r?\n/)) out.push(`  ${line}`)
  }
  out.push('', c.dim('Next: vib tools · vib resources · vib prompts · vib check'))
  return out.join('\n')
}

export async function discoverCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const { session, server } = await startSession(flags)
  try {
    const info = await session.discover()
    if (flags.json) printJson(info)
    else console.log(formatDiscover(info, describeServerTarget(server)))
    return 0
  } finally {
    await session.close()
  }
}
