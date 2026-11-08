import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { VIBRISSA_CLIENT_INFO } from '../src/session/index.js'

test('MCP client identifies itself with the installed package version', () => {
  const manifest = createRequire(import.meta.url)('../package.json')
  expect(VIBRISSA_CLIENT_INFO).toEqual({ name: 'vibrissa', version: manifest.version })
})
