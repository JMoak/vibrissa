# After 2.0

The v1 roadmap that lived here (tags and filters, failure transcripts, profiles, the echo
fixture, the Inspector wrapper) shipped in 2.0, along with most of
[V2_SCOPE.md](./V2_SCOPE.md). What is left, roughly in priority order:

| Item | Notes | Scope ref |
|---|---|---|
| `vib show-trace <file>` | Pretty-print `reports/traces/*.ndjson`. Transcripts are written today; only the viewer is missing. | §3.8 |
| `vib run --watch` | Re-run affected cases on file changes; debounce; works with `--tag`. | §3.8 |
| `vib run --perf` | p50 / p95 per tool into `reports/perf.json`. Budgets and baseline latency gating already ship. | §3.7 |
| Matcher plugins | `registerMatcher('$semver', fn)`, mirroring `registerReporter`. | §3.11 |
| GitHub Action | `jmoak/vibrissa-action` wrapping `vib run` with artifact upload and baseline download. `vib init --ci` covers the common case today. | §3.8 |
| `@jmoak/vibrissa-evals` | Model-in-the-loop tool-selection evals (`expectToolCall`, `passRate`, description A/B), as a separate package so the core stays deterministic. | §3.10 |
| `vib gen` | Opt-in LLM proposals for a starter suite; every proposal still goes through `record`. Lives with the evals package. | §3.9 |
| Pluggable transports | Beyond stdio and Streamable HTTP. | §3.11 |
| OAuth client credentials | Minimal non-interactive grant for HTTP servers. Today: static headers with `${ENV}` tokens. | §8 Q4 |
| Single-binary build | For teams without Node (`npx` works today). | §8 Q6 |

Settled by 2.0 (from V2_SCOPE §8):

- Normalization strips the whole `io.modelcontextprotocol/serverInfo` stamp by default;
  the manifest lock records server identity instead.
- A changed description fails the manifest check by default; `--update-manifest` accepts.
- Flows run on one session per worker and are never split across workers or shards.
- HTTP auth is static headers only.
- One manifest lock serves both protocol eras: `protocolVersion` and `listMeta` are ignored by
  default (`vib manifest diff --strict` compares them).
