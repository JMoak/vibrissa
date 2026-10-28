# Vibrissa v2 — Scope & Direction

Status: delivered as 2.0.0 (alpha, 2026-10-28), after one dogfood round. This file is the
original scoping menu, kept for the rationale; what shipped is tracked in
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) and what is left in
[FUTURE.md](./FUTURE.md). Where this file and the reference docs (CASES, CLI, CONFIG)
disagree, the reference docs describe the shipped behavior.

---

## 1. Where v1 stands

v1 is a clean, small, stdio-only golden-file runner on the v1 TypeScript SDK:

- Protocol revision **2025-11-25** via `@modelcontextprotocol/sdk` 1.x (v1 line tops out there; bug-fix-only support window ends ~Jan 2027).
- Contract surface: `tools/list` + `tools/call` only.
- Assertions: exact deep-equality plus `$partial`, `$regex`, `$wildcard`, `$unordered`, `expectError`.
- Loop: `init → tools → call → record → run`, plus `inspect` wrapping MCP Inspector.
- Output: console only. No reporters, no flows, no normalization, no HTTP.

The current spec is **2026-07-28**. It is a rewrite of the core, not a point release, and
several of its changes land directly on what a golden-file tester must do:

| 2026-07-28 change | Consequence for Vibrissa |
|---|---|
| `initialize` handshake removed; `server/discover` added; per-request `_meta` carries version + capabilities | v1 client cannot talk to a 2026-only server. Need era negotiation (auto / modern / legacy). |
| Every result carries `resultType`; servers stamp `_meta["io.modelcontextprotocol/serverInfo"]` | Exact-match goldens churn on every server version bump unless we normalize. |
| Multi Round-Trip Requests (`resultType: "input_required"`) replace server-initiated elicitation / sampling / roots | A tool call can legitimately *pause and ask*. Cases need scripted answers. |
| Protocol-level sessions removed; cross-call state via **server-minted handles passed as tool args** | Single-call cases can no longer test stateful servers. Need multi-step flows with captures. |
| `tools/list` must be deterministic; list results carry `ttlMs` / `cacheScope` | Tool manifest becomes a stable, snapshot-able contract. |
| `inputSchema` / `outputSchema` are full JSON Schema 2020-12 | We can validate args and `structuredContent` mechanically. |
| Tasks moved to an extension with polling (`tasks/get`) | Long-running tools need a poll-until-complete primitive. |
| Error codes renumbered (`-32020..-32022`), resource-not-found is now `-32602` | `expectError.code` names must track the v2 SDK enums. |
| Roots, Sampling, Logging deprecated | Don't build on them. stderr capture is the logging story. |

---

## 2. Positioning: what Vibrissa is, and is not

The 2026 landscape has sorted itself into layers (the "Layer 0–3" framing is now common):

| Layer | What | Who owns it today |
|---|---|---|
| 0 — Conformance | Does the server speak the spec correctly? | `@modelcontextprotocol/conformance` (official, unstable, HTTP-centric) |
| 1 — Contract / behavior | Given these args, does *this* server return *this*? | **Vibrissa** (and ad-hoc pytest/vitest scripts) |
| 2 — Robustness / security | Fuzzing, fault injection, tool poisoning, rug pulls | mcp-scan (now Snyk), Cisco mcp-scanner, OWASP ASRH |
| 3 — Model-in-the-loop evals | Does an LLM pick the right tool with the right args? | MCPJam, Promptfoo, Braintrust, DeepEval |
| — Exploration | Click around | MCP Inspector v2, MCPJam Inspector |

**v2 thesis:** own Layer 1 completely, absorb the deterministic halves of Layers 0 and 2,
and offer Layer 3 as an *optional plugin* rather than diluting the core.

What makes Vibrissa different, and what v2 must protect:

1. **Zero test code.** The whole suite is JSON. This is why agents author it well and
   humans review it easily. Every v2 feature must be expressible in a case file.
2. **Ground truth, not hallucinated envelopes.** `record` captures reality. v2 extends
   "record" to every new surface (resources, prompts, flows, manifests, transcripts).
3. **Deterministic by default.** No LLM in the critical path. CI gates must be
   reproducible. Model-based checks live behind an explicit opt-in.
4. **Fast local loop.** Sub-second feedback, no accounts, no hosted anything.

Non-goals for v2: a hosted UI, a server registry, a general LLM eval platform, OAuth
debugging UX (defer to Inspector / MCPJam).

---

## 3. Feature catalog

Each item notes its lineage ("borrowed from") so we take the best idea, not reinvent it.

### 3.1 Protocol currency (foundation; everything else depends on it)

- **Migrate to `@modelcontextprotocol/client` 2.x.** Era negotiation `auto` (default) /
  `modern` / `legacy`, exposed as `server.protocol` in config and `--protocol` on the CLI.
  Suites keep working against 2025-era and 2026-era servers.
- **Streamable HTTP transport.** `server: { url, headers }` alongside `server: { cmd }`.
  Static bearer / API-key headers first; OAuth via an env-provided token. Full OAuth flows
  are Inspector's job.
- **`vib discover`.** Calls `server/discover` (falls back to `initialize` on legacy
  servers) and prints versions, capabilities, extensions, identity. `--json` for agents.
- **Result envelope normalization.** Config-level `normalize` applied before matching and
  before recording:
  ```jsonc
  "normalize": {
    "stripMeta": ["io.modelcontextprotocol/*"],   // default
    "dropKeys": ["resultType"],                    // default
    "ttlMs": "ignore"                              // for list results
  }
  ```
  Goldens stay clean of per-version noise; opt out per case with `"normalize": false`.
- **Error model aligned to v2 SDK.** `expectError.code` accepts the new names
  (`UnsupportedProtocolVersion`, `HeaderMismatch`, …) and numeric codes. `vib migrate`
  rewrites old names in existing case files.

### 3.2 Whole-contract coverage (borrowed from: Inspector's surface, Pact's "the contract is the whole API")

- **Resources & prompts as first-class cases.**
  ```json
  { "resource": "file:///README.md", "expect": { "contents": [ … ] } }
  { "resourceTemplate": "users://{id}", "args": { "id": "42" }, "expect": … }
  { "prompt": "summarize", "args": { "style": "terse" }, "expect": { "messages": [ … ] } }
  ```
  `vib resources`, `vib prompts`, `vib read <uri>`, `vib get-prompt <name>` mirror
  `tools` / `call`. `record` grows `--resource` / `--prompt`.
- **Manifest lock (the headline feature).** `vib manifest record` snapshots
  `server/discover` + `tools/list` + `resources/templates/list` + `prompts/list` into
  `tests/integration/__manifest__.json`. `vib run` diffs the live manifest against it and
  fails on: added/removed tools, changed `inputSchema`/`outputSchema`, **changed
  descriptions**, changed annotations, changed capabilities. This is `package-lock.json`
  for your MCP surface and doubles as **rug-pull detection** (mcp-scan's "tool pinning"
  idea, but committed to git and reviewed in PRs). `--update-manifest` accepts changes.
- **Automatic `outputSchema` enforcement.** When a tool declares `outputSchema`, every
  `tools/call` result's `structuredContent` is validated against it (JSON Schema 2020-12,
  `$ref` resolution) *in addition to* the case's `expect`. Off per case with
  `"validateOutput": false`. (Lineage: schemathesis / OpenAPI contract tests.)
- **Argument pre-validation.** Case `args` are checked against `inputSchema` before the
  call. A case that sends invalid args without an `expectError` is flagged as a probable
  authoring mistake.

### 3.3 Flows: multi-step, stateful, MRTR-aware (borrowed from: Playwright/Cypress chains, Pact interactions, k6 scenarios)

The stateless 2026 core pushes state into server-minted handles. Tests must chain.

```jsonc
{
  "name": "create then fetch",
  "steps": [
    { "tool": "session.create", "args": { "user": "jordan" },
      "capture": { "sid": "structuredContent.sessionId" } },
    { "tool": "session.get", "args": { "sessionId": "{{sid}}" },
      "expect": { "$partial": true, "structuredContent": { "user": "jordan" } } },
    { "tool": "session.close", "args": { "sessionId": "{{sid}}" } }
  ],
  "teardown": [ { "tool": "session.close", "args": { "sessionId": "{{sid}}" }, "ignoreErrors": true } ]
}
```

- `capture` uses dotted paths (no JSONPath dependency); `{{name}}` interpolates into any
  later step's args or expect.
- `setup` / `teardown` at case and suite level (`vibrissa.json#hooks`), also expressible
  as steps. Teardown runs on failure.
- **MRTR scripting.** When a step returns `resultType: "input_required"`, Vibrissa answers
  from the case and retries:
  ```jsonc
  { "tool": "deploy", "args": { "env": "prod" },
    "respond": {
      "elicitation/create": { "action": "accept", "content": { "confirm": true } }
    },
    "expectInputRequired": { "$partial": true, "elicitation/create": { "message": { "$regex": "prod" } } },
    "expect": { … final result … } }
  ```
  Unanswered `input_required` fails loudly with the request shown. `record` captures the
  interim request into `expectInputRequired` and prompts for the answer (or `--respond`).
- **Tasks extension.** `"await": { "pollMs": 500, "timeoutMs": 30000 }` polls `tasks/get`
  until terminal and matches the final result. `expectTask` for asserting a task was
  returned.
- **`vib record --flow`**: interactive multi-call recording session that writes one
  `steps` case.

### 3.4 Assertion language v2 (borrowed from: Jest asymmetric matchers, Pact matchers, Postman)

Keep it JSON, keep it small, make it orthogonal:

| Matcher | Meaning |
|---|---|
| `{"$any": true}` | present, any value |
| `{"$type": "string" \| "number" \| "array" \| …}` | type check |
| `{"$schema": { …json schema… }}` | validate subtree against inline JSON Schema |
| `{"$oneOf": [ … ]}` | any alternative matches |
| `{"$contains": x}` | array contains an element matching x (partial by nature) |
| `{"$length": 3}` / `{"$length": {"min": 1, "max": 10}}` | array/string length |
| `{"$number": {"gte": 0, "lt": 100}}` | numeric range |
| `{"$ignore": true}` | explicitly ignored (documents intent, unlike `$partial`) |
| `{"$ref": "./shared/user-shape.json"}` | reuse an expectation fragment |

All existing matchers remain. `$ref` enables shared fixtures and keeps suites DRY.

### 3.5 Generative & property testing (borrowed from: schemathesis, Hypothesis, fast-check)

- **`vib fuzz <tool> [--runs 200] [--seed 42]`.** Generates args from `inputSchema`:
  valid, boundary (min/max/empty/unicode/huge), and invalid (wrong type, missing
  required, extra props). Invariants checked without any golden:
  - valid args → no protocol error, result matches `outputSchema`, no timeout, no crash
  - invalid args → `InvalidParams` (not a 500-style crash, not a silent success)
  - server stays alive and `tools/list` is unchanged afterwards
- `--record-failures` writes each counterexample as a replayable case. Deterministic via
  seed. This is where agents will find the bugs humans didn't think to test.
- **Spec-sanity checks** (the deterministic Layer 0 subset, runnable on stdio where the
  official conformance CLI is HTTP-first): discover works, list ordering stable across
  two calls, `ttlMs`/`cacheScope` present, schemas are valid 2020-12 with resolvable
  `$ref`s, error codes match the renumbered spec. `vib check` runs them; `vib run
  --check` folds them into CI. `vib conformance` wraps the official CLI the way `inspect`
  wraps Inspector, for people who want the full suite.

### 3.6 Security posture, deterministic subset (borrowed from: mcp-scan, Cisco mcp-scanner, OWASP MCP Top 10)

- **Description lint** (part of `vib check`): flags hidden-instruction patterns in tool
  descriptions (`<IMPORTANT>`, "ignore previous", "do not tell the user", references to
  *other* tools' names = shadowing, URLs/base64 blobs, instructions to read files outside
  scope). Pattern-based, offline, zero false-negatives claims — a smoke detector, not a
  scanner.
- **Manifest lock** (3.2) covers rug pulls.
- **Output-injection probes** (`vib fuzz --inject`): feeds canonical prompt-injection
  payloads through string args and asserts they come back as data, not as changed
  behavior (e.g. no unexpected extra tool calls in flows, no description mutation). Keep
  modest; the full red-team belongs to Promptfoo / OWASP ASRH.

### 3.7 Stability, performance, flake (borrowed from: Playwright retries, k6 thresholds, the "delta gating" pattern)

- `"budgetMs": 800` per case/step → fails on breach; `vib run --perf` reports p50/p95
  per tool to `reports/perf.json`.
- `--repeat N` with flake classification (pass rate per case; "hard" cases must be
  100 %, `"flaky": true` cases get a floor).
- **Delta gating:** `--baseline reports/last-green.json` fails only on regressions vs the
  last green run (new failures, latency growth > X %), not on absolute thresholds.

### 3.8 Reporting & CI (borrowed from: Vitest/Jest reporters, Playwright traces, MCPJam's CI mode)

- Reporters: `console` (current), `json`, `junit`, `github` (annotations +
  `$GITHUB_STEP_SUMMARY` markdown table), `tap`. Multiple at once.
- **Transcripts.** On failure (or `--trace`), write the raw JSON-RPC exchange for the
  case to `reports/traces/<case>.ndjson` plus captured stderr. `vib show-trace <file>`
  pretty-prints it. This is the Playwright trace viewer idea at MCP granularity.
- `--update` (jest `-u`): rewrite failing goldens from live output, interactively or
  with `--yes`. Prints the diff it accepted.
- `--tag` / `--exclude-tag`, `--grep`, `--shard i/n`, `--concurrency N` (one session per
  worker; flows are never split), `--watch`.
- GitHub Action (`jmoak/vibrissa-action`) and a `vib init --ci` that writes a workflow.

### 3.9 Authoring DX (the part that keeps Vibrissa agent-native)

- **`vib tap` — capture from real usage (VCR / Polly idea).** A stdio proxy you put
  between a real client (Claude Code, Cursor, Inspector) and your server:
  `"command": "vib", "args": ["tap", "--", "node", "dist/index.js"]`. Every
  `tools/call` is appended to `reports/tap/*.ndjson`; `vib record --from-tap` turns
  selected calls into cases. Real usage becomes your regression suite without typing a
  single argument.
- **`vib diff --against "<other server cmd>"`.** Runs the suite (or just the manifest)
  against two server commands and prints a contract diff: tools added/removed, schema
  changes, result differences per case. Release-notes material and a migration checker
  in one.
- **`vib gen` (opt-in LLM).** Given `tools --json`, proposes a starter suite covering
  happy path, each required-arg omission, boundary values, and `expectError` cases.
  Writes *proposals*; every case still goes through `record` for ground truth.
- **`vib explain <case>`**: human-readable paraphrase of what a case asserts (helps PR
  review of agent-authored suites).
- `vib init` templates for TypeScript / Python / Go servers (detect `pyproject.toml`,
  `go.mod`), and a `--from-claude-config` that reads `.mcp.json` / Claude Desktop config
  to pre-fill `server`.

### 3.10 Model-in-the-loop (separate package: `@jmoak/vibrissa-evals`)

Kept out of core so the core stays deterministic and dependency-light. Same JSON
philosophy:

```jsonc
{
  "prompt": "Turn the lights off in the kitchen",
  "expectToolCall": { "name": "lights.set", "args": { "$partial": true, "room": "kitchen", "on": false } },
  "model": "claude-opus-5-5",
  "runs": 5, "passRate": 0.8
}
```

- Negative cases (`"expectNoToolCall": true`) and overlap cases ("two similar tools,
  which one?") — the things vendor guides agree matter most.
- Runs through the Anthropic SDK with `thinking: { type: "adaptive" }`; model is a
  config knob, default `claude-opus-5-5`.
- Reports tool-selection accuracy over time with the same delta gating as 3.7.
- **Description A/B**: `vib evals --manifest alt-manifest.json` re-runs the prompt set
  with edited descriptions without touching the server. Iterate on descriptions like
  prompts.

### 3.11 Library & integrations

- Stable programmatic API: `runCases`, `openSession`, `matchValue`, `normalize`, reporter
  interface, matcher plugin interface (`registerMatcher('$semver', fn)`).
- `vibrissa/vitest`: `describeCases('tests/integration/**/*.json')` expands each case into
  a Vitest test so teams with existing runners get one report.
- Pluggable transports so a Python / Go server team can still use the JSON suite.

---

## 4. Config & schema v2 sketch

```jsonc
{
  "$schema": "./node_modules/@jmoak/vibrissa/schema/vibrissa.schema.json",
  "servers": {
    "local":   { "cmd": "node", "args": ["dist/index.js"], "protocol": "auto" },
    "staging": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  },
  "defaultServer": "local",
  "globs": ["tests/integration/**/*.json"],
  "manifest": "tests/integration/__manifest__.json",
  "normalize": { "stripMeta": ["io.modelcontextprotocol/*"], "dropKeys": ["resultType"] },
  "timeoutMs": 15000,
  "budgetMs": 2000,
  "reporters": ["console", "junit"],
  "profiles": {
    "ci":    { "reporters": ["console", "junit", "github"], "check": true, "repeat": 1 },
    "smoke": { "tags": ["smoke"], "failFast": true }
  },
  "hooks": { "setup": [ … steps … ], "teardown": [ … ] }
}
```

Case files: v1 shape stays valid. New top-level keys: `steps`, `resource`,
`resourceTemplate`, `prompt`, `respond`, `expectInputRequired`, `await`, `capture`,
`budgetMs`, `tags`, `server`, `normalize`, `validateOutput`, `flaky`, `teardown`.

---

## 5. CLI v2 surface

```
vib run        [--profile ci] [--tag smoke] [--shard 1/4] [--repeat 5] [--update] [--trace] [--check] [--baseline f]
vib discover | tools | resources | prompts
vib call <tool> | read <uri> | get-prompt <name>
vib record <tool|--resource|--prompt|--flow|--from-tap> …
vib manifest record | diff
vib check      (spec-sanity + description lint)
vib fuzz <tool> [--runs N] [--seed S] [--inject] [--record-failures]
vib tap -- <server cmd>
vib diff --against "<cmd>"
vib migrate    (v1 → v2 case/config rewrite)
vib inspect | conformance   (wrappers)
vib evals      (plugin)
```

---

## 6. Compatibility & migration

- v1 case files and `vibrissa.json` load unchanged. `server` (singular) is sugar for
  `servers.default`.
- `vib migrate` rewrites error-code names, adds `$schema` pointing at the correct
  `@jmoak/vibrissa` path (v1 writes `node_modules/vibrissa/…`, which never resolves —
  fix regardless), and offers to record a manifest.
- Goldens recorded under v1 against 2025 servers keep passing against 2026 servers
  because normalization strips the new envelope fields by default.

---

## 7. Prioritization

**Must (defines v2):**
SDK v2 + era negotiation · Streamable HTTP · normalization · resources & prompts ·
manifest lock · flows with capture · MRTR scripting · JSON/JUnit/GitHub reporters ·
transcripts on failure · `--update` · tags/profiles/watch · `vib migrate`.

**Should (makes v2 best-in-class):**
`outputSchema` enforcement · `vib fuzz` · `vib check` spec-sanity + description lint ·
`vib tap` · `vib diff --against` · perf budgets + delta gating · tasks polling ·
assertion matchers v2 · Vitest bridge.

**Could (differentiators, after the above ship):**
`@jmoak/vibrissa-evals` · `vib gen` · `vib explain` · GitHub Action · conformance wrapper ·
output-injection probes · matcher plugins.

**Won't:** hosted UI, registry, OAuth debugger, general eval platform.

Suggested sequencing: ship **v2.0** = Must list on the v2 SDK (one breaking release,
one migration story). Then **2.1** flows/fuzz/check, **2.2** tap/diff/perf, **2.3** evals
plugin.

---

## 8. Open questions

1. **Normalization defaults** — strip `serverInfo` always, or keep `name` and strip only
   `version`? (Keeping `name` catches "wrong server launched" mistakes.)
2. **Manifest granularity** — fail on description change by default (strict, catches
   poisoning) or warn-only (less churn)? Proposal: fail, with `--update-manifest`.
3. **Flows and concurrency** — flows need an isolated session; do we spawn one server
   per flow or serialize flows after parallel single-call cases?
4. **HTTP auth scope** — bearer header only, or also a minimal OAuth client-credentials
   grant? (Everything interactive stays out.)
5. **Evals plugin boundary** — same CLI (`vib evals`) via plugin discovery, or a separate
   bin? Plugin discovery keeps one mental model.
6. **Python/Go users** — is `npx vib` acceptable, or do we need a single-binary build
   (pkg / bun compile) for non-Node shops?

---

## 9. Sources consulted

- MCP 2026-07-28 changelog — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MRTR pattern — https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- TypeScript SDK v2 migration — https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
- SDK v2 betas announcement — https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/
- Official conformance framework — https://github.com/modelcontextprotocol/conformance
- "7 assertions for the 2026-07-28 spec" (layered eval model, delta gating) — https://techsy.io/en/blog/mcp-evaluation-guide
- MCP Inspector v2 / MCPJam feature comparison — https://www.mcpjam.com/blog/mcp-inspector-v2-guide
- Braintrust on tool-selection evals — https://www.braintrust.dev/articles/best-mcp-testing-tools-agent-evals-2026
- mcp-scan (tool pinning / rug pulls) — https://invariantlabs.ai/blog/introducing-mcp-scan
- Pact bi-directional contracts & Drift — https://docs.pact.io/blog/2026/05/22/pact-open-source-update-may-2026
