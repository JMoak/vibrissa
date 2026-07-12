## vibrissa (whisker) â€” JSONâ€‘Driven MCP Integration Test Runner

Endâ€‘toâ€‘end test your MCP server over stdio using declarative JSON cases. Ship stable, contractâ€‘focused integration suites that humans can review and LLMs can author.

### Why Vibrissa?
- Integrationâ€‘first: validates real I/O over MCP stdio
- JSON cases: simple, diffâ€‘friendly, easy to generate
- Powerful matching: exact, partial, regex, wildcard, unordered arrays
- Flexible: CLI (`vib-test`) or library API

### Requirements
- Node.js >= 20
- ESM-only package (use `import`, not `require`)

### Install
```bash
npm i -D vibrissa
```

### Quickstart
```bash
npm i -D vibrissa
vib init
# edit vibrissa.json server block if needed
vib tools
vib call echo --arg text=hello --arg uppercase=true
vib record echo --arg text=hello --arg uppercase=true --name "echo uppercase"
vib run
```

Or scaffold by hand:

1) Create `vibrissa.json` in your MCP server repo (root):
```json
{
  "$schema": "./node_modules/vibrissa/schema/vibrissa.schema.json",
  "server": { "cmd": "node", "args": ["dist/index.js"] },
  "globs": ["tests/integration/**/*.json"]
}
```

2) Create a case: `tests/integration/echo.basic.json`
```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": {
    "text": "hello",
    "uppercase": true
  },
  "expect": {
    "content": [
      {
        "type": "text",
        "text": "HELLO"
      }
    ]
  }
}
```

3) Run
```bash
vib-test run
```

Optional: add an NPM script
```json
{
  "scripts": {
    "test:integration": "vib-test run"
  }
}
```

### Test Case Semantics
- Default is exact deep equality.
- Partial
```json
{
  "expect": {
    "$partial": true,
    "content": [
      {
        "type": "text"
      }
    ]
  }
}
```
- Regex
```json
{
  "expect": {
    "content": [
      {
        "type": "text",
        "text": {
          "$regex": "^hel+o$",
          "flags": "i"
        }
      }
    ]
  }
}
```
- Wildcard (globâ€‘like)
```json
{
  "expect": {
    "content": [
      {
        "type": "text",
        "text": {
          "$wildcard": "hel*o"
        }
      }
    ]
  }
}
```
- Unordered arrays
```json
{
  "expect": {
    "content": {
      "$unordered": true,
      "value": [
        {
          "type": "text"
        }
      ]
    }
  }
}
```
- Error expectations
```json
{
  "expectError": {
    "code": "InvalidParams",
    "message": {
      "$regex": "Invalid.*echo"
    }
  }
}
```

### CLI â€” vib / vib-test

Subcommands (default is `run` when omitted):

```bash
vib init
vib tools
vib call echo --arg text=hello --arg uppercase=true
vib record echo --arg text=hello --arg uppercase=true --name "echo uppercase"
vib run
vib inspect          # opens MCP Inspector with the same server config
```

| Command | Purpose |
|--------|---------|
| `run` | Execute JSON cases (CI gate) |
| `tools` | List tools + argument shapes |
| `call` | One-shot `tools/call`, print result |
| `record` | One-shot call â†’ write a golden case file |
| `init` | Scaffold `vibrissa.json` + sample case + npm script |
| `inspect` | Launch [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) against this server |

**Division of labor:** use Inspector for visual exploration and debugging; use Vibrissa `tools` â†’ `call` â†’ `record` â†’ `run` for the authoring/regression loop. `inspect` reuses your `vibrissa.json` server block so you do not re-type command/args/env.

Shared options:
- **--config**: path to your config file (otherwise auto-discovered from the current directory)
- **--server**: override server command (quoted argv ok), e.g. `--server "node dist/index.js"`
- **--server-cwd**: working directory for starting the server (overrides `server.cwd`; relative paths resolve from the shell cwd)
- **--env KEY=VALUE**: extra environment (repeatable)
- **--timeout**: per-call / spawn timeout in ms
- **--json**: machine-readable output for `tools` / `call` / `record`

`run` options:
- **--cases**: glob of JSON cases (relative to the shell cwd when passed on the CLI)
- **--allow-empty**: exit 0 when no cases match (by default, zero matches is a failure)
- **--fail-fast**, **--pretty** / **--no-pretty**

`record` options: `--out`, `--name`, `--partial`, `--force`

Notes:
- Globs in `vibrissa.json` resolve relative to the config file's directory.
- Relative `server.cwd` values in config also resolve from that directory.
- Matching zero case files exits `1` unless `--allow-empty` / `allowEmpty: true` is set.
- Recorded cases include `$schema` pointing at `schema/case.schema.json` for editor validation.

### Case Layout (recommended)
```
tests/
  integration/
    echo.basic.json
    tools/
      invalid-args.json
      flow.multistep.json
```

### Configuration (vibrissa.json)
Create a `vibrissa.json` in your project root to avoid repeating flags and enable IDE IntelliSense via `$schema`.

```json
{
  "$schema": "./node_modules/vibrissa/schema/vibrissa.schema.json",
  "server": {
    "cmd": "node",
    "args": ["dist/index.js"],
    "cwd": ".",
    "env": {
      "LOG_LEVEL": "info"
    }
  },
  "globs": [
    "tests/integration/**/*.json"
  ],
  "concurrency": 4,
  "timeoutMs": 15000,
  "failFast": false,
  "reportPath": "reports/junit/junit.xml",
  "hooks": {
    "before": "node scripts/before.js",
    "after": "node scripts/after.js"
  }
}
```

Then run:
```bash
vib-test
```

Notes:
- `$schema` gives editor validation/autocomplete. Using the local path works immediately after install and offline.
- CLI flags always override config values.

### Library API
```ts
import { runCases } from "vibrissa";

await runCases({
  server: { cmd: process.execPath, args: ["dist/index.js"], env: {} },
  globs: ["tests/integration/**/*.json"],
  concurrency: 4,
  failFast: true,
  timeoutMs: 15000,
  reportPath: "reports/junit/junit.xml"
});
```

### CI (GitHub Actions)
```yaml
name: integration
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx vib-test --config vibrissa.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: junit
          path: reports/junit/junit.xml
```

### What to Test
- Tools contract: `listTools`, `tools/call`
- Arg validation: codes/messages for bad inputs
- Multiâ€‘step flows: sequences across tools
- Streaming/long ops: use partial/regex for stability
- Optional performance thresholds per case

### Troubleshooting
- Hanging cases: increase `--timeout` and inspect server logs
- Flaky text: prefer `$partial` or `$regex`
- Globs not matching: run with quotes and verify working directory

### License
MIT

### Authoring from tdd-dsl

You can author Vibrissa cases from a shared `.tdd` contract and emit JSON with [tdd-dsl](https://github.com/JMoak/tdd-dsl):

```text
suite "Echo MCP contract"
target vibrissa "echo-server"

case "echo basic":
  given input:
    {"text": "hello"}
  when call "echo"
  then equals:
    {"content": [{"type": "text", "text": "hello"}]}
```

```bash
tdd-dsl emit --target vibrissa --out-dir tests/integration contract.tdd
vib run
```

Mapping: `when call` → `tool`, `given input` → `args`, `then equals` → `expect`. Prefer recording once with `vib record` so `expect` matches the real MCP `tools/call` envelope.

**Layering:** keep Vitest/Jest for unit tests of Vibrissa itself and of MCP handler logic. Use Vibrissa JSON for protocol e2e. Do **not** pull Python / tdd-dsl into Vibrissa CI — emit cases in the contract repo (or regenerate locally) and commit the JSON that `vib run` executes.

