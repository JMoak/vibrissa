# vibrissa

> *vibrissa* (n.): a whisker; a sensory organ for probing the world.

**Contract testing for MCP servers.** Record real responses as JSON, replay them in CI,
lock your tool manifest, fuzz your schemas. No test code: the whole suite is data.

[![npm](https://img.shields.io/npm/v/%40jmoak%2Fvibrissa?color=cb3837&label=npm)](https://www.npmjs.com/package/@jmoak/vibrissa)
[![CI](https://github.com/JMoak/vibrissa/actions/workflows/ci.yml/badge.svg)](https://github.com/JMoak/vibrissa/actions/workflows/ci.yml)
[![node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-3c873a)](https://nodejs.org)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Vibrissa drives your server over stdio or Streamable HTTP, speaks both MCP 2026-07-28
and the 2025 revisions, and diffs every tool, resource, and prompt result against
committed JSON. It also snapshots the server's whole surface into a lock file, so a
changed schema or a quietly rewritten tool description fails the PR instead of reaching
a client.

```bash
npm i -D @jmoak/vibrissa
npx vib init                      # vibrissa.json + a real sample case from your server
npx vib discover                  # protocol era, capabilities, identity
npx vib tools                     # what the server exposes
npx vib call echo --arg text=hello
npx vib record echo --arg text=hello --name "echo hello"
npx vib manifest record           # lock the surface
npx vib run                       # replay every case: the CI gate
npx vib check                     # spec sanity + description lint
npx vib fuzz echo --runs 200      # schema-driven fuzzing
```

Releases ship through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
with provenance: each version links to the commit and workflow that built it.

---

## Why

MCP testing has sorted itself into layers:

| Layer | Question | Tools |
|---|---|---|
| 0: Conformance | Does the server speak the spec? | official conformance suite; `vib check` covers the deterministic subset |
| **1: Contract** | **Given these args, does this server return this?** | **Vibrissa** |
| 2: Robustness | Fuzzing, poisoning, rug pulls | `vib fuzz`, `vib check`, manifest lock (deterministic subset) |
| 3: Model evals | Does an LLM pick the right tool? | eval platforms; out of core by design |

Vibrissa owns Layer 1 and absorbs the deterministic halves of 0 and 2. No LLM in the
critical path, no accounts, no hosted anything: CI gates are reproducible and the loop is
sub-second.

The 2026-07-28 revision rewrote the core. Each change lands on what a contract tester
must do:

| 2026-07-28 change | Vibrissa |
|---|---|
| `initialize` replaced by `server/discover` | `protocol: auto` negotiates either era |
| `resultType` + `_meta` serverInfo on every result | normalized away; old goldens stay green |
| Multi Round-Trip Requests (`input_required`) | `respond` scripts the answers |
| No protocol sessions; state in server-minted handles | flows with `capture` and `{{name}}` |
| Deterministic `tools/list` with cache hints | manifest lock; `vib check` |
| JSON Schema 2020-12 `outputSchema` | enforced on every call |
| Tasks extension with `tasks/get` polling | `await`, `expectTask` |
| Renumbered error codes | stable code names on both eras |

## The loop

| Step | Command | What it does |
|---|---|---|
| explore | `vib discover`, `vib tools`, `vib resources`, `vib prompts` | see the surface |
| probe | `vib call <tool>`, `vib read <uri>`, `vib get-prompt <name>` | one live request, printed |
| capture | `vib record ...`, `vib tap -- <server>` | real responses become golden cases |
| gate | `vib run` | replay everything, diff the manifest; non-zero on any mismatch |
| harden | `vib check`, `vib fuzz <tool>` | spec sanity, poisoning lint, generated edge cases |

Every command except `tap` takes `--json`. [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
is still the place to click around: `vib inspect` opens it with your config.

## Anatomy of a case

The v1 shape is still the core shape. `tests/integration/echo.basic.json`:

```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": { "content": [{ "type": "text", "text": "hello" }] }
}
```

`expect` is exact deep equality over the normalized result unless a matcher says
otherwise. `resource`, `resourceTemplate`, and `prompt` work the same way as `tool`.

**A flow** chains steps on one session and passes values forward:

```json
{
  "name": "sum flows into echo",
  "steps": [
    { "tool": "typed", "args": { "a": 2, "b": 3 }, "capture": { "sum": "structuredContent.sum" } },
    {
      "tool": "echo",
      "args": { "text": "sum is {{sum}}" },
      "expect": { "content": [{ "type": "text", "text": "sum is 5" }] }
    }
  ]
}
```

**An MRTR case** answers the server's question and asserts it was asked:

```json
{
  "name": "confirm deploy",
  "tool": "confirm",
  "args": { "action": "deploy" },
  "respond": { "elicitation/create": { "action": "accept", "content": { "confirm": true } } },
  "expectInputRequired": { "$partial": true, "elicitation/create": { "message": "Proceed with deploy?" } },
  "expect": { "content": [{ "type": "text", "text": "confirmed: deploy" }] }
}
```

Also: `setup` / `teardown`, `await` for long-running tasks, `budgetMs`, `tags`, `skip`,
`flaky`, per-case `server`, `$ref` fragments. Every key: [docs/CASES.md](./docs/CASES.md).

## Matchers

Matchers nest anywhere in an expectation. Several in one object must all pass.

| Matcher | Example | Asserts |
|---|---|---|
| `$partial` | `{"$partial": true, "isError": false}` | only the fields you name |
| `$regex` | `{"$regex": "^hel+o$", "flags": "i"}` | pattern match |
| `$wildcard` | `{"$wildcard": "req_*"}` | glob match |
| `$unordered` | `{"$unordered": true, "value": [1, 2]}` | array in any order |
| `$any` / `$ignore` | `{"$any": true}` | present / don't care |
| `$type` | `{"$type": ["string", "null"]}` | JSON type |
| `$schema` | `{"$schema": {"type": "string", "format": "date-time"}}` | inline JSON Schema |
| `$oneOf` | `{"$oneOf": ["queued", "running"]}` | any alternative |
| `$contains` | `{"$contains": {"type": "image"}, "count": 1}` | some element matches |
| `$length` / `$number` | `{"$length": {"min": 1}}` | sizes and ranges |
| `$ref` | `{"$ref": "./shared/user.json"}` | reuse a fragment |
| `$literal` | `{"$literal": {"$ref": "#/a"}}` | data that looks like a matcher |

`expectError` asserts that a call fails correctly:
`{"code": "InvalidParams", "message": {"$regex": "text"}}`. Full reference:
[docs/MATCHERS.md](./docs/MATCHERS.md).

## Manifest lock

`vib manifest record` snapshots `server/discover`, `tools/list`, `resources/list`,
`resources/templates/list`, and `prompts/list` into
`tests/integration/__manifest__.json`. From then on `vib run` diffs the live surface
against it and fails on added or removed tools, changed input or output schemas, changed
annotations, changed capabilities, and **changed descriptions**.

It is `package-lock.json` for your MCP surface. It also catches rug pulls: a tool
description that changes after review, the move behind tool-poisoning attacks, shows up
as a reviewed diff in git instead of a silent change. Each change is marked breaking or
not (a removed property or a newly required one is; a reworded description is drift, but
not breaking), with a word diff for prose. Accept intended changes with
`vib run --update-manifest` and commit the lock with the PR that caused them. One lock
serves both protocol eras; `requireManifest: true` makes a missing lock fail CI.

## Checks and fuzz

**`vib check`** runs offline checks over the manifest: `spec/*` sanity (known protocol
version, deterministic `tools/list`, cache hints, valid 2020-12 schemas, resolvable
`$ref`s) and `desc/*` lint for hidden instructions, invisible Unicode, tool shadowing,
credential paths, and exfiltration URLs in model-visible text. It is a smoke detector,
not a scanner. `vib run --check` folds it into CI. Ids and allow-listing:
[docs/CHECKS.md](./docs/CHECKS.md).

**`vib fuzz <tool>`** generates arguments from the tool's `inputSchema`: valid,
boundary, invalid, and (with `--inject`) prompt-injection payloads. It checks invariants
that need no golden: valid args never cause a protocol error, invalid args get
`InvalidParams`, the server never crashes. Seeded and reproducible;
`--record-failures` writes each counterexample as a case. See [docs/FUZZ.md](./docs/FUZZ.md).

## Reporters and CI

Reporters: `console` (default), `json` (`reports/results.json`), `junit`
(`reports/junit.xml`), `github` (annotations + job summary), `tap`. Use several at once.

```yaml
# .github/workflows/vibrissa.yml (vib init --ci writes this)
name: vibrissa
on:
  push:
    branches: [main]
  pull_request:
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build --if-present
      - run: npx vib run --profile ci
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: vibrissa-reports, path: reports/ }
```

**Delta gating:** `vib run --baseline reports/last-green.json` fails only on regressions
against a previous green run, so a known-broken case does not block unrelated PRs.
`--repeat 5` measures flake rates, `--shard 2/4` splits the suite across jobs, and every
failing case gets a JSON-RPC transcript under `reports/traces/`. Details:
[docs/CI.md](./docs/CI.md).

## Agents write great cases

JSON cases are the most generatable test format there is, and `record` keeps agents
honest. Start the agent with **`vib help cases`**: the whole case format, every matcher,
flows, MRTR, and tasks on one screen. Then the same loop you use:

1. `vib tools --json`: the agent reads the contract, schemas included.
2. `vib call <tool> --args '{...}' --json`: it probes behavior and edge cases.
3. `vib record ...`: real responses become goldens. No hallucinated envelopes, and
   timestamps, UUIDs, and values that change between calls are loosened to matchers
   automatically. (The stable check calls the tool twice; pass `--no-stable-check` for
   tools with side effects. Tools annotated destructive are called once.)
4. `vib tap -- node dist/index.js`: or record real client sessions and pick calls with
   `vib record --from-tap`.
5. `vib run --json --brief`: the agent verifies its own suite from one JSON report on
   stdout, listing only what failed.

Everything is built for that loop: `--json` always prints one object with `ok` (errors
too, as `{ "ok": false, "error": { "type", "code", "message", "hint" }, "next" }`), unknown
flags, tools, keys, matchers, and error codes all fail with a did-you-mean, and every
error message says what to do next.

The worst an agent can do is record a case you don't want, and that is a one-file JSON
review. `vib explain` paraphrases what each case asserts and flags weak assertions (a
bare `$partial`, `expectError: {}`, no expectation), for faster PR review.

Cases can also be emitted from a [`tdd-dsl`](https://github.com/Rosavera-I/tdd-dsl)
contract: `tdd-dsl emit --target vibrissa --out-dir tests/integration contract.tdd`.

## Configuration

`vibrissa.json` at the repo root (`vib init` creates it):

```json
{
  "$schema": "./node_modules/@jmoak/vibrissa/schema/vibrissa.schema.json",
  "servers": {
    "default": { "cmd": "node", "args": ["dist/index.js"] },
    "staging": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  },
  "defaultServer": "default",
  "globs": ["tests/integration/**/*.json"],
  "timeoutMs": 15000,
  "profiles": {
    "ci": { "reporters": ["console", "github", "junit", "json"], "check": true, "requireManifest": true },
    "legacy": { "servers": { "default": { "protocol": "legacy" } } }
  }
}
```

Precedence is defaults, then the file, then `--profile`, then CLI flags. Paths resolve
from the config file's directory. Zero matching cases fails the run unless `allowEmpty`.
Every key: [docs/CONFIG.md](./docs/CONFIG.md).

## Compatibility

v1 case files and v1 `vibrissa.json` (with `server`) load unchanged, and goldens
recorded against 2025 servers keep passing against 2026 servers because normalization
strips the new envelope fields. `vib migrate` rewrites old error-code names and the v1
`$schema` paths. See [docs/MIGRATION.md](./docs/MIGRATION.md).

## Library API

```ts
import { loadConfig, runCases } from '@jmoak/vibrissa'

const { options } = loadConfig(process.cwd(), { profile: 'ci' })
process.exitCode = await runCases(options) // 0 ok, 1 failures, 2 config error
```

The v1 call shape (`runCases({ server: { cmd, args }, globs })`) still works.
`new Runner(options).execute()` returns the full result instead of an exit code.

### Vitest bridge

Teams with an existing Vitest suite can run the contract suite inside it, gated on the same
things as `vib run`:

```ts
// tests/mcp.contract.test.ts
import { describeCases } from '@jmoak/vibrissa/vitest'

await describeCases({ profile: 'ci', checks: true })
```

It registers a manifest-lock test per server, a checks test (with `checks`), and one `it`
per case. A string argument is a case glob. Options (`config`, `profile`, `globs`,
`checks`, `lockManifest`, `title`, `api`, runner options): [docs/CI.md](./docs/CI.md#inside-a-vitest-suite).

Also exported: `McpSession`, `loadCases`, `executeCase`, `matchValue`,
`normalizeResult`, `diffManifest`, `createReporters`, `registerReporter`, `runChecks`,
`generateArgs`.

## Docs

| Doc | Covers |
|---|---|
| [CASES.md](./docs/CASES.md) | every case-file key, flows, MRTR, tasks, recipes |
| [MATCHERS.md](./docs/MATCHERS.md) | the assertion language |
| [CONFIG.md](./docs/CONFIG.md) | `vibrissa.json`, servers, profiles |
| [CLI.md](./docs/CLI.md) | every command and flag |
| [CI.md](./docs/CI.md) | GitHub Actions, JUnit, shards, baselines |
| [CHECKS.md](./docs/CHECKS.md) | `vib check` ids |
| [FUZZ.md](./docs/FUZZ.md) | `vib fuzz` generation and invariants |
| [MIGRATION.md](./docs/MIGRATION.md) | v1 to v2 |
| [FUTURE.md](./docs/FUTURE.md) | after 2.0 |

Contributing (humans and agents): [AGENTS.md](./AGENTS.md). Releasing:
[RELEASING.md](./RELEASING.md).

## License

[MIT](./LICENSE) © Jordan Moak
