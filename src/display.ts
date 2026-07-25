import { diffStringsUnified } from 'jest-diff'
export interface ResultsDisplay {
  onStart(total: number): void
  onCasePass(name: string): void
  onCaseFail(name: string, error?: string): void
  onComplete(summary: { total: number; passed: number; failed: number; durationMs: number }): void
}

export class ConsoleResultsDisplay implements ResultsDisplay {
  onStart(_total: number): void {}
  onCasePass(_name: string): void {}
  onCaseFail(name: string, error?: string): void {
    // Keep the exact message to satisfy existing tests that spy on console.error
    // Case failed: <name> - <error>
    console.error(`Case failed: ${name}${error ? ` - ${error}` : ''}`)
  }
  onComplete(_summary: {
    total: number
    passed: number
    failed: number
    durationMs: number
  }): void {}
}

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const FG_RED = '\x1b[31m'
const FG_GREEN = '\x1b[32m'
const FG_CYAN = '\x1b[36m'
const FG_GRAY = '\x1b[90m'

function color(text: string, code: string): string {
  return `${code}${text}${RESET}`
}

function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

function boxLine(content: string, width: number): string {
  const pad = Math.max(0, width - 2 - visibleLength(content))
  return `|${content}${' '.repeat(pad)}|`
}

function padCenter(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  const totalPad = width - text.length
  const left = Math.floor(totalPad / 2)
  const right = totalPad - left
  return `${' '.repeat(left)}${text}${' '.repeat(right)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export class PrettyConsoleResultsDisplay implements ResultsDisplay {
  private total = 0
  private startedAt = 0
  private passed: string[] = []
  private failed: { name: string; error?: string }[] = []
  private cases: { name: string; status: 'pass' | 'fail'; error?: string }[] = []

  onStart(total: number): void {
    this.total = total
    this.startedAt = Date.now()
  }

  onCasePass(name: string): void {
    this.passed.push(name)
    this.cases.push({ name, status: 'pass' })
    const badge = color('[OK]', FG_GREEN)
    const nameColored = color(name, FG_CYAN)
    console.log(`${badge} ${nameColored}`)
  }

  onCaseFail(name: string, error?: string): void {
    this.failed.push({ name, error })
    this.cases.push({ name, status: 'fail', error })
    const badge = color('[!!]', FG_RED)
    const nameColored = color(name, FG_CYAN)
    console.log(`${badge} ${nameColored}`)
  }

  onComplete(summary: { total: number; passed: number; failed: number; durationMs: number }): void {
    const width = 64
    const top = `+${'='.repeat(width - 2)}+`
    const mid = `+${'-'.repeat(width - 2)}+`
    const title = boxLine(color(padCenter('vib-test results', width - 2), BOLD + FG_CYAN), width)

    const totals = [
      ` Total: ${color(String(summary.total), FG_CYAN)} `,
      ` Passed: ${color(String(summary.passed), FG_GREEN)} `,
      ` Failed: ${color(String(summary.failed), FG_RED)} `,
      ` Duration: ${color(formatDuration(summary.durationMs), FG_GRAY)}`,
    ].join(' |')

    console.log(top)
    console.log(title)
    console.log(mid)
    console.log(boxLine(totals, width))

    if (this.failed.length > 0) {
      console.log(mid)
      console.log(color(boxLine(` Failures (${this.failed.length}):`, width), FG_RED))
      const maxList = 10
      for (let i = 0; i < Math.min(this.failed.length, maxList); i++) {
        const f = this.failed[i]
        const lineRaw = ` - ${f.name}`
        const maxContent = width - 3
        const trimmed =
          lineRaw.length > maxContent ? `${lineRaw.slice(0, maxContent - 3)}...` : lineRaw
        console.log(color(boxLine(` ${trimmed}`, width), FG_RED))

        if (f.error?.includes('::')) {
          const idx = f.error.indexOf('::')
          try {
            const json = f.error.slice(idx + 2).trim()
            const parsed = JSON.parse(json) as { expected?: unknown; actual?: unknown }
            const expectedStr = JSON.stringify(parsed.expected, null, 2)
            const actualStr = JSON.stringify(parsed.actual, null, 2)
            const unified = diffStringsUnified(expectedStr, actualStr, {
              aAnnotation: 'expected',
              bAnnotation: 'actual',
              expand: false,
              contextLines: 3,
            })
            const diffLines = (unified ?? '').split(/\r?\n/)
            for (const d of diffLines) console.log(`|${d}`)
          } catch {}
        }
      }
      if (this.failed.length > maxList) {
        console.log(color(boxLine(` ...and ${this.failed.length - maxList} more`, width), FG_RED))
      }
    }

    console.log(top)
  }
}
