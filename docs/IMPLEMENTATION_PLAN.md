# Implementation plan: status

Vibrissa is a JSON-driven contract tester for MCP servers. This file tracks what is built.
The design lives in [V2_SCOPE.md](./V2_SCOPE.md) (why) and
[V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md) (how). Remaining work is in
[FUTURE.md](./FUTURE.md).

## v1 (0.1.x): delivered

| Milestone | Status |
|---|---|
| M1: runner over MCP stdio, exact match, `expectError` | Delivered |
| M2: `$partial`, `$regex`, `$wildcard`, `$unordered` with path-level mismatches | Delivered |
| M3: JUnit reporting + before/after hooks | Delivered in 2.0 (`junit` reporter, `setup` / `teardown`, config `hooks`) |
| M4: `run`, `tools`, `call`, `record`, `init`, `inspect`; case schema; `vib` / `vib-test` bins | Delivered |
| M5: performance thresholds + streaming guidance | Delivered in 2.0 (`budgetMs`, `--baseline` latency gating, [CASES.md recipes](./CASES.md#recipes)) |

## v2 (2.0.0): delivered

From V2_SCOPE §7.

**Must**

| Item | Where |
|---|---|
| `@modelcontextprotocol/client` 2.x with era negotiation (`auto` / `legacy` / `modern` / pin) | `src/session/` |
| Streamable HTTP servers | `src/session/`, [CONFIG.md](./CONFIG.md#servers) |
| Envelope normalization | `src/normalize.ts` |
| Resources, resource templates, prompts as cases; `discover`, `resources`, `prompts`, `read`, `get-prompt` | `src/runner.ts`, `src/cli/` |
| Manifest lock (`vib manifest`, drift check in `vib run`, `--update-manifest`) | `src/manifest.ts` |
| Flows with `capture` and `{{name}}` interpolation; `setup` / `teardown` / `hooks` | `src/cases.ts`, `src/runner.ts` |
| MRTR scripting (`respond`, `expectInputRequired`) | `src/session/`, `src/runner.ts` |
| Reporters: console, json, junit, github, tap | `src/reporters/` |
| Transcripts on failure (`--trace` for all) | `src/runner.ts` |
| `--update` (and `--update=all`) | `src/runner.ts` |
| Tags, grep, profiles, shards, concurrency | `src/config.ts`, `src/cases.ts` |
| `vib migrate` | `src/cli/migrate.ts` |

**Should**

| Item | Where |
|---|---|
| `outputSchema` enforcement; `inputSchema` pre-validation warnings | `src/runner.ts`, `src/schema.ts` |
| `vib fuzz` | `src/fuzz/`, `src/cli/fuzz.ts` |
| `vib check` (spec sanity + description lint) and `vib run --check` | `src/lint/` |
| `vib tap` and `vib record --from-tap` | `src/tap/`, `src/cli/record.ts` |
| `vib diff --against` | `src/cli/diff.ts` |
| Budgets, `--repeat` flake rates, `--baseline` delta gating | `src/runner.ts` |
| Tasks polling (`await`, `expectTask`) | `src/session/`, `src/runner.ts` |
| Matchers v2 | `src/match.ts` |
| Vitest bridge (`describeCases`) | `src/vitest.ts` |

**Could**

| Item | Status |
|---|---|
| `vib explain` | Delivered |
| `vib conformance` wrapper | Delivered |
| Output-injection probes (`vib fuzz --inject`) | Delivered |
| `vib init --ci`, `--from-claude-config`, Python / Go detection | Delivered |
| `vib record --flow` | Delivered |
| Evals plugin, `vib gen`, GitHub Action, matcher plugins | After 2.0, see [FUTURE.md](./FUTURE.md) |

**Not delivered from Must / Should:** `--watch`, `--perf` reports, `vib show-trace`. All
three are in [FUTURE.md](./FUTURE.md).
