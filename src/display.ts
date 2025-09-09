import { createUnifiedDiff, stripAnsi } from './utils.js'
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
const DIM = '\x1b[2m'
const FG_RED = '\x1b[31m'
const FG_GREEN = '\x1b[32m'
const FG_CYAN = '\x1b[36m'
const FG_GRAY = '\x1b[90m'
const BG_RED = '\x1b[41m'
const BG_GREEN = '\x1b[42m'

function color(text: string, code: string): string {
  return `${code}${text}${RESET}`
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
  }

  onCaseFail(name: string, error?: string): void {
    this.failed.push({ name, error })
    this.cases.push({ name, status: 'fail', error })
    console.error(`Case failed: ${name}${error ? ` - ${error}` : ''}`)
  }

  onComplete(summary: { total: number; passed: number; failed: number; durationMs: number }): void {
    const width = 64
    const top = `+${'='.repeat(width - 2)}+`
    const mid = `+${'-'.repeat(width - 2)}+`
    const titleRaw = padCenter('vib-test results', width - 2)
    const title = `|${color(BOLD + color(titleRaw, FG_CYAN), '')}|`

    const totalsLine = `| Total: ${color(String(summary.total), FG_CYAN)}  | Passed: ${color(String(summary.passed), FG_GREEN)}  | Failed: ${color(String(summary.failed), FG_RED)}  | Duration: ${color(formatDuration(summary.durationMs), FG_GRAY)}${' '.repeat(Math.max(0, width - 2 - ('| Total:  | Passed:   | Failed:   | Duration: '.length + String(summary.total).length + String(summary.passed).length + String(summary.failed).length + formatDuration(summary.durationMs).length)))}|`

    console.log(top)
    console.log(title)
    console.log(mid)
    // Per-case status list
    const casesHeader = `| Cases:${' '.repeat(width - 9)}|`
    console.log(color(casesHeader, FG_GRAY))
    if (this.cases.length === 0) {
      const none = `|  (no cases found)${' '.repeat(width - 20)}|`
      console.log(color(none, FG_GRAY))
    } else {
      for (const c of this.cases) {
        const icon = c.status === 'pass' ? '✔' : '✖'
        const iconColored = c.status === 'pass' ? color(icon, FG_GREEN) : color(icon, FG_RED)
        const name = c.name
        const errPlain = c.status === 'fail' && c.error ? ` [${c.error}]` : ''
        const maxContent = width - 2
        const contentPlain = ` ${icon} ${name}${errPlain}`
        const trimmedPlain =
          contentPlain.length > maxContent
            ? `${contentPlain.slice(0, maxContent - 3)}...`
            : contentPlain
        let contentColored = trimmedPlain.replace(` ${icon} `, ` ${iconColored} `)
        if (errPlain && trimmedPlain.includes(errPlain)) {
          contentColored = contentColored.replace(errPlain, color(errPlain, FG_GRAY))
        }
        const pad = Math.max(0, maxContent - stripAnsi(contentColored).length)
        const line = `|${contentColored}${' '.repeat(pad)}|`
        console.log(line)
      }
    }

    console.log(mid)
    console.log(totalsLine)

    if (this.failed.length > 0) {
      console.log(mid)
      const header = `| Failures (${this.failed.length}):${' '.repeat(width - 14 - String(this.failed.length).length)}|`
      console.log(color(header, FG_RED))
      const maxList = 10
      for (let i = 0; i < Math.min(this.failed.length, maxList); i++) {
        const f = this.failed[i]
        const lineRaw = ` - ${f.name}${f.error ? ` [${f.error}]` : ''}`
        const maxContent = width - 3
        const trimmed =
          lineRaw.length > maxContent ? `${lineRaw.slice(0, maxContent - 3)}...` : lineRaw
        const line = `| ${trimmed}${' '.repeat(Math.max(0, width - 3 - trimmed.length))}|`
        console.log(color(line, FG_RED))

        if (f.error?.includes('::')) {
          const idx = f.error.indexOf('::')
          try {
            const json = f.error.slice(idx + 2).trim()
            const parsed = JSON.parse(json) as { expected?: unknown; actual?: unknown }
            const expectedStr = JSON.stringify(parsed.expected, null, 2)
            const actualStr = JSON.stringify(parsed.actual, null, 2)
            const diffLines = createUnifiedDiff(expectedStr, actualStr, 20).split(/\r?\n/)
            for (const d of diffLines) {
              const colored = d.startsWith('- ')
                ? `${BG_RED}${d}${RESET}`
                : d.startsWith('+ ')
                  ? `${BG_GREEN}${d}${RESET}`
                  : color(d, FG_GRAY)
              const padInner = Math.max(0, width - 2 - stripAnsi(colored).length)
              console.log(`|${colored}${' '.repeat(padInner)}|`)
            }
          } catch {}
        }
      }
      if (this.failed.length > maxList) {
        const more = `| ...and ${this.failed.length - maxList} more${' '.repeat(Math.max(0, width - 14 - String(this.failed.length - maxList).length))}|`
        console.log(color(more, FG_RED))
      }
    }

    console.log(top)
  }
}
