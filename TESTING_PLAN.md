# TESTING PLAN — JSON‑Driven MCP Integration Runner

## Goal

Prefer integration tests over unit tests by exercising the server via MCP stdio, using declarative JSON cases that are easy to author, scale, and generate via LLMs.

## Packaging

- Separate reusable package: `@your-scope/mcp-integration-runner`
- Deliverables:
  - CLI: `mcp-test`
  - Library API for custom runners

## Test Case Format (LLM-friendly)

Example: `tests/integration/echo.basic.json`

```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": { "text": "hello", "uppercase": false },
  "expect": {
    "content": [
      { "type": "text", "text": "hello" }
    ]
  }
}
```

Optional patterns:

- Partial match:

```json
{ "expect": { "$partial": true, "content": [{ "type": "text" }] } }
```

- Regex:

```json
{ "expect": { "content": [{ "type": "text", "text": { "$regex": "^hel+o$", "flags": "i" } }] } }
```

- Wildcard (glob-like):

```json
{ "expect": { "content": [{ "type": "text", "text": { "$wildcard": "hel*o" } }] } }
```

- Error expectation:

```json
{ "expectError": { "code": "InvalidParams", "message": { "$regex": "Invalid.*echo" } } }
```

## Matching Semantics

- Exact: deep equality by default.
- Partial: if `"$partial": true`, provided fields must exist and match; extra fields are allowed.
- Regex: `{ "$regex": "<pattern>", "flags": "imuxs" }` uses JavaScript RegExp.
- Wildcard: `{ "$wildcard": "<glob>" }` uses simple glob rules for plain strings:
  - `*` matches any sequence
  - `?` matches one character
  - `**` treated the same as `*` for plain strings
  - Implementation: escape literals, convert `*` → `.*`, `?` → `.`, anchor with `^…$` and compile as RegExp.
- Arrays: exact order by default; allow unordered via `"$unordered": true` at the array’s parent:

```json
{ "expect": { "content": { "$unordered": true, "value": [ { "type": "text" } ] } } }
```

Runner interprets objects with `"$unordered": true` as sets (partial matching still applies inside items).

## CLI (runner)

Basic:

```bash
npx @your-scope/mcp-integration-runner \
  --server "node dist/index.js" \
  --cases "tests/integration/**/*.json" \
  --fail-fast --concurrency 4 --timeout 15000
```

Useful flags:

- `--server`, `--server-cwd`, `--env FOO=bar`
- `--cases "<glob>"`
- `--fail-fast`, `--concurrency N`, `--timeout ms`
- `--report junit.xml` (optional JUnit)
- `--before <script>`, `--after <script>` (optional hooks)

## Library API (advanced)

```ts
import { runCases } from "@your-scope/mcp-integration-runner";

await runCases({
  server: { cmd: process.execPath, args: ["dist/index.js"], env: {} },
  globs: ["tests/integration/**/*.json"],
  concurrency: 4,
  failFast: true,
  timeoutMs: 15000
});
```

## CI

Build then run:

```bash
npm run build
npx @your-scope/mcp-integration-runner --server "node dist/index.js" --cases "tests/integration/**/*.json"
```

- Gate on non‑zero exit
- Cache `node_modules`; shard by globs if suite grows

## Scope Coverage

- Tools contract: `listTools`, `tools/call`
- Validation: error codes/messages for bad args
- Flows: multi-step tool sequences
- Performance: soft thresholds per case (optional)
- Streaming/long ops: supported; prefer partial/regex for stable assertions

## Rationale

- Maintains strict, reviewable contracts (JSON expectations)
- Scales with minimal boilerplate; ideal for LLM-generated cases
- Headless, deterministic, and transport-accurate (stdio)


