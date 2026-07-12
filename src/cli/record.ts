import fs from 'node:fs'
import path from 'node:path'
import { McpSession } from '../mcp-session.js'
import type { JsonValue, TestCase } from '../types.js'
import { hasFlag, parseToolArgs, printJson, resolvePathFromCwd, takeFlag } from './args.js'
import {
  formatCallHeader,
  formatErrorBanner,
  formatSuccessBanner,
  formatWarnBanner,
} from './format.js'
import { openSessionOptions, parseCommonFlags } from './resolve.js'

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function defaultOutPath(rootDir: string, tool: string, name: string): string {
  const dir = path.join(rootDir, 'tests', 'integration')
  return path.join(dir, `${slugify(name) || slugify(tool) || 'case'}.json`)
}

function caseSchemaRef(outPath: string, rootDir: string): string {
  const localSchema = path.join(rootDir, 'node_modules', 'vibrissa', 'schema', 'case.schema.json')
  if (fs.existsSync(localSchema)) {
    return path.relative(path.dirname(outPath), localSchema).replace(/\\/g, '/')
  }
  return 'https://unpkg.com/vibrissa/schema/case.schema.json'
}

export async function recordCommand(argv: string[]): Promise<number> {
  const tool = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  if (!tool) {
    console.error(
      'Usage: vib-test record <tool> [--args \'{"key":"value"}\'] [--out path] [--name "..."] [--partial]',
    )
    return 1
  }

  const rest = argv.slice(1)
  const flags = parseCommonFlags(rest)
  const args = parseToolArgs(rest)
  const name = takeFlag(rest, '--name') ?? `${tool} recorded`
  const outFlag = takeFlag(rest, '--out')
  const partial = hasFlag(rest, '--partial')
  const force = hasFlag(rest, '--force')

  const { server, rootDir, timeoutMs } = openSessionOptions(flags)
  const outPath = outFlag ? resolvePathFromCwd(outFlag) : defaultOutPath(rootDir, tool, name)

  if (fs.existsSync(outPath) && !force) {
    console.error(formatErrorBanner(`Refusing to overwrite ${outPath} (pass --force to replace)`))
    return 1
  }

  const spawnTimeoutMs = Math.max(2000, Math.min(10000, timeoutMs))
  const session = await McpSession.start(server, spawnTimeoutMs)
  try {
    if (!flags.json) console.log(formatCallHeader(tool, args))
    const outcome = await session.callTool(tool, args, timeoutMs)

    const testCase: TestCase & { $schema?: string } = {
      $schema: caseSchemaRef(outPath, rootDir),
      name,
      tool,
      args,
    }

    if (outcome.kind === 'error') {
      testCase.expectError = {
        ...(outcome.error.codeName ? { code: outcome.error.codeName } : {}),
        message: { $regex: escapeRegex(outcome.error.message.slice(0, 80)) },
      }
      if (!flags.json) {
        console.log(
          formatWarnBanner(
            `Captured ${outcome.error.kind} error into expectError (${outcome.error.codeName ?? 'tool'})`,
          ),
        )
      }
    } else {
      const expect = outcome.result as JsonValue
      testCase.expect = partial
        ? ({ $partial: true, ...(expect as Record<string, JsonValue>) } as JsonValue)
        : expect
      if (!flags.json) console.log(formatSuccessBanner('Captured result into expect'))
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${JSON.stringify(testCase, null, 2)}\n`, 'utf8')

    if (flags.json) printJson({ ok: true, path: outPath, case: testCase })
    else console.log(`${formatSuccessBanner('wrote')} ${outPath}`)
    return 0
  } finally {
    await session.close()
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
