import type { RunCasesOptions } from './types.js'

export const defaultRunCasesOptions: RunCasesOptions = {
  server: { cmd: 'node', args: ['dist/index.js'], cwd: '.', env: {} },
  globs: ['tests/integration/**/*.json'],
  timeoutMs: 15000,
  failFast: false,
  display: 'pretty',
  allowEmpty: false,
}
