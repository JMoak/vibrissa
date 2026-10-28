/**
 * `vib check` engine: spec-sanity checks + description lint over a manifest.
 * Pure: give it data recorded from a session, get CheckOutcome[] back.
 */
import type { CheckOutcome } from '../events.js'
import { DESCRIPTION_RULES, type DescriptionLintOptions, lintDescriptions } from './descriptions.js'
import { type Severity, sortOutcomes } from './outcomes.js'
import { SPEC_CHECKS, type SchemaValidator, checkSpec } from './spec.js'
import type { ManifestLike, ToolSummary } from './types.js'

export * from './types.js'
export {
  DESCRIPTION_RULES,
  HIDDEN_INSTRUCTION_PATTERNS,
  IMPERATIVE_PATTERNS,
  SENSITIVE_PATH_PATTERNS,
  collectTextSources,
  lintDescriptions,
  mentionPattern,
  type DescriptionLintOptions,
  type DescriptionRule,
  type Pattern,
  type TextSource,
} from './descriptions.js'
export {
  KNOWN_PROTOCOL_VERSIONS,
  KNOWN_SERVER_CAPABILITIES,
  MODERN_PROTOCOL_VERSION,
  SPEC_CHECKS,
  checkSpec,
  eraOf,
  errorCodeExpectations,
  expectedErrorCode,
  type Era,
  type ErrorCodeExpectation,
  type ErrorSituation,
  type ExpectedCode,
  type SchemaValidator,
  type SpecInput,
  type SpecOptions,
} from './spec.js'
export { findUnresolvedRefs, type RefProblem } from './refs.js'
export {
  isAllowed,
  sortOutcomes,
  summarizeChecks,
  type LintOptions,
  type Severity,
} from './outcomes.js'

export interface RunChecksOptions {
  /** Two or more consecutive tools/list results, for `spec/tools-list-stable`. */
  toolsListSamples?: ToolSummary[][]
  /** Check ids to skip (`id`, `prefix/*`, or `id:subject`). Config: `checks.allow`. */
  allow?: string[]
  /** Severity overrides by check id. Config: `checks.severity`. */
  severity?: Record<string, Severity>
  /** Tool names from other configured servers, for cross-server shadowing detection. */
  knownToolNames?: string[]
  maxDescriptionLength?: DescriptionLintOptions['maxDescriptionLength']
  /** Override the JSON Schema validator (defaults to src/schema.ts `isValidSchema`). */
  validateSchema?: SchemaValidator
}

/** Every check id with its title and default severity, in table order. */
export function listChecks(): Array<{ id: string; title: string; severity: Severity }> {
  return [...SPEC_CHECKS, ...DESCRIPTION_RULES].map(({ id, title, severity }) => ({
    id,
    title,
    severity,
  }))
}

/**
 * Run spec-sanity checks and description lint over a manifest.
 * Returns outcomes sorted failed -> warned -> passed (then by id).
 */
export function runChecks(manifest: ManifestLike, opts: RunChecksOptions = {}): CheckOutcome[] {
  const common = { allow: opts.allow, severity: opts.severity }
  const spec = checkSpec(
    { ...manifest, toolsListSamples: opts.toolsListSamples },
    { ...common, validateSchema: opts.validateSchema },
  )
  const desc = lintDescriptions(manifest.tools, {
    ...common,
    resources: manifest.resources,
    resourceTemplates: manifest.resourceTemplates,
    prompts: manifest.prompts,
    instructions: manifest.instructions,
    knownToolNames: opts.knownToolNames,
    maxDescriptionLength: opts.maxDescriptionLength,
  })
  return sortOutcomes([...spec, ...desc])
}
