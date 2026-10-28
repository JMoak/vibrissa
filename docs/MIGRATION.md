# Migrating from v1 to v2

v2 is one breaking release with one migration story. Most suites need no edits: v1 case
files and v1 `vibrissa.json` files load unchanged, and goldens recorded against 2025-era
servers keep passing against 2026-era servers.

## The short version

```bash
npm i -D @jmoak/vibrissa@^2
npx vib migrate --dry-run  # see what would change
npx vib migrate            # servers map, $schema paths, error-code names
npx vib run                # same suite, now on the v2 client
npx vib manifest record    # recommended: lock the server surface
```

Review the diff, commit, done. The rest of this page explains what changed and why.

## What changed in the protocol

MCP revision **2026-07-28** rewrote the core. The parts that matter to a contract tester:

| 2026-07-28 change | What Vibrissa does about it |
|---|---|
| `initialize` removed; `server/discover` added; version and capabilities ride on every request's `_meta` | Era negotiation: `protocol: "auto"` speaks either era. |
| Every result carries `resultType`; servers stamp `_meta["io.modelcontextprotocol/serverInfo"]` | Normalization strips both before matching and recording. |
| Multi Round-Trip Requests (`input_required`) replace server-initiated elicitation, sampling, roots | Cases script answers with `respond` and assert the question with `expectInputRequired`. |
| No protocol sessions; state lives in server-minted handles passed as tool args | Flows: `steps` with `capture` and `{{name}}`. |
| `tools/list` must be deterministic; list results carry `ttlMs` / `cacheScope` | Manifest lock; `vib check` verifies determinism and cache hints. |
| `inputSchema` / `outputSchema` are JSON Schema 2020-12 | `structuredContent` is validated against `outputSchema` on every call. |
| Tasks moved to an extension with `tasks/get` polling | `await` polls; `expectTask` asserts the handle. |
| Error codes renumbered (`-32020..-32022`); resource-not-found is `-32602` | Stable code names that match on both eras. |
| Roots, sampling, logging deprecated | Not built on. Server stderr is the logging story. |

## What changed in Vibrissa

- **Client:** `@modelcontextprotocol/sdk` 1.x is replaced by `@modelcontextprotocol/client`
  2.x. Against a 2025-era server, `auto` falls back to the `initialize` handshake.
- **Transports:** Streamable HTTP servers (`{ "url", "headers" }`) alongside stdio.
- **Config:** a `servers` map with `defaultServer`, `profiles`, `${ENV}` interpolation,
  `normalize`, `manifest`, `hooks`, `checks`, `reporters`. See [CONFIG.md](./CONFIG.md).
- **Cases:** resources, resource templates, prompts, flows, MRTR, tasks, budgets, tags,
  per-case servers. See [CASES.md](./CASES.md).
- **Matchers:** `$any`, `$type`, `$schema`, `$oneOf`, `$contains`, `$length`, `$number`,
  `$ignore`, `$ref`, `$literal`. See [MATCHERS.md](./MATCHERS.md).
- **Commands:** `discover`, `resources`, `prompts`, `read`, `get-prompt`, `manifest`,
  `check`, `fuzz`, `tap`, `migrate`, and more. See [CLI.md](./CLI.md).
- **Reporting:** console, json, junit, github, tap; transcripts on failure; `--baseline`
  delta gating. See [CI.md](./CI.md).

## What stays the same

- The case shape: `name`, `tool`, `args`, `expect`, `expectError`.
- Every v1 matcher: `$partial`, `$regex`, `$wildcard`, `$unordered`.
- `server` (singular) in config. It is now sugar for `servers.default`.
- The bins: `vib` and `vib-test` are the same binary; bare `vib` means `vib run`.
- The loop: `tools`, `call`, `record`, `run`, `inspect`.
- Exit codes: `0` when everything passed, non-zero otherwise. Zero matching cases is still
  a failure unless `allowEmpty`.

## `vib migrate`

Rewrites v1 files in place so they say what v2 means. It is idempotent: a second run
changes nothing.

| It rewrites | From | To |
|---|---|---|
| Config `server` (also inside profiles) | `"server": { ... }` | `"servers": { "default": { ... } }` plus `"defaultServer": "default"` |
| `$schema` in cases and config | missing, `.../node_modules/vibrissa/schema/...`, or `https://unpkg.com/vibrissa/...` | the `@jmoak/vibrissa` schema (local path when installed, else unpkg) |
| `expectError.code` aliases | `RequestTimedOut`, `Timeout` | `RequestTimeout` |
| | `ConnectionLost` | `ConnectionClosed` |
| | `UnsupportedVersion` | `UnsupportedProtocolVersion` |
| | `HeaderMismatchError` | `HeaderMismatch` |
| v1 numeric codes that no longer arrive as numbers | `-32000`, `-32001`, `-32002` | `ConnectionClosed`, `RequestTimeout`, `ResourceNotFound` |

v1 `vib init` wrote a `$schema` path under `node_modules/vibrissa/`, which never existed
(the package is scoped). The fix gives you editor completion again.

It does not touch `expect` bodies; goldens do not need rewriting (see below). Files that
contain comments are left alone and reported as needing a manual edit unless you pass
`--force`, which drops the comments; either way the command exits `1` so the leftover is
not missed. v1 keys with no effect in v2 (`display`) are reported with what to use
instead. `--dry-run` shows the edits without writing; `--manifest` also records the
manifest lock. Record one: the lock is what turns a changed tool description into a
failing PR instead of a silent change. Flags: [CLI.md](./CLI.md#vib-migrate).

## Why your goldens stay green

A v1 golden was recorded from a 2025 server:

```json
{
  "name": "echo basic",
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": { "content": [{ "type": "text", "text": "hello" }] }
}
```

A 2026 server answers the same call with more envelope:

```json
{
  "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "vibrissa-echo-fixture", "version": "2.0.0" } },
  "content": [{ "type": "text", "text": "hello" }],
  "resultType": "complete"
}
```

Default normalization drops `resultType` and every `_meta` key matching
`io.modelcontextprotocol/*` (removing `_meta` once it is empty), so the matcher sees
exactly the v1 shape. `record` normalizes the same way, so new goldens stay clean too.

Two edge cases:

- If your server puts its **own** data under an `io.modelcontextprotocol/` `_meta` key,
  it is stripped as well. Narrow `normalize.stripMeta` to the keys you want gone.
- To assert the envelope itself, set `"normalize": false` on that case.

## Error codes

v1 case names keep working. What changed is how errors arrive:

| Situation | v1 (SDK 1.x) | v2 |
|---|---|---|
| Unknown resource on a 2026 server | n/a | `-32602` with `data: { uri }`. `ResourceNotFound` still matches. |
| Unknown resource on a 2025 server | `-32002` | `-32002`. `ResourceNotFound` matches. |
| Timeout | `-32001` `RequestTimeout` from the SDK | Client-side `RequestTimeout`. Same name. |
| Server exited | `-32000` `ConnectionClosed` | Client-side `ConnectionClosed`. Same name. |
| Version / header / capability errors | n/a | `UnsupportedProtocolVersion` (-32022), `HeaderMismatch` (-32020), `MissingRequiredClientCapability` (-32021). |

`expectError.code` now also accepts numbers. A number matches only that exact code the
server sent, so `-32001` no longer matches a timeout (timeouts are raised by the client and
carry no wire code) and `-32002` no longer matches a 2026 server's not-found. Prefer names;
`vib migrate` converts these three. The full list is in [CASES.md](./CASES.md#error-codes).

## Breaking changes

1. **`outputSchema` is enforced.** A tool that declares `outputSchema` and returns
   `structuredContent` that violates it now fails, even when the golden matches. Fix the
   server, or set `"validateOutput": false` on the case while you do.
2. **Library API.** `runCases` still accepts the v1 shape (`{ server, globs, timeoutMs,
   failFast }`) and the v2 `RunOptions` (`servers` + `defaultServer`), and still resolves to
   an exit code (now `2` for configuration errors). `McpSession` is the v2 session:
   `McpSession.start(server, { timeoutMs })` instead of `start(server, timeoutMs)`, and calls
   return an `Outcome` (`kind: "result" | "error" | "input_required"`). The v1 type
   `ToolCallOutcome` is gone from the package root; `defaultRunCasesOptions` and
   `RunCasesOptions` remain as deprecated aliases.
3. **Console output changed.** The console reporter replaces v1's display. Scripts that
   scraped stdout should use `vib run --json` (one JSON report on stdout) or read
   `reports/results.json` from the `json` reporter.
4. **Config key `display` is ignored.** Use `--pretty` / `--no-pretty`.
5. **`$id` of both schemas** moved to `https://unpkg.com/@jmoak/vibrissa/schema/...`.
6. **Manifest drift fails runs** once you have recorded a manifest. That is the point;
   `--update-manifest` accepts intended changes. Without a lock, `vib run` warns, or fails
   with `requireManifest: true`.
7. **Case files are validated on load.** Unknown keys, `expect` together with
   `expectError`, unknown `$` keys in expectations (`$partail`), unknown
   `expectError.code` names, malformed matchers, and placeholders that nothing captures
   fail the case before it runs, with a did-you-mean (v1 ignored some of these). Data that
   really has `$`-keys goes in `{"$literal": ...}`; `vib record` does that for you.
8. **Config files are validated too.** An unknown key in `vibrissa.json` (or a profile) is
   an error, exit `2`, with a did-you-mean; all problems are listed at once.
9. **Protocol version on 2025 servers.** The v2 client negotiates up to `2025-11-25` on
   the legacy era. Servers pinned to older revisions still connect; their negotiated
   version may differ from what v1 reported.

## FAQ

**Do I have to re-record anything?** No. Run `vib run` first. Re-record only cases that
fail for a real reason.

**My server is still on the 2025 SDK. Do I need to change it?** No. `protocol: "auto"`
falls back to `initialize`.

**How do I prove my server works on both eras?** Add a profile that pins the old
handshake and run both in CI:

```json
{ "profiles": { "legacy": { "servers": { "default": { "protocol": "legacy" } } } } }
```

```bash
vib run && vib run --profile legacy
```

Both runs check the same manifest lock: `protocolVersion` and `listMeta` (the 2026 list
cache hints) are in the default `manifestIgnore`, so the legacy run does not report drift.
Exclude cases that need 2026 features (tasks, the raw envelope) from the legacy profile with
`excludeTags`.

**A tool now pauses with `input_required` and my case fails.** The server moved to MRTR.
Add a `respond` entry for the method in the error message. `vib record` captures the
question into `expectInputRequired` for you.

**My stateful tests relied on one long-lived session.** Each case still runs on a
session, but 2026 servers keep no protocol state. Turn the sequence into one flow
(`steps`) and pass handles with `capture`.

**Can I keep `vib-test` in my npm scripts?** Yes. Both bins stay.

**Where did the roadmap in FUTURE.md go?** Mostly shipped in 2.0. What is left is in
[FUTURE.md](./FUTURE.md).
