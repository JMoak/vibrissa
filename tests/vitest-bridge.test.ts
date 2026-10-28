import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readManifest } from '../src/manifest'
import { type VitestApi, describeCases } from '../src/vitest'

const fixtureConfig = path.join(process.cwd(), 'tests/fixtures/echo-server/vibrissa.json')

// Real registration: the bridge imports vitest lazily (no api, no globals) and the cases
// below run as ordinary tests of this file.
await describeCases({
  config: fixtureConfig,
  title: 'fixture cases via describeCases',
  globs: [
    'cases/echo.basic.json',
    'cases/flow.capture.json',
    'cases/mrtr.confirm-accept.json',
    'cases/task.slow.json',
    'cases/skip.example.json',
  ],
})

interface Registered {
  titles: string[]
  tests: Array<{ name: string; fn: () => void | Promise<void> }>
  skipped: string[]
  before: Array<() => void | Promise<void>>
  after: Array<() => void | Promise<void>>
}

function fakeApi(): { api: VitestApi; registered: Registered } {
  const registered: Registered = { titles: [], tests: [], skipped: [], before: [], after: [] }
  const it = Object.assign(
    (name: string, fn: () => void | Promise<void>) => void registered.tests.push({ name, fn }),
    { skip: (name: string) => void registered.skipped.push(name) },
  )
  return {
    registered,
    api: {
      describe: (title, fn) => {
        registered.titles.push(title)
        fn()
      },
      it,
      beforeAll: (fn) => void registered.before.push(fn),
      afterAll: (fn) => void registered.after.push(fn),
    },
  }
}

describe('describeCases with an injected api', () => {
  it('registers one test per case (skips as it.skip) and reports failures with mismatches', async () => {
    const { api, registered } = fakeApi()
    await describeCases(
      ['cases/echo.basic.json', 'cases/echo.fail.json', 'cases/skip.example.json'],
      {
        config: fixtureConfig,
        api,
      },
    )
    expect(registered.titles).toEqual(['vibrissa'])
    // The manifest lock gates the bridge like `vib run`; then one test per case.
    expect(registered.tests.map((t) => t.name)).toEqual([
      'manifest lock (tests/__manifest__.json)',
      'echo basic',
      'echo mismatch',
    ])
    expect(registered.skipped).toEqual(['skipped: documents a known gap'])

    for (const fn of registered.before) await fn()
    try {
      await registered.tests[0].fn()
      await registered.tests[1].fn()
      const failure = registered.tests[2].fn()
      await expect(failure).rejects.toThrow(
        /Expectation failed at content\[0\]\.text: expected "HELLO", got "hello"\.\n {2}- content\[0\]\.text: expected "HELLO", got "hello"[\s\S]*\(cases\/echo\.fail\.json\)/,
      )
      // `--update` is not reachable from Vitest: no hint about it.
      await expect(registered.tests[2].fn()).rejects.not.toThrow(/--update/)
    } finally {
      for (const fn of registered.after) await fn()
    }
  }, 30000)

  it('fails the manifest-lock test on drift, and runs checks when asked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrissa-bridge-'))
    const lock = path.join(dir, 'lock.json')
    const drifted = readManifest(path.join(path.dirname(fixtureConfig), 'tests/__manifest__.json'))
    drifted.tools = drifted.tools.filter((t) => t.name !== 'echo')
    fs.writeFileSync(lock, JSON.stringify(drifted))
    const { api, registered } = fakeApi()
    await describeCases(['cases/echo.basic.json'], {
      config: fixtureConfig,
      manifest: lock,
      checks: true,
      api,
    })
    expect(registered.tests.map((t) => t.name)).toEqual([
      expect.stringMatching(/^manifest lock \(.*lock\.json\)$/),
      'checks (echo)',
      'echo basic',
    ])
    for (const fn of registered.before) await fn()
    try {
      expect(() => registered.tests[0].fn()).toThrow(
        /Manifest drift: 1 tool added \(echo\)[\s\S]*Review the change, then accept it with "vib manifest record"/,
      )
      await registered.tests[1].fn() // the fixture passes every check
    } finally {
      for (const fn of registered.after) await fn()
    }
  }, 30000)

  it('requireManifest adds a failing lock test when the lock is missing', async () => {
    const { api, registered } = fakeApi()
    await describeCases(['cases/echo.basic.json'], {
      config: fixtureConfig,
      manifest: path.join(os.tmpdir(), 'vibrissa-no-such-lock.json'),
      requireManifest: true,
      api,
    })
    expect(() => registered.tests[0].fn()).toThrow(/No manifest lock at .*requireManifest is on/)
  })

  it('registers a failing placeholder test when no case matches', async () => {
    const { api, registered } = fakeApi()
    await describeCases({ config: fixtureConfig, globs: ['cases/none-*.json'], api })
    expect(registered.tests.map((t) => t.name)).toEqual(['has cases'])
    expect(() => registered.tests[0].fn()).toThrow(
      /No test cases matched globs: cases\/none-\*\.json/,
    )
  })
})
