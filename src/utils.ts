export function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function stripAnsi(input: string): string {
  const pattern =
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~])/g
  return input.replace(pattern, '')
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
