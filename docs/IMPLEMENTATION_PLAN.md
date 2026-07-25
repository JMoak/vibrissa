## Implementation Plan — Vibrissa (vib-test)

### 1. Integration-first via MCP stdio
- Exercise the server end-to-end over stdio; prioritize integration tests over unit tests.
- Outcome: deterministic, transport-accurate validation of MCP contracts.

### 2. JSON-driven test cases (LLM-friendly)
- Case schema: `name`, `tool`, `args`, `expect` (and `expectError`).
- Store under `tests/integration/**/*.json`.
- Encourage LLM generation and human review.

### 3. Matching semantics for assertions
- Default exact deep equality.
- Extensions:
  - `$partial`: allow extra fields, assert provided ones.
  - `$regex`: regex match with flags.
  - `$wildcard`: glob-like string matching.
  - `$unordered`: treat arrays as sets; combine with partial.
  - `expectError`: explicit error codes/messages.

### 4. CLI runner (vib-test)
- Binary: `vib-test`.
- Core flags:
  - `--server`, `--server-cwd`, `--env FOO=bar`
  - `--cases "tests/integration/**/*.json"`
  - `--fail-fast`, `--timeout ms`, `--allow-empty`
  - Future (see FUTURE.md): concurrency, reporting, before/after hooks
- Example:

```bash
vib-test \
  --server "node dist/index.js" \
  --cases "tests/integration/**/*.json" \
  --fail-fast --timeout 15000
```

### 5. Scope coverage
- Contracts: `listTools`, `tools/call`.
- Validation: invalid args → error codes/messages.
- Flows: multi-step tool sequences.
- Streaming/long ops: supported; prefer partial/regex.
- Optional performance thresholds per case.

### 6. Library API
- Export `runCases(options)` for programmatic control.
- Mirrors CLI options (`server`, `globs`, `failFast`, `timeoutMs`).

### 7. CI integration
- Build then run vib-test.
- Non-zero exit gates merges.
- Cache dependencies; shard suites by glob patterns when large.

### 8. Packaging
- Reusable module with CLI (`vib-test`) and library.
- Files: `dist`, `bin`, `README.md`, `LICENSE`.

### 9. Milestones
- M1 (done): Minimal runner executing JSON cases via real MCP stdio (`@modelcontextprotocol/sdk` client); exact match plus `expectError` (code + message/`$regex`).
- M2 (done): Partial/regex/wildcard/unordered semantics via a structured matcher engine (`src/match.ts`) that reports path-level mismatches (e.g. `content[0].text`). `$partial` cascades to its subtree; `$unordered` uses backtracking multiset matching and combines with `$partial`.
- M3: JUnit reporting + before/after hooks.
- M4 (done): Dev-loop CLI subcommands — `run` (default), `tools`, `call`, `record`, `init`, plus `inspect` to launch MCP Inspector with the same server config. Case JSON schema at `schema/case.schema.json`. Binary aliases: `vib` and `vib-test`.
- M5: Performance thresholds + streaming guidance.


