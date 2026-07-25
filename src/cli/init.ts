import fs from 'node:fs'
import path from 'node:path'
import { hasFlag, resolvePathFromCwd, takeFlag } from './args.js'
import { formatSuccessBanner, formatWarnBanner } from './format.js'
import { parseCommonFlags } from './resolve.js'

function writeFile(pathName: string, contents: string, force: boolean): 'wrote' | 'skipped' {
  if (fs.existsSync(pathName) && !force) return 'skipped'
  fs.mkdirSync(path.dirname(pathName), { recursive: true })
  fs.writeFileSync(pathName, contents, 'utf8')
  return 'wrote'
}

function detectServerCommand(dir: string): { cmd: string; args: string[] } {
  const distCandidates = ['dist/index.js', 'build/index.js', 'src/index.js']
  for (const candidate of distCandidates) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return { cmd: 'node', args: [candidate] }
    }
  }
  return { cmd: 'node', args: ['dist/index.js'] }
}

function schemaRef(fromFile: string, rootDir: string, schemaName: string): string {
  const local = path.join(rootDir, 'node_modules', 'vibrissa', 'schema', schemaName)
  if (fs.existsSync(local)) {
    return path.relative(path.dirname(fromFile), local).replace(/\\/g, '/')
  }
  return `https://unpkg.com/vibrissa/schema/${schemaName}`
}

export async function initCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const dir = resolvePathFromCwd(takeFlag(argv, '--dir') ?? '.')
  const force = hasFlag(argv, '--force')
  const serverOverride = flags.serverCmd
    ? { cmd: flags.serverCmd, args: flags.serverArgs ?? [] }
    : detectServerCommand(dir)

  const configPath = path.join(dir, 'vibrissa.json')
  const casesDir = path.join(dir, 'tests', 'integration')
  const samplePath = path.join(casesDir, 'echo.basic.json')

  const config = {
    $schema: schemaRef(configPath, dir, 'vibrissa.schema.json'),
    server: {
      cmd: serverOverride.cmd,
      args: serverOverride.args,
      cwd: '.',
    },
    globs: ['tests/integration/**/*.json'],
    timeoutMs: 15000,
    failFast: false,
  }

  const sample = {
    $schema: schemaRef(samplePath, dir, 'case.schema.json'),
    name: 'echo basic',
    tool: 'echo',
    args: { text: 'hello', uppercase: true },
    expect: {
      content: [{ type: 'text', text: 'HELLO' }],
    },
  }

  const configStatus = writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, force)
  fs.mkdirSync(casesDir, { recursive: true })
  const sampleStatus = writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`, force)

  const pkgPath = path.join(dir, 'package.json')
  let pkgNote = 'no package.json found (skipped script)'
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    pkg.scripts ??= {}
    if (!pkg.scripts['test:integration'] || force) {
      pkg.scripts['test:integration'] = 'vib-test run'
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
      pkgNote = 'added scripts.test:integration'
    } else {
      pkgNote = 'scripts.test:integration already present'
    }
  }

  console.log(formatSuccessBanner('vibrissa init'))
  console.log(`  config:  ${configStatus.padEnd(7)} ${configPath}`)
  console.log(`  sample:  ${sampleStatus.padEnd(7)} ${samplePath}`)
  console.log(`  package: ${pkgNote}`)
  console.log('')
  console.log('Next:')
  console.log('  1. vib-test tools')
  console.log('  2. vib-test call <tool> --arg key=value')
  console.log('  3. vib-test record <tool> --arg key=value')
  console.log('  4. vib-test run')
  console.log('  5. vib-test inspect   # open MCP Inspector with this server')
  if (configStatus === 'skipped' || sampleStatus === 'skipped') {
    console.log(
      formatWarnBanner('Some files already existed; re-run with --force to replace them.'),
    )
  }
  return 0
}
