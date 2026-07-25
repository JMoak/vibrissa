import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleResultsDisplay, PrettyConsoleResultsDisplay } from '../src/display'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConsoleResultsDisplay', () => {
  it('logs failures to console.error and nothing else', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const display = new ConsoleResultsDisplay()
    display.onStart(2)
    display.onCasePass('good case')
    display.onCaseFail('bad case', 'boom')
    display.onComplete({ total: 2, passed: 1, failed: 1, durationMs: 5 })

    expect(err).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledWith('Case failed: bad case - boom')
    expect(log).not.toHaveBeenCalled()
  })
})

describe('PrettyConsoleResultsDisplay', () => {
  function renderComplete(
    setup: (d: PrettyConsoleResultsDisplay) => void,
    summary = { total: 2, passed: 1, failed: 1, durationMs: 1234 },
  ): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const display = new PrettyConsoleResultsDisplay()
    display.onStart(summary.total)
    setup(display)
    display.onComplete(summary)
    return log.mock.calls.map((call) => stripAnsi(String(call[0])))
  }

  it('renders per-case badges', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const display = new PrettyConsoleResultsDisplay()
    display.onCasePass('alpha')
    display.onCaseFail('beta', 'oops')
    const lines = log.mock.calls.map((call) => stripAnsi(String(call[0])))
    expect(lines[0]).toBe('[OK] alpha')
    expect(lines[1]).toBe('[!!] beta')
  })

  it('renders an aligned summary box', () => {
    const lines = renderComplete((d) => {
      d.onCasePass('alpha')
      d.onCaseFail('beta', 'oops')
    })

    const boxLines = lines.filter((l) => l.startsWith('|') || l.startsWith('+'))
    for (const line of boxLines) {
      expect(line.length).toBe(64)
    }
    expect(lines.some((l) => l.includes('Total: 2') && l.includes('Passed: 1'))).toBe(true)
    expect(lines.some((l) => l.includes('Failures (1):'))).toBe(true)
    expect(lines.some((l) => l.includes('- beta'))).toBe(true)
  })

  it('renders a unified diff when failure details carry expected/actual JSON', () => {
    const details = JSON.stringify({ expected: { text: 'HELLO' }, actual: { text: 'hello' } })
    const lines = renderComplete((d) => {
      d.onCaseFail('diff case', `Expectation failed :: ${details}`)
    })
    expect(lines.some((l) => l.includes('expected'))).toBe(true)
    expect(lines.some((l) => l.includes('actual'))).toBe(true)
  })

  it('truncates the failure list past ten entries', () => {
    const lines = renderComplete(
      (d) => {
        for (let i = 0; i < 12; i++) d.onCaseFail(`case-${i}`, 'nope')
      },
      { total: 12, passed: 0, failed: 12, durationMs: 10 },
    )
    expect(lines.some((l) => l.includes('...and 2 more'))).toBe(true)
  })

  it('formats sub-second and second durations', () => {
    const fast = renderComplete(() => {}, { total: 0, passed: 0, failed: 0, durationMs: 999 })
    expect(fast.some((l) => l.includes('999ms'))).toBe(true)
    const slow = renderComplete(() => {}, { total: 0, passed: 0, failed: 0, durationMs: 2500 })
    expect(slow.some((l) => l.includes('2.50s'))).toBe(true)
  })
})
