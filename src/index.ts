/**
 * Public library API of @jmoak/vibrissa.
 *
 * - Run suites: `runCases(options)` (exit code) or `new Runner(options).execute()` (full result).
 * - Building blocks: `loadCases`, `executeCase`, `McpSession`, `buildManifest` / `diffManifest`,
 *   the matcher engine, normalization, JSON Schema validation, reporters, checks and fuzzing.
 */

// Runner
export {
  Runner,
  runCases,
  resolveRunnerOptions,
  executeCase,
  applyUpdates,
  inputRequestView,
  traceName,
  DEFAULT_FLAKY_FLOOR,
  DEFAULT_BASELINE_LATENCY_PCT,
  DEFAULT_BASELINE_LATENCY_MIN_MS,
  type RunnerOptions,
  type RunResult,
  type RunCasesInput,
  type ManifestResult,
  type ExecuteContext,
  type CaseExecution,
  type ExpectationUpdate,
} from './runner.js'

// Cases
export {
  loadCases,
  loadCasesSync,
  loadCaseFile,
  filterCases,
  shardCases,
  resolveCaseFiles,
  caseIdFor,
  parseCaseText,
  validateCaseShape,
  planSteps,
  interpolate,
  interpolateStep,
  placeholdersIn,
  InterpolationError,
  getPath,
  parsePath,
  CASE_KEYS,
  STEP_KEYS,
  OP_KINDS,
  type LoadedCase,
  type LoadCasesOptions,
  type LoadCasesResult,
  type CaseFilters,
  type InterpolationScope,
  type OpKind,
  type PlannedStep,
} from './cases.js'

// Manifest
export {
  buildManifest,
  captureManifest,
  manifestFrom,
  diffManifest,
  summarizeDiff,
  formatDiff,
  readManifest,
  writeManifest,
  manifestPathFor,
  jsonEqual,
  ManifestFileError,
  DEFAULT_MANIFEST_IGNORE,
  MANIFEST_VERSION,
  MANIFEST_SECTIONS,
  type Manifest,
  type ManifestDiff,
  type ManifestSection,
  type SectionDiff,
  type ItemChange,
  type FieldChange,
  type CapturedManifest,
  type CaptureManifestOptions,
  type DiffManifestOptions,
} from './manifest.js'

// Session
export {
  McpSession,
  SessionStartError,
  SessionRequestError,
  expandUriTemplate,
  errorMatchesCode,
  errorCodeName,
  canonicalCodeName,
  knownCodeNames,
  MODERN_PROTOCOL_VERSION,
  TASKS_EXTENSION,
  type Outcome,
  type ToolError,
  type CallOptions,
  type SessionOptions,
  type InputResponder,
  type SessionStartErrorCode,
} from './session/index.js'

// Matching, normalization, schema
export {
  matchValue,
  matches,
  resolveRefs,
  lintExpectation,
  escapeDirectives,
  RefResolutionError,
  MAX_MISMATCHES,
  type MatchOptions,
  type RefLoader,
} from './match.js'
export { normalizeResult, defaultNormalizeConfig, matchesGlob } from './normalize.js'
export {
  validate,
  compileSchema,
  isValidSchema,
  SchemaCompileError,
  type ValidationResult,
  type SchemaIssue,
  type Validator,
  type CompileOptions,
  type SchemaRefResolver,
} from './schema.js'

// Reporters & events
export {
  createReporters,
  registerReporter,
  unregisterReporter,
  resetReporters,
  hasReporter,
  listReporters,
  fanout,
  UnknownReporterError,
  BUILTIN_REPORTERS,
  ConsoleReporter,
  JsonReporter,
  JunitReporter,
  GithubReporter,
  TapReporter,
  RESULTS_FILE,
  type ReporterFactory,
  type JsonReport,
  type JsonCase,
} from './reporters/index.js'
export type {
  RunEvent,
  Reporter,
  ReporterContext,
  CaseRef,
  StepRef,
  CaseOutcome,
  CaseStatus,
  CheckOutcome,
  RunSummary,
  Mismatch,
} from './events.js'

// Checks & fuzzing
export {
  runChecks,
  listChecks,
  checkSpec,
  lintDescriptions,
  summarizeChecks,
  type RunChecksOptions,
  type ManifestLike,
} from './lint/index.js'
export {
  generateArgs,
  evaluate,
  createDefaultInvariants,
  defaultInvariants,
  type GenerateOptions,
  type GeneratedCase,
  type Invariant,
  type FuzzOutcome,
} from './fuzz/index.js'

// Config
export {
  loadConfig,
  resolveOptions,
  ConfigError,
  parseShard,
  parseProtocolMode,
  type ConfigFile,
  type ConfigOverrides,
  type ResolvedConfig,
} from './config.js'
export { defaultRunOptions, defaultRunCasesOptions, DEFAULT_NORMALIZE } from './defaults.js'

// Types
export type {
  JsonValue,
  JsonObject,
  TestCase,
  Step,
  Operation,
  ExpectError,
  AwaitOptions,
  RunOptions,
  ServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  ProtocolMode,
  NormalizeConfig,
  ShardSpec,
  SuiteHooks,
  ToolSummary,
  ResourceSummary,
  ResourceTemplateSummary,
  PromptSummary,
  DiscoverInfo,
  ListResult,
  TranscriptEntry,
} from './types.js'
export { isHttpServerConfig, isStdioServerConfig } from './types.js'

/** @deprecated v1 name for RunOptions. */
export type { RunOptions as RunCasesOptions } from './types.js'
