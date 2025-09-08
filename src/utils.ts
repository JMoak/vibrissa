import fs from 'node:fs'
import path from 'node:path'

export function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

export function matchGlob(filePath: string, glob: string): boolean {
  const normFile = filePath.split(path.sep).join('/')
  const normGlob = glob.split(path.sep).join('/')
  const parts = normGlob.split('**')
  if (parts.length === 1) {
    const pattern = parts[0].replace(/\./g, '\\.').replace(/\*/g, '[^/]*')
    return new RegExp(`^${pattern}$`).test(normFile)
  }
  let lastIndex = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '') continue
    const pattern = part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')
    const re = new RegExp(pattern)
    const match = re.exec(normFile.slice(lastIndex))
    if (!match) return false
    lastIndex += match.index + match[0].length
  }
  return true
}

export function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
