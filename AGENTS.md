# AGENTS.md

Instructions for coding agents (and humans) working on **this repo**, the Vibrissa source.
For writing test suites *with* Vibrissa, see [README.md](./README.md) and
[docs/CASES.md](./docs/CASES.md).

## What this is

Vibrissa is a JSON-driven contract-testing CLI and library for MCP servers. TypeScript,
ESM only, Node >= 20, published as `@jmoak/vibrissa` with two bins (`vib` and `vib-test`,
same binary).

Read before changing anything non-trivial:

1. [docs/V2_SCOPE.md](./docs/V2_SCOPE.md): the product thesis. Protect its four
   principles: zero test code, ground truth via `record`, deterministic core, fast local loop.
2. [docs/V2_ARCHITECTURE.md](./docs/V2_ARCHITECTURE.md): module layout, shared
   interfaces, ownership. It is the contract between parallel workers. If you change a
   shared interface, change that file first and say so in your report.

## Architecture map

| Path | Role | Pure? |
|---|---|---|
| `src/types.ts` | Case, config, and session summary types | yes |
| `src/config.ts`, `src/defaults.ts`, `src/paths.ts` | Load, merge, and validate config; profiles; `${ENV}` | mostly |
| `src/session/` | `McpSession`: stdio/HTTP, era negotiation, MRTR, tasks, transcripts; `errors.ts` code names | no (I/O) |
| `src/normalize.ts` | Envelope normalization | yes |
| `src/match.ts` | Matcher engine (`matchValue`, `resolveRefs`, `lintExpectation`) | yes |
| `src/schema.ts` | Ajv 2020-12 wrapper | yes |
| `src/events.ts` | `RunEvent` union + `Reporter` interface (lead-owned, shared) | yes |
| `src/reporters/` | console, json, junit, github, tap | consume events only |
| `src/lint/` | `vib check`: `spec/*` checks and `desc/*` rules | yes |
| `src/fuzz/` | Seeded arg generator + invariants | yes |
| `src/cases.ts` | Case loading, shape validation, filters, shards, `{{name}}` interpolation, dotted paths | mostly |
| `src/manifest.ts` | Manifest build and diff | yes |
| `src/runner.ts` | `Runner` and `executeCase`: flows, MRTR, tasks, repeat, budgets, update, baseline, traces | no |
| `src/tap/` | `vib tap` proxy (`proxy.ts`) and capture format (`entries.ts`) | no |
| `src/cli/` | One file per command; `src/cli.ts` holds the `COMMANDS` table, help, and exit codes | no |
| `src/vitest.ts` | `describeCases` Vitest bridge | no |
| `src/index.ts` | Public library API | n/a |
| `schema/` | JSON Schemas for case files and `vibrissa.json` | n/a |
| `tests/fixtures/echo-server/` | Fixture MCP server (both eras, stdio + HTTP) and its suite | n/a |

Keep pure modules pure. Reporters never touch the session. The session never normalizes;
the runner does.

## Ownership

- Every module in the architecture map has an owner. Edit only what you own or were asked
  to change. If a file you don't own is broken, report it with the failing command and
  error; do not "fix" it in passing.
- `src/events.ts` and `docs/V2_ARCHITECTURE.md` are shared contracts. Change them
  deliberately and call it out.
- Module docs belong to the module owner: `docs/MATCHERS.md` (matchers),
  `docs/CHECKS.md` (lint), `docs/FUZZ.md` (fuzz). Link to them; do not duplicate their
  content elsewhere.

## Commands

```bash
npm ci                                  # install
npm run build                           # tsup -> dist/
npm run typecheck                       # tsc --noEmit
npm test                                # full vitest suite (spawns fixture servers)
npx vitest run tests/match.test.ts      # one file: use this while others are mid-flight
npm run lint                            # biome check . --write (formats in place)
npx biome ci .                          # what CI runs (no writes)
npm run e2e                             # build, then run the fixture suite through the CLI
npm run e2e:demo                        # same, including the intentional *.fail.json cases
```

CI (`.github/workflows/ci.yml`) runs typecheck, `biome ci`, build, test, and e2e on
ubuntu + windows, Node 20/22/24. Paths must work on Windows: use `path.join`, never
hand-built `/` paths for the file system; print paths with forward slashes.

## Hard rules

1. **Never `git commit` or `git push`.** Leave changes in the working tree. Suggest a commit
   message if useful. The only exception is an explicit request in the current conversation.
2. **No LLM calls in `src/`.** Model-in-the-loop work lives in a separate package.
3. **No new dependencies** beyond those listed in V2_ARCHITECTURE.md without saying so.
4. **Every CLI command has `--json`** (except `vib tap`, whose stdout is the protocol
   stream). Agents are first-class users.
5. **Every case and config key is in the JSON Schema with a `description`.** A test
   enforces it (`tests/config.test.ts`). Docs mirror the schema descriptions.
6. **User-visible changes get a changeset** (`npx changeset`). See [RELEASING.md](./RELEASING.md).

## Error messages

Format: `<what failed> at <where>: <expected vs got>. <one-line hint>`

```
Expectation failed at content[0].text: expected "HELLO", got "hello". Use --update to accept.
Unknown server at case.server: "stagin" is not in servers (have: local, staging). Add it to "servers" in vibrissa.json or fix the name.
```

The hint says what to do next: a flag, a config key, a command. Never throw a bare
`Error("invalid")`.

## Recipes

### Add a matcher

1. `src/match.ts`: add the name to `DIRECTIVES` (its position is the AND evaluation
   order), allowed side options to `AUX_KEYS`, a `validateDirective` case, and a handler
   in `HANDLERS`.
2. Make `lintExpectation` catch malformed uses statically.
3. Tests in `tests/match.test.ts`: pass, fail message, invalid-matcher message, nesting.
4. Document it in `docs/MATCHERS.md` (quick reference row + section with one example and
   its failure output). Update the `expect` description in `schema/case.schema.json` if it
   lists matchers.

### Add a reporter

1. `src/reporters/<name>.ts`: a class implementing `Reporter` from `src/events.ts`. Use
   `RunCollector` from `shared.ts` instead of re-deriving state. Write files under
   `ctx.outDir` in `close()`.
2. Register it in `builtins()` in `src/reporters/index.ts` and add it to `BUILTIN_REPORTERS`.
3. Tests in `tests/reporters.test.ts` with a golden under `tests/fixtures/reporters/`.
4. Add the name to the `reporters` description in `schema/vibrissa.schema.json`, and to
   [docs/CI.md](./docs/CI.md) / [docs/CONFIG.md](./docs/CONFIG.md).

### Add a check

1. A new phrase for an existing rule: one line in that rule's pattern table in
   `src/lint/descriptions.ts`.
2. A new rule: an entry in `DESCRIPTION_RULES` (`src/lint/descriptions.ts`) or
   `SPEC_CHECKS` (`src/lint/spec.ts`) with a stable id (`desc/...` or `spec/...`), title,
   default severity, and check function.
3. Positive and negative tests in `tests/lint.test.ts`; keep the clean fixture clean.
4. Document the id in `docs/CHECKS.md`. A test fails if an id is missing there.
5. Regexes run on attacker-controlled text: no nested or adjacent unbounded quantifiers.

### Add a fuzz strategy

1. `src/fuzz/generate.ts`: add the name to `Strategy` and `ALL_STRATEGIES` (and
   `DEFAULT_STRATEGIES` if it should run without a flag), and a candidate source in
   `sources` inside `generateArgs`.
2. Each case needs a `reason`, a `target`, and an `expect` (`success`, `invalid-params`,
   `any`). Mutate exactly one location of the base where possible.
3. If it needs a new invariant, add it to `src/fuzz/invariants.ts` as data.
4. Tests in `tests/fuzz.test.ts` (determinism per seed is mandatory). Document it in
   `docs/FUZZ.md`.

### Add a CLI command

1. `src/cli/<command>.ts` exporting `<command>Command(argv: string[]): Promise<number>`
   (the exit code: `0` ok, `1` failed, `2` usage/config/connection). Parse shared flags
   with `parseCommonFlags` and connect with `startSession` from `src/cli/resolve.ts`.
   Throw `UsageError` for bad input; `src/cli.ts` maps it (and `ConfigError`,
   `SessionStartError`) to exit `2`.
2. Support `--json`: exactly one JSON document with an `ok` field on stdout (print it
   with `printJson`, which handles compact vs pretty), everything human on stderr.
   Errors thrown as `UsageError` / `ConfigError` become `{ ok: false, error: { type, code,
   message, hint }, next }` automatically. Connection flags come for free with `common: true`.
3. Add an entry to `COMMANDS` in `src/cli.ts` (`name`, `group`, `summary`, `usage`,
   `flags`, `examples`, `run`). Every flag the command reads must be listed in `flags`
   (or `extraFlags`): unknown flags are rejected with a did-you-mean on every command.
   That entry is what `vib <command> --help` prints.
4. Tests in `tests/cli-commands.test.ts` against the fixture server.
5. Document it in [docs/CLI.md](./docs/CLI.md): synopsis, flags, exit codes, `--json`
   shape, one example. Add a row to the README command table if it is part of the loop.

## Docs map

| Doc | Covers |
|---|---|
| [README.md](./README.md) | Pitch, quick start, the loop |
| [docs/CASES.md](./docs/CASES.md) | Every case-file key |
| [docs/CONFIG.md](./docs/CONFIG.md) | Every `vibrissa.json` key |
| [docs/CLI.md](./docs/CLI.md) | Every command and flag |
| [docs/MATCHERS.md](./docs/MATCHERS.md) | Assertion language |
| [docs/CHECKS.md](./docs/CHECKS.md) | `vib check` ids |
| [docs/FUZZ.md](./docs/FUZZ.md) | `vib fuzz` generation and invariants |
| [docs/CI.md](./docs/CI.md) | Reporters, sharding, baselines in CI |
| [docs/MIGRATION.md](./docs/MIGRATION.md) | v1 to v2 |
| [RELEASING.md](./RELEASING.md) | Changesets, trusted publishing, 2.0.0 checklist |
