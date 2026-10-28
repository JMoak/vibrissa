# CLI reference

`vib` and `vib-test` are the same binary. With no command, `vib` runs `vib run`.
`vib --help` lists commands, `vib <command> --help` (or `vib help <command>`) shows one,
`vib --version` prints the version.

Related: [CONFIG.md](./CONFIG.md) (what flags override), [CASES.md](./CASES.md) (what
`record` writes), [CI.md](./CI.md).

## Contents

| Group | Commands |
|---|---|
| Explore | [`discover`](#vib-discover), [`tools`](#vib-tools), [`resources`](#vib-resources), [`prompts`](#vib-prompts) |
| Probe | [`call`](#vib-call), [`read`](#vib-read), [`get-prompt`](#vib-get-prompt) |
| Capture | [`record`](#vib-record), [`tap`](#vib-tap), [`manifest`](#vib-manifest), [`migrate`](#vib-migrate), [`init`](#vib-init) |
| Gate | [`run`](#vib-run), [`diff`](#vib-diff), [`explain`](#vib-explain) |
| Harden | [`check`](#vib-check), [`fuzz`](#vib-fuzz) |
| Wrappers | [`inspect`](#vib-inspect), [`conformance`](#vib-conformance) |
| Planned | [after 2.0](#planned) |

## Conventions

**Exit codes** (every command):

| Code | Meaning |
|---|---|
| `0` | OK |
| `1` | Failed: an assertion, a check, drift, a tool error |
| `2` | Usage, config, or connection error (bad flag, invalid `vibrissa.json`, server would not start) |

`tap`, `inspect`, and `conformance` exit with the wrapped process's code.

**Connection flags** (accepted by every command that talks to a server):

| Flag | Meaning |
|---|---|
| `--config <path>` | `vibrissa.json` / `.jsonc` / `package.json#vibrissa` |
| `--server <name\|cmd\|url>` | A server from config, a command line (`"node dist/index.js"`), or an http(s) URL |
| `--profile <name>` | Merge `profiles.<name>` over the config |
| `--protocol <mode>` | `auto` (default), `legacy`, `modern`, or a revision like `2026-07-28` |
| `--timeout <ms>` | Per-request timeout (also bounds spawn) |
| `--env KEY=VALUE` | Extra env var for stdio servers (repeatable) |
| `--server-cwd <dir>` | Working directory for a stdio server |
| `--json` | Machine-readable output: one JSON object on stdout |

Value flags accept `--flag value` and `--flag=value`. Unknown flags are rejected with a
suggestion (`Unknown option --tiemout for vib call. Did you mean --timeout?`).

**`--json`.** Human text and progress go to stderr; stdout carries exactly one JSON
document. On an error the document is
`{ "ok": false, "error": { "type": "ConfigError", "code": "spawn", "message": "..." } }`
(`code` only for server start failures). Every document has an `ok` field.

**Arguments** for `call`, `read`, `get-prompt`, and `record`:

| Flag | Meaning |
|---|---|
| `--args '<json>'` | Arguments as a JSON object |
| `--arg key=value` | One argument, repeatable. `true`, `false`, `null`, numbers, and JSON values are parsed; anything else is a string |

**Input requests and tasks** (`call`, `record`; `read` and `get-prompt` take the first two):

| Flag | Meaning |
|---|---|
| `--respond '<json>'` | Scripted answers keyed by method: `'{"elicitation/create": {"action": "accept", "content": {...}}}'` (repeatable) |
| `--respond-key m=<json>` | One answer: `elicitation/create='{"action":"accept"}'` (repeatable) |
| `--await` | Tasks extension: poll `tasks/get` until the task finishes |
| `--await-timeout <ms>` | Give up polling after this long (implies `--await`; default 30000) |

---

## Explore

### `vib discover`

```
vib discover [--json]
```

Calls `server/discover` (2026-07-28) or reads the `initialize` result (2025 era) and prints
identity, negotiated protocol, supported versions, transport, capabilities, extensions,
and instructions.

`--json`: the `DiscoverInfo` object:

```json
{
  "era": "modern",
  "protocolVersion": "2026-07-28",
  "supportedVersions": ["2026-07-28"],
  "serverInfo": { "name": "vibrissa-echo-fixture", "version": "2.0.0" },
  "capabilities": { "tools": {}, "resources": {}, "prompts": {}, "extensions": { "io.modelcontextprotocol/tasks": {} } },
  "extensions": ["io.modelcontextprotocol/tasks"],
  "instructions": "Fixture server for Vibrissa tests.",
  "synthesized": false,
  "raw": {}
}
```

`synthesized: true` means it was built from a legacy `initialize`. `raw` is the wire result.

```bash
vib discover --protocol legacy
```

### `vib tools`

```
vib tools [--json]
```

Tools with title, description, arguments (from `inputSchema`), and annotation hints.

`--json`: `{ "tools": ToolSummary[], "listMeta": { "tools": { "ttlMs", "cacheScope" } } }`.
Each `ToolSummary` has `name`, `title`, `description`, `inputSchema`, `outputSchema`,
`annotations` (when the server sent them).

```bash
vib tools --json | jq ".tools[].name"
```

### `vib resources`

```
vib resources [--json]
```

Resources (URI, MIME type) and resource templates.

`--json`: `{ "resources": [...], "resourceTemplates": [...], "listMeta": { "resources", "resourceTemplates" } }`.
A list the server does not support has `listMeta.<list>.unsupported: true`.

### `vib prompts`

```
vib prompts [--json]
```

Prompts and their arguments. `--json`: `{ "prompts": [...], "listMeta": { "prompts" } }`.

## Probe

### `vib call`

```
vib call <tool> [--args '{...}'] [--arg k=v] [--respond '{...}'] [--await] [--validate] [--raw]
```

Calls a tool once and prints the result **after** config `normalize`, which is exactly what
a golden would hold.

| Flag | Meaning |
|---|---|
| `--validate` | Validate `structuredContent` against the tool's `outputSchema` and print a verdict |
| `--raw` | Print the raw wire result (skip normalization) |

When the server asks for input and nothing answers, the request is printed with a
ready-to-paste `--respond` value. When it answers with a task, the hint suggests `--await`.

Exit `1` on an error, an unanswered input request, or a failed `--validate`.

`--json`:

```json
{
  "ok": true,
  "operation": "tool",
  "method": "tools/call",
  "target": "echo",
  "args": { "text": "hello" },
  "kind": "result",
  "durationMs": 4,
  "normalized": true,
  "result": { "content": [{ "type": "text", "text": "hello" }] }
}
```

`kind` is `result`, `error` (with `error: { kind, code, codeName, message, data }`), or
`input_required` (with `requests` and a `hint`). Also present when relevant:
`inputRequests` (every round), `task`, `validation`.

```bash
vib call confirm --arg action=deploy \
  --respond '{"elicitation/create": {"action": "accept", "content": {"confirm": true}}}'
vib call slow --arg ms=50 --await --json
```

### `vib read`

```
vib read <uri> [--raw]
vib read '<uri-template>' --arg key=value
```

`resources/read`. With `--arg`, the positional is an RFC 6570 template expanded first.
`--json` has the same shape as `call` (`operation: "resource"` or `"resourceTemplate"`,
plus `uri` for templates).

```bash
vib read fixture://readme
vib read 'fixture://users/{id}' --arg id=42 --json
```

### `vib get-prompt`

```
vib get-prompt <name> [--args '{...}'] [--arg key=value] [--raw]
```

`prompts/get`. Prompt arguments are strings on the wire; non-string `--arg` values are
sent as JSON text. `--json` as for `call` (`operation: "prompt"`).

```bash
vib get-prompt greet --arg name=Ada --arg style=terse
```

## Capture

### `vib record`

```
vib record <tool> [--arg k=v] [--respond ...] [--await] [--partial]
vib record --resource <uri> | --resource-template <tpl> --arg k=v | --prompt <name> --arg k=v
vib record --flow [--name "..."]          (stdin: one step per line)
vib record --from-tap <file> [--select <n|name|all>]
```

Runs an operation live and writes it as a case file: the golden is reality. Results go
through config `normalize`, and matcher-looking keys in the data are wrapped in
`$literal`, so the golden matches what `vib run` compares. Errors become `expectError`
(code name plus message). Input requests become `respond` plus `expectInputRequired`;
without `--respond` you are asked in a terminal, and non-interactive runs fail with the
exact `--respond` to pass.

| Flag | Meaning |
|---|---|
| `--resource <uri>` | Record `resources/read` |
| `--resource-template <tpl>` | Record a URI template read (expanded with `--arg`) |
| `--prompt <name>` | Record `prompts/get` |
| `--partial` | Wrap the expectation in `"$partial": true` |
| `--flow` | Record a multi-step flow from stdin |
| `--no-capture` | `--flow`: do not infer `{{captures}}` |
| `--from-tap <file>` | Turn calls captured by `vib tap` into cases |
| `--select <sel>` | `--from-tap`: which calls: 1-based index, range `2-5`, tool/prompt name or URI, `all` (repeatable, comma-separated) |
| `--out-dir <dir>` | `--from-tap`: where to write (default `tests/integration/tap`) |
| `--out <path>` | Case file (default `tests/integration/<name>.json`) |
| `--name <text>` | Case name |
| `--tag <tag>` | Add a tag (repeatable) |
| `--force` | Overwrite an existing case file |

**`--flow`** reads steps until an empty line. Each line is `<tool> {"json": "args"}`,
`<tool> key=value ...`, or an NDJSON object (`{"tool": ..., "args": ..., "respond": ...}`).
Server-minted ids that later steps reuse become `{{captures}}` automatically.

Exit `0` when a file was written, `1` otherwise. `--json`:
`{ "ok": true, "path": "...", "case": { ... }, "notes": [] }`.

```bash
vib record echo --arg text=hello --name "echo hello"
vib record --resource fixture://readme
printf '%s\n' 'typed {"a": 2, "b": 3}' 'echo text=done' '' | vib record --flow --name "sum then echo"
```

### `vib tap`

```
vib tap [--out reports/tap/<ts>.ndjson] [--quiet] -- <server command...>
vib tap [--server <name>]          (proxy the configured stdio server)
```

A transparent stdio proxy between a real client and your server. Bytes pass through
unchanged. Each `tools/call`, `resources/read`, and `prompts/get` (plus initialize,
discover, list, and tasks context, and 2025-era server requests) is appended to the
capture as one NDJSON line:

```json
{ "ts": "2026-10-28T12:00:00.000Z", "seq": 4, "from": "client", "method": "tools/call", "id": 7, "params": { "name": "echo", "arguments": { "text": "hi" } }, "result": { "content": [{ "type": "text", "text": "hi" }] }, "durationMs": 12 }
```

| Flag | Meaning |
|---|---|
| `--out <file>` | Capture file (default `reports/tap/<timestamp>.ndjson`; appended) |
| `--quiet` | No status lines on stderr |
| `--env KEY=VALUE`, `--server-cwd <dir>` | For the server process |
| `--config`, `--server <name>`, `--profile` | Proxy a configured server instead of a command after `--` |

stdout is the protocol channel: `vib tap` prints status only to stderr and has no
`--json`. Put it in a client config, e.g. `.mcp.json`:

```json
{ "mcpServers": { "my-server": { "command": "npx", "args": ["vib", "tap", "--", "node", "dist/index.js"] } } }
```

Then `vib record --from-tap reports/tap/<file>.ndjson --select all`.

### `vib manifest`

```
vib manifest record [--out <path>] [--json]
vib manifest diff   [--out <path>] [--json]
vib manifest show   [--json]
```

| Action | Does | Exit |
|---|---|---|
| `record` | Snapshot `server/discover` + `tools/list` + `resources/list` + `resources/templates/list` + `prompts/list` into the lock (config `manifest`, default `tests/integration/__manifest__.json`) | `0` |
| `diff` | Compare the live server with the lock: added/removed items, schema, description and annotation changes, capabilities | `0` same, `1` drift, `2` no lock |
| `show` | Print the live manifest, write nothing | `0` |

Servers other than `defaultServer` get a sibling lock: `__manifest__.<server>.json`.
`--out <path>` (relative to the shell cwd) picks another file. `server.version` is ignored
by the diff by default, so a version bump alone is not drift.

`--json`: `record` prints `{ ok, path, server, created, changes?, manifest }`; `diff`
prints `{ ok, path, server, identical, summary, diff }`; `show` prints the manifest.

```bash
vib manifest record
vib manifest record --server staging
vib manifest diff --json
```

`vib run` performs the `diff` on every run. Accept drift there with `--update-manifest`.

### `vib migrate`

```
vib migrate [--dry-run] [--manifest] [--cases <glob>] [--force]
```

Rewrites v1 config and case files to v2 in place. Idempotent.

- Config: `server` becomes `servers.default` plus `defaultServer` (also inside profiles).
- Config and cases: `$schema` added, or fixed to point at `@jmoak/vibrissa`.
- Cases: `expectError.code` aliases renamed (`RequestTimedOut` to `RequestTimeout`, ...),
  and v1 numeric codes named (`-32000` to `ConnectionClosed`, `-32001` to `RequestTimeout`,
  `-32002` to `ResourceNotFound`).

| Flag | Meaning |
|---|---|
| `--dry-run` | Show what would change; write nothing |
| `--manifest` | Also record the manifest lock (`vib manifest record`) |
| `--cases <glob>` | Case files to migrate (default: config globs) |
| `--force` | Rewrite files that contain comments (the comments are dropped) |

Files with comments are left alone without `--force`. Exit `1` when a file was left alone
for that reason, or the manifest could not be recorded. See [MIGRATION.md](./MIGRATION.md).

```bash
vib migrate --dry-run
vib migrate --manifest
```

### `vib init`

```
vib init [--dir .] [--server "<cmd>"|<url>] [--from-claude-config [file]] [--ci] [--force]
```

Scaffolds `vibrissa.json` (a `servers` map, case globs that exclude the manifest, and a
`ci` profile), `tests/integration/echo.basic.json`, a skipped sample flow, and a
`test:integration` npm script.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Target directory (default `.`) |
| `--server <cmd\|url>` | Server command line or URL (skips detection) |
| `--from-claude-config [file]` | Pre-fill servers from `.mcp.json`, else Claude Desktop's `claude_desktop_config.json`. Literal secrets in `env` / `headers` become `${VAR}` references |
| `--ci` | Also write `.github/workflows/vibrissa.yml`, which runs `vib run --profile ci --check --reporter console,github,junit,json` (see [CI.md](./CI.md#github-actions)) |
| `--protocol <mode>` | Set `protocol` on the scaffolded servers |
| `--timeout <ms>` | `timeoutMs` for the config (default 15000) |
| `--force` | Overwrite existing files |
| `--json` | Machine-readable output |

Detection order: `package.json` (`bin`, `main`, `dist`), `pyproject.toml`
(`python -m <pkg>`), `go.mod` (`go run .`).

```bash
vib init --from-claude-config --ci
vib init --server "uv run my-server"
```

## Gate

### `vib run`

```
vib run [options]
```

Runs every case, verifies the manifest lock, and (with `--check`) runs `vib check`,
reporting through the chosen reporters.

| Flag | Meaning |
|---|---|
| `--cases <glob>` | Case glob, relative to the shell cwd (repeatable; `!` excludes). Replaces config `globs` |
| `--tag <t>` | Only cases with this tag (repeatable, comma ok) |
| `--exclude-tag <t>` | Skip cases with this tag (repeatable, comma ok) |
| `--grep <pattern>` | Only cases whose name or file matches (regex, case-insensitive) |
| `--shard <i/n>` | Run shard i of n (stable split by case id) |
| `--repeat <n>` | Run every case n times; report pass rates (`flaky: true` gets a floor of 0.5) |
| `--concurrency <n>` | Workers per server, one session each (flows never split) |
| `--update` | Rewrite failing plain goldens from live output |
| `--update=all` | Also replace goldens that contain matchers with the literal output |
| `--update-manifest` | Accept manifest drift (rewrite the lock, or create it) |
| `--check` | Also run spec-sanity and description checks (failed checks fail the run) |
| `--baseline <file>` | Fail only on regressions against a previous `results.json` |
| `--trace` | Write `reports/traces/<case>.ndjson` for every case (default: failures only) |
| `--reporter <names>` | `console`, `json`, `junit`, `github`, `tap` (repeatable, comma ok) |
| `--out-dir <dir>` | Directory for reports (default `reports/`) |
| `--fail-fast` | Stop after the first failing case |
| `--allow-empty` | Exit 0 when no cases match |
| `--pretty` / `--no-pretty` | Force colors and glyphs on or off |

The run **fails** (exit `1`) when a case fails, the manifest drifted, a check failed (with
`--check`), or (with `--baseline`) a regression appeared. A missing manifest lock is a
warning. Zero matching cases fails unless `--allow-empty`. A server that cannot start fails
its cases; an invalid server entry exits `2`.

`--update` notes:

- It rewrites only plain goldens. An `expect` with matchers is left alone (it prints why)
  unless you pass `--update=all`. Never rewritten: `expectError`, an `expect` with
  `{{captures}}`, and files that contain comments. Key order, indentation, and line
  endings are kept.
- Rewritten cases are reported as `updated`. `--repeat` is ignored while updating.
- Review the diff before committing, as with `jest -u`.

`--json` prints the run report (the `results.json` document, shape in
[CI.md](./CI.md#delta-gating)) as the one JSON object on stdout. Console output moves to
stderr, other reporters still run, and `reports/results.json` is still written.

```bash
vib run
vib run --profile ci
vib run --tag smoke --fail-fast
vib run --repeat 5 --concurrency 2
vib run --baseline reports/last-green.json --reporter console,json
```

### `vib diff`

```
vib diff --against "<cmd | url | server name>" [--cases <glob>] [--manifest-only] [--json]
```

A contract diff between two servers. The base is the configured default (or `--server`).
Both get a manifest snapshot and, unless `--manifest-only`, every case runs against both;
normalized results are compared. A command-line `--against` runs in the base server's cwd
and env. Release-notes material and a migration check in one.

| Flag | Meaning |
|---|---|
| `--against <target>` | The other server: a configured name, a command line, or a URL |
| `--cases <glob>` | Cases to compare (default: config globs; repeatable) |
| `--manifest-only` | Compare only the manifests |

Exit `1` when anything differs. `--json`:
`{ ok, identical, base, against, manifest: { identical, summary, diff }, cases: [{ id, name, same, base, against, diff? }], summary: { cases, different } }`.

```bash
vib diff --against "node ../v1/dist/index.js"
vib diff --against staging --manifest-only
```

### `vib explain`

```
vib explain <case.json> [more files or "globs/**/*.json"] [--full] [--json]
```

Paraphrases what case files do and assert, naming every matcher in plain words: what is
called with which args, what must equal, match, or be present, captures and placeholders,
scripted answers, task polling, budgets. Built for reviewing agent-written suites. Needs
no server.

| Flag | Meaning |
|---|---|
| `--full` | Show every assertion (default: the first 40 per expectation) |
| `--json` | `{ "ok", "cases": [{ "file", "name", "kind", "tags", "steps": [...] }] }` |

Exit `1` when a file does not load.

```
$ vib explain tests/integration/sum-flow.json
sum flows into echo  tests/integration/sum-flow.json
  flow of 2 steps

  Step 1: Calls tool "typed" with {"a":2,"b":3}
    then captures {{sum}} = structuredContent.sum
    asserts only that the call succeeds

  Step 2: Calls tool "echo" with {"text":"sum is {{sum}}"}
    uses captured {{sum}}
    expects the result (after normalization):
      (root) is an object with exactly: content
        content has exactly 1 item, in this order
          content[0] is an object with exactly: type, text
            content[0].type equals "text"
            content[0].text equals "sum is 5"
```

## Harden

### `vib check`

```
vib check [--allow <id>] [--verbose] [--json]
vib check --list
```

Offline, deterministic checks over the live manifest: `spec/*` sanity and `desc/*`
description lint. Every id is in [CHECKS.md](./CHECKS.md). Configure with `checks.allow`
and `checks.severity` ([CONFIG.md](./CONFIG.md#checks)).

| Flag | Meaning |
|---|---|
| `--allow <id>` | Skip a check: `id`, `prefix/*`, or `id:subject` (repeatable) |
| `--list` | List every check id with its default severity |
| `--verbose` | List passed checks individually |

Exit `1` when any check failed; warnings never fail. `--json`:
`{ ok, server, protocolVersion, serverInfo, summary: { failed, warned, passed }, outcomes: [{ id, title, status, detail?, server }] }`.
`--list --json`: `{ checks: [{ id, title, severity }] }`.

```bash
vib check
vib check --allow desc/long-description --json
```

### `vib fuzz`

```
vib fuzz <tool> [--runs 100] [--seed S] [--strategy s] [--inject] [--budget ms] [--record-failures]
vib fuzz <tool> --seed S --runs N --id <case-id>      (reproduce one case)
```

Generates arguments from the tool's `inputSchema` and checks invariants that need no
golden. Strategies: `valid`, `boundary`, `invalid` (the default set) and `inject`. If the
server crashes it is restarted and fuzzing continues; afterwards the server must be alive
with `tools/list` unchanged. Generation and invariants: [FUZZ.md](./FUZZ.md).

| Flag | Meaning |
|---|---|
| `--runs <n>` | Cases to generate (default 100) |
| `--seed <n\|text>` | Seed (default: the tool name); printed in every reproduce line |
| `--strategy <s>` | `valid`, `boundary`, `invalid`, `inject` (repeatable or comma-separated) |
| `--inject` | Add the `inject` strategy |
| `--budget <ms>` | Also fail calls slower than this |
| `--strict-invalid` | Invalid args must get JSON-RPC `InvalidParams`; a tool error fails |
| `--id <case-id>` | Run a single case (same `--seed` / `--runs` as the report) |
| `--record-failures` | Write each failing case to `tests/integration/fuzz/<tool>-<id>.json` |
| `--out-dir <dir>` | Where `--record-failures` writes |

Exit `1` when an error-level invariant failed. `--json`:
`{ ok, tool, server, seed, runs, strategies, generated, durationMs, restarts, schemaWarnings, invariants: [{ id, title, level, passed, failed, skipped }], runChecks, failures: [...], cases: [...], recorded: [...], reproduce }`.

```bash
vib fuzz echo --runs 200
vib fuzz echo --inject --record-failures
vib fuzz echo --seed echo --runs 100 --id invalid-3f9a1c2b7e
```

## Wrappers

### `vib inspect`

```
vib inspect [--cli] [-- extra inspector args]
```

Opens [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) on the
configured stdio server with its command, args, cwd, and env, so nothing is typed twice.
For an HTTP server it prints the URL to connect to in the Inspector UI (add the configured
headers there). `--cli` uses Inspector's CLI mode. Arguments after `--` go to Inspector.

### `vib conformance`

```
vib conformance [--server <url|name>] [-- extra conformance args]
```

Runs the official `@modelcontextprotocol/conformance` suite against an HTTP server
(`npx @modelcontextprotocol/conformance server --url <url>`). The official suite is
HTTP-first; for stdio servers use `vib check`, the deterministic subset.

## Planned

Not in 2.0. Do not rely on these flags yet; see [FUTURE.md](./FUTURE.md).

| Command / flag | Intent |
|---|---|
| `vib show-trace <file>` | Pretty-print a transcript from `reports/traces/` |
| `vib run --watch` | Re-run affected cases on file changes |
| `vib run --perf` | p50 / p95 latency per tool in `reports/perf.json` |
| `vib gen` | Opt-in LLM proposals for a starter suite (every case still goes through `record`) |
| `vib evals` | Model-in-the-loop tool-selection evals, as the separate `@jmoak/vibrissa-evals` package |
