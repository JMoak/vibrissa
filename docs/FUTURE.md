## FUTURE — Roadmap ideas for Vibrissa

### Tags and filters
- Add case metadata: `tags: string[]` on each case JSON.
- CLI selection:
  - `--tag <tag>`: include only cases with tag
  - `--exclude-tag <tag>`: exclude cases with tag
- Support multiple occurrences; combine with globs.

Example case snippet:
```json
{
  "name": "echo basic",
  "tags": ["smoke", "tools"],
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": { "content": [{ "type": "text", "text": "hello" }] }
}
```

### Transcripts and record mode
- On failure, persist MCP stdio transcript per case to `artifacts/transcripts/<case>.ndjson`.
- `--record` flag to save transcripts for all runs, not just failures.
- Include server stderr/stdout capture and a minimal HTML or JSON summary index.

### Profiles
- Extend config with `profiles` (already in schema) and load via `--profile <name>`.
- Merge strategy: `defaults` → `config` → `profiles[name]` → CLI flags.
- Common profiles: `smoke`, `ci`, `slow`, `perf`.

Example run:
```bash
vib-test --profile ci
```

### Fixtures: echo server
- Done: `tests/fixtures/echo-server/` dogfoods Vibrissa end-to-end.

### MCP Inspector integration
- `vib-test inspect` launches `@modelcontextprotocol/inspector` using the resolved Vibrissa server block (command/args/cwd/env).
- Positioning: Inspector for visual exploration; Vibrissa for authoring (`tools`/`call`/`record`) and regression (`run`).
- Optional CLI mode: `vib-test inspect --cli -- --method tools/list`

### Watch mode
- `vib-test --watch` to re-run affected cases on file changes.
- Debounce changes; show succinct pass/fail summary; support `--tag` with watch.


