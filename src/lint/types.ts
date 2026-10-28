/**
 * Minimal input shapes for the lint module. They mirror the field names in
 * docs/V2_ARCHITECTURE.md (ToolSummary, Manifest, ...) and are deliberately
 * permissive (mostly optional) so that the foundation's richer types — and raw
 * JSON read from a manifest file — are assignable to them. Every check treats
 * these values as untrusted server output and re-validates them at runtime.
 */
import type { JsonValue } from '../types.js'

export interface ToolAnnotationsLike {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolSummary {
  name: string
  title?: string
  description?: string
  inputSchema?: JsonValue
  outputSchema?: JsonValue
  annotations?: ToolAnnotationsLike | JsonValue
}

export interface ResourceSummary {
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

export interface ResourceTemplateSummary {
  uriTemplate: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

export interface PromptArgumentSummary {
  name: string
  title?: string
  description?: string
  required?: boolean
}

export interface PromptSummary {
  name: string
  title?: string
  description?: string
  arguments?: PromptArgumentSummary[]
}

/** Cache metadata carried by a 2026-07-28 list result. Raw wire values; validated by spec checks. */
export interface ListMetaEntry {
  ttlMs?: JsonValue
  cacheScope?: JsonValue
}

export interface ListMeta {
  tools?: ListMetaEntry
  resources?: ListMetaEntry
  resourceTemplates?: ListMetaEntry
  prompts?: ListMetaEntry
}

/**
 * Anything shaped like a recorded Manifest (src/manifest.ts). `listMeta` holds the
 * `ttlMs` / `cacheScope` of each list result; leave a list's entry undefined when
 * that list was not fetched. `instructions` is the optional server instructions
 * string from discover/initialize (model-visible, so it is linted too).
 */
export interface ManifestLike {
  protocolVersion?: string
  server?: { name?: string; version?: string }
  capabilities?: JsonValue
  instructions?: string
  tools: ToolSummary[]
  resources?: ResourceSummary[]
  resourceTemplates?: ResourceTemplateSummary[]
  prompts?: PromptSummary[]
  listMeta?: ListMeta
  /** How the session reached the server. Decides whether stdout hygiene applies. */
  transport?: 'stdio' | 'http'
  /** Non-JSON-RPC lines a stdio server wrote to stdout (from `session.stdoutNoise`). */
  stdoutNoise?: StdoutNoise
}

export interface StdoutNoise {
  lines: number
  sample: string[]
}
