import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MANIFEST_IGNORE,
  type Manifest,
  captureManifest,
  diffManifest,
  formatDiff,
  manifestPathFor,
  readManifest,
  summarizeDiff,
  writeManifest,
} from '../manifest.js'
import type { RunOptions } from '../types.js'
import {
  UsageError,
  VALUE_FLAGS,
  normalizeArgv,
  printJson,
  resolvePathFromCwd,
  takeFlag,
} from './args.js'
import { type CommandHelp, formatCommandHelp } from './format.js'
import {
  type CommonCliFlags,
  describeServerTarget,
  parseCommonFlags,
  startSession,
} from './resolve.js'
import { assertCommandFlags, usageFailure } from './run.js'

export const manifestHelp: CommandHelp = {
  name: 'manifest',
  group: 'contract',
  summary: 'Record, diff or show the manifest lock (tools, schemas, descriptions, capabilities)',
  usage: [
    'vib manifest record [--out <path>] [--server <name|cmd|url>] [--json]',
    'vib manifest diff   [--out <path>] [--strict] [--json]',
    'vib manifest show   [--json]',
  ],
  description: [
    'record  snapshot server/discover + tools/list + resources + templates + prompts into the',
    '        lock file (default: "manifest" in vibrissa.json, tests/integration/__manifest__.json).',
    'diff    compare the live server with the lock; exit 1 on drift. `vib run` does this too.',
    '        Each change says whether it is breaking (removed tool/property, newly required, ...).',
    'show    print the live manifest without writing anything.',
    'Servers other than defaultServer use a sibling lock: __manifest__.<server>.json.',
    'Paths in "manifestIgnore" (default server.version, protocolVersion, listMeta) are not',
    'compared, so one lock serves both protocol eras; --strict compares everything.',
    'Full reference: docs/CLI.md.',
  ].join('\n'),
  flags: [
    {
      flag: '--out <path>',
      text: 'Lock file to write (record) or compare (diff); relative to the shell cwd',
    },
    { flag: '--strict', text: 'diff: compare everything (ignore no paths)' },
  ],
  common: true,
  examples: [
    'vib manifest record',
    'vib manifest diff --json',
    'vib manifest show',
    'vib manifest record --server staging --out tests/integration/__manifest__.staging.json',
  ],
  extraFlags: ['--manifest'],
}

const MANIFEST_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, '--out', '--manifest'])

/** Full `vib manifest --help` text. */
export const help: string = formatCommandHelp(manifestHelp)

/** `manifestIgnore` from resolved options (config → profile), else the default. */
export function manifestIgnoreOf(options: Pick<RunOptions, 'manifestIgnore'>): readonly string[] {
  return options.manifestIgnore ?? DEFAULT_MANIFEST_IGNORE
}

function display(file: string): string {
  const rel = path.relative(process.cwd(), file)
  return (rel && !rel.startsWith('..') ? rel : file).replace(/\\/g, '/')
}

function counts(manifest: Manifest): string {
  const parts = [
    `${manifest.tools.length} tool${manifest.tools.length === 1 ? '' : 's'}`,
    `${manifest.resources.length} resource${manifest.resources.length === 1 ? '' : 's'}`,
    `${manifest.resourceTemplates.length} template${manifest.resourceTemplates.length === 1 ? '' : 's'}`,
    `${manifest.prompts.length} prompt${manifest.prompts.length === 1 ? '' : 's'}`,
  ]
  return parts.join(', ')
}

export function formatManifest(manifest: Manifest, target?: string): string {
  const who =
    [manifest.server.name, manifest.server.version].filter(Boolean).join(' ') || '(unnamed server)'
  const lines = [`${who} · protocol ${manifest.protocolVersion}${target ? ` · ${target}` : ''}`]
  lines.push(`  ${counts(manifest)}`)
  const section = (title: string, items: Array<{ key: string; description?: string }>) => {
    if (items.length === 0) return
    lines.push('', `${title}:`)
    for (const item of items) {
      const description = item.description ? ` — ${item.description.split(/\r?\n/)[0]}` : ''
      lines.push(
        `  ${item.key}${description.length > 100 ? `${description.slice(0, 99)}…` : description}`,
      )
    }
  }
  section(
    'tools',
    manifest.tools.map((t) => ({ key: t.name, description: t.description })),
  )
  section(
    'resources',
    manifest.resources.map((r) => ({ key: r.uri, description: r.description })),
  )
  section(
    'resource templates',
    manifest.resourceTemplates.map((t) => ({ key: t.uriTemplate, description: t.description })),
  )
  section(
    'prompts',
    manifest.prompts.map((p) => ({ key: p.name, description: p.description })),
  )
  return lines.join('\n')
}

/** `vib manifest record|diff|show`. */
export async function manifestCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help)
    return 0
  }
  const json = argv.includes('--json')
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined
  if (sub !== 'record' && sub !== 'diff' && sub !== 'show') {
    return usageFailure(
      new UsageError(
        `Unknown manifest action ${sub ? `"${sub}"` : '(none)'}: expected record, diff or show.`,
        {
          code: 'unknown-action',
          hint: 'Example: vib manifest record',
          next: ['vib manifest --help'],
        },
      ),
      'manifest',
      json,
    )
  }
  const rest = normalizeArgv(argv.slice(1), MANIFEST_VALUE_FLAGS)
  let flags: CommonCliFlags
  try {
    assertCommandFlags(rest, manifestHelp, MANIFEST_VALUE_FLAGS)
    flags = parseCommonFlags(rest)
  } catch (err) {
    return usageFailure(err, 'manifest', json)
  }
  const outFlag = takeFlag(rest, '--out') ?? takeFlag(rest, '--manifest')
  const strict = rest.includes('--strict')

  const { session, options, server, serverName } = await startSession(flags)
  try {
    const file = outFlag ? resolvePathFromCwd(outFlag) : manifestPathFor(options, serverName)
    const { manifest } = await captureManifest(session)

    if (sub === 'show') {
      if (flags.json) printJson({ ok: true, server: serverName, manifest })
      else console.log(formatManifest(manifest, describeServerTarget(server)))
      return 0
    }

    if (sub === 'record') {
      const existed = fs.existsSync(file)
      let summary: string | undefined
      if (existed) {
        try {
          summary = summarizeDiff(diffManifest(readManifest(file), manifest, { ignore: [] }))
        } catch {
          summary = undefined
        }
      }
      writeManifest(file, manifest)
      if (flags.json) {
        printJson({
          ok: true,
          path: file,
          server: serverName,
          created: !existed,
          ...(summary ? { changes: summary } : {}),
          manifest,
        })
      } else {
        console.log(`wrote ${display(file)} (${counts(manifest)})`)
        if (summary && summary !== 'no changes')
          console.log(`  changes vs previous lock: ${summary}`)
        console.log('Commit it; vib run now fails when the live surface drifts from it.')
      }
      return 0
    }

    // diff
    if (!fs.existsSync(file)) {
      const named = flags.server !== undefined && Object.hasOwn(options.servers, flags.server)
      const record = `vib manifest record${named ? ` --server ${flags.server}` : ''}`
      return usageFailure(
        new UsageError(`No manifest lock at ${display(file)}.`, {
          code: 'manifest-missing',
          hint: `Create it with "${record}".`,
          next: [record],
        }),
        'manifest',
        Boolean(flags.json),
      )
    }
    const diff = diffManifest(readManifest(file), manifest, {
      ignore: strict ? [] : manifestIgnoreOf(options),
    })
    if (flags.json) {
      printJson({
        ok: diff.identical,
        path: file,
        server: serverName,
        identical: diff.identical,
        summary: summarizeDiff(diff),
        diff,
      })
    } else if (diff.identical) {
      console.log(`manifest ${display(file)}: no drift (${counts(manifest)})`)
    } else {
      console.log(`manifest ${display(file)}:`)
      console.log(formatDiff(diff))
      console.log('')
      console.log(
        'Review the change, then accept it with "vib manifest record" or "vib run --update-manifest".',
      )
    }
    return diff.identical ? 0 : 1
  } finally {
    await session.close()
  }
}
