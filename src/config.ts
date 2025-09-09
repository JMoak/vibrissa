import fs from 'node:fs'
import path from 'node:path'
import { defaultRunCasesOptions } from './defaults.js'
import type { RunCasesOptions } from './types.js'

export function stripJsonComments(input: string): string {
  let result = ''
  let inString = false
  let stringQuote: string | null = null
  let escaped = false
  let inBlockComment = false
  let inLineComment = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ''

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (!inString && char === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (!inString && char === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }

    if (inString) {
      result += char
      if (!escaped && char === stringQuote) {
        inString = false
        stringQuote = null
      }
      escaped = !escaped && char === '\\'
      if (escaped && stringQuote === '\\') escaped = false
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true
      stringQuote = char
      result += char
      escaped = false
      continue
    }

    result += char
  }

  return result
}

export function loadConfigObjectFromPath(configPath: string): Partial<RunCasesOptions> {
  const raw = fs.readFileSync(configPath, 'utf8')
  const json = JSON.parse(stripJsonComments(raw))
  return json as Partial<RunCasesOptions>
}

export function loadConfigFile(
  cwd: string,
  explicitPath?: string,
): Partial<RunCasesOptions> | undefined {
  if (explicitPath) {
    const abs = path.isAbsolute(explicitPath) ? explicitPath : path.join(cwd, explicitPath)
    if (!fs.existsSync(abs)) throw new Error(`Config not found: ${abs}`)
    return loadConfigObjectFromPath(abs)
  }

  const candidates = ['vibrissa.json', 'vibrissa.jsonc']
  for (const name of candidates) {
    const file = path.join(cwd, name)
    if (fs.existsSync(file)) {
      return loadConfigObjectFromPath(file)
    }
  }

  const pkgPath = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (pkg?.vibrissa && typeof pkg.vibrissa === 'object') {
      return pkg.vibrissa as Partial<RunCasesOptions>
    }
  }
  return undefined
}

export function resolveOptions(cwd: string, explicitPath?: string): RunCasesOptions {
  const fileConfig = loadConfigFile(cwd, explicitPath)
  const resolved: RunCasesOptions = {
    ...defaultRunCasesOptions,
    ...fileConfig,
    server: {
      ...defaultRunCasesOptions.server,
      ...(fileConfig?.server ?? {}),
    },
  }
  return resolved
}
