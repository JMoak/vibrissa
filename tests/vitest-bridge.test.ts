import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
    expect(registered.tests.map((t) => t.name)).toEqual(['echo basic', 'echo mismatch'])
    expect(registered.skipped).toEqual(['skipped: documents a known gap'])

    for (const fn of registered.before) await fn()
    try {
      await registered.tests[0].fn()
      await expect(registered.tests[1].fn()).rejects.toThrow(
        /Expectation failed at content\[0\]\.text: expected "HELLO", got "hello"[\s\S]*- content\[0\]\.text: expected "HELLO", got "hello"[\s\S]*\(cases\/echo\.fail\.json\)/,
      )
    } finally {
      for (const fn of registered.after) await fn()
    }
  }, 30000)

  it('registers a failing placeholder test when no case matches', async () => {
    const { api, registered } = fakeApi()
    await describeCases({ config: fixtureConfig, globs: ['cases/none-*.json'], api })
    expect(registered.tests.map((t) => t.name)).toEqual(['has cases'])
    expect(() => registered.tests[0].fn()).toThrow(
      /No test cases matched globs: cases\/none-\*\.json/,
    )
  })
})
