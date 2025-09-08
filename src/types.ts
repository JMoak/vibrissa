export interface ServerConfig {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface HooksConfig {
  before?: string
  after?: string
}

export interface RunCasesOptions {
  server: ServerConfig
  globs: string[]
  concurrency: number
  timeoutMs: number
  failFast: boolean
  reportPath?: string
  hooks?: HooksConfig
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface TestCase {
  name?: string
  tool?: string
  args?: Record<string, JsonValue>
  expect?: JsonValue
  expectError?: {
    code?: string
    message?: string | { $regex?: string; flags?: string }
  }
}
