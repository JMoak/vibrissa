# CLI reference

`vib` and `vib-test` are the same binary. With no command, `vib` runs `vib run`.
`vib --help` lists commands, `vib <command> --help` (or `vib help <command>`) shows one,
`vib help cases` prints a one-screen cheat sheet of the case format, and `vib --version`
prints the version.

Related: [CONFIG.md](./CONFIG.md) (what flags override), [CASES.md](./CASES.md) (what
`record` writes), [CI.md](./CI.md).

## Contents

| Group | Commands |
|---|---|
| Setup | [`init`](#vib-init), [`migrate`](#vib-migrate) |
| Explore | [`discover`](#vib-discover), [`tools`](#vib-tools), [`resources`](#vib-resources), [`prompts`](#vib-prompts) |
| Probe | [`call`](#vib-call), [`read`](#vib-read), [`get-prompt`](#vib-get-prompt) |
| Capture | [`record`](#vib-record), [`tap`](#vib-tap), [`manifest`](#vib-manifest) |
| Gate | [`run`](#vib-run), [`diff`](#vib-diff), [`explain`](#vib-explain) |
| Harden | [`check`](#vib-check), [`fuzz`](#vib-fuzz) |
| Wrappers | [`inspect`](#vib-inspect), [`conformance`](#vib-conformance) |
| Planned | [after 2.0](#planned) |

## Conventions

**Exit codes** (every command):

| Code | Meaning |
|---|---|
| `0` | OK |
| `1` | Failed: an assertion, a check, drift, a tool error, an empty selection |
| `2` | Usage, config, or connection error: an unknown flag or command, an invalid `vibrissa.json`, a server that would not start |

`tap`, `inspect`, and `conformance` exit with the wrapped process's code.

**Unknown flags are rejected** on every command, bare `vib` included, with a suggestion and
exit `2`: `Unknown option --tiemout for vib call. Did you mean --timeout?`. Value flags
accept `--flag value` and `--flag=value`.

**Connection flags** (every command that talks to a server):

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
| `--compact` | Single-line JSON even on a terminal |

**`--json`.** stdout carries exactly one JSON document: pretty-printed on a terminal,
single-line when piped (or with `--compact`). Every document has an `ok` field.

- Success: `{ "ok": true, ... }` with the command's fields (shapes below).
- A failed result keeps the command's own shape with `"ok": false` (for example a `call`
  that stopped at `input_required` carries `requests` and a `hint`).
- An error raised by the CLI (usage, config, connection) is always on stdout as
  `{ "ok": false, "error": { "type", "code", "message", "hint" }, "next": [...] }`:

```json
{"ok":false,"error":{"type":"UsageError","code":"unknown-tool","message":"Unknown tool \"nope\" on this server.","hint":"Available: echo, fail, confirm, slow, typed, sleep. Pass --expect-missing to send it anyway."},"next":["vib tools"]}
```

**`--brief`** (`run`, `check`, `fuzz`, `explain`): only what needs attention (failures,
warnings, drift). With `--json` it also drops passing entries and empty arrays.

**Server start diagnostics.** A server that cannot start fails fast (exit `2`) with the
reason and the first line of its stderr: a missing file
(`File not found: dist/index.js ... Run your build`), a command that is really a script
(`Did you mean "node server/index.js"?`), or a command not on `PATH`.

**Arguments** for `call`, `read`, `get-prompt`, and `record`:

| Flag | Meaning |
|---|---|
| `--args '<json>'` | Arguments as a JSON object |
| `--arg key=value` | One argument, repeatable. `true`, `false`, `null`, numbers, and JSON values are parsed; anything else is a string |
| `--expect-missing` | Skip the check that the tool, resource, or prompt is listed by the server (to probe unknown names) |

Without `--expect-missing`, an unlisted name fails with exit `2` and a did-you-mean
(`Unknown tool "ech" on this server. Did you mean "echo"?`).

**Input requests and tasks** (`call`, `record`; `read` and `get-prompt` take the first two):

| Flag | Meaning |
|---|---|
| `--respond '<json>'` | Scripted answers keyed by method: `'{"elicitation/create": {"action": "accept", "content": {...}}}'` (repeatable) |
| `--respond-key m=<json>` | One answer: `elicitation/create='{"action":"accept"}'` (repeatable) |
| `--await` | Tasks extension: poll `tasks/get` until the task finishes |
| `--await-timeout <ms>` | Give up polling after this long (implies `--await`; default 30000) |

---

## Setup

### `vib init`

```
vib init [--dir .] [--server "<cmd>"|<url>] [--from-claude-config [file]] [--no-call] [--force]
vib init --ci
```

Scaffolds a project:

- `vibrissa.json` with one server named `default`, the case globs, the manifest path, and a
  `ci` profile (`reporters: ["console", "github", "junit", "json"]`, `check: true`,
  `requireManifest: true`).
- **A real sample case.** If the server starts, the first suitable tool is called with
  minimal generated arguments and recorded (tools annotated read-only are preferred; tools
  annotated destructive are never called). Otherwise, or with `--no-call`, a skipped
  placeholder is written for you to edit.
- A skipped sample flow (`flow.sample.json`), `reports/` in `.gitignore`, and a
  `test:integration` npm script when there is a `package.json`.

| Flag | Meaning |
|---|---|
| `--dir <path>` | Target directory (default `.`) |
| `--server <cmd\|url>` | Server command line or URL (skips detection) |
| `--from-claude-config [file]` | Pre-fill servers from `.mcp.json`, else Claude Desktop's `claude_desktop_config.json`. Literal secrets in `env` / `headers` become `${VAR}` references |
| `--no-call` | Do not call a tool for the sample (write a skipped placeholder) |
| `--ci` | Write `.github/workflows/vibrissa.yml`, which runs `vib run --profile ci` ([CI.md](./CI.md#github-actions)). When `vibrissa.json` already exists, writes only the workflow |
| `--protocol <mode>` | Set `protocol` on the scaffolded server |
| `--timeout <ms>` | `timeoutMs` for the config (default 15000) |
| `--force` | Overwrite existing files |

Detection order: `package.json` (`bin`, `main`, `dist`), `pyproject.toml`
(`python -m <pkg>`), `go.mod` (`go run .`), else a guess of `node dist/index.js` with a note.
`--json`: `{ ok, dir, servers, defaultServer, source, files, sample, package, notes, next }`.

```bash
vib init
vib init --server "uv run my-server"
vib init --ci
```

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
- Leftover v1 keys that have no effect (`display`) are reported with what to do instead.

| Flag | Meaning |
|---|---|
| `--dry-run` | Show what would change; write nothing |
| `--manifest` | Also record the manifest lock (`vib manifest record`) |
| `--cases <glob>` | Case files to migrate (default: config globs) |
| `--force` | Rewrite files that contain comments (the comments are dropped) |

Files with comments are left alone without `--force` and reported as "needs manual edit".
Exit `1` when any file could not be migrated or the manifest could not be recorded. See
[MIGRATION.md](./MIGRATION.md).

## Explore

### `vib discover`

```
vib discover [--json]
```

Calls `server/discover` (2026-07-28) or reads the `initialize` result (2025 era) and prints
identity, negotiated protocol, supported versions, transport, capabilities, extensions,
and instructions.

`--json`:

```json
{
  "ok": true,
  "era": "modern",
  "protocolVersion": "2026-07-28",
  "supportedVersions": ["2026-07-28"],
  "serverInfo": { "name": "vibrissa-echo-fixture", "version": "2.0.0" },
  "capabilities": { "tools": {}, "resources": {}, "prompts": {}, "extensions": { "io.modelcontextprotocol/tasks": {} } },
  "extensions": ["io.modelcontextprotocol/tasks"],
  "instructions": "Fixture server for Vibrissa tests.",
  "synthesized": false,
  "transport": { "type": "stdio", "command": "node server/index.js" },
  "next": ["vib tools", "vib resources", "vib prompts", "vib check"]
}
```

`synthesized: true` means it was built from a legacy `initialize`.

### `vib tools`

```
vib tools [--json]
vib tools <name> [--json]
```

All tools with title, description, arguments, and annotation hints; or one tool in detail
(description, arguments, full `inputSchema` / `outputSchema`, annotations, and next
commands). `--expect-missing` skips the listed-name check for `<name>`.

`--json`: `{ "ok", "tools": ToolSummary[], "listMeta": { "tools": { "ttlMs", "cacheScope" } } }`;
with `<name>`: `{ "ok", "tool" }`.

```bash
vib tools echo
vib tools --json | jq ".tools[].name"
```

### `vib resources`

```
vib resources [--json]
```

Resources (URI, MIME type) and resource templates. `--json`:
`{ "ok", "resources", "resourceTemplates", "listMeta": { "resources", "resourceTemplates" } }`;
a list the server does not support has `listMeta.<list>.unsupported: true`.

### `vib prompts`

```
vib prompts [--json]
```

Prompts and their arguments. `--json`: `{ "ok", "prompts", "listMeta": { "prompts" } }`.

## Probe

### `vib call`

```
vib call <tool> [--args '{...}'] [--arg k=v] [--respond '{...}'] [--await] [--validate] [--raw]
```

Calls a tool once and prints the result **after** config `normalize`, which is exactly what
a golden would hold. `structuredContent` is always checked against the tool's
`outputSchema`: a violation is a warning (`vib run would fail this`), or a failure with
`--validate`.

| Flag | Meaning |
|---|---|
| `--validate` | Fail (exit 1) when `structuredContent` violates the `outputSchema` |
| `--raw` | Print the raw wire result (skip normalization) |
| `--expect-missing` | Call a tool the server does not list |

When the server asks for input and nothing answers, the request is printed with a
ready-to-paste `--respond`. When it answers with a task, the hint suggests `--await`.
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
`inputRequests` (every round), `task`, `validation`, `warnings`.

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

`resources/read`. With `--arg`, the positional is an RFC 6570 template expanded first. The
URI must be listed by `resources/list` or match a listed template (`--expect-missing`
skips that). `--json` has the same shape as `call` (`operation: "resource"` or
`"resourceTemplate"`, plus `uri` for templates).

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

Runs an operation live and writes it as a case file: the golden is reality.

- The tool, resource, or prompt must be listed by the server (did-you-mean otherwise;
  `--expect-missing` skips the check).
- Results go through config `normalize`, and matcher-looking keys in the data are wrapped
  in `$literal`, so the golden matches what `vib run` compares.
- **Volatile values are loosened by default**: ISO timestamps become
  `{"$schema": {"type": "string", "format": "date-time"}}`, UUIDs a `uuid` format,
  epoch-millisecond numbers `{"$type": "integer"}`, and text with an embedded timestamp a
  `$regex`. To catch values with no recognizable pattern, the operation is **run a second
  time** (the stable check) and anything that differs is loosened too. Read
  [Generated ids and timestamps](./CASES.md#generated-ids-and-timestamps).
- **Side effects:** the stable check calls the tool twice. Tools annotated
  `destructiveHint: true` are called once (with a note). For other tools with side effects
  (creating records, sending messages), pass `--no-stable-check`.
- A result whose `structuredContent` violates the tool's `outputSchema` is refused (exit 1):
  a golden must not bless a broken contract. `--allow-invalid-output` writes it anyway.
- Errors become `expectError` (code name plus message). Input requests become `respond`
  plus `expectInputRequired`; without `--respond` you are asked in a terminal, and
  non-interactive runs fail with the exact `--respond` to pass. A task answer records
  `expectTask` (re-record with `--await` for the final result).
- The default name is `<tool> <args>` (`echo text=hello`); the file name is its slug,
  deduplicated (`echo-text-hello.json`, `echo-text-hello-2.json`).
- Files go to the directory of the first positive config glob. If the target is outside
  the suite globs, record warns and reports `inSuite: false`.
- `--server <name>` (a non-default configured server) writes `"server": "<name>"` into the
  case.

| Flag | Meaning |
|---|---|
| `--resource <uri>` | Record `resources/read` |
| `--resource-template <tpl>` | Record a URI template read (expanded with `--arg`) |
| `--prompt <name>` | Record `prompts/get` |
| `--partial` | Wrap the expectation in `"$partial": true` |
| `--exact` | Keep every value verbatim (no loosening) |
| `--no-stable-check` | Do not repeat the call to find values that change between calls |
| `--allow-invalid-output` | Write the golden even if `structuredContent` violates the `outputSchema` |
| `--flow` | Record a multi-step flow from stdin |
| `--no-capture` | `--flow`: do not infer `{{captures}}` |
| `--from-tap <file>` | Turn calls captured by `vib tap` into cases |
| `--select <sel>` | `--from-tap`: which calls: 1-based index, range `2-5`, tool/prompt name or URI, `all` (repeatable, comma-separated) |
| `--out-dir <dir>` | `--from-tap`: where to write (default `<suite dir>/tap`) |
| `--out <path>` | Case file (default `<suite dir>/<name>.json`) |
| `--name <text>` | Case name (default `<tool> <args>`) |
| `--tag <tag>` | Add a tag (repeatable) |
| `--force` | Overwrite an existing case file |

**`--flow`** reads steps until an empty line. Each line is `<tool> {"json": "args"}`,
`<tool> key=value ...`, or an NDJSON object (`{"tool": ..., "args": ..., "respond": ...}`).
Server-minted ids that later steps reuse become `{{captures}}` automatically.

Exit `0` when a file was written. `--json`: `{ "ok", "path", "inSuite", "case", "notes"? }`.

```bash
vib record echo --arg text=hello
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
| `--out <file>` | Capture file (default `reports/tap/<timestamp>.ndjson`). Appended; `seq` continues from the existing file |
| `--quiet` | No status lines on stderr |
| `--env KEY=VALUE`, `--server-cwd <dir>` | For the server process |
| `--config`, `--server <name>`, `--profile` | Proxy a configured server instead of a command after `--` |

stdout is the protocol channel: `vib tap` prints status only to stderr and has no
`--json`. When the server exits without answering any call, it says
`nothing captured (no tools/call, resources/read or prompts/get answered)`. Put it in a
client config, e.g. `.mcp.json`:

```json
{ "mcpServers": { "my-server": { "command": "npx", "args": ["vib", "tap", "--", "node", "dist/index.js"] } } }
```

Then `vib record --from-tap reports/tap/<file>.ndjson --select all`.

### `vib manifest`

```
vib manifest record [--out <path>] [--server <name|cmd|url>] [--json]
vib manifest diff   [--out <path>] [--strict] [--json]
vib manifest show   [--json]
```

| Action | Does | Exit |
|---|---|---|
| `record` | Snapshot `server/discover` + `tools/list` + `resources/list` + `resources/templates/list` + `prompts/list` into the lock (config `manifest`, default `tests/integration/__manifest__.json`) | `0` |
| `diff` | Compare the live server with the lock | `0` same, `1` drift, `2` no lock |
| `show` | Print the live manifest, write nothing | `0` |

Every change is marked **breaking** or not. Breaking: a removed tool, resource, or prompt;
a removed or renamed input property; a newly required property or prompt argument; a type
change; removed enum values; a tightened `additionalProperties`; any `outputSchema` change;
a changed resource `mimeType`; a removed capability; a `protocolVersion` change.
Descriptions, titles, and annotations are not breaking (but still drift). The console
view has one line per changed sub-path, with a word diff for prose:

```
Manifest drift: 2 tools changed (echo: description, inputSchema.required; typed: inputSchema.properties.broken) (breaking)
  tools:
    ~ echo
        description: Echo text back, optionally [-uppercased.-]{+uppercased+}
        inputSchema.required: [] -> ["text"]  (breaking)
    ~ typed
        inputSchema.properties.broken: (absent) -> {"type":"boolean","description":"Return structuredContent that violates outputSchema"}
```

Servers other than `defaultServer` get a sibling lock: `__manifest__.<server>.json`.
`--out <path>` (relative to the shell cwd) picks another file. Paths in config
`manifestIgnore` (default `server.version`, `protocolVersion`, `listMeta`) are not compared,
so one lock serves both protocol eras; `--strict` compares everything.

`--json`: `record` prints `{ ok, path, server, created, changes?, manifest }`; `diff`
prints `{ ok, path, server, identical, summary, diff }`, where `diff` is
`{ identical, breaking, changes?, tools?: { added?, removed?, changed?: [{ key, breaking, fields: [{ path, before?, after?, breaking }] }] }, ... }`;
`show` prints `{ ok, server, manifest }`.

```bash
vib manifest record
vib manifest record --server staging
vib manifest diff --json
```

`vib run` performs the `diff` on every run. Accept drift there with `--update-manifest`.

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
| `--update` | Patch failing goldens with live output, leaf by leaf |
| `--update=all` | Also replace mismatched matchers with the literal live value |
| `--update-manifest` | Accept manifest drift (rewrite the lock, or create it) |
| `--check` | Also run spec-sanity and description checks (failed checks fail the run) |
| `--baseline <file>` | Fail only on regressions against a previous `results.json` |
| `--trace` | Write `reports/traces/<case>.ndjson` for every case (default: failures only) |
| `--reporter <names>` | `console`, `json`, `junit`, `github`, `tap` (repeatable, comma ok) |
| `--out-dir <dir>` | Directory for reports (default `reports/`) |
| `--fail-fast` | Stop after the first failing case |
| `--allow-empty` | Exit 0 when no cases match |
| `--brief` | Only failures, warnings, and drift |
| `--pretty` / `--no-pretty` | Force colors and glyphs on or off |

The run **fails** (exit `1`) when a case fails, the manifest drifted, a check failed (with
`--check`), a regression appeared (with `--baseline`), the lock is missing and
`requireManifest` is on, or the selection is empty (no glob match, or nothing left after
filters) without `--allow-empty`. A missing lock is otherwise a warning. A server that
cannot start fails its cases; an invalid server entry exits `2`. Lines on a stdio server's
stdout that are not JSON-RPC produce a warning (and fail `spec/stdout-clean` under
`--check`).

Files the globs match but that are not cases are skipped: manifest locks (the configured
path, per-server siblings, anything shaped like a lock) and `$ref` fragments (files
referenced from a case, or in a `shared/` or `fragments/` directory), with one `info:` line.

**`--update`** patches leaves, not files:

- Only the mismatched plain leaves of a failing `expect` take the live value. Subtrees that
  still match, matchers included, are kept as written. The file keeps its indent width,
  key order, and line endings.
- A mismatched matcher or `$ref` blocks the rewrite, and the reason names it. With
  `--update=all` it is replaced by the literal live value, with a warning saying what was
  replaced.
- Never rewritten: `expectError`, `expectInputRequired`, `expectTask`, leaves with
  `{{captures}}`, and files that contain comments. A failing case that was not rewritten
  reports why (`updateSkipped.reason` in JSON).
- Without `--update`, a failure says `Use --update to accept the new output.` only when
  `--update` would actually rewrite it; otherwise it says why not.
- Rewritten cases are reported as `updated`. `--repeat` is ignored while updating.

**`--json`** prints only the run report (the `results.json` document, shape in
[CI.md](./CI.md#delta-gating)) on stdout; stderr carries only `warning:` and `error:`
lines. `reports/results.json` is still written, and other reporters still run.

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
Both get a manifest snapshot and, unless `--manifest-only`, every case runs against both.
Results are compared through each case's matchers: a value the matcher accepts reads
`"<matches $type>"`, and `$partial` drops keys the case does not assert, so only real
contract differences show. A command-line `--against` runs in the base server's cwd and
env. Release-notes material and a migration check in one; it reports observations, not
pass/fail of the cases.

| Flag | Meaning |
|---|---|
| `--against <target>` | The other server: a configured name, a command line, or a URL |
| `--cases <glob>` | Cases to compare, relative to the shell cwd (default: config globs; repeatable) |
| `--manifest-only` | Compare only the manifests (no cases are run) |

Exit `1` when anything differs. `--json`:
`{ ok, identical, base, against, manifest: { identical, summary, diff }, cases: [{ id, name, same, base, against, diff? }], summary: { cases, different } }`.

```bash
vib diff --against "node ../v1/dist/index.js"
vib diff --against staging --manifest-only
```

### `vib explain`

```
vib explain                                   (every case in the configured suite)
vib explain <case.json | "case name" | "glob/**/*.json"> ... [--brief] [--full] [--json]
```

Paraphrases what cases do and assert, naming every matcher in plain words: what is called
with which args, what must equal, match, or be present, captures and placeholders,
scripted answers, task polling, budgets, `$ref` fragments inlined. Cases load exactly as
in `vib run`, so load errors are reported the same way. It needs no server.

It also **flags weak assertions**: `expectError: {}`, a bare root `{"$partial": true}`, no
expectation at all, `validateOutput: false`, `ignoreErrors` outside teardown, skipped
cases.

| Flag | Meaning |
|---|---|
| `--brief` | Only load errors and flags |
| `--full` | Show every assertion (default: the first 40 per expectation) |
| `--json` | `{ "ok", "summary": { "cases", "errors", "flagged" }, "cases": [{ "file", "name", "kind", "steps", "flags"?, "errors"? }] }` |

Exit `1` on load errors.

```
$ vib explain "weak"
weak  tests/integration/weak.json
  ! case: expect {"$partial": true} accepts any object result

  Calls tool "echo" with {"text":"x"}
    expects the result (after normalization):
      (root) is any object
```

## Harden

### `vib check`

```
vib check [--allow <id>] [--brief] [--verbose] [--json]
vib check --list
```

Offline, deterministic checks over the live manifest: `spec/*` sanity (including
`spec/stdout-clean` for stdio servers) and `desc/*` description lint. Every id is in
[CHECKS.md](./CHECKS.md). Configure with `checks.allow` and `checks.severity`
([CONFIG.md](./CONFIG.md#checks)).

| Flag | Meaning |
|---|---|
| `--allow <id>` | Skip a check: `id`, `prefix/*`, or `id:subject` (repeatable) |
| `--list` | List every check id with its default severity |
| `--brief` | Only failures and warnings |
| `--verbose` | List passed checks individually |

Exit `1` when any check failed; warnings never fail. `--json`:
`{ ok, server, protocolVersion, serverInfo, summary: { failed, warned, passed }, outcomes: [{ id, title, status, detail?, server }] }`.
`--list --json`: `{ checks: [{ id, title, severity }] }` (currently without `ok`).

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
golden. The output has one row per invariant (`n/a` when it does not apply, for example
`output-matches-output-schema` for a tool with no `outputSchema`) and groups failures by
root cause, with one example, its reproduce line, and the other case ids. Flags, the
`--json` shape, and generation details: [FUZZ.md](./FUZZ.md#cli).

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

Not in 2.0. Do not rely on these yet; see [FUTURE.md](./FUTURE.md).

| Command / flag | Intent |
|---|---|
| `vib show-trace <file>` | Pretty-print a transcript from `reports/traces/` |
| `vib run --watch` | Re-run affected cases on file changes |
| `vib run --perf` | p50 / p95 latency per tool in `reports/perf.json` |
| `vib gen` | Opt-in LLM proposals for a starter suite (every case still goes through `record`) |
| `vib evals` | Model-in-the-loop tool-selection evals, as the separate `@jmoak/vibrissa-evals` package |
