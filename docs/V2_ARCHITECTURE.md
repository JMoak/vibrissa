# Vibrissa v2 — Architecture Contract

This file is the contract between everyone (human or agent) building v2 in parallel.
Read `V2_SCOPE.md` first for the *why*. This file is the *how*: module layout, shared
interfaces, ownership, and conventions. If you must change a shared interface, change
it here first and say so in your report.

## Ground rules

1. **TypeScript, ESM, Node ≥ 20.** `npm run lint` (biome) must pass on files you own.
2. **Zero test code for users.** Every feature is expressible in a JSON case or config.
3. **Deterministic core.** No LLM calls in `src/`. (Evals plugin is a separate package, later.)
4. **Dependencies:** `@modelcontextprotocol/client` 2.x (+ `@modelcontextprotocol/core`),
   `ajv` 8 + `ajv-formats`, `fast-glob`, `jest-diff`. `@modelcontextprotocol/server` 2.x is
   a devDependency for fixtures. Add nothing else without noting it in your report.
5. **Never `git commit` or `git push`.** Leave changes in the working tree.
6. **Tests:** vitest. Run *your own* test files (`npx vitest run tests/<file>.test.ts`)
   while other modules are mid-flight; the full suite and `npm run typecheck` are run at
   integration time. Do not "fix" files you don't own; report the problem instead.
7. **Agent- and human-intuitive.** Every CLI command has `--json`. Every error message
   says what to do next. Case keys are plain words; matchers start with `$`.

## Module layout & ownership

```
src/
  types.ts            Case/config/result types (v2)                     [foundation]
  config.ts           Load/merge config, profiles, servers, env interp  [foundation]
  paths.ts            Root/server resolution                            [foundation]
  session/
    index.ts          McpSession: connect (stdio|http, era), tools,     [foundation]
                      resources, prompts, discover, MRTR responder,
                      tasks polling, transcript hook
    errors.ts         ToolError model, code-name mapping (v2 enums)     [foundation]
  normalize.ts        Envelope normalization (pure)                     [matchers]
  match.ts            Matcher engine v2 (pure)                          [matchers]
  schema.ts           Ajv 2020-12 wrapper: compile, validate, $ref      [matchers]
  events.ts           RunEvent union + Reporter interface (SHARED)      [owner: lead]
  reporters/
    index.ts          createReporters(names, opts) → Reporter[]         [reporters]
    console.ts, json.ts, junit.ts, github.ts, tap.ts                    [reporters]
  lint/
    descriptions.ts   Tool-description lint rules (pure)                [lint]
    spec.ts           Spec-sanity checks over a Manifest (pure)         [lint]
  fuzz/
    generate.ts       JSON-Schema → arg generator, seeded (pure)        [fuzz]
    invariants.ts     Invariant definitions (pure)                      [fuzz]
  manifest.ts         Manifest build/diff (pure over session output)    [phase 2]
  runner.ts           Runner v2: cases, flows, MRTR, tasks, repeat,     [phase 2]
                      shard, concurrency, budgets, update mode
  tap/                stdio proxy capture                               [phase 2]
  cli/                one file per command                              [phase 2]
  index.ts            Public library API                                [phase 2]
schema/               JSON Schemas for case + config                    [foundation]
tests/                vitest; fixtures/echo-server upgraded to v2 SDK   [foundation]
docs/                 scope, architecture, matchers, migration          [each]
```

## Shared interfaces

### Case file (v2) — `src/types.ts`

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/** A single MCP operation. Exactly one of tool | resource | resourceTemplate | prompt. */
export interface Operation {
  tool?: string
  resource?: string                 // resources/read by URI
  resourceTemplate?: string         // expand with args, then resources/read
  prompt?: string                   // prompts/get
  args?: Record<string, JsonValue>
}

export interface Step extends Operation {
  name?: string
  expect?: JsonValue
  expectError?: ExpectError
  /** Scripted answers for MRTR input_required rounds, keyed by request method. */
  respond?: Record<string, JsonValue>            // e.g. { "elicitation/create": { action: "accept", content: {...} } }
  expectInputRequired?: JsonValue                // matcher over the InputRequests map
  await?: { pollMs?: number; timeoutMs?: number } // tasks extension: poll until terminal
  capture?: Record<string, string>               // name → dotted path into normalized result
  budgetMs?: number
  timeoutMs?: number
  ignoreErrors?: boolean                          // teardown steps
  validateOutput?: boolean                        // default true when tool has outputSchema
  normalize?: NormalizeConfig | false
}

export interface TestCase extends Step {
  $schema?: string
  tags?: string[]
  server?: string                                 // key into config.servers
  steps?: Step[]                                  // flow; when present, top-level op fields are ignored
  setup?: Step[]
  teardown?: Step[]
  flaky?: boolean
  skip?: boolean | string
}

export interface ExpectError {
  code?: string | number
  message?: string | { $regex: string; flags?: string }
}
```

Interpolation: `{{name}}` inside any string in `args`/`expect` of later steps is replaced
with the captured value (strings inline; a string that is *exactly* `{{name}}` is replaced
by the raw JSON value). Also available: `{{env.FOO}}`.

### Config (v2) — `src/types.ts`

```ts
export interface StdioServerConfig { cmd: string; args?: string[]; cwd?: string; env?: Record<string,string> }
export interface HttpServerConfig  { url: string; headers?: Record<string,string> }
export type ServerConfig = (StdioServerConfig | HttpServerConfig) & {
  protocol?: 'auto' | 'legacy' | { pin: string }   // default 'auto'
  spawnTimeoutMs?: number
}
export interface NormalizeConfig {
  stripMeta?: string[]      // glob-ish keys under _meta; default ["io.modelcontextprotocol/*"]
  dropKeys?: string[]       // top-level result keys; default ["resultType"]
  ttlMs?: 'keep' | 'ignore' // default 'ignore'
}
export interface RunOptions {
  servers: Record<string, ServerConfig>
  defaultServer: string
  globs: string[]
  manifest?: string                  // path; default tests/integration/__manifest__.json
  normalize: NormalizeConfig
  timeoutMs: number
  budgetMs?: number
  failFast: boolean
  allowEmpty: boolean
  reporters: string[]                // ["console"] default
  tags?: string[]; excludeTags?: string[]; grep?: string
  repeat?: number; shard?: { index: number; total: number }; concurrency?: number
  update?: boolean; trace?: boolean; check?: boolean; baseline?: string
  rootDir: string
}
```

Config file: `servers` + `defaultServer`; legacy `server` (singular) is sugar for
`servers.default`. `profiles` merge over the base. `${ENV_VAR}` interpolation in strings.
Precedence: defaults → file → profile → CLI flags.

### Session — `src/session/index.ts`

```ts
export interface SessionOptions { timeoutMs: number; transcript?: (entry: TranscriptEntry) => void; inputResponder?: InputResponder }
export type InputResponder = (method: string, params: JsonValue) => JsonValue | undefined

export class McpSession {
  static start(server: ServerConfig, opts: SessionOptions): Promise<McpSession>
  readonly era: 'legacy' | 'modern'; readonly protocolVersion: string
  discover(): Promise<DiscoverInfo>                // works on both eras (synthesized on legacy)
  listTools(): Promise<ToolSummary[]>              // name, title, description, inputSchema, outputSchema, annotations
  listResources(): Promise<ResourceSummary[]>; listResourceTemplates(): Promise<ResourceTemplateSummary[]>
  listPrompts(): Promise<PromptSummary[]>
  callTool(name, args, opts?: CallOptions): Promise<Outcome>
  readResource(uri, opts?): Promise<Outcome>; getPrompt(name, args, opts?): Promise<Outcome>
  close(): Promise<void>
}
export type Outcome =
  | { kind: 'result'; result: JsonValue; durationMs: number }
  | { kind: 'error'; error: ToolError; durationMs: number }
  | { kind: 'input_required'; requests: JsonValue; durationMs: number }   // only when no responder answered
export interface ToolError { kind: 'protocol' | 'tool' | 'transport' | 'timeout'; code?: number; codeName?: string; message: string }
```

`CallOptions.respond` (per-call responder override) and `CallOptions.await` (tasks polling)
are honored by the session. The session never normalizes; the runner does.

**Foundation additions (all optional / additive; the authoritative types are in the files):**

- `Outcome.result` is the *raw wire* `result` (2026 servers include `resultType` and
  `_meta["io.modelcontextprotocol/serverInfo"]`), captured at the transport. Every outcome may
  also carry `inputRequests?: JsonValue[]` (each InputRequests map the server sent, one per
  round, so `expectInputRequired` works even when `respond` answered) and `task?: JsonValue`
  (the CreateTaskResult). Error outcomes for tool `isError` results carry `result` too;
  `input_required` may carry `requestState`.
- `ToolError` adds `data?: JsonValue` (JSON-RPC `error.data`) and `local?: true` (raised by the
  client SDK, not received from the server). `errorMatchesCode(error, expected)` in
  `session/errors.ts` implements `expectError.code` matching (names, aliases, numbers,
  `ResourceNotFound` ≡ `-32602 + {uri}`).
- `InputResponder` may return a Promise. `CallOptions = { timeoutMs?, respond?: InputResponder |
  Record<method, JsonValue>, await?: AwaitOptions | true }`; per-call responder first, then
  the session responder.
- `SessionOptions` adds `stderr?: 'inherit' | 'capture' | 'ignore'`, `onStderr`, `tasks?`
  (declare the tasks extension, default true), `clientInfo`. Transcript entries:
  `{ dir: 'in' | 'out' | 'stderr', ts, message?, text? }`.
- `McpSession` adds `list*Result()` (items + list-level `ttlMs` / `cacheScope` / `_meta`),
  `readResourceTemplate(template, args, opts?)`, `ping()`, `closed`, `stderrTail`, `sdk`.
  `start()` throws `SessionStartError` (`code: spawn | exited | timeout | negotiation | http |
  config`); list/discover verbs throw `SessionRequestError` (carries a `ToolError`).
- Step adds `expectTask?: JsonValue`; `await` also accepts `true`. `ServerConfig.protocol`
  also accepts `'modern'` (= `{ pin: "2026-07-28" }`). `RunOptions` adds `hooks?`.
- Operations on one session are serialized (one in flight); use one session per worker.

### Run events & reporters — `src/events.ts` (authoritative copy lives in the file)

See `src/events.ts`. Reporters are pure consumers of `RunEvent`s; they must not touch the
session. `console` reporter replaces today's `display.ts`.

### Matchers — `src/match.ts`

`matchValue(expected: JsonValue, actual: unknown, ctx?: MatchOptions): Mismatch[]`
v1 matchers stay. v2 adds: `$any`, `$type`, `$schema`, `$oneOf`, `$contains`, `$length`,
`$number`, `$ignore`, `$ref` (resolved by the runner before matching, relative to the case
file). Document every matcher in `docs/MATCHERS.md` with one example each.

### Normalization — `src/normalize.ts`

`normalizeResult(result: JsonValue, cfg: NormalizeConfig): JsonValue`. Pure, idempotent.

### Manifest — `src/manifest.ts`

```ts
export interface Manifest { vibrissa: 2; protocolVersion: string; server: { name?: string; version?: string }
  capabilities: JsonValue; tools: ToolSummary[]; resources: ResourceSummary[]; resourceTemplates: ...; prompts: PromptSummary[] }
export function diffManifest(locked: Manifest, live: Manifest): ManifestDiff   // added/removed/changed per section, field-level for tools
```

As built: `Manifest` also has `instructions?` and `listMeta` (`ttlMs` / `cacheScope` per list
fetched). Tools are sorted by name, resources by `uri`, templates by `uriTemplate`, prompts by
name; item keys come in a fixed order and `io.modelcontextprotocol/*` `_meta` keys are
stripped. Machine shape (empty lists and unchanged sections omitted):
`ManifestDiff = { identical, breaking, changes?: FieldChange[], tools?|resources?|resourceTemplates?|prompts?: { added?, removed?, changed?: [{ key, breaking, fields: FieldChange[] }] } }`
with `FieldChange = { path, before?, after?, breaking }`. `path` is the deepest changed
sub-path (`inputSchema.required`, `inputSchema.properties.city.type`, `description`); prompt
arguments are keyed by name. **Breaking**: a removed item, a removed/renamed input property, a
newly required property or prompt argument, a type change, removed enum values, a tightened
`additionalProperties`, any `outputSchema` change, a changed resource `mimeType`, a removed
capability, a `protocolVersion` change. Descriptions, titles and annotations are not breaking.
Comparison ignores object key order. `diffManifest(a, b, { ignore })` drops dotted paths first
(default `["server.version", "protocolVersion", "listMeta"]`, so one lock serves both protocol
eras; `vib manifest diff --strict` = `ignore: []`; sections are keyed by item name/uri, `*`
matches any key, item keys may contain dots: `tools.*.annotations`,
`tools.notes.search.description`). `summarizeDiff` gives the one-liner (ending ` (breaking)`
when it is); `formatDiff` the console view: one line per sub-path, `[-old-]{+new+}` word diffs
for prose, `(breaking)` tags. `captureManifest(session, { toolsListSamples })` also returns the
raw tools/list samples for `spec/tools-list-stable`. Lock path: config `manifest` for the
default server, a sibling `<name>.<server>.json` (`__manifest__.staging.json`) for any other.

### Runner — `src/runner.ts`, `src/cases.ts`

Loading (`loadCases`): globs (relative to rootDir, `!` negates) → files → JSONC parse →
shape validation (unknown keys get a did-you-mean; errors read `<file>: <problem>. <hint>`;
`expectError.code` names must be known — did-you-mean against `knownCodeNames()`, numbers
always pass) → `$ref` expansion in `expect` / `expectInputRequired` / `expectTask` relative to
the case file → `lintExpectation` (unknown `$` keys such as `$partail` fail with a
did-you-mean; data with literal `$`-keys goes in `$literal`) → static `{{name}}` check (every
name must be captured by an earlier step, by suite `hooks.setup`, or be `env.X` with X set;
teardown may use any capture of the case). A bad file never throws: it becomes a failed case
with `errorKind: "load"`. Case id = posix path relative to rootDir (absolute when outside it),
`line: 1`. Filters: `tags` (any), `excludeTags` (any), `grep` (case-insensitive regex over name
and id; substring if the regex is invalid), then `shard i/n` (every n-th case of the id-sorted
selection, starting at i). `skip: true | "reason"` reports `skipped` with that reason.
Unparseable files are kept by tag filters. Manifest locks are never cases: the configured
`manifest` path, its per-server siblings, and any file shaped like a lock (`"vibrissa": 2` + a
`tools` array) are dropped even when the globs match them (`LoadCasesOptions.manifest` /
`exclude`). So are `$ref` fragments: a JSON file with no operation key and no `steps` that is
the target of a `$ref` from another matched file, or lives in a `shared/` or `fragments/`
directory (`LoadCasesResult.fragments`; the runner prints one `info:` line listing them).

Execution: cases are grouped by server; each server gets `concurrency` workers, one
McpSession each (a dead session is restarted before the next case); a case — every step of a
flow — runs on one worker. Before cases run, the first session verifies the manifest lock and
(with `check`) runs `runChecks` over the live manifest + two tools/list samples + `transport` +
`session.stdoutNoise`, honoring `checks.allow` / `checks.severity`. Non-JSON-RPC stdout lines
are a run warning even without `check`. Per case: `setup` → `steps` (or the case's own
operation) → `teardown` (always). `ignoreErrors: true` works on any step (and on a single-op
case): a failure is recorded on the step as `failed` with reason `ignored (ignoreErrors): ...`,
but it never fails the case and never stops the flow (non-teardown ignores also emit a
warning). A teardown step whose `{{capture}}` never happened (its step failed) is `skipped`,
not failed. Each step is interpolated, called with `timeoutMs` / `respond` / `await`, then
evaluated in this order: unanswered `input_required` (fails with the requests and a
paste-ready `"respond": {...}` derived from the `requestedSchema`, unless the step asserts only
`expectInputRequired`, i.e. has no `expect` / `expectError`), `expectInputRequired`,
`expectTask`, `expectError` (code via `errorMatchesCode`, message via the matcher; a success
that also violated outputSchema says so), otherwise `outputSchema` (validates the raw
`structuredContent` when the tool declares one and `validateOutput !== false`; violations are
assertion mismatches at `structuredContent.<path>`) and `expect` against the normalized result
(case/step `normalize` merge over config; `false` disables). A tool `isError` result with an
`expect` is compared as data. A call to a tool the server does not list adds `Tool "x" is not
on the server; did you mean "y"? Available: ...`. `capture` reads dotted paths (`a.b[0].c` or
`a.b.0.c`) from the normalized result (from `{ kind, codeName, code, message, data }` for an
expected error). Step `budgetMs` checks the operation time; case `budgetMs` (default: config
`budgetMs`) checks the summed operation time of setup + steps. Both fail with
`errorKind: "budget"`. Steps after a failure are reported `skipped`.

Mismatches are patchable: each carries `field` (`expect` | `expectError` |
`expectInputRequired` | `expectTask` | `structuredContent`), `pointer` (RFC 6901 into the case
file, e.g. `/steps/1/expect/content/0/text`; none for server-side `structuredContent`) and, in
flows, `stepIndex` (0-based plan index, as `StepRef.index`).

**`expectInputRequired` shape.** It is matched against a view of every InputRequests round the
server sent during the call (`Outcome.inputRequests`, so it works whether or not `respond`
answered). Two views; the expectation picks one:

- **by method** — chosen when every plain (non-`$`) top-level key contains a `/`:
  `{ "elicitation/create": <params> }`. A method asked more than once maps to an array of
  params in order. Era-neutral; prefer it.
- **by key** (otherwise) — the server's own InputRequests map merged over rounds:
  `{ "<key>": { "method": "elicitation/create", "params": {...} } }`. On 2026-07-28 the keys
  are the server's (`confirm`); on 2025-era connections they are JSON-RPC request ids.

```jsonc
"expectInputRequired": { "elicitation/create": { "$partial": true, "message": "Proceed with deploy?" } }   // by method
"expectInputRequired": { "confirm": { "method": "elicitation/create", "params": { "$partial": true } } }  // by key
```

Interpolation: `{{name}}` / `{{env.X}}` in `tool`, `resource`, `resourceTemplate`, `prompt`,
`args`, `expect`, `expectError`, `respond`, `expectInputRequired`, `expectTask`. A string that is
exactly one placeholder becomes the raw captured JSON value; otherwise values are inlined
(non-strings as JSON). Keys are never interpolated.

Run-level behavior:

- `repeat: N` runs every case N times in rounds (ids `<id>#<n>`); `summary.passRates` per case
  id and `summary.runs` (case runs); `summary.total` / `passed` / `failed` count cases by
  verdict. A case passes overall at 100 %, or at `>= flakyFloor` (default 0.5) when
  `flaky: true`. `run:end.ok` and the exit code use that verdict. `run:start` carries `repeat`
  and, under `--shard`, `shard: { index, total }`.
- `update` is leaf-level: only mismatched plain leaves of a failing `expect` (case or step)
  take the normalized live value (`escapeDirectives`); subtrees that still match — matchers
  included — are kept verbatim, and the file keeps its indent, key order and EOL. A mismatched
  matcher or `$ref` blocks the rewrite (the reason names it) unless `updateAll`
  (`--update=all`), which replaces it with the literal value and warns what it replaced.
  Never rewritten: `expectError`, `expectInputRequired`, `expectTask`, `{{captured}}` leaves,
  files with comments. A failing case that was not rewritten carries
  `outcome.updateSkipped: { reason }` (plus a warning). Without `update`, a golden failure ends
  with `Use --update to accept the new output.` only when `--update` would rewrite it, else with
  why not; `ExecuteContext.updateHint: false` (vitest bridge, `vib diff`) drops the hint.
  `--update` forces `repeat` to 1; a flow keeps going after an accepted step.
- `baseline: <results.json>` (the json reporter's file): only regressions fail — case ids
  failing now that did not fail in the baseline (new cases included), and passing cases whose
  mean durationMs grew by more than `baselineLatencyPct` (default 50 %) and at least
  `baselineLatencyMinMs` (default 10 ms). Reported as a `baseline/regressions` check event;
  still-failing known cases are a warning. An unreadable baseline falls back to normal gating.
- Manifest lock: lock present → `manifest:ok` or `manifest:diff` (fails the run; `summary` =
  one-liner, then the `formatDiff` body, then the `--update-manifest` tip; `diff` = the machine
  shape) — with `updateManifest` the lock is rewritten (or created) and a warning +
  `manifest:ok` are emitted; lock absent → a warning naming `vib manifest record [--server x]`,
  or, with `requireManifest: true`, a `manifest:diff` (`diff.errorKind: "load"`) that fails the
  run. `lockManifest: false` turns it off.
- `trace` (or any failure) writes `<outDir>/traces/<id without .json>[.run<n>].ndjson` (the
  case's JSON-RPC messages as TranscriptEntry lines) and `.stderr.txt` when the server wrote
  to stderr during the case; cases outside rootDir use `traces/_external/<name>-<hash>`.
  Runner sessions use `stderr: 'capture'`.
- Exit code: 0 ok, 1 failures / drift / failed checks / regressions / empty selection, 2
  configuration error (an invalid server entry). A server that cannot start fails its cases
  (`errorKind: "error"`); an empty selection (no glob match, or nothing left after filters) is
  an `error:` on stderr and exit 1 unless `allowEmpty`. `failFast` stops pulling new cases
  after the first failure.

Library: `new Runner(options).execute()` → `{ exitCode, ok, summary, cases, checks, manifests,
warnings }`; `runCases(partial)` → exit code (v1 `server` is sugar for `servers.default`);
`executeCase(data, ctx)` runs one case on a session (used by `vib diff` and
`@jmoak/vibrissa/vitest`'s `describeCases`, which also registers a manifest-lock test and,
with `checks: true`, a checks test). `checks`, `manifestIgnore`, `requireManifest` and `outDir`
come from config (`RunOptions`; unknown config keys are a ConfigError with a did-you-mean, all
problems reported at once); `pretty`, `stdout`/`stderr`, `extraReporters`, `updateAll`,
`updateManifest`, `lockManifest`, `flakyFloor`, `baselineLatencyPct`, `baselineLatencyMinMs`,
`serverStderr`, `env` live on `RunnerOptions` (`reporters: []` means none). CLI: unknown flags
on `vib run` / `manifest` / `diff` exit 2 with a did-you-mean. `vib run --json` prints exactly
one JSON object on stdout (the JsonReport, also written to `<outDir>/results.json`;
`{ ok: false, error }` on a usage error) and keeps stderr to warnings and errors; `--brief`
shows only failures, warnings and drift (with `--json`: no passing cases, no empty arrays).
`vib diff` compares observed results through each case's matchers (a value its matcher accepts
reads `"<matches $type>"`, `$partial` drops unasserted keys) and reports observations only.

## CLI surface (phase 2)

See `V2_SCOPE.md` §5. Every command: `--config`, `--server <name|"cmd ...">`, `--json`,
`--profile`. `vib` and `vib-test` are aliases.

## Conventions for error messages

`<what failed> at <where>: <expected vs got>. <one-line hint>` — e.g.
`Expectation failed at content[0].text: expected "HELLO", got "hello". Use --update to accept.`
