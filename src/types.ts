/**
 * Vibrissa v2 shared types: case files, config, and the session's summary shapes.
 * See docs/V2_ARCHITECTURE.md ("Shared interfaces") for the contract these implement.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// Case files
// ---------------------------------------------------------------------------

/** A single MCP operation. Exactly one of tool | resource | resourceTemplate | prompt. */
export interface Operation {
  /** `tools/call` by tool name. */
  tool?: string
  /** `resources/read` by URI. */
  resource?: string
  /** RFC 6570 URI template; expanded with `args`, then `resources/read`. */
  resourceTemplate?: string
  /** `prompts/get` by prompt name. */
  prompt?: string
  /** Tool arguments, template variables, or prompt arguments. */
  args?: Record<string, JsonValue>
}

export interface ExpectError {
  /** Error code name (`InvalidParams`, `RequestTimeout`, ...) or numeric JSON-RPC code. */
  code?: string | number
  message?: string | { $regex: string; flags?: string }
}

/** Tasks extension polling (SEP-2663): poll `tasks/get` until the task is terminal. */
export interface AwaitOptions {
  /** Poll interval override in ms. Default: the task's `pollIntervalMs`, else 500. */
  pollMs?: number
  /** Give up after this many ms. Default 30000. */
  timeoutMs?: number
}

export interface Step extends Operation {
  name?: string
  expect?: JsonValue
  expectError?: ExpectError
  /** Scripted answers for MRTR input_required rounds, keyed by request method. */
  respond?: Record<string, JsonValue>
  /** Matcher over the InputRequests map(s) the server sent (see Outcome.inputRequests). */
  expectInputRequired?: JsonValue
  /** Matcher over the CreateTaskResult the server returned (tasks extension). */
  expectTask?: JsonValue
  /** Tasks extension: poll until terminal (`true` = defaults). */
  await?: AwaitOptions | boolean
  /** name → dotted path into the normalized result. */
  capture?: Record<string, string>
  budgetMs?: number
  timeoutMs?: number
  /** Teardown steps: never fail the case. */
  ignoreErrors?: boolean
  /** Validate structuredContent against the tool's outputSchema. Default true when declared. */
  validateOutput?: boolean
  normalize?: NormalizeConfig | false
}

export interface TestCase extends Step {
  $schema?: string
  tags?: string[]
  /** Key into config.servers. */
  server?: string
  /** Flow; when present, top-level op fields are ignored. */
  steps?: Step[]
  setup?: Step[]
  teardown?: Step[]
  flaky?: boolean
  skip?: boolean | string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Protocol era negotiation.
 * - `auto` (default): probe `server/discover`, fall back to the 2025 `initialize` handshake.
 * - `legacy`: 2025 `initialize` handshake only.
 * - `modern`: require the 2026-07-28 era (sugar for `{ pin: "2026-07-28" }`).
 * - `{ pin }`: modern era at exactly this revision; no fallback.
 */
export type ProtocolMode = 'auto' | 'legacy' | 'modern' | { pin: string }

export interface ServerCommon {
  protocol?: ProtocolMode
  /** Max time for spawn + handshake (stdio) or connect (http). Default: clamp(timeoutMs, 2000, 10000). */
  spawnTimeoutMs?: number
}

export interface StdioServerConfig {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface HttpServerConfig {
  url: string
  headers?: Record<string, string>
}

export type ServerConfig = (StdioServerConfig | HttpServerConfig) & ServerCommon

export type ResolvedStdioServer = StdioServerConfig & ServerCommon
export type ResolvedHttpServer = HttpServerConfig & ServerCommon

export function isHttpServerConfig(server: ServerConfig): server is ResolvedHttpServer {
  return typeof (server as { url?: unknown }).url === 'string'
}

export function isStdioServerConfig(server: ServerConfig): server is ResolvedStdioServer {
  return typeof (server as { cmd?: unknown }).cmd === 'string'
}

export interface NormalizeConfig {
  /** Glob-ish keys under `_meta` to strip. Default `["io.modelcontextprotocol/*"]`. */
  stripMeta?: string[]
  /** Top-level result keys to drop. Default `["resultType"]`. */
  dropKeys?: string[]
  /** List results' `ttlMs`/`cacheScope`. Default `ignore`. */
  ttlMs?: 'keep' | 'ignore'
}

export interface ShardSpec {
  /** 1-based shard index. */
  index: number
  total: number
}

export interface SuiteHooks {
  setup?: Step[]
  teardown?: Step[]
}

export interface RunOptions {
  servers: Record<string, ServerConfig>
  defaultServer: string
  globs: string[]
  /** Path; default tests/integration/__manifest__.json. */
  manifest?: string
  normalize: NormalizeConfig
  timeoutMs: number
  budgetMs?: number
  failFast: boolean
  allowEmpty: boolean
  /** Reporter names; default ["console"]. */
  reporters: string[]
  tags?: string[]
  excludeTags?: string[]
  grep?: string
  repeat?: number
  shard?: ShardSpec
  concurrency?: number
  update?: boolean
  trace?: boolean
  check?: boolean
  baseline?: string
  /** Suite-level setup/teardown steps. */
  hooks?: SuiteHooks
  /** `vib check` / `--check` tuning: skipped check ids and per-check severity overrides. */
  checks?: { allow?: string[]; severity?: Record<string, 'failed' | 'warned'> }
  /** Dotted manifest paths ignored by the lock diff. Filled by loadConfig: ["server.version"]. */
  manifestIgnore?: string[]
  /** Reporter artifact directory (relative to rootDir). Unset unless configured; the runner defaults to "reports". */
  outDir?: string
  /** Directory the config was loaded from; relative paths resolve against it. */
  rootDir: string
}

// ---------------------------------------------------------------------------
// Session summaries (what McpSession returns)
// ---------------------------------------------------------------------------

export interface ToolSummary {
  name: string
  title?: string
  description?: string
  inputSchema: JsonValue
  outputSchema?: JsonValue
  annotations?: JsonValue
  icons?: JsonValue
  execution?: JsonValue
  _meta?: JsonValue
}

export interface ResourceSummary {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
  annotations?: JsonValue
  icons?: JsonValue
  _meta?: JsonValue
}

export interface ResourceTemplateSummary {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: JsonValue
  icons?: JsonValue
  _meta?: JsonValue
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
  icons?: JsonValue
  _meta?: JsonValue
}

/** A list verb's aggregated result plus the list-level cache hints (2026-07-28). */
export interface ListResult<T> {
  items: T[]
  /** `ttlMs` from the (first page of the) list result, when the server sent one. */
  ttlMs?: number
  /** `cacheScope` from the list result, when the server sent one. */
  cacheScope?: string
  /** List-level `_meta` (e.g. the stamped serverInfo), when present. */
  _meta?: JsonValue
}

export interface ServerIdentity {
  name?: string
  version?: string
  title?: string
  [key: string]: JsonValue | undefined
}

export interface DiscoverInfo {
  era: 'legacy' | 'modern'
  /** Negotiated revision, e.g. "2026-07-28" or "2025-11-25". */
  protocolVersion: string
  /** Revisions the server advertises (modern) or `[protocolVersion]` (legacy). */
  supportedVersions: string[]
  /** Modern: `_meta["io.modelcontextprotocol/serverInfo"]`; legacy: `initialize.serverInfo`. */
  serverInfo?: ServerIdentity
  capabilities: JsonValue
  /** Keys of `capabilities.extensions` (e.g. "io.modelcontextprotocol/tasks"). */
  extensions: string[]
  instructions?: string
  /** True when built from the legacy `initialize` result instead of `server/discover`. */
  synthesized: boolean
  /** The raw wire result (`server/discover` or `initialize`). */
  raw: JsonValue
}

/** One JSON-RPC message (or stderr chunk) observed by the session. */
export interface TranscriptEntry {
  /** `out` = client → server, `in` = server → client, `stderr` = server stderr text. */
  dir: 'in' | 'out' | 'stderr'
  /** Epoch milliseconds. */
  ts: number
  message?: JsonValue
  text?: string
}
