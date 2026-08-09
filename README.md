# vibrissa

> *vibrissa* (n.) — a whisker; a sensory organ for probing the world.

**Golden-file integration testing for MCP servers.** Point it at your server, record real
responses as JSON cases, replay them in CI. No test code — just contracts.

[![npm](https://img.shields.io/npm/v/%40jmoak%2Fvibrissa?color=cb3837&label=npm)](https://www.npmjs.com/package/@jmoak/vibrissa)
[![CI](https://github.com/JMoak/vibrissa/actions/workflows/ci.yml/badge.svg)](https://github.com/JMoak/vibrissa/actions/workflows/ci.yml)
[![node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-3c873a)](https://nodejs.org)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm i -D @jmoak/vibrissa
vib init          # scaffold vibrissa.json + a sample case
vib tools         # see what your server exposes
vib call echo --arg text=hello --arg uppercase=true
vib record echo --arg text=hello --arg uppercase=true --name "echo uppercase"
vib run           # replay every recorded case — your CI gate
```

Releases ship through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC, no tokens) with provenance attestation — each version is linked to the exact
commit and workflow that built it.

---

## Why

MCP servers are contracts: tools in, structured results out. Unit tests exercise your
handlers; nothing exercises **the protocol surface your clients actually see**. Vibrissa
spawns your server over stdio, drives real `tools/call` requests, and diffs the full
result envelope against committed JSON — so a renamed field, a changed error code, or a
broken tool never reaches a client first.

- **Integration-first** — real I/O over MCP stdio, not mocked handlers
- **Golden files** — record once, diff forever; failures show a Jest-style diff
- **Reviewable** — cases are plain JSON: diff-friendly for humans, trivially authored by agents
- **Zero test code** — the entire suite is data

## The loop

| Step | Command | What it does |
|------|---------|--------------|
| explore | `vib tools` | list tools + argument shapes |
| probe | `vib call <tool> --arg k=v` | one-shot `tools/call`, print the result |
| capture | `vib record <tool> --arg k=v --name "..."` | write the real response as a golden case |
| gate | `vib run` | replay all cases; non-zero exit on any mismatch |

Use [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual
exploration (`vib inspect` launches it with your config — no re-typing server args);
use the loop above for authoring and regression.

## Anatomy of a case

`tests/integration/echo.basic.json`:

```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": { "text": "hello", "uppercase": true },
  "expect": {
    "content": [{ "type": "text", "text": "HELLO" }]
  }
}
```

`expect` is matched against the **entire** `tools/call` result object, exact deep
equality by default. `vib record` captures the full envelope, so recorded cases are
always exact-match ready. When exactness is too brittle, reach for a matcher:

| Matcher | Case snippet | Asserts |
|---------|--------------|---------|
| partial | `"expect": { "$partial": true, ... }` | only the fields you name |
| regex | `"text": { "$regex": "^hel+o$", "flags": "i" }` | pattern match |
| wildcard | `"text": { "$wildcard": "hel*o" }` | glob-like match |
| unordered | `"content": { "$unordered": true, "value": [...] }` | array, any order |
| error | `"expectError": { "code": "InvalidParams", "message": { "$regex": "Invalid.*echo" } }` | the call fails *correctly* |

Matchers nest anywhere in the expectation tree. Prefer `$partial` / `$regex` for
streaming output, timestamps, and anything else that legitimately varies.

## Agents write great cases

JSON cases are the most generatable test format there is. Point your coding agent at
the same loop you use:

1. `vib tools --json` — the agent discovers the contract
2. `vib call <tool> --arg ... --json` — it probes behavior, including edge cases
3. `vib record` — real responses become golden cases (no hallucinated envelopes)
4. `vib run` — the agent verifies its own suite before handing it back

Because `record` captures ground truth from the live server, agent-authored suites
can't drift from reality — the worst an agent can do is record a case you don't want,
and that's a one-line JSON review.

## Configuration

`vibrissa.json` at your repo root (created by `vib init`; `$schema` gives IDE
autocomplete and validation):

```json
{
  "$schema": "./node_modules/@jmoak/vibrissa/schema/vibrissa.schema.json",
  "server": {
    "cmd": "node",
    "args": ["dist/index.js"],
    "cwd": ".",
    "env": { "LOG_LEVEL": "info" }
  },
  "globs": ["tests/integration/**/*.json"],
  "timeoutMs": 15000,
  "failFast": false
}
```

- Globs and relative `server.cwd` resolve from the config file's directory.
- CLI flags always override config values.
- Zero matching case files exits `1` — a silently-empty suite is a failure, not a pass.
  Opt out with `--allow-empty` / `allowEmpty: true`.

## CLI reference

`vib` and `vib-test` are the same binary; bare `vib` defaults to `run`.

| Command | Purpose |
|---------|---------|
| `run` | execute JSON cases (CI gate) |
| `tools` | list tools + argument shapes |
| `call` | one-shot `tools/call`, print result |
| `record` | one-shot call → write a golden case file |
| `init` | scaffold `vibrissa.json` + sample case + npm script |
| `inspect` | launch MCP Inspector with this server config |

Shared options: `--config`, `--server "node dist/index.js"`, `--server-cwd`,
`--env KEY=VALUE` (repeatable), `--timeout <ms>`, `--json` (machine-readable output
for `tools` / `call` / `record`).

`run` options: `--cases <glob>`, `--allow-empty`, `--fail-fast`, `--pretty` / `--no-pretty`.
`record` options: `--out`, `--name`, `--partial`, `--force`.

## Library API

```ts
import { runCases } from "@jmoak/vibrissa";

await runCases({
  server: { cmd: process.execPath, args: ["dist/index.js"], env: {} },
  globs: ["tests/integration/**/*.json"],
  failFast: true,
  timeoutMs: 15000,
});
```

## CI

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
```

## What to test

- **Tools contract** — `listTools` shape, every tool callable
- **Arg validation** — codes and messages for bad inputs (`expectError`)
- **Multi-step flows** — sequences across tools
- **Streaming / long ops** — `$partial` + `$regex` for stability

Keep Vitest/Jest for unit-testing your handler logic; use vibrissa JSON for the
protocol surface. The suite is data, so it lives in your repo and reviews like code.

## Authoring from tdd-dsl

Cases can be emitted from a shared [`tdd-dsl`](https://github.com/Rosavera-I/tdd-dsl)
contract (`when call` → `tool`, `given input` → `args`, `then equals` → `expect`):

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

Emit in the contract repo and commit the JSON — don't pull Python into your MCP
server's CI. Prefer `vib record` for the initial capture so `expect` matches the real
envelope.

## Troubleshooting

- **Hanging cases** — raise `--timeout`, check the server's stderr
- **Flaky text** — switch to `$partial` or `$regex`
- **Globs not matching** — quote the glob; remember config-relative resolution

## Roadmap

Tags/filters, failure transcripts, profiles, watch mode — see
[docs/FUTURE.md](./docs/FUTURE.md).

## License

[MIT](./LICENSE) © Jordan Moak
