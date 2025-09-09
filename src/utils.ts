export function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function stripAnsi(input: string): string {
  let result = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\x1B' || ch === '\x9B') {
      let j = i + 1
      if (ch === '\x1B' && input[j] === '[') j++
      while (j < input.length) {
        const code = input.charCodeAt(j)
        if (code >= 0x40 && code <= 0x7e) {
          j++
          break
        }
        j++
      }
      i = j - 1
      continue
    }
    result += ch
  }
  return result
}

export function createUnifiedDiff(expected: string, actual: string, maxLines = 40): string {
  const exp = expected.split(/\r?\n/)
  const act = actual.split(/\r?\n/)
  const out: string[] = []
  out.push('--- expected')
  out.push('+++ actual')
  let i = 0
  let j = 0
  let lines = 0
  while (i < exp.length || j < act.length) {
    if (lines >= maxLines) {
      out.push('...')
      break
    }
    const e = i < exp.length ? exp[i] : undefined
    const a = j < act.length ? act[j] : undefined
    if (e === a) {
      out.push(`  ${e ?? ''}`)
      i++
      j++
    } else if (a !== undefined && (e === undefined || e !== a)) {
      if (e !== undefined) {
        out.push(`- ${e}`)
        lines++
        i++
      }
      if (a !== undefined) {
        out.push(`+ ${a}`)
        lines++
        j++
      }
    }
  }
  return out.join('\n')
}
