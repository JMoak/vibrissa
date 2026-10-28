/** Public surface of the fuzz module (wired to `vib fuzz` in phase 2). */
export {
  ALL_STRATEGIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_STRATEGIES,
  LARGE_ARRAY_LENGTH,
  LONG_STRING_LENGTH,
  canonicalJson,
  findCase,
  formatPath,
  generateArgs,
  schemaWarnings,
  validateAgainstSchema,
} from './generate.js'
export type {
  Expectation,
  GenerateOptions,
  GeneratedCase,
  PathSeg,
  SchemaCheckResult,
  Strategy,
} from './generate.js'
export {
  createDefaultInvariants,
  defaultInvariants,
  errorText,
  evaluate,
  hasFailures,
  invalidArgsYieldInvalidParams,
  isInvalidParams,
  isTimeout,
  isToolError,
  latencyUnderBudget,
  neverCrash,
  noEchoOfInjectionPayload,
  outputMatchesOutputSchema,
  payloadsInCase,
  validArgsNoProtocolError,
  validArgsNoTimeout,
} from './invariants.js'
export type {
  EvaluatedVerdict,
  FuzzOutcome,
  Invariant,
  InvariantLevel,
  InvariantOptions,
  InvalidParamsOptions,
  Verdict,
} from './invariants.js'
export { INJECTION_PAYLOADS, findEchoedPayloads, payloadById } from './payloads.js'
export type { InjectionPayload } from './payloads.js'
export { createRng, hashString, normalizeSeed, seedFromString } from './random.js'
export type { Rng } from './random.js'
