## Vibrissa — JSON‑Driven MCP Integration Test Runner

End‑to‑end test your MCP server over stdio using declarative JSON cases. Ship stable, contract‑focused integration suites that humans can review and LLMs can author.

### Why Vibrissa?
- Integration‑first: validates real I/O over MCP stdio
- JSON cases: simple, diff‑friendly, easy to generate
- Powerful matching: exact, partial, regex, wildcard, unordered arrays
- Flexible: CLI (`vib-test`) or library API

### Requirements
- Node.js >= 20

### Install
```bash
npm i -D vibrissa
```

### Quickstart
1) Add an NPM script in your MCP server repo:
```json
{
  "scripts": {
    "test:integration": "vib-test --server \"node dist/index.js\" --cases \"tests/integration/**/*.json\" --fail-fast --concurrency 4 --timeout 15000"
  }
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
npx vib-test --server "node dist/index.js" --cases "tests/integration/**/*.json"
# or
npm run test:integration
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
```bash
vib-test \
  --server "node dist/index.js" \
  --server-cwd "." \
  --env FOO=bar --env BAZ=qux \
  --cases "tests/integration/**/*.json" \
  --fail-fast \
  --concurrency 4 \
  --timeout 15000 \
  --report reports/junit/junit.xml \
  --before "node scripts/before.js" \
  --after "node scripts/after.js"
```
- **--server**: command to start your MCP server (stdio)
- **--server-cwd**: working directory for the server process
- **--env**: repeatable `KEY=value` pairs for the server env
- **--cases**: glob(s) for JSON cases
- **--fail-fast**: stop at first failure
- **--concurrency**: parallel case workers
- **--timeout**: per‑case timeout (ms)
- **--report**: optional JUnit XML path
- **--before/--after**: optional hook scripts

Tips (Windows PowerShell): quote with `"..."` inside `package.json` and use regular `"` in direct shells.

### Case Layout (recommended)
```
tests/
  integration/
    echo.basic.json
    tools/
      invalid-args.json
      flow.multistep.json
```

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
      - run: npx vib-test --server "node dist/index.js" --cases "tests/integration/**/*.json" --report reports/junit/junit.xml
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


