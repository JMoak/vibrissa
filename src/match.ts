import type { JsonValue } from './types.js'

export interface Mismatch {
  path: string
  message: string
  expected?: unknown
  actual?: unknown
}

interface MatchContext {
  partial: boolean
  mismatches: Mismatch[]
}

const MAX_MISMATCHES = 25

export function matchValue(expected: JsonValue, actual: unknown): Mismatch[] {
  const ctx: MatchContext = { partial: false, mismatches: [] }
  matchNode(expected, actual, '', ctx)
  return ctx.mismatches
}

export function matches(expected: JsonValue, actual: unknown): boolean {
  return matchValue(expected, actual).length === 0
}

function report(ctx: MatchContext, mismatch: Mismatch): void {
  if (ctx.mismatches.length < MAX_MISMATCHES) ctx.mismatches.push(mismatch)
}

function displayPath(path: string): string {
  return path === '' ? '(root)' : path
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchNode(expected: JsonValue, actual: unknown, path: string, ctx: MatchContext): void {
  if (isPlainObject(expected)) {
    if ('$regex' in expected) {
      matchRegexDirective(expected, actual, path, ctx)
      return
    }
    if ('$wildcard' in expected) {
      matchWildcardDirective(expected, actual, path, ctx)
      return
    }
    if (expected.$unordered === true && Array.isArray(expected.value)) {
      matchUnordered(expected.value, actual, path, ctx)
      return
    }
    matchObject(expected, actual, path, ctx)
    return
  }
  if (Array.isArray(expected)) {
    matchArray(expected, actual, path, ctx)
    return
  }
  if (!Object.is(expected, actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      expected,
      actual,
    })
  }
}

function matchRegexDirective(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const pattern = directive.$regex
  const flags = directive.flags
  if (typeof pattern !== 'string' || (flags !== undefined && typeof flags !== 'string')) {
    report(ctx, {
      path: displayPath(path),
      message: `invalid $regex directive: ${JSON.stringify(directive)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (typeof actual !== 'string') {
    report(ctx, {
      path: displayPath(path),
      message: `expected a string matching /${pattern}/${flags ?? ''}, got ${describeType(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch (err) {
    report(ctx, {
      path: displayPath(path),
      message: `invalid $regex pattern /${pattern}/${flags ?? ''}: ${err instanceof Error ? err.message : String(err)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (!regex.test(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected string matching /${pattern}/${flags ?? ''}, got ${JSON.stringify(actual)}`,
      expected: directive,
      actual,
    })
  }
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')
  return new RegExp(`^${body}$`)
}

function matchWildcardDirective(
  directive: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  const pattern = directive.$wildcard
  if (typeof pattern !== 'string') {
    report(ctx, {
      path: displayPath(path),
      message: `invalid $wildcard directive: ${JSON.stringify(directive)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (typeof actual !== 'string') {
    report(ctx, {
      path: displayPath(path),
      message: `expected a string matching wildcard "${pattern}", got ${describeType(actual)}`,
      expected: directive,
      actual,
    })
    return
  }
  if (!wildcardToRegex(pattern).test(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected string matching wildcard "${pattern}", got ${JSON.stringify(actual)}`,
      expected: directive,
      actual,
    })
  }
}

function matchObject(
  expected: Record<string, JsonValue>,
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (!isPlainObject(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an object, got ${describeType(actual)}`,
      expected,
      actual,
    })
    return
  }
  const partial = ctx.partial || expected.$partial === true
  const expectedKeys = Object.keys(expected).filter((key) => key !== '$partial')
  if (!partial) {
    const actualKeys = Object.keys(actual)
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key))
    if (extra.length > 0) {
      report(ctx, {
        path: displayPath(path),
        message: `unexpected key${extra.length > 1 ? 's' : ''} ${extra.map((k) => JSON.stringify(k)).join(', ')} (use "$partial": true to allow extra fields)`,
        expected,
        actual,
      })
    }
  }
  for (const key of expectedKeys) {
    const childPath = path === '' ? key : `${path}.${key}`
    if (!(key in actual)) {
      report(ctx, {
        path: displayPath(childPath),
        message: `missing expected key (expected ${JSON.stringify(expected[key])})`,
        expected: expected[key],
        actual: undefined,
      })
      continue
    }
    const childCtx: MatchContext = { partial, mismatches: ctx.mismatches }
    matchNode(expected[key], actual[key], childPath, childCtx)
  }
}

function matchArray(expected: JsonValue[], actual: unknown, path: string, ctx: MatchContext): void {
  if (!Array.isArray(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an array, got ${describeType(actual)}`,
      expected,
      actual,
    })
    return
  }
  const lengthOk = ctx.partial
    ? actual.length >= expected.length
    : actual.length === expected.length
  if (!lengthOk) {
    report(ctx, {
      path: displayPath(path),
      message: `expected array of length ${ctx.partial ? `>= ${expected.length}` : expected.length}, got ${actual.length}`,
      expected,
      actual,
    })
    return
  }
  for (let i = 0; i < expected.length; i++) {
    matchNode(expected[i], actual[i], `${path}[${i}]`, ctx)
  }
}

function matchesQuietly(expected: JsonValue, actual: unknown, partial: boolean): boolean {
  const scratch: MatchContext = { partial, mismatches: [] }
  matchNode(expected, actual, '', scratch)
  return scratch.mismatches.length === 0
}

function matchUnordered(
  expected: JsonValue[],
  actual: unknown,
  path: string,
  ctx: MatchContext,
): void {
  if (!Array.isArray(actual)) {
    report(ctx, {
      path: displayPath(path),
      message: `expected an array (unordered), got ${describeType(actual)}`,
      expected,
      actual,
    })
    return
  }
  if (ctx.partial ? actual.length < expected.length : actual.length !== expected.length) {
    report(ctx, {
      path: displayPath(path),
      message: `expected unordered array of length ${ctx.partial ? `>= ${expected.length}` : expected.length}, got ${actual.length}`,
      expected,
      actual,
    })
    return
  }
  const used = new Array<boolean>(actual.length).fill(false)
  const assign = (index: number): boolean => {
    if (index === expected.length) return true
    for (let j = 0; j < actual.length; j++) {
      if (used[j]) continue
      if (matchesQuietly(expected[index], actual[j], ctx.partial)) {
        used[j] = true
        if (assign(index + 1)) return true
        used[j] = false
      }
    }
    return false
  }
  if (!assign(0)) {
    report(ctx, {
      path: displayPath(path),
      message: `no arrangement of the actual array satisfies the expected elements (unordered${ctx.partial ? ', partial' : ''})`,
      expected,
      actual,
    })
  }
}
