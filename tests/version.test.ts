import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { VIBRISSA_CLIENT_INFO } from '../src/session/index.js'

test('MCP client identifies itself with the installed package version', () => {
  const manifest = createRequire(import.meta.url)('../package.json')
  expect(VIBRISSA_CLIENT_INFO).toEqual({ name: 'vibrissa', version: manifest.version })
})

test('bundled version follows the release manifest and survives relocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-version-'))
  try {
    const source = path.join(dir, 'package', 'src', 'version.ts')
    const outfile = path.join(dir, 'relocated', 'deep', 'version.mjs')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.copyFileSync(fileURLToPath(new URL('../src/version.ts', import.meta.url)), source)
    fs.writeFileSync(
      path.join(dir, 'package', 'package.json'),
      JSON.stringify({ version: '2.0.0-alpha.99' }),
    )
    buildSync({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
    })
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { VERSION } from ${JSON.stringify(pathToFileURL(outfile).href)}; console.log(VERSION)`,
      ],
      { encoding: 'utf8' },
    )
    expect(output.trim()).toBe('2.0.0-alpha.99')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
