import type { NormalizeConfig, RunOptions } from './types.js'

export const DEFAULT_SERVER_NAME = 'default'
export const DEFAULT_MANIFEST_PATH = 'tests/integration/__manifest__.json'
/** Mirrors DEFAULT_MANIFEST_IGNORE in src/manifest.ts (kept here so config has no runtime deps). */
export const DEFAULT_MANIFEST_IGNORE_PATHS: readonly string[] = ['server.version']
export const DEFAULT_OUT_DIR = 'reports'

export const DEFAULT_NORMALIZE: Required<NormalizeConfig> = {
  stripMeta: ['io.modelcontextprotocol/*'],
  dropKeys: ['resultType'],
  ttlMs: 'ignore',
}

/** Built-in defaults: the bottom layer of defaults → file → profile → CLI. */
export const defaultRunOptions: RunOptions = {
  servers: { [DEFAULT_SERVER_NAME]: { cmd: 'node', args: ['dist/index.js'], cwd: '.', env: {} } },
  defaultServer: DEFAULT_SERVER_NAME,
  globs: ['tests/integration/**/*.json'],
  manifest: DEFAULT_MANIFEST_PATH,
  manifestIgnore: [...DEFAULT_MANIFEST_IGNORE_PATHS],
  // outDir stays unset unless configured: the runner applies DEFAULT_OUT_DIR, and callers
  // (e.g. tests) treat a defined outDir as an explicit choice.
  checks: {},
  normalize: DEFAULT_NORMALIZE,
  timeoutMs: 15000,
  failFast: false,
  allowEmpty: false,
  reporters: ['console'],
  rootDir: '.',
}

/** @deprecated v1 name; use defaultRunOptions. */
export const defaultRunCasesOptions = defaultRunOptions
