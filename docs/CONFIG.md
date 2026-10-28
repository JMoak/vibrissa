# Configuration (`vibrissa.json`)

One file configures which servers to test, where cases live, how results are normalized,
and how runs report. Every key is optional; with no file at all Vibrissa runs
`node dist/index.js` against `tests/integration/**/*.json`.

The schema is [`schema/vibrissa.schema.json`](../schema/vibrissa.schema.json). Descriptions
in the tables below are the schema's, word for word.

Related: [CASES.md](./CASES.md), [CLI.md](./CLI.md), [CI.md](./CI.md).

## Contents

- [Where config is read from](#where-config-is-read-from)
- [A complete example](#a-complete-example)
- [Precedence and merge rules](#precedence-and-merge-rules)
- [Key reference](#key-reference)
- [Servers](#servers): stdio, Streamable HTTP, [`protocol`](#protocol)
- [`defaultServer`](#defaultserver)
- [`globs`](#globs)
- [`normalize`](#normalize)
- [`manifest`](#manifest)
- [`checks`](#checks)
- [Reporters](#reporters)
- [Timeouts and budgets](#timeouts-and-budgets)
- [Run selection and policy](#run-selection-and-policy)
- [`hooks`](#hooks)
- [`profiles`](#profiles)
- [Environment interpolation](#environment-interpolation)
- [Validation and warnings](#validation-and-warnings)

## Where config is read from

1. `--config <path>` (absolute, or relative to the shell's working directory).
2. Otherwise, in the current directory: `vibrissa.json`, then `vibrissa.jsonc`, then the
   `vibrissa` key of `package.json`.

Comments and trailing commas are allowed in all of them. Relative paths in the file
(`globs`, `manifest`, `baseline`, a stdio `cwd`) resolve against **the config file's
directory**, not the shell's.

## A complete example

```json
{
  "$schema": "./node_modules/@jmoak/vibrissa/schema/vibrissa.schema.json",
  "servers": {
    "default": { "cmd": "node", "args": ["dist/index.js"], "protocol": "auto" },
    "staging": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  },
  "defaultServer": "default",
  "globs": ["tests/integration/**/*.json"],
  "manifest": "tests/integration/__manifest__.json",
  "normalize": { "stripMeta": ["io.modelcontextprotocol/*"], "dropKeys": ["resultType"] },
  "timeoutMs": 15000,
  "budgetMs": 2000,
  "reporters": ["console", "junit"],
  "profiles": {
    "ci": { "reporters": ["console", "github", "junit", "json"], "check": true, "requireManifest": true },
    "smoke": { "tags": ["smoke"], "failFast": true, "defaultServer": "staging" },
    "legacy": { "servers": { "default": { "protocol": "legacy" } } }
  }
}
```

`vib run` uses the base. `vib run --profile ci` merges `profiles.ci` over it.

## Precedence and merge rules

Lowest to highest: **built-in defaults, then this file, then the selected profile, then
CLI flags.**

| What | Rule |
|---|---|
| Scalars (`timeoutMs`, `failFast`, `check`, ...) | The higher layer replaces. |
| Lists (`globs`, `reporters`, `tags`, `excludeTags`, `manifestIgnore`) | The higher layer replaces the whole list. |
| `shard`, `hooks` | Replaced whole. |
| `normalize` | Merged key by key: defaults, file, profile, CLI. |
| `servers` | The file's map replaces the built-in default server. A profile patches entries by name (see [profiles](#profiles)). |
| `defaultServer` | CLI `--server <name>`, then profile, then file, then inferred. |
| `checks.allow` | Profile entries are appended to the file's (deduplicated). |
| `checks.severity` | Merged by check id; the profile wins. |

CLI flags that touch servers:

| Flag | Effect |
|---|---|
| `--server <name>` | Selects `servers.<name>` as the default server. |
| `--server https://...` | Replaces the selected server with that Streamable HTTP URL (keeps `protocol` and `spawnTimeoutMs`). |
| `--server "node dist/index.js"` | Replaces the selected server's command line (keeps `cwd` and `env`). |
| `--server-cwd <dir>` | Working directory for the selected stdio server. |
| `--env KEY=VALUE` | Merged into **every** stdio server's `env`. Repeatable. |
| `--protocol <mode>` | Applied to **every** server. |
| `--timeout <ms>` | Overrides `timeoutMs`. |

## Key reference

| Key | Type | Default | Description |
|---|---|---|---|
| `$schema` | string | none | Path or URL of this schema (for editor completion). |
| `server` | server | none | v1 shorthand for servers.default. |
| `servers` | object of servers | `{ "default": { "cmd": "node", "args": ["dist/index.js"] } }` | Named servers under test. Cases pick one with "server"; otherwise defaultServer is used. |
| `defaultServer` | string | `"default"`, or the only server | Key into servers used when a case names no server. Default: "default", or the only server. |
| `globs` | string or string[] | `["tests/integration/**/*.json"]` | Case file globs relative to the config file. Prefix with ! to exclude. Default ["tests/integration/**/*.json"]. |
| `manifest` | string | `"tests/integration/__manifest__.json"` | Manifest lock file path. Default "tests/integration/__manifest__.json". |
| `normalize` | object | see [normalize](#normalize) | Result envelope normalization applied before matching and recording. |
| `timeoutMs` | integer >= 0 | `15000` | Per-request timeout in ms. Default 15000. |
| `budgetMs` | integer >= 0 | none | Default latency budget per case/step in ms; slower fails. |
| `failFast` | boolean | `false` | Stop at the first failing case. Default false. |
| `allowEmpty` | boolean | `false` | If true, matching zero case files exits 0. Default false (fail loud). |
| `reporters` | string or string[] | `["console"]` | Reporters to run: console, json, junit, github, tap. Default ["console"]. `[]` runs no reporter at all. |
| `tags` | string[] | none | Run only cases carrying at least one of these tags. |
| `excludeTags` | string[] | none | Skip cases carrying any of these tags. |
| `grep` | string | none | Run only cases whose name matches this regular expression. |
| `repeat` | integer >= 1 | `1` | Run every case N times and report pass rates (flake detection). |
| `shard` | `"i/n"` or `{ "index", "total" }` | none | Run only one shard of the suite: "<index>/<total>" (1-based) or { "index", "total" }. |
| `concurrency` | integer >= 1 | `1` | Parallel workers (one server session each). Default 1. |
| `update` | boolean | `false` | Rewrite failing goldens from live output (like jest -u). |
| `trace` | boolean | `false` | Write JSON-RPC transcripts for every case, not only failures. |
| `check` | boolean | `false` | Also run spec-sanity checks and description lint. |
| `baseline` | string | none | Previous results file; fail only on regressions against it. |
| `hooks` | object | none | Suite-level steps run once per server session. |
| `profiles` | object | none | Named overlays merged over the base config with --profile <name>. |
| `checks` | object | none | Tuning for spec-sanity checks and description lint (vib check, vib run --check). Profiles extend allow and merge severity. |
| `manifestIgnore` | string[] | `["server.version", "protocolVersion", "listMeta"]` | Dotted manifest paths ignored when diffing against the lock (e.g. "tools.*.description"). Default ["server.version", "protocolVersion", "listMeta"]: release and protocol-era noise, so one lock serves both eras. `vib manifest diff --strict` compares everything. |
| `requireManifest` | boolean | `false` | Fail the run when a server's manifest lock file is missing (instead of warning). Turn it on in CI so an unrecorded surface cannot pass silently. Default false. |
| `outDir` | string | `"reports"` | Directory for reporter artifacts (junit.xml, results.json, traces/), relative to the config file. Default "reports". |

## Servers

> A server under test: { "cmd": ... } for stdio or { "url": ... } for Streamable HTTP.

Exactly one of the two.

### stdio

"A server spawned as a child process and spoken to over stdio."

| Key | Type | Description |
|---|---|---|
| `cmd` | string | Executable to spawn (stdio transport), e.g. "node". |
| `args` | string[] | Arguments passed to cmd. |
| `cwd` | string | Working directory for the server process, relative to the config file. |
| `env` | object of strings | Extra environment variables for the server process (merged over the current environment). |
| `protocol` | see [protocol](#protocol) | Protocol era negotiation. |
| `spawnTimeoutMs` | integer >= 0 | Max time (ms) to spawn/connect and finish the handshake. Default: timeoutMs clamped to 2000..10000. |

```json
{ "servers": { "default": { "cmd": "node", "args": ["dist/index.js"], "cwd": ".", "env": { "LOG_LEVEL": "warn" } } } }
```

Server stderr is captured per case and attached to failures and traces.

### Streamable HTTP

"A server reached over the Streamable HTTP transport."

| Key | Type | Description |
|---|---|---|
| `url` | string | Streamable HTTP endpoint, e.g. "https://mcp.example.com/mcp" (may use ${ENV} interpolation). |
| `headers` | object of strings | Static HTTP headers sent on every request, e.g. { "Authorization": "Bearer ${MCP_TOKEN}" }. |
| `protocol` | see [protocol](#protocol) | Protocol era negotiation. |
| `spawnTimeoutMs` | integer >= 0 | Max time (ms) to spawn/connect and finish the handshake. Default: timeoutMs clamped to 2000..10000. |

```json
{
  "servers": {
    "staging": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Auth is static headers only. For OAuth, obtain a token outside Vibrissa and pass it
through an environment variable. Interactive auth flows are MCP Inspector's job.

### `protocol`

> Protocol era negotiation. "auto" (default) probes server/discover and falls back to the
> 2025 initialize handshake; "legacy" forces the 2025 handshake; "modern" requires the
> 2026-07-28 era; a revision string or { "pin": "<revision>" } requires exactly that
> revision.

| Value | Behavior |
|---|---|
| `"auto"` (default) | Probe `server/discover`; on a 2025-era server, fall back to `initialize`. |
| `"legacy"` | 2025 `initialize` handshake only. |
| `"modern"` | Require 2026-07-28. Same as `{ "pin": "2026-07-28" }`. |
| `"2026-07-28"` | Pin to this revision, e.g. "2026-07-28". |
| `{ "pin": "2026-07-28" }` | Exact protocol revision to require, e.g. "2026-07-28". No fallback. |

Use `auto` unless you need to prove a server works on one era. A common pattern is a
`legacy` profile that reruns the same suite on the old handshake:

```json
{ "profiles": { "legacy": { "servers": { "default": { "protocol": "legacy" } } } } }
```

## `defaultServer`

Cases without a `server` key run against `defaultServer`. When it is unset, Vibrissa uses
the server named `default`, or the only server if there is just one. With several servers
and no `default`, the run fails with `Missing defaultServer` and tells you to set it or pass
`--server <name>`.

## `globs`

Case files to load, relative to the config file. `!` excludes. Quote globs on the command
line.

```json
{ "globs": ["tests/integration/**/*.json", "!tests/integration/**/*.wip.json"] }
```

Zero matching files fails the run (`allowEmpty: false`), because a silently empty suite
is a broken suite.

Matched files that are not cases are skipped, with one `info:` line: the manifest lock
(the configured path, its per-server siblings, and any file shaped like a lock) and `$ref`
fragments (a JSON file with no operation that a case references, or that lives in a
`shared/` or `fragments/` directory). No `!` exclusions are needed for them.

## `normalize`

"Result envelope normalization applied before matching and recording."

| Key | Type | Default | Description |
|---|---|---|---|
| `stripMeta` | string[] | `["io.modelcontextprotocol/*"]` | Glob-ish keys to strip from every _meta object. Default ["io.modelcontextprotocol/*"]. |
| `dropKeys` | string[] | `["resultType"]` | Top-level result keys to drop. Default ["resultType"]. |
| `ttlMs` | `"keep"` or `"ignore"` | `"ignore"` | Whether list results keep their ttlMs/cacheScope cache hints. Default "ignore". |

`*` matches any run of characters, including `/`. A `_meta` object emptied by `stripMeta`
is removed. Pass `[]` to turn a rule off. Cases can override per step, or opt out with
`"normalize": false` (see [CASES.md](./CASES.md#normalize)).

The defaults are why goldens recorded against a 2025 server keep passing against a 2026
server: the new `resultType` and `_meta["io.modelcontextprotocol/serverInfo"]` fields
never reach the matcher.

## `manifest`

Path of the manifest lock written by `vib manifest record` and checked by `vib run`.
Default `tests/integration/__manifest__.json`. The lock is a snapshot of the server's
surface (discover info, tools, resources, resource templates, prompts). A run fails when
the live surface drifts from it; `vib run --update-manifest` accepts the change. Without
a lock, `vib run` warns, or fails with [`requireManifest`](#requiremanifest). See
[CLI.md](./CLI.md#vib-manifest).

Each server is locked separately: `defaultServer` uses this path, every other server a
sibling file, `__manifest__.<server>.json`.

The lock may sit in the case directory; `vib run` never loads it as a case.

### `requireManifest`

> Fail the run when a server's manifest lock file is missing (instead of warning). Turn it
> on in CI so an unrecorded surface cannot pass silently. Default false.

The `ci` profile that `vib init` writes sets it.

### `manifestIgnore`

Dotted paths in the manifest that the drift check ignores. Default
`["server.version", "protocolVersion", "listMeta"]`: release and protocol-era noise, so a
version bump is not drift and one lock serves both protocol eras (a `legacy` profile runs
against the same lock). Set `[]`, or use `vib manifest diff --strict`, to compare
everything. Sections are keyed
by tool, prompt, or resource name/URI, and `*` matches any one key: `tools.*.annotations`,
`tools.echo.description`, `capabilities.experimental`, `listMeta` (the list cache hints).

```json
{ "manifestIgnore": ["server.version", "protocolVersion", "listMeta", "tools.*.annotations"] }
```

Ignoring `description` paths gives up rug-pull detection for those tools. Prefer
reviewing the diff.

`vib run`, `vib manifest diff`, and `vib diff` honor it. A profile's value replaces the
base list.

## `checks`

Tunes `vib check` and `vib run --check` (the `check` key turns the checks on for every run).
Check ids and their default severities are in [CHECKS.md](./CHECKS.md).

```json
{
  "checks": {
    "allow": ["desc/long-description", "desc/sensitive-paths:ssh.list_keys", "spec/server-identity"],
    "severity": { "desc/embedded-url": "failed" }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `allow` | string[] | Check ids to skip: an exact id, a family wildcard (`desc/*`), or `id:subject` for one tool, prompt, resource URI, template, or `instructions`. Allow-listed findings stay visible as "n finding(s) allow-listed". |
| `severity` | object | Per-check severity override: check id -> "failed" (fails the run) or "warned" (reported only). Informational notes ("not checked", "skipped") stay `warned`. |

In profiles, `checks.allow` is appended to the base list (duplicates dropped) and
`checks.severity` is merged by id. `vib check --allow <id>` adds to the list for one run.

## Reporters

`reporters` picks one or more of the built-ins (names are case-insensitive; a
comma-separated string also works):

| Name | Output |
|---|---|
| `console` | Human output on stdout (default). Plain ASCII when not a TTY or `NO_COLOR` is set. |
| `json` | `reports/results.json`: the machine-readable record, also the input for `baseline`. |
| `junit` | `reports/junit.xml` for GitHub, GitLab, and Jenkins test dashboards. |
| `github` | Workflow annotations plus a markdown job summary (`$GITHUB_STEP_SUMMARY`, else `reports/summary.md`). Annotations only inside GitHub Actions. |
| `tap` | TAP 14 on stdout. Do not combine with `console`, which also writes to stdout. |

`"reporters": []` runs none (useful from the library, or with `vib run --json`, which adds
its own JSON output).

Artifacts go to `reports/` under the config directory (`outDir` or `--out-dir` to move
them), and transcripts to `reports/traces/`. See [CI.md](./CI.md) for how to wire each
one into a pipeline.

## Timeouts and budgets

| Setting | Scope | Default | On breach |
|---|---|---|---|
| `timeoutMs` (config) | every request | 15000 | `RequestTimeout` error |
| `timeoutMs` (step) | one step | config value | `RequestTimeout` error |
| `spawnTimeoutMs` (server) | spawn + handshake | `timeoutMs` clamped to 2000..10000 | the run fails to start that server |
| `await.timeoutMs` (step) | task polling | 30000 | `RequestTimeout` error |
| `budgetMs` (config) | every case and step | none | failure with `errorKind: "budget"` |
| `budgetMs` (step) | one step | config value | failure with `errorKind: "budget"` |

A timeout means "no answer". A budget means "answered, but too slowly". Use budgets for
latency regressions and keep timeouts generous.

## Run selection and policy

| Key | Notes |
|---|---|
| `tags`, `excludeTags` | Match case `tags`. A case runs if it has any of `tags` and none of `excludeTags`. Case files that fail to load are never filtered out. |
| `grep` | A case-insensitive regular expression tested against each case's name and id (its file path). An invalid pattern is used as a plain substring. |
| `repeat` | Runs every case N times; reports pass rates. Non-flaky cases must pass every run. Cases with `flaky: true` are judged by pass rate. |
| `shard` | `"2/4"` runs cases 2, 6, 10, ... of the id-sorted selection (after tag and grep filters). Every case lands in exactly one shard; a flow is one case, so it is never split. |
| `concurrency` | Parallel workers, one server session each. Steps of a flow always share one session. |
| `failFast` | Stop at the first failing case. |
| `allowEmpty` | Exit 0 when no case matches. |
| `update` | Rewrite failing goldens from live output. Review the diff before committing. |
| `trace` | Write transcripts for every case (failures always get one). |
| `check` | Run [checks](#checks) as part of `vib run`. |
| `baseline` | A previous `results.json`. Only regressions against it fail (see [CI.md](./CI.md#delta-gating)). |

These usually come from flags or profiles rather than the base config.

## `hooks`

"Suite-level steps run once per server session."

| Key | Description |
|---|---|
| `setup` | Steps run before the first case (step shape: case.schema.json#/$defs/step). |
| `teardown` | Steps run after the last case, even on failure (step shape: case.schema.json#/$defs/step). |

```json
{
  "hooks": {
    "setup": [{ "tool": "echo", "args": { "text": "warm up" } }],
    "teardown": [{ "tool": "echo", "args": { "text": "bye" }, "ignoreErrors": true }]
  }
}
```

With `concurrency` above 1, hooks run once per worker session.

## `profiles`

"Named overlays merged over the base config with --profile <name>." A profile may contain
any config key except `profiles`.

Server entries in a profile **patch** the base by name:

> Profile override for a named server. Include cmd or url to replace the entry; otherwise
> the listed fields patch the base entry.

In detail:

- A patch with `cmd` or `url` replaces the whole entry.
- A patch without them changes only the listed fields. `env` and `headers` are replaced
  as a whole, not merged key by key.
- Fields that do not fit the transport are dropped (`args`, `cwd`, `env` on an HTTP server;
  `headers` on a stdio server).
- A name that is not in the base `servers` must define a server (`cmd` or `url`); a field
  patch for an unknown name is an error: `profile x patches unknown server 'nope'; servers
  are: default. Fix the name, or give it "cmd" / "url" to define a new server.`

```json
{
  "servers": { "default": { "cmd": "node", "args": ["dist/index.js"] } },
  "profiles": {
    "ci": { "reporters": ["console", "github", "junit", "json"], "check": true, "requireManifest": true },
    "smoke": { "tags": ["smoke"], "failFast": true },
    "debug": { "servers": { "default": { "env": { "DEBUG": "*" } } }, "trace": true },
    "built": { "servers": { "default": { "args": ["build/server.js"] } } }
  }
}
```

An unknown `--profile` fails and lists the profiles that exist.

## Environment interpolation

Every string in the file (keys are left alone) supports:

| Syntax | Result |
|---|---|
| `${NAME}` | The value of `NAME`. Unset or empty: `""` plus a warning naming the key. |
| `${NAME:-fallback}` | The value of `NAME`, or `fallback` when it is unset or empty. |
| `$${NAME}` | The literal text `${NAME}`. |

```json
{
  "servers": {
    "staging": {
      "url": "${MCP_URL:-https://staging.example.com/mcp}",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Interpolation happens when the config loads, for the base and the selected profile.
Case files use a different syntax, `{{env.NAME}}`, resolved at run time (see
[CASES.md](./CASES.md#capture-and-interpolation)).

## Validation and warnings

- A wrong type or value is an error that names the key and the fix, for example
  `Invalid config at servers.default: expected exactly one of "cmd" (stdio) or "url"
  (Streamable HTTP), got an object.`
- An unknown key is an error (exit `2`) with a did-you-mean, in the base and in profiles.
  Every problem in the file is reported at once:

  ```
  Invalid config (vibrissa.json): 2 problems:
    - Unknown config key at timeOutMs (vibrissa.json): did you mean "timeoutMs"? ...
    - Unknown config key at reporter (vibrissa.json): did you mean "reporters"? ...
  ```

- Warnings (for example an unset `${VAR}`) print on every command. Do not ignore them.
- Setting both `server` and `servers.default` warns; `servers.default` wins.
- Numbers or booleans in `env` and `headers` are converted to strings with a warning.
- The v1 key `display` is accepted and ignored (use `--pretty` / `--no-pretty`);
  `vib migrate` reports it.
