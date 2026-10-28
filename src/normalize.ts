/**
 * Result-envelope normalization, applied by the runner before matching and before
 * recording so goldens stay free of per-protocol-version noise. Pure and idempotent:
 * the input is never mutated and `normalizeResult(normalizeResult(x)) === normalizeResult(x)`
 * structurally.
 */
import type { JsonValue } from './types.js'

export interface NormalizeConfig {
  /** Glob patterns (`*` = any run of characters) for keys removed from every `_meta` object. */
  stripMeta?: string[]
  /** Top-level result keys to remove. */
  dropKeys?: string[]
  /** `'ignore'` removes top-level `ttlMs` and `cacheScope` (list-result cache hints). */
  ttlMs?: 'keep' | 'ignore'
}

export const defaultNormalizeConfig: Required<NormalizeConfig> = Object.freeze({
  stripMeta: Object.freeze(['io.modelcontextprotocol/*']) as string[],
  dropKeys: Object.freeze(['resultType']) as string[],
  ttlMs: 'ignore' as const,
})

const TTL_KEYS = ['ttlMs', 'cacheScope']

type JsonObject = { [key: string]: JsonValue }

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function globToRegex(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${body}$`)
}

/** True when `key` matches the simple glob `pattern` (`*` matches any run of characters). */
export function matchesGlob(pattern: string, key: string): boolean {
  return globToRegex(pattern).test(key)
}

/**
 * Normalize an MCP result for matching/recording. Missing config fields fall back to
 * `defaultNormalizeConfig`; pass empty arrays / `ttlMs: 'keep'` to disable a rule.
 */
export function normalizeResult(
  result: JsonValue,
  cfg: NormalizeConfig = defaultNormalizeConfig,
): JsonValue {
  const stripMeta = (cfg.stripMeta ?? defaultNormalizeConfig.stripMeta).map(globToRegex)
  const dropKeys = new Set(cfg.dropKeys ?? defaultNormalizeConfig.dropKeys)
  if ((cfg.ttlMs ?? defaultNormalizeConfig.ttlMs) === 'ignore') {
    for (const key of TTL_KEYS) dropKeys.add(key)
  }

  const stripped = stripMeta.length > 0 ? stripMetaKeys(result, stripMeta) : result
  if (!isPlainObject(stripped) || dropKeys.size === 0) return stripped
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(stripped)) {
    if (!dropKeys.has(key)) out[key] = value
  }
  return out
}

function stripMetaKeys(value: JsonValue, patterns: RegExp[]): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripMetaKeys(item, patterns))
  if (!isPlainObject(value)) return value
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '_meta' && isPlainObject(child)) {
      const meta: JsonObject = {}
      let removed = false
      for (const [metaKey, metaValue] of Object.entries(child)) {
        if (patterns.some((re) => re.test(metaKey))) removed = true
        else meta[metaKey] = stripMetaKeys(metaValue, patterns)
      }
      // A `_meta` emptied by stripping disappears; one that was already empty stays.
      if (removed && Object.keys(meta).length === 0) continue
      out[key] = meta
      continue
    }
    out[key] = stripMetaKeys(child, patterns)
  }
  return out
}
