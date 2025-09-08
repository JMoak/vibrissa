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

export const defaultRunCasesOptions: RunCasesOptions = {
  server: { cmd: 'node', args: ['dist/index.js'], cwd: '.', env: {} },
  globs: ['tests/integration/**/*.json'],
  concurrency: 4,
  timeoutMs: 15000,
  failFast: false,
}

export async function runCases(
  _options: RunCasesOptions = defaultRunCasesOptions,
): Promise<number> {
  return 0
}
