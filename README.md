## vibrissa (whisker) — JSON‑Driven MCP Integration Test Runner

End‑to‑end test your MCP server over stdio using declarative JSON cases. Ship stable, contract‑focused integration suites that humans can review and LLMs can author.

### Why Vibrissa?
- Integration‑first: validates real I/O over MCP stdio
- JSON cases: simple, diff‑friendly, easy to generate
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
1) Create `vibrissa.jsonc` in your MCP server repo (root):
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
vib-test
```

Optional: add an NPM script
```json
{
  "scripts": {
    "test:integration": "vib-test"
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
- Wildcard (glob‑like)
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

### CLI — vib-test
Usage:
```bash
vib-test [--config ./path/to/vibrissa.jsonc] [--server-cwd .]
```
- **--config**: path to your config file (otherwise auto-discovered)
- **--server-cwd**: working directory for starting the server

### Case Layout (recommended)
```
tests/
  integration/
    echo.basic.json
    tools/
      invalid-args.json
      flow.multistep.json
```

### Configuration (vibrissa.jsonc)
Create a `vibrissa.jsonc` in your project root to avoid repeating flags and enable IDE IntelliSense via `$schema`.

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
      - run: npx vib-test --config vibrissa.jsonc
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: junit
          path: reports/junit/junit.xml
```

### What to Test
- Tools contract: `listTools`, `tools/call`
- Arg validation: codes/messages for bad inputs
- Multi‑step flows: sequences across tools
- Streaming/long ops: use partial/regex for stability
- Optional performance thresholds per case

### Troubleshooting
- Hanging cases: increase `--timeout` and inspect server logs
- Flaky text: prefer `$partial` or `$regex`
- Globs not matching: run with quotes and verify working directory

### License
MIT


