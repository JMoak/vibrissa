import type { CheckOutcome } from '../events.js'
import { listChecks, runChecks, summarizeChecks } from '../lint/index.js'
import { captureManifest } from '../manifest.js'
import { printJson, takeAllFlags } from './args.js'
import { colors, plural, renderTable } from './format.js'
import { loadChecksConfig, openSessionOptions, parseCommonFlags, startSession } from './resolve.js'

export function formatChecks(outcomes: CheckOutcome[], verbose: boolean): string {
  const c = colors()
  const groups: Array<[CheckOutcome['status'], string, (t: string) => string]> = [
    ['failed', 'Failed', c.red],
    ['warned', 'Warned', c.yellow],
    ['passed', 'Passed', c.green],
  ]
  const out: string[] = []
  for (const [status, label, paint] of groups) {
    const items = outcomes.filter((o) => o.status === status)
    if (items.length === 0) continue
    out.push(paint(c.bold(`${label} (${items.length})`)))
    if (status === 'passed' && !verbose) {
      const ids = [...new Set(items.map((o) => o.id))]
      out.push(`  ${c.dim(ids.join(', '))}`, '')
      continue
    }
    for (const o of items) {
      out.push(
        `  ${paint(status === 'failed' ? '✗' : status === 'warned' ? '!' : '✓')} ${c.bold(o.id)}  ${c.dim(o.title)}`,
      )
      if (o.detail) for (const line of o.detail.split(/\r?\n/)) out.push(`      ${line}`)
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}

export async function checkCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  if (argv.includes('--list')) {
    const checks = listChecks()
    if (flags.json) printJson({ checks })
    else {
      console.log(
        renderTable(
          [{ header: 'ID' }, { header: 'DEFAULT' }, { header: 'TITLE', flex: true }],
          checks.map((check) => [check.id, check.severity, check.title]),
        ),
      )
      console.log(
        colors().dim(
          '\nSkip a check with "checks": { "allow": ["<id>" | "<id>:<subject>" | "desc/*"] } in vibrissa.json, or --allow <id>.',
        ),
      )
    }
    return 0
  }

  const resolved = openSessionOptions(flags)
  const config = loadChecksConfig(flags, resolved.options)
  const allow = [...(config.allow ?? []), ...takeAllFlags(argv, '--allow')]
  const { session, serverName } = await startSession(flags, {}, resolved)
  try {
    const captured = await captureManifest(session, { toolsListSamples: 2 })
    const outcomes = runChecks(captured.manifest, {
      toolsListSamples: captured.toolsListSamples,
      ...(allow.length > 0 ? { allow } : {}),
      ...(config.severity ? { severity: config.severity } : {}),
    }).map((o) => ({ ...o, server: serverName }))
    const summary = summarizeChecks(outcomes)
    const ok = summary.failed === 0
    if (flags.json) {
      printJson({
        ok,
        server: serverName,
        protocolVersion: captured.manifest.protocolVersion,
        serverInfo: captured.manifest.server,
        summary,
        outcomes,
      })
    } else {
      const c = colors()
      const who = [captured.manifest.server.name, captured.manifest.server.version]
        .filter(Boolean)
        .join(' ')
      console.log(c.bold(`vib check · ${who || serverName} · ${captured.manifest.protocolVersion}`))
      console.log('')
      console.log(formatChecks(outcomes, argv.includes('--verbose')))
      console.log('')
      const line = `${plural(summary.failed, 'failed check')}, ${plural(summary.warned, 'warning')}, ${summary.passed} passed`
      console.log(ok ? c.green(line) : c.red(line))
      if (!ok) {
        console.log(
          c.dim(
            'Fix the server, or allow-list a reviewed finding with "checks": { "allow": ["<id>:<subject>"] } (see docs/CHECKS.md).',
          ),
        )
      }
    }
    return ok ? 0 : 1
  } finally {
    await session.close()
  }
}
