import path from 'node:path'
import type { JsonValue } from '../types.js'

export function takeFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

export function takeAllFlags(argv: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) {
      values.push(argv[i + 1])
      i++
    }
  }
  return values
}

export function splitCommandLine(input: string): { cmd: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  if (tokens.length === 0) throw new Error('Empty --server command')
  return { cmd: tokens[0], args: tokens.slice(1) }
}

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid --env value "${pair}" (expected KEY=VALUE)`)
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

export function parseArgValue(raw: string): JsonValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']')) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw) as JsonValue
    } catch {
      return raw
    }
  }
  return raw
}

export function parseToolArgs(argv: string[]): Record<string, JsonValue> {
  const json = takeFlag(argv, '--args')
  const pairs = takeAllFlags(argv, '--arg')
  let args: Record<string, JsonValue> = {}
  if (json !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new Error(`Invalid --args JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--args must be a JSON object')
    }
    args = { ...(parsed as Record<string, JsonValue>) }
  }
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid --arg value "${pair}" (expected key=value)`)
    args[pair.slice(0, eq)] = parseArgValue(pair.slice(eq + 1))
  }
  return args
}

export function resolvePathFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
