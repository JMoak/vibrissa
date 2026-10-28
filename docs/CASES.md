# Case files

A case file is one JSON document describing one test: an MCP operation, the arguments to
send, and what must come back. The whole suite is data. This page lists every key.
The schema is [`schema/case.schema.json`](../schema/case.schema.json); add its path as
`$schema` for editor completion.

Related: [MATCHERS.md](./MATCHERS.md) (the assertion language),
[CONFIG.md](./CONFIG.md) (`vibrissa.json`), [CLI.md](./CLI.md) (`vib record` writes these
files for you).

Every example on this page runs against the fixture server in
[`tests/fixtures/echo-server/`](../tests/fixtures/echo-server/) (tools `echo`, `fail`,
`confirm`, `slow`, `typed`, `sleep`; resources `fixture://readme` and
`fixture://users/{id}`; prompt `greet`), except the handle recipe (it needs a stateful
server) and the `staging` example (it needs a second configured server). The fixture's
own suite in `cases/` is a good second reference.

## Contents

- [The smallest case](#the-smallest-case)
- [How a case runs](#how-a-case-runs)
- [Key reference](#key-reference)
- [Operations](#operations): `tool`, `resource`, `resourceTemplate`, `prompt`, `args`
- [Expectations](#expectations): `expect`, `expectError`, `validateOutput`, `normalize`
- [Flows](#flows): `steps`, `setup`, `teardown`, `ignoreErrors`
- [Capture and interpolation](#capture-and-interpolation)
- [Input requests (MRTR)](#input-requests-mrtr): `respond`, `expectInputRequired`
- [Tasks](#tasks): `await`, `expectTask`
- [Selection and policy](#selection-and-policy): `tags`, `skip`, `flaky`, `budgetMs`, `timeoutMs`, `server`
- [Fragments with `$ref`](#fragments-with-ref)
- [Error codes](#error-codes)
- [Recipes](#recipes)

## The smallest case

`tests/integration/echo.basic.json`:

```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": { "content": [{ "type": "text", "text": "hello" }] }
}
```

This is the v1 shape, and it is still the most common one. Every v1 case file is a valid
v2 case file.

One file holds one case. Put cases anywhere the config `globs` match (default
`tests/integration/**/*.json`). JSON files under the globs that are not cases are skipped
automatically: the manifest lock (and anything shaped like one), and `$ref` fragments
(files a case references, or files in a `shared/` or `fragments/` directory).

## How a case runs

For a single-operation case, and for each step of a flow:

1. **Interpolate** `{{capture}}` and `{{env.NAME}}` placeholders in `args` and `expect`.
2. **Call** the operation (`tools/call`, `resources/read`, or `prompts/get`) on the case's
   server session. Calling a tool the server does not list fails with a did-you-mean.
   Tool `args` that do not match the tool's `inputSchema` produce a warning (a likely
   authoring mistake), unless the step has `expectError`.
3. **Answer input requests.** If the server returns `input_required`, answer from
   `respond` and retry until the call completes. An unanswered request fails the step and
   prints the request.
4. **Poll tasks.** If `await` is set and the server returned a task, poll `tasks/get`
   until the task is terminal.
5. **Normalize** the result (strip `resultType`, `_meta["io.modelcontextprotocol/*"]`,
   list cache hints; see [`normalize`](#normalize)).
6. **Validate output.** When the tool declares an `outputSchema`, `structuredContent`
   must validate against it (unless `validateOutput: false`).
7. **Match** `expect` / `expectError`, `expectInputRequired`, and `expectTask`.
8. **Capture** values for later steps.
9. **Check the budget** (`budgetMs`).

A flow runs `setup`, then `steps` in order, then `teardown`, all on one server session.
Teardown runs even when a step failed.

## Key reference

"Case" keys are valid only at the top level. "Step" keys are valid at the top level and
inside `steps`, `setup`, and `teardown`. The description column is the schema's
description, word for word.

| Key | Type | Default | Where | Description |
|---|---|---|---|---|
| `$schema` | string | none | case | Path or URL of this schema (for editor completion). |
| `name` | string | file name without `.json` | step | Human-readable name shown in reports. |
| `tool` | string | none | step | Tool to call (tools/call). |
| `resource` | string | none | step | Resource URI to read (resources/read). |
| `resourceTemplate` | string | none | step | RFC 6570 URI template, expanded with args, then read (resources/read). |
| `prompt` | string | none | step | Prompt to get (prompts/get). |
| `args` | object | `{}` | step | Tool arguments, template variables, or prompt arguments. Strings may use {{capture}} and {{env.NAME}}. |
| `expect` | any JSON | none | step | Expected (normalized) result. Exact match by default; matchers start with $ ($partial, $regex, $wildcard, $unordered, $any, $type, ...). |
| `expectError` | object | none | step | Expect the operation to fail (protocol error or tool isError result). |
| `expectError.code` | string or integer | none | step | Error code name (InvalidParams, MethodNotFound, ResourceNotFound, RequestTimeout, UnsupportedProtocolVersion, ...) or numeric JSON-RPC code. |
| `expectError.message` | string or `{ "$regex", "flags" }` | none | step | Exact error message, or { "$regex": "...", "flags": "i" }. |
| `respond` | object | none | step | Scripted answers for server input requests (MRTR input_required rounds or legacy server requests), keyed by method: "elicitation/create", "sampling/createMessage", "roots/list". Values are the bare result, e.g. { "action": "accept", "content": { ... } }. |
| `expectInputRequired` | any JSON | none | step | Matcher over the InputRequests map(s) the server sent before completing. |
| `expectTask` | any JSON | none | step | Matcher over the CreateTaskResult when the server answers with a task (tasks extension). |
| `await` | boolean or object | off | step | Tasks extension: poll tasks/get until the task is terminal, then match the final result. true = defaults. |
| `await.pollMs` | integer >= 0 | task's `pollIntervalMs`, else 500 | step | Poll interval in ms. Default: the task pollIntervalMs, else 500. |
| `await.timeoutMs` | integer >= 0 | 30000 | step | Give up after this many ms. Default 30000. |
| `capture` | object of strings | none | step | Save values for later steps: name -> dotted path into the normalized result (e.g. "structuredContent.id"). |
| `budgetMs` | integer >= 0 | config `budgetMs` | step | Fail if this step takes longer than this many ms. |
| `timeoutMs` | integer >= 0 | config `timeoutMs` (15000) | step | Per-request timeout for this step (overrides config). |
| `ignoreErrors` | boolean | `false` | step | Never fail the case because of this step (teardown). |
| `validateOutput` | boolean | `true` when the tool declares `outputSchema` | step | Validate structuredContent against the tool's outputSchema. Default true when one is declared. |
| `normalize` | `false` or object | config `normalize` | step | Override config normalization for this step, or false to match the raw wire result. |
| `tags` | string[] | `[]` | case | Tags for --tag / --exclude-tag filtering. |
| `server` | string | config `defaultServer` | case | Key into config servers; default is defaultServer. |
| `steps` | step[] (min 1) | none | case | Multi-step flow run on one session; top-level operation fields are ignored when present. |
| `setup` | step[] | none | case | Steps run before the case. |
| `teardown` | step[] | none | case | Steps run after the case, even when it failed. |
| `flaky` | boolean | `false` | case | Known-flaky: with --repeat, judged by pass rate instead of 100%. |
| `skip` | boolean or string | `false` | case | Skip this case (true, or a reason string). |

A case needs exactly one of `tool`, `resource`, `resourceTemplate`, `prompt`, or `steps`,
and a step exactly one operation. `expect` and `expectError` cannot both be set.

Case files are checked when they load. Unknown keys fail the case with a suggestion
(`"expct" is not a case key. Did you mean "expect"?`), and so do unknown matchers
(`"$partail" is not a matcher; did you mean "$partial"?`), unknown error-code names
(`"InvalidParam" is not a known error code; did you mean "InvalidParams"?`), malformed
matchers, and undefined placeholders. A broken file is reported as a failed case (`errorKind: "load"`);
it is never silently skipped, even by tag filters.

Comments are allowed: case files may use `//` and `/* */` comments and trailing commas,
and keys named `$comment` or starting with `//` are ignored. (Editors validating against
the schema flag these keys, and `vib run --update` never rewrites a file that has
comments.)

## Operations

### `tool`

`tools/call`. `expect` is matched against the whole result object
(`content`, `structuredContent`, `isError`), after normalization.

```json
{
  "name": "typed adds",
  "tool": "typed",
  "args": { "a": 2, "b": 3 },
  "expect": {
    "content": [{ "type": "text", "text": "{\"sum\":5}" }],
    "structuredContent": { "sum": 5 }
  }
}
```

### `resource`

`resources/read` by URI. The result is `{ "contents": [...] }`.

```json
{
  "name": "readme resource",
  "resource": "fixture://readme",
  "expect": {
    "contents": [{ "uri": "fixture://readme", "mimeType": "text/plain", "text": "Vibrissa echo fixture" }]
  }
}
```

### `resourceTemplate`

An RFC 6570 URI template. `args` fill the variables (non-strings are stringified), then
the expanded URI is read with `resources/read`.

```json
{
  "name": "user 42 via template",
  "resourceTemplate": "fixture://users/{id}",
  "args": { "id": "42" },
  "expect": {
    "contents": [
      {
        "uri": "fixture://users/42",
        "mimeType": "application/json",
        "text": "{\"id\":\"42\",\"name\":\"user-42\"}"
      }
    ]
  }
}
```

### `prompt`

`prompts/get`. `args` are the prompt arguments. The result is
`{ "description", "messages": [...] }`.

```json
{
  "name": "greet terse",
  "prompt": "greet",
  "args": { "name": "Ada", "style": "terse" },
  "expect": {
    "description": "Greeting prompt",
    "messages": [
      { "role": "user", "content": { "type": "text", "text": "Say hello to Ada in a terse way." } }
    ]
  }
}
```

### `args`

A JSON object. For tools it is sent as `arguments`; for templates it fills the URI
variables; for prompts it is sent as `arguments` (MCP prompt arguments are strings, so
quote them). Strings may contain `{{capture}}` and `{{env.NAME}}` placeholders.

## Expectations

### `expect`

Plain JSON is exact deep equality: extra keys fail, arrays keep length and order, object
key order does not matter. Matcher objects (`{"$regex": ...}`, `{"$type": ...}`, ...)
relax it where you need to. The full language is in [MATCHERS.md](./MATCHERS.md).

Omit `expect` to assert only that the call succeeds (no protocol error, no `isError`).

A tool result with `isError: true` fails the step, unless the step has `expectError`, or
has an `expect`, in which case the error result is compared as data. That is how
`vib record` goldens of error results stay exact:

```json
{
  "name": "fail tool result as data",
  "tool": "fail",
  "args": { "message": "boom" },
  "expect": { "content": [{ "type": "text", "text": "boom" }], "isError": true }
}
```

### `expectError`

The step must fail. A failure is either a JSON-RPC error response or a tool result with
`isError: true`.

```json
{
  "name": "echo rejects missing text",
  "tool": "echo",
  "args": { "uppercase": true },
  "expectError": {
    "code": "InvalidParams",
    "message": { "$regex": "Invalid.*echo" }
  }
}
```

- `code` is a [stable name](#error-codes) or a number. Names match across protocol eras,
  so `"ResourceNotFound"` passes against both a 2025 server (`-32002`) and a 2026 server
  (`-32602` with `data: { uri }`). A number matches only that exact code.
- `message` is the exact message, or `{ "$regex": "...", "flags": "i" }`. The SDK's
  `MCP error -32602:` prefix is stripped before matching.
- A tool `isError` result has no code. Match it on `message`, which is the text of its
  `content` items joined by newlines:

```json
{
  "name": "fail tool reports execution error",
  "tool": "fail",
  "args": { "message": "boom goes the reactor" },
  "expectError": { "message": { "$regex": "boom" } }
}
```

`expectError: {}` passes on any failure. A step with `expectError` fails if the call
succeeds.

### `validateOutput`

When a tool declares `outputSchema`, every successful result's `structuredContent` is
validated against it (JSON Schema 2020-12, with `$ref` resolution). This happens in
addition to `expect`, so a golden can never bless output that breaks the tool's own
contract. A missing `structuredContent` fails too. `isError` results and task handles
are not validated, and a schema that does not compile produces a warning (run
`vib check`). Set `"validateOutput": false` to turn it off, for one step or (at the top
level) for every step of the case, for example while a known server bug is being fixed:

```json
{
  "name": "typed broken output, schema check off",
  "tool": "typed",
  "args": { "a": 2, "b": 3, "broken": true },
  "validateOutput": false,
  "expect": { "$partial": true, "structuredContent": { "sum": "5" } }
}
```

### `normalize`

Results are normalized before matching and before `record` writes a golden. Defaults come
from config (see [CONFIG.md](./CONFIG.md#normalize)):

| Option | Default | Effect |
|---|---|---|
| `stripMeta` | `["io.modelcontextprotocol/*"]` | Glob-ish keys to strip from every _meta object. |
| `dropKeys` | `["resultType"]` | Top-level result keys to drop. |
| `ttlMs` | `"ignore"` | Keep or ignore list cache hints. |

A `normalize` object at the top of a case is merged over the config, and one on a step is
merged over both. `"normalize": false` (case or step) matches the raw wire result, which
is how you assert the 2026 envelope itself (this case passes only on a 2026-07-28
connection):

```json
{
  "name": "modern envelope is stamped",
  "tool": "echo",
  "args": { "text": "hi" },
  "normalize": false,
  "expect": {
    "$partial": true,
    "resultType": "complete",
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "vibrissa-echo-fixture", "version": { "$type": "string" } } }
  }
}
```

## Flows

### `steps`

A flow is a list of steps run in order on **one** session. Each step is an operation with
its own expectations. When `steps` is present, top-level operation fields (`tool`,
`args`, `expect`, ...) are ignored.

`tests/fixtures/echo-server/cases/flow.capture.json`:

```json
{
  "name": "flow: capture a value and reuse it",
  "tags": ["flow", "smoke"],
  "steps": [
    {
      "name": "make a handle",
      "tool": "echo",
      "args": { "text": "handle-42" },
      "capture": { "handle": "content[0].text" },
      "expect": { "content": [{ "type": "text", "text": "handle-42" }] }
    },
    {
      "name": "inline interpolation",
      "tool": "echo",
      "args": { "text": "using {{handle}}", "uppercase": true },
      "expect": { "content": [{ "type": "text", "text": "USING HANDLE-42" }] }
    },
    {
      "name": "capture a number",
      "tool": "typed",
      "args": { "a": 2, "b": 3 },
      "capture": { "sum": "structuredContent.sum" }
    },
    {
      "name": "exact placeholder keeps the JSON type",
      "tool": "typed",
      "args": { "a": "{{sum}}", "b": 1 },
      "expect": { "$partial": true, "structuredContent": { "sum": 6 } }
    }
  ],
  "teardown": [{ "tool": "echo", "args": { "text": "bye {{handle}}" }, "ignoreErrors": true }]
}
```

The first failing step fails the case; later steps are reported as skipped, and
`teardown` still runs. Reports show per-step status and timing. A top-level `timeoutMs`,
`validateOutput`, or `normalize` applies to every step that does not set its own.

### `setup` and `teardown`

Steps run before and after the case. They work on single-operation cases and flows alike.
Captures from `setup` are visible to the case and to `teardown`. `teardown` always runs,
even after a failure, so it is where you release server-side state.

Suite-wide setup and teardown live in config (`hooks`, see
[CONFIG.md](./CONFIG.md#hooks)) and run once per server session. Captures from
`hooks.setup` are visible in every case.

### `ignoreErrors`

A step with `"ignoreErrors": true` never fails the case and never stops a flow. When it
fails, the step is still reported as failed, with the reason `ignored (ignoreErrors): ...`,
and the case outcome is unaffected. Outside `teardown` an ignored failure also produces a
warning, so it stays visible. A failed step captures nothing: a later step that uses its
captures fails, except in `teardown`, where such a step is reported as skipped
(`{{h}} was never captured`) rather than failed.

Use it in `teardown` for cleanup that may legitimately find nothing to clean, or on a
best-effort step in a flow (a warm-up call, an optional reset).

## Capture and interpolation

`capture` maps a variable name to a dotted path into the step's **normalized** result:

```json
{ "capture": { "sum": "structuredContent.sum", "firstText": "content[0].text" } }
```

- Paths are dot-separated keys. Array elements are `[0]` or a numeric segment
  (`content[0].text` and `content.0.text` are the same path).
- Names use letters, digits, `_`, and `-`, and start with a letter or `_`. `env` is
  reserved.
- Values are captured only from a step that passed. A path with nothing at it fails the
  step and lists the top-level keys that are there.
- On a step with `expectError`, the path reads the error:
  `{ "kind", "codeName", "code", "message", "data" }`. On a step that only asserts
  `expectInputRequired`, it reads the input-request view.
- A later capture with the same name overwrites the earlier one.
- Captures from config `hooks.setup` are visible in every case.

Placeholders are replaced in every string of a step's `tool`, `resource`,
`resourceTemplate`, `prompt`, `args`, `expect`, `expectError`, `respond`,
`expectInputRequired`, and `expectTask` (keys are never touched):

| Placeholder | Replaced with |
|---|---|
| `{{name}}` | A value captured by an earlier step. |
| `{{env.NAME}}` | The environment variable `NAME`. |

Rules:

- A string that is **exactly** one placeholder is replaced by the raw JSON value, so
  numbers, booleans, objects, and arrays keep their type:
  `"args": { "count": "{{sum}}" }` sends `5`, not `"5"`.
- A placeholder inside a longer string is inlined as text (`"sum is {{sum}}"` becomes
  `"sum is 5"`). Objects and arrays are inlined as JSON.
- Matcher strings are interpolated too, so `{"$regex": "^{{sid}}$"}` works. Captured
  values are inserted as-is, not regex-escaped.
- Placeholders are checked when the case loads. A `{{name}}` that no earlier step
  captures, or a `{{env.NAME}}` that is not set, fails the case before anything runs, with
  the location and a fix. `teardown` may use any name captured anywhere in the case.
- Whitespace inside the braces is allowed: `{{ sid }}`.

## Input requests (MRTR)

On the 2026-07-28 protocol a tool call can pause and ask the client for input
(`resultType: "input_required"`, Multi Round-Trip Requests). Elicitation, sampling, and
roots all travel this way. On 2025-era servers the same questions arrive as
server-to-client requests. Vibrissa answers both from the same `respond` map.

### `respond`

Keyed by request method. The value is the bare result to send back. It is reused for
every round that asks with that method.

| Method | Example answer |
|---|---|
| `elicitation/create` | `{ "action": "accept", "content": { "confirm": true } }`, `{ "action": "decline" }`, `{ "action": "cancel" }` |
| `sampling/createMessage` | `{ "role": "assistant", "content": { "type": "text", "text": "ok" }, "model": "scripted", "stopReason": "endTurn" }` |
| `roots/list` | `{ "roots": [{ "uri": "file:///repo", "name": "repo" }] }` |

If the server asks for something `respond` does not answer, the step fails with a
ready-to-paste entry built from the request's `requestedSchema`:

```
Unanswered input request at tool "confirm": the server asked for elicitation/create "Proceed with x?".
Add to the step: "respond": {"elicitation/create":{"action":"accept","content":{"confirm":true}}}
(edit the sample values), or assert only the request with "expectInputRequired".
```

### `expectInputRequired`

A matcher over every input request the server sent during the call (all rounds), after
normalization. It fails if the server never asked. It is matched against one of two
views, chosen by the shape of your expectation:

| View | When | Shape |
|---|---|---|
| by method | every plain top-level key contains `/` | `{ "elicitation/create": <params> }`; a method asked several times maps to an array of params in order |
| by key (default) | otherwise | `{ "<server's request key>": { "method": "...", "params": {...} } }`, merged over all rounds |

Prefer the **by-method** view. On 2025-era connections the request keys are JSON-RPC ids,
so by-key expectations only work on one era. Use `$partial`, because servers add fields
such as `mode` and `requestedSchema`:

```json
{
  "name": "confirm deploy (accept)",
  "tool": "confirm",
  "args": { "action": "deploy" },
  "respond": {
    "elicitation/create": { "action": "accept", "content": { "confirm": true } }
  },
  "expectInputRequired": {
    "$partial": true,
    "elicitation/create": { "message": "Proceed with deploy?" }
  },
  "expect": { "content": [{ "type": "text", "text": "confirmed: deploy" }] }
}
```

The same assertion in the by-key view, for a server whose request key is `confirm`:

```json
{
  "name": "confirm deploy (by key)",
  "tool": "confirm",
  "args": { "action": "deploy" },
  "respond": { "elicitation/create": { "action": "accept", "content": { "confirm": true } } },
  "expectInputRequired": {
    "$partial": true,
    "confirm": { "method": "elicitation/create", "params": { "message": "Proceed with deploy?" } }
  },
  "expect": { "content": [{ "type": "text", "text": "confirmed: deploy" }] }
}
```

A step with `expectInputRequired` and neither `expect` nor `expectError` asserts the
question alone: it passes when the server asks, even if nothing answers.

## Tasks

Long-running tools can answer with a task (the tasks extension, `resultType: "task"`)
instead of a result. Vibrissa declares the extension, so servers that support it will do
this.

### `await`

Poll `tasks/get` until the task is `completed`, `failed`, or `cancelled`, then match the
final result with `expect` (or `expectError` for a failed task).

```json
{
  "name": "slow job completes",
  "tool": "slow",
  "args": { "ms": 50, "text": "job" },
  "await": { "pollMs": 10, "timeoutMs": 5000 },
  "expect": { "content": [{ "type": "text", "text": "done: job" }] }
}
```

`"await": true` uses the defaults (the task's `pollIntervalMs`, else 500 ms; give up after
30000 ms). Giving up is a `RequestTimeout` error. On servers that answer synchronously
(2025-era, or no tasks support), `await` is a no-op and the result is matched directly.

### `expectTask`

A matcher over the CreateTaskResult itself, after normalization (so `resultType` and the
task's `ttlMs` are gone by default). Without `await`, `expect` sees the task handle as the
result; with `await`, `expect` sees the final result and `expectTask` still sees the
handle. It fails when the server answers directly: tasks need a 2026-07-28 connection
and a server that supports the extension.

`tests/fixtures/echo-server/cases/task.slow.json`:

```json
{
  "name": "tasks: slow work is polled to completion",
  "tags": ["tasks"],
  "tool": "slow",
  "args": { "ms": 40, "text": "job" },
  "await": { "pollMs": 10, "timeoutMs": 5000 },
  "expectTask": { "$partial": true, "taskId": { "$type": "string" }, "status": "working" },
  "expect": { "content": [{ "type": "text", "text": "done: job" }] }
}
```

Run task cases only where tasks exist: the fixture's `legacy` profile sets
`"excludeTags": ["tasks"]`.

## Selection and policy

| Key | Effect |
|---|---|
| `tags` | `vib run --tag smoke` runs cases with at least one matching tag; `--exclude-tag slow` drops them. Profiles can set both. |
| `skip` | `true`, or a reason string shown in reports. Skipped cases count as `skipped`, never `passed`. |
| `flaky` | Under `--repeat N`, the case passes when its pass rate meets the flaky floor instead of 100%. Without `--repeat`, a flaky case must pass like any other. |
| `budgetMs` | Latency budget, failing with `errorKind: "budget"` even when results matched. At the top level it bounds the case's total operation time (`setup` and `steps`, not `teardown`); config `budgetMs` is the default. On a step of a multi-step case it bounds that step. |
| `timeoutMs` | Request timeout for this step. A timeout fails with code `RequestTimeout`. |
| `server` | Run the case against `servers.<name>` from config instead of `defaultServer`. |

```json
{
  "name": "echo smoke on staging",
  "server": "staging",
  "tags": ["smoke"],
  "budgetMs": 800,
  "tool": "echo",
  "args": { "text": "ping" },
  "expect": { "content": [{ "type": "text", "text": "ping" }] }
}
```

A case budget and a step budget together (`tests/fixtures/echo-server/cases/budget.sleep.json`):

```json
{
  "name": "budget: a quick call stays within its budget",
  "tags": ["perf"],
  "steps": [
    { "name": "short sleep", "tool": "sleep", "args": { "ms": 5 }, "budgetMs": 2000 },
    {
      "tool": "echo",
      "args": { "text": "after" },
      "expect": { "content": [{ "type": "text", "text": "after" }] }
    }
  ],
  "budgetMs": 2500
}
```

Skipping with a reason (`skip.example.json`):

```json
{
  "name": "skipped: documents a known gap",
  "skip": "the fixture has no streaming tool yet",
  "tool": "echo",
  "args": { "text": "never sent" }
}
```

## Fragments with `$ref`

`{"$ref": "./shared/x.json"}` anywhere in `expect` (or `expectInputRequired`,
`expectTask`) is replaced with the contents of that file when the case loads. Paths are
relative to the file containing the `$ref`; `file.json#/json/pointer` selects part of a
file. Remote URLs are not supported; vendor the fragment into the repo. Full rules:
[MATCHERS.md#ref](./MATCHERS.md#ref).

`tests/fixtures/echo-server/shared/user-json-content.json`:

```json
{
  "$partial": true,
  "mimeType": "application/json",
  "text": { "$regex": "^\\{\"id\":\"\\d+\",\"name\":\"user-\\d+\"\\}$" }
}
```

`tests/fixtures/echo-server/cases/resource-template.user.json`:

```json
{
  "name": "resourceTemplate: expand and read a user",
  "tags": ["resources"],
  "resourceTemplate": "fixture://users/{id}",
  "args": { "id": "7" },
  "expect": {
    "contents": [{ "$ref": "../shared/user-json-content.json" }]
  }
}
```

Fragment files may live under the case globs: a JSON file with no operation and no
`steps` is skipped (with one `info:` line) when a case references it or it sits in a
`shared/` or `fragments/` directory. A fragment that nothing references, outside those
directories, is loaded as a case and fails, so you notice it.

## Error codes

`expectError.code` accepts these names. They are stable across protocol eras and SDK
versions; Vibrissa maps wire codes and SDK errors onto them.

**JSON-RPC and MCP codes** (sent by the server):

| Name | Code | Notes |
|---|---|---|
| `ParseError` | -32700 | |
| `InvalidRequest` | -32600 | |
| `MethodNotFound` | -32601 | |
| `InvalidParams` | -32602 | Also unknown tools and, on 2026-07-28, unknown resources. |
| `InternalError` | -32603 | |
| `ResourceNotFound` | -32002 | Also the 2026-07-28 shape, -32602 with `data` exactly `{ "uri": ... }`. Reported as `ResourceNotFound` on both eras. |
| `HeaderMismatch` | -32020 | 2026-07-28 HTTP binding: header and body disagree. |
| `MissingRequiredClientCapability` | -32021 | 2026-07-28. |
| `UnsupportedProtocolVersion` | -32022 | 2026-07-28. |
| `UrlElicitationRequired` | -32042 | |

**Client-side codes** (raised by the SDK, not the server):

| Name | Meaning |
|---|---|
| `RequestTimeout` | No response within `timeoutMs` (also matches -32001). |
| `ConnectionClosed` | The server exited or closed its output (also matches -32000). |
| `NotConnected`, `SendFailed` | Transport failures. |
| `InvalidResult` | The response failed the SDK's result validation. |
| `UnsupportedResultType` | A `resultType` the client cannot consume. |
| `InputRequiredRoundsExceeded` | The server kept asking for input past the round cap. |
| `MethodNotSupportedByProtocolVersion` | The method does not exist on the negotiated era (for example `tasks/get` on a 2025 server). |
| `CapabilityNotSupported`, `NotInitialized`, `AlreadyConnected`, `ListPaginationExceeded` | Rare SDK states. |
| `EraNegotiationFailed` | Protocol negotiation failed (see `protocol` in [CONFIG.md](./CONFIG.md#protocol)). |
| `ClientHttpAuthentication`, `ClientHttpForbidden` | HTTP 401 / 403. |
| `ClientHttpNotImplemented`, `ClientHttpUnexpectedContent`, `ClientHttpFailedToOpenStream`, `ClientHttpFailedToTerminateSession` | Other Streamable HTTP failures. |
| `ClientError` | Anything else thrown inside the client. |

**Accepted aliases** (rewritten by `vib migrate`): `RequestTimedOut` and `Timeout`
(`RequestTimeout`), `ConnectionLost` (`ConnectionClosed`), `UnsupportedVersion`
(`UnsupportedProtocolVersion`), `HeaderMismatchError` (`HeaderMismatch`).

## Recipes

### Stateful flow with server-minted handles

2026-07-28 servers keep no protocol session. State lives in handles the server returns
and the client passes back as tool arguments. Capture the handle, use it, release it in
`teardown`. (Tool names below are an example server's, not the fixture's.)

```json
{
  "name": "create then fetch a session",
  "steps": [
    {
      "tool": "session.create",
      "args": { "user": "jordan" },
      "capture": { "sid": "structuredContent.sessionId" }
    },
    {
      "tool": "session.get",
      "args": { "sessionId": "{{sid}}" },
      "expect": { "$partial": true, "structuredContent": { "user": "jordan", "sessionId": "{{sid}}" } }
    }
  ],
  "teardown": [
    { "tool": "session.close", "args": { "sessionId": "{{sid}}" }, "ignoreErrors": true }
  ]
}
```

### Elicitation: accept and decline

Same tool, two answers, two goldens:

```json
{
  "name": "confirm deploy (decline)",
  "tool": "confirm",
  "args": { "action": "deploy" },
  "respond": { "elicitation/create": { "action": "decline" } },
  "expect": { "content": [{ "type": "text", "text": "decline: deploy" }] }
}
```

The accept variant is under [`expectInputRequired`](#expectinputrequired). To assert that
a tool asks before doing anything, leave `respond` out and assert only the question:

```json
{
  "name": "MRTR: assert the input request alone",
  "tags": ["mrtr"],
  "tool": "confirm",
  "args": { "action": "rollback" },
  "expectInputRequired": {
    "elicitation/create": {
      "$partial": true,
      "message": "Proceed with rollback?",
      "requestedSchema": { "$partial": true, "required": ["confirm"] }
    }
  }
}
```

### Long-running task that fails

```json
{
  "name": "slow job failure surfaces as InternalError",
  "tool": "slow",
  "args": { "ms": 10, "fail": true },
  "await": true,
  "expectError": { "code": "InternalError", "message": "slow work failed" }
}
```

### Streaming-ish or model-generated text

Assert the shape, not the words:

```json
{
  "name": "greeting mentions the name",
  "prompt": "greet",
  "args": { "name": "Ada" },
  "expect": {
    "$partial": true,
    "messages": [
      { "role": "user", "content": { "type": "text", "text": { "$regex": "^Say hello to Ada\\b" } } }
    ]
  }
}
```

### Generated ids and timestamps

`vib record` loosens these for you: ISO timestamps become a `date-time` `$schema`, UUIDs a
`uuid` `$schema`, epoch-millisecond numbers `{"$type": "integer"}`, text with an embedded
timestamp a `$regex`, and values that changed between two back-to-back calls are loosened
too (`--exact` keeps everything verbatim; see [CLI.md](./CLI.md#vib-record)). The same
matchers by hand, on the fixture's task handle, which has both (2026-07-28 connections;
tag such cases so a legacy profile can exclude them):

```json
{
  "name": "task handle has an id and a timestamp",
  "tool": "slow",
  "args": { "ms": 10 },
  "expect": {
    "$partial": true,
    "taskId": { "$type": "string", "$wildcard": "task-*" },
    "createdAt": { "$schema": { "type": "string", "format": "date-time" } },
    "status": { "$oneOf": ["working", "completed"] }
  }
}
```

### Partial content lists

Some item matches, in any position:

```json
{
  "name": "echo content contains a text block",
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": {
    "content": { "$contains": { "type": "text", "text": { "$wildcard": "*ell*" } }, "count": 1 }
  }
}
```

At least these items, any order, extras allowed:

```json
{
  "name": "unordered subset of content",
  "tool": "echo",
  "args": { "text": "solo" },
  "expect": {
    "content": { "$unordered": true, "$partial": true, "value": [{ "type": "text" }] }
  }
}
```

### A resource that must not exist

```json
{
  "name": "unknown user is not found",
  "resourceTemplate": "fixture://users/{id}",
  "args": { "id": "404" },
  "expectError": { "code": "ResourceNotFound" }
}
```
