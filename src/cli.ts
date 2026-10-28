#!/usr/bin/env node
/**
 * `vib` / `vib-test` entry point: the command table, help, flag checks, and the error →
 * exit-code mapping (0 ok · 1 failed · 2 usage / config / connection error).
 *
 * Under `--json` every outcome is one JSON object on stdout: `{ ok: true, ... }` on success,
 * `{ ok: false, error: { type, code, message, hint }, next? }` on any failure (nothing is
 * duplicated on stderr).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UsageError,
  assertKnownFlags,
  closest,
  normalizeArgv,
  printJson,
  setJsonStyle,
  splitAtDoubleDash,
} from './cli/args.js'
import { callCommand } from './cli/call.js'
import { checkCommand } from './cli/check.js'
import { diffCommand, diffHelp } from './cli/diff.js'
import { discoverCommand } from './cli/discover.js'
import { explainCommand } from './cli/explain.js'
import { type CommandHelp, acceptedFlags, colors, formatCommandHelp } from './cli/format.js'
import { fuzzCommand } from './cli/fuzz.js'
import { getPromptCommand } from './cli/get-prompt.js'
import { initCommand } from './cli/init.js'
import { conformanceCommand, inspectCommand } from './cli/inspect.js'
import { manifestCommand, manifestHelp } from './cli/manifest.js'
import { migrateCommand } from './cli/migrate.js'
import { promptsCommand } from './cli/prompts.js'
import { readCommand } from './cli/read.js'
import { recordCommand } from './cli/record.js'
import { resourcesCommand } from './cli/resources.js'
import { runCommand, runHelp } from './cli/run.js'
import { tapCommand } from './cli/tap.js'
import { toolsCommand } from './cli/tools.js'
import { ConfigError } from './config.js'
import { SessionRequestError, SessionStartError } from './session/index.js'

export interface CommandSpec extends CommandHelp {
  run: (argv: string[]) => Promise<number>
  /** stdout carries a protocol stream: never print errors/JSON there. */
  protocolStdout?: boolean
}

const GROUPS: Array<[string, string]> = [
  ['setup', 'Setup — create or upgrade a project'],
  ['explore', 'Explore — what does the server offer?'],
  ['probe', 'Probe — try one operation'],
  ['capture', 'Capture — turn reality into cases'],
  ['gate', 'Gate — run and review the suite'],
  ['harden', 'Harden — checks and fuzzing'],
  ['wrappers', 'Wrappers — official tools, pre-configured'],
]

const MRTR_FLAGS = [
  {
    flag: '--respond <json>',
    text: 'Scripted answers for input requests, keyed by method: \'{"elicitation/create": {"action": "accept", "content": {...}}}\' (repeatable)',
  },
  {
    flag: '--respond-key m=<json>',
    text: 'One scripted answer: elicitation/create=\'{"action":"accept"}\' (repeatable)',
  },
  { flag: '--await', text: 'Tasks extension: poll tasks/get until the task finishes' },
  {
    flag: '--await-timeout <ms>',
    text: 'Give up polling after this long (implies --await; default 30000)',
  },
]

const ARG_FLAGS = [
  { flag: "--args '<json>'", text: 'Arguments as a JSON object' },
  {
    flag: '--arg key=value',
    text: 'One argument (repeatable; true/false/null/numbers/JSON parsed)',
  },
]

const EXPECT_MISSING = {
  flag: '--expect-missing',
  text: 'Skip the check that the name is listed by the server (to probe unknown names)',
}

const BRIEF = { flag: '--brief', text: 'Only failures and warnings' }

export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    name: 'init',
    group: 'setup',
    summary:
      'Scaffold vibrissa.json, a real sample case from your server, a sample flow, optionally CI',
    usage: [
      'vib init [--dir .] [--server "<cmd>"|<url>] [--from-claude-config [file]] [--force]',
      'vib init --ci        (only writes .github/workflows/vibrissa.yml when vibrissa.json exists)',
    ],
    description:
      'Detects the server command: package.json bin/main/dist, pyproject.toml (python -m <pkg>), go.mod (go run .).\nThe server is named "default". If it starts, the first tool is called with minimal generated args and\nrecorded as a real case; otherwise a skipped sample is written for you to edit. Adds reports/ to .gitignore.\n--from-claude-config reads .mcp.json, else Claude Desktop\'s claude_desktop_config.json (mcpServers);\nliteral secrets in env/headers are replaced with ${VAR} references.',
    flags: [
      { flag: '--dir <path>', text: 'Target directory (default .)' },
      { flag: '--server <cmd|url>', text: 'Server command line or URL (skips detection)' },
      { flag: '--from-claude-config [file]', text: 'Pre-fill servers from a Claude config' },
      {
        flag: '--ci',
        text: 'Write .github/workflows/vibrissa.yml (runs vib run --profile ci; the profile carries the flags)',
      },
      {
        flag: '--no-call',
        text: 'Do not call a tool for the sample (writes a skipped placeholder instead)',
      },
      { flag: '--protocol <mode>', text: 'Set protocol on the scaffolded servers' },
      { flag: '--timeout <ms>', text: 'timeoutMs for the config (default 15000)' },
      { flag: '--force', text: 'Overwrite existing files' },
      { flag: '--json', text: 'Machine-readable output' },
    ],
    examples: [
      'vib init',
      'vib init --server "uv run my-server"',
      'vib init --from-claude-config',
      'vib init --ci',
    ],
    run: initCommand,
  },
  migrate: {
    name: 'migrate',
    group: 'setup',
    summary: 'Rewrite v1 config and case files to v2 in place (idempotent)',
    usage: ['vib migrate [--dry-run] [--manifest] [--cases <glob>] [--force]'],
    description:
      'server → servers.default + defaultServer (also in profiles); $schema added / fixed to @jmoak/vibrissa;\nexpectError.code aliases renamed (RequestTimedOut → RequestTimeout) and v1 numeric codes named\n(-32001 → RequestTimeout, -32002 → ResourceNotFound). Leftover v1 keys (display) are reported.\nFiles with comments are left alone unless --force. Exit 1 when a file could not be migrated.',
    flags: [
      { flag: '--dry-run', text: 'Show what would change; write nothing' },
      { flag: '--manifest', text: 'Also record the manifest lock (vib manifest record)' },
      { flag: '--cases <glob>', text: 'Case files to migrate (default: config globs)' },
      {
        flag: '--force',
        text: 'Rewrite files even if they contain comments (comments are dropped)',
      },
    ],
    common: true,
    examples: ['vib migrate --dry-run', 'vib migrate --manifest'],
    run: migrateCommand,
  },
  discover: {
    name: 'discover',
    group: 'explore',
    summary: 'Show protocol era/version, server identity, capabilities, extensions, instructions',
    usage: ['vib discover [--json]'],
    description:
      'Calls server/discover (2026-07-28) or reads the initialize result (2025 era).\n--json: { ok, era, protocolVersion, supportedVersions, serverInfo, capabilities, extensions, instructions, synthesized, transport, next }.',
    common: true,
    examples: [
      'vib discover',
      'vib discover --server staging --json',
      'vib discover --protocol legacy',
    ],
    run: discoverCommand,
  },
  tools: {
    name: 'tools',
    group: 'explore',
    summary: 'List tools (name, title, description, arguments, hints), or show one in detail',
    usage: ['vib tools [--json]', 'vib tools <name> [--json]'],
    description:
      '--json: { ok, tools: ToolSummary[], listMeta: { tools: { ttlMs, cacheScope } } }; with <name>: { ok, tool }.',
    flags: [EXPECT_MISSING],
    common: true,
    examples: ['vib tools', 'vib tools echo', 'vib tools --json | jq ".tools[].name"'],
    run: toolsCommand,
  },
  resources: {
    name: 'resources',
    group: 'explore',
    summary: 'List resources (uri, mime type) and resource templates',
    usage: ['vib resources [--json]'],
    description:
      '--json: { ok, resources, resourceTemplates, listMeta: { resources, resourceTemplates } }; a list the server does not support has listMeta.<list>.unsupported = true.',
    common: true,
    run: resourcesCommand,
  },
  prompts: {
    name: 'prompts',
    group: 'explore',
    summary: 'List prompts and their arguments',
    usage: ['vib prompts [--json]'],
    description: '--json: { ok, prompts, listMeta: { prompts } }.',
    common: true,
    run: promptsCommand,
  },
  call: {
    name: 'call',
    group: 'probe',
    summary: 'Call a tool once and print the (normalized) result',
    usage: [
      "vib call <tool> [--args '{...}'] [--arg k=v] [--respond '{...}'] [--await] [--validate] [--raw]",
    ],
    description:
      'Prints the result after config "normalize" (what a golden would hold); --raw shows the wire result.\nThe tool must be listed by the server (did-you-mean otherwise; --expect-missing skips the check).\nstructuredContent is always checked against the outputSchema: a violation is a warning, or a failure with --validate.\nWhen the server asks for input (MRTR) and nothing answers, the request is printed with a ready-to-paste --respond.\nExit 1 on an error, an unanswered input request, or a failed --validate.',
    flags: [
      ...ARG_FLAGS,
      ...MRTR_FLAGS,
      {
        flag: '--validate',
        text: 'Fail (exit 1) when structuredContent violates the outputSchema, and print the verdict',
      },
      { flag: '--raw', text: 'Print the raw wire result (skip normalization)' },
      EXPECT_MISSING,
    ],
    common: true,
    examples: [
      'vib call echo --arg text=hello',
      'vib call typed --args \'{"a": 1, "b": 2}\' --validate',
      'vib call confirm --respond \'{"elicitation/create": {"action": "accept", "content": {"confirm": true}}}\'',
      'vib call slow --await --json',
    ],
    run: callCommand,
  },
  read: {
    name: 'read',
    group: 'probe',
    summary: 'Read a resource by URI (or expand a URI template with --arg)',
    usage: ['vib read <uri> [--raw]', "vib read '<uri-template>' --arg key=value"],
    description:
      'The URI must be listed by resources/list or match a listed template (--expect-missing skips the check).',
    flags: [
      ...ARG_FLAGS,
      ...MRTR_FLAGS.slice(0, 2),
      { flag: '--raw', text: 'Print the raw wire result' },
      EXPECT_MISSING,
    ],
    common: true,
    examples: ['vib read file:///README.md', "vib read 'users://{id}' --arg id=42 --json"],
    run: readCommand,
  },
  'get-prompt': {
    name: 'get-prompt',
    group: 'probe',
    summary: 'Get a prompt with arguments and print its messages',
    usage: ["vib get-prompt <name> [--args '{...}'] [--arg key=value] [--raw]"],
    description:
      'Prompt arguments are strings on the wire; non-string --arg values are sent as JSON text.',
    flags: [
      ...ARG_FLAGS,
      ...MRTR_FLAGS.slice(0, 2),
      { flag: '--raw', text: 'Print the raw wire result' },
      EXPECT_MISSING,
    ],
    common: true,
    examples: ['vib get-prompt greet --arg name=Jordan --arg style=terse'],
    run: getPromptCommand,
  },
  record: {
    name: 'record',
    group: 'capture',
    summary: 'Run an operation live and write it as a case file (the golden is reality)',
    usage: [
      'vib record <tool> [--arg k=v] [--respond ...] [--await] [--partial]',
      'vib record --resource <uri> | --resource-template <tpl> --arg k=v | --prompt <name> --arg k=v',
      'vib record --flow [--name "..."]        (stdin: one step per line)',
      'vib record --from-tap <file> [--select <n|name|all>]',
    ],
    description:
      'Results go through config "normalize", then matcher-like keys are escaped ($literal), so the golden matches what vib run compares.\nVolatile values are loosened: ISO timestamps, UUIDs, epoch-ms numbers, and anything that differs between two back-to-back\ncalls (--no-stable-check skips the second call; --exact keeps everything verbatim). See docs/CASES.md "Generated ids and timestamps".\nErrors become expectError (code name + message prefix). Input requests are recorded as respond + expectInputRequired;\nwithout --respond you are asked in a terminal, and non-interactive runs fail with the exact --respond to pass.\nA result that violates the tool\'s outputSchema is refused unless --allow-invalid-output.\nFiles go to the directory of the first config glob (deduplicated names); --server <name> writes "server" into the case.\n--flow reads steps until an empty line: `<tool> {"json": "args"}`, `<tool> key=value ...`, or NDJSON objects\n({"tool": ..., "args": ..., "respond": ...}). Server-minted ids reused by later steps become {{captures}} automatically (--no-capture to disable).\n--from-tap lists the calls in a vib tap capture; --select picks them (1-based index, range 2-5, tool/prompt name or URI, all).',
    flags: [
      ...ARG_FLAGS,
      { flag: '--resource <uri>', text: 'Record resources/read' },
      {
        flag: '--resource-template <tpl>',
        text: 'Record a URI template read (expanded with --arg)',
      },
      { flag: '--prompt <name>', text: 'Record prompts/get' },
      ...MRTR_FLAGS,
      { flag: '--partial', text: 'Wrap the expectation in "$partial": true' },
      { flag: '--exact', text: 'Keep every value verbatim (no volatile-field loosening)' },
      {
        flag: '--no-stable-check',
        text: 'Do not repeat the call to find values that change between calls',
      },
      {
        flag: '--allow-invalid-output',
        text: 'Write the golden even if structuredContent violates the outputSchema',
      },
      EXPECT_MISSING,
      { flag: '--flow', text: 'Record a multi-step flow from stdin' },
      { flag: '--no-capture', text: '--flow: do not infer {{captures}}' },
      { flag: '--from-tap <file>', text: 'Turn calls captured by vib tap into cases' },
      { flag: '--select <sel>', text: '--from-tap: which calls (repeatable, comma-separated)' },
      { flag: '--out-dir <dir>', text: '--from-tap: where to write (default <suite dir>/tap)' },
      { flag: '--out <path>', text: 'Case file (default <suite dir>/<name>.json)' },
      { flag: '--name <text>', text: 'Case name (default "<tool> <args>")' },
      { flag: '--tag <tag>', text: 'Add a tag (repeatable)' },
      { flag: '--force', text: 'Overwrite an existing case file' },
    ],
    common: true,
    examples: [
      'vib record echo --arg text=hello',
      'vib record --resource fixture://readme',
      'vib record confirm --respond \'{"elicitation/create": {"action": "accept", "content": {"confirm": true}}}\'',
      'printf \'%s\\n\' \'{"tool":"session.create","args":{"user":"jo"}}\' \'{"tool":"session.get","args":{"sessionId":"<id>"}}\' | vib record --flow --name "session"',
      'vib record --from-tap reports/tap/2026-10-28T12-00-00-000Z.ndjson --select 1,3',
    ],
    run: (argv) => recordCommand(argv),
  },
  tap: {
    name: 'tap',
    group: 'capture',
    summary: 'Transparent stdio proxy that captures real client usage to NDJSON',
    usage: [
      'vib tap [--out reports/tap/<ts>.ndjson] [--quiet] -- <server command...>',
      'vib tap [--server <name>]   (proxy the configured stdio server)',
    ],
    description:
      'Put it between a real client and your server, e.g. in .mcp.json:\n  "command": "npx", "args": ["vib", "tap", "--", "node", "dist/index.js"]\nBytes pass through unchanged (newline-delimited and Content-Length framing). Each tools/call, resources/read,\nprompts/get (plus initialize/discover/list/tasks context) is appended as {ts, seq, from, method, id, params, result|error, durationMs}.\nstdout is the protocol channel: vib tap prints status only to stderr. Exits with the server\'s exit code.\nThen: vib record --from-tap <file>.',
    flags: [
      {
        flag: '--out <file>',
        text: 'Capture file (default reports/tap/<timestamp>.ndjson; appended, seq continues)',
      },
      { flag: '--quiet', text: 'No status lines on stderr' },
      { flag: '--env KEY=VALUE', text: 'Extra env var for the server (repeatable)' },
      { flag: '--server-cwd <dir>', text: 'Working directory for the server' },
      { flag: '--config <path>', text: 'Config to read the server from (without --)' },
      { flag: '--server <name>', text: 'Configured server to proxy (without --)' },
      { flag: '--profile <name>', text: 'Profile for the configured server (without --)' },
    ],
    protocolStdout: true,
    examples: [
      'vib tap -- node dist/index.js',
      'vib tap --out reports/tap/session.ndjson -- python -m my_server',
    ],
    run: tapCommand,
  },
  // Help for run / manifest / diff lives with those commands (src/cli/{run,manifest,diff}.ts).
  manifest: { ...manifestHelp, group: 'capture', run: manifestCommand },
  run: { ...runHelp, group: 'gate', run: runCommand },
  diff: { ...diffHelp, group: 'gate', run: diffCommand },
  explain: {
    name: 'explain',
    group: 'gate',
    summary: 'Paraphrase what cases do and assert, and flag weak assertions',
    usage: [
      'vib explain                      (every case in the configured suite)',
      'vib explain <case.json | "case name" | "glob/**/*.json"> ... [--brief] [--full] [--json]',
    ],
    description:
      'Loads cases exactly like vib run (validation, $ref fragments, placeholder checks) and reports the same load errors.\nNames every matcher in plain words (docs/MATCHERS.md), and flags weak assertions: expectError {}, a bare root\n$partial, no expectation, validateOutput: false, ignoreErrors outside teardown, skipped cases. Exit 1 on load errors.',
    flags: [
      BRIEF,
      { flag: '--full', text: 'Show every assertion (default: first 40 per expectation)' },
      { flag: '--config <path>', text: 'Config whose suite (globs, servers) to use' },
      { flag: '--json', text: 'Structured explanation: { ok, cases: [...] }' },
    ],
    examples: [
      'vib explain',
      'vib explain tests/integration/echo.basic.json',
      'vib explain "echo basic"',
      'vib explain --brief --json',
    ],
    run: explainCommand,
  },
  check: {
    name: 'check',
    group: 'harden',
    summary: 'Spec-sanity checks + tool-description lint (poisoning, shadowing, exfiltration)',
    usage: ['vib check [--allow <id>] [--brief] [--verbose] [--json]', 'vib check --list'],
    description:
      'Offline, deterministic checks over the live manifest (docs/CHECKS.md). Config:\n  "checks": { "allow": ["desc/long-description", "desc/sensitive-paths:ssh.list_keys"], "severity": { "desc/embedded-url": "failed" } }\nExit 1 when any check failed (warnings never fail).',
    flags: [
      { flag: '--allow <id>', text: 'Skip a check (id, prefix/*, or id:subject; repeatable)' },
      { flag: '--list', text: 'List every check id with its default severity' },
      BRIEF,
      { flag: '--verbose', text: 'List passed checks individually' },
    ],
    common: true,
    run: checkCommand,
  },
  fuzz: {
    name: 'fuzz',
    group: 'harden',
    summary: 'Generate args from inputSchema and check invariants (no goldens needed)',
    usage: [
      'vib fuzz <tool> [--runs 100] [--seed S] [--strategy s] [--inject] [--budget ms] [--record-failures]',
      'vib fuzz <tool> --seed S --runs N --id <case-id>   (reproduce one case)',
    ],
    description:
      'Strategies: valid, boundary, invalid (default) and inject (prompt-injection payloads, via --inject).\nInvariants: valid args never get a protocol error or time out; invalid args get InvalidParams (or a tool error);\nthe server never crashes (it is restarted and fuzzing continues); structuredContent matches outputSchema;\nerrors do not echo injection payloads (warning). Afterwards: server alive, tools/list unchanged.\nDeterministic: the seed (default: the tool name) and --runs reproduce the same cases.',
    flags: [
      { flag: '--runs <n>', text: 'Cases to generate (default 100)' },
      {
        flag: '--seed <n|text>',
        text: 'Seed (default: the tool name); printed in every reproduce line',
      },
      {
        flag: '--strategy <s>',
        text: 'valid | boundary | invalid | inject (repeatable or comma-separated)',
      },
      { flag: '--inject', text: 'Add the inject strategy' },
      { flag: '--budget <ms>', text: 'Also fail calls slower than this' },
      {
        flag: '--strict-invalid',
        text: 'Invalid args must get JSON-RPC InvalidParams (a tool error fails)',
      },
      { flag: '--id <case-id>', text: 'Run a single case (same --seed/--runs as the report)' },
      {
        flag: '--record-failures',
        text: 'Write each failing case to <suite dir>/fuzz/<tool>-<id>.json',
      },
      { flag: '--out-dir <dir>', text: 'Where --record-failures writes' },
      BRIEF,
    ],
    common: true,
    examples: [
      'vib fuzz search --runs 200',
      'vib fuzz echo --inject --record-failures',
      'vib fuzz echo --seed echo --runs 100 --id invalid-3f9a1c2b7e',
    ],
    run: fuzzCommand,
  },
  inspect: {
    name: 'inspect',
    group: 'wrappers',
    summary: 'Open MCP Inspector on the configured server',
    usage: ['vib inspect [--cli] [-- extra inspector args]'],
    flags: [{ flag: '--cli', text: 'Inspector CLI mode instead of the UI' }],
    common: true,
    run: inspectCommand,
  },
  conformance: {
    name: 'conformance',
    group: 'wrappers',
    summary: 'Run the official MCP conformance suite against an HTTP server',
    usage: ['vib conformance [--server <url|name>] [-- extra conformance args]'],
    description:
      'Wraps npx @modelcontextprotocol/conformance server --url <url>. The official suite is HTTP-first;\nfor stdio servers use vib check (the deterministic subset).',
    common: true,
    run: conformanceCommand,
  },
}

/** `vib help cases`: everything needed to write a case, in about 2 KB. */
export const CASES_CHEATSHEET = `Vibrissa case files — cheat sheet (full reference: docs/CASES.md, docs/MATCHERS.md)

One JSON file = one case. One operation:
  "tool": "echo"  |  "resource": "file:///x"  |  "resourceTemplate": "users://{id}"  |  "prompt": "greet"
  "args": { ... }            tool args, template variables, or prompt args
  "expect": <expectation>    the normalized result; plain JSON = exact deep equality
  "expectError": { "code": "InvalidParams", "message": { "$regex": "must be" } }   (a tool isError counts)
Also: name, tags, server, skip, flaky, timeoutMs, budgetMs, validateOutput, normalize

Matchers (anywhere inside expect):
  {"$partial": true, ...}           extra keys / trailing items allowed below
  {"$regex": "^ok", "flags": "i"}   {"$wildcard": "req_*"}       strings
  {"$type": "string"}  {"$any": true} (present)  {"$ignore": true} (may be missing)
  {"$number": {"gte": 0, "lt": 10}}  {"$length": {"min": 1}}
  {"$contains": {...}, "count": 1}  {"$unordered": true, "value": [...]}   arrays
  {"$oneOf": [a, b]}  {"$schema": {...JSON Schema...}}  {"$ref": "./shared/x.json"}  {"$literal": {...}}
  Timestamps: {"$schema": {"type": "string", "format": "date-time"}}

Flows: "steps": [ step, ... ], plus "setup" / "teardown" (teardown runs on failure; "ignoreErrors": true)
  "capture": { "sid": "structuredContent.sessionId" }   then "{{sid}}" in later args / expect
  "{{env.NAME}}" reads an environment variable
Input requests (MRTR):
  "respond": { "elicitation/create": { "action": "accept", "content": { "confirm": true } } }
  "expectInputRequired": { "elicitation/create": { "$partial": true, "message": "Proceed?" } }
Tasks: "await": true  or  { "pollMs": 500, "timeoutMs": 30000 };  "expectTask": { "$partial": true, ... }

Examples:
  {"tool": "echo", "args": {"text": "hi"}, "expect": {"content": [{"type": "text", "text": "hi"}]}}
  {"tool": "echo", "args": {}, "expectError": {"code": "InvalidParams"}}
  {"steps": [
    {"tool": "session.create", "args": {"user": "jo"}, "capture": {"sid": "structuredContent.id"}},
    {"tool": "session.get", "args": {"id": "{{sid}}"},
     "expect": {"$partial": true, "structuredContent": {"user": "jo"}}}]}

Write cases: vib record <tool> --arg k=v · review: vib explain <file> · run: vib run`

const HELP_TOPICS: Record<string, () => string> = { cases: () => CASES_CHEATSHEET }

function version(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function formatGlobalHelp(): string {
  const c = colors()
  const out = [
    `${c.bold('vib')} ${c.dim(`(vib-test) ${version()}`)} — contract tests for MCP servers, written as JSON`,
    '',
    `${c.bold('Usage:')} vib <command> [options]      (no command = run)`,
  ]
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  for (const [group, title] of GROUPS) {
    out.push('', c.bold(title))
    for (const spec of Object.values(COMMANDS).filter((s) => s.group === group)) {
      out.push(`  ${c.cyan(spec.name.padEnd(width))}  ${spec.summary}`)
    }
  }
  out.push(
    '',
    c.bold('Every command:'),
    '  --config <path> · --server <name|cmd|url> · --profile <name> · --protocol auto|legacy|modern|<date>',
    '  --timeout <ms> · --env KEY=VALUE · --json (one JSON object on stdout; --compact for one line)',
    '',
    `Help for one command: ${c.cyan('vib <command> --help')} · case syntax: ${c.cyan('vib help cases')} · full flag reference: docs/CLI.md`,
    'Typical loop: vib init → vib discover → vib tools → vib call → vib record → vib manifest record → vib run --check',
    'Exit codes: 0 ok · 1 failed (assertion, check, tool error) · 2 usage/config/connection error',
  )
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  ok: false
  error: { type: string; code: string; message: string; hint: string }
  next?: string[]
}

function lastSentence(message: string): { detail: string; hint?: string } {
  const parts = message.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)
  if (parts.length < 2) return { detail: message.trim() }
  return { detail: parts.slice(0, -1).join(' '), hint: parts[parts.length - 1] }
}

/** Map anything thrown by a command to exit code + the `--json` envelope + human text. */
export function describeError(
  err: unknown,
  command: string,
): { exit: number; envelope: ErrorEnvelope; human: string } {
  const type = err instanceof Error ? err.name : 'Error'
  const fallbackHint = `Run vib ${command} --help for usage.`
  let exit = 1
  let code = 'internal'
  let message = err instanceof Error ? err.message : String(err)
  let hint: string | undefined
  let next: string[] | undefined
  if (err instanceof UsageError) {
    exit = 2
    code = err.code
    message = err.detail
    hint = err.hint
    next = err.next
  } else if (err instanceof ConfigError) {
    exit = 2
    code = 'config'
  } else if (err instanceof SessionStartError) {
    exit = 2
    code = err.code
    // The message may end with the server's stderr tail; the next step is about the server.
    hint = SERVER_START_HINT
    next = ['vib discover --server "<cmd>"', 'vib init --server "<cmd>"']
  } else if (err instanceof SessionRequestError) {
    code = err.error.codeName ?? 'request'
  } else if (type === 'ManifestFileError') {
    exit = 2
    code = 'manifest'
  }
  if (hint === undefined) {
    const split = lastSentence(message)
    if (
      split.hint &&
      /\b(run|pass|use|check|add|set|fix|try|make|point|export|start|edit|delete|re-run|quote)\b/i.test(
        split.hint,
      )
    ) {
      message = split.detail
      hint = split.hint
    }
  }
  hint ??= fallbackHint
  message = endSentence(message)
  return {
    exit,
    envelope: { ok: false, error: { type, code, message, hint }, ...(next ? { next } : {}) },
    human: `${message} ${hint}`,
  }
}

const SERVER_START_HINT =
  'Fix the server command in vibrissa.json, or try one with --server "<cmd> <args>" (vib init --server "<cmd>" writes it to the config).'

/** Close a message as a sentence (`..., ` / `...:` → `....`) so a hint can follow it. */
export function endSentence(text: string): string {
  const trimmed = text.trim().replace(/[\s,;:]+$/, '')
  return /[.!?)"'`]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function reportError(
  err: unknown,
  command: string,
  json: boolean,
  protocolStdout: boolean,
): number {
  const { exit, envelope, human } = describeError(err, command)
  if (json && !protocolStdout) printJson(envelope)
  else console.error(colors().red(`error: ${human}`))
  if (process.env.VIB_DEBUG && err instanceof Error && err.stack) console.error(err.stack)
  return exit
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run the CLI with `argv` (without node/script). Returns the exit code. */
export async function main(rawArgv: string[]): Promise<number> {
  const argv = normalizeArgv(rawArgv)
  const [ownAll] = splitAtDoubleDash(argv)
  const json = ownAll.includes('--json')
  setJsonStyle(ownAll.includes('--compact') ? 'compact' : 'auto')
  const first = argv[0]
  if (first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? argv[1] : undefined
    if (topic === undefined) console.log(formatGlobalHelp())
    else if (Object.hasOwn(COMMANDS, topic)) console.log(formatCommandHelp(COMMANDS[topic]))
    else if (Object.hasOwn(HELP_TOPICS, topic)) console.log(HELP_TOPICS[topic]())
    else {
      const topics = [...Object.keys(HELP_TOPICS), ...Object.keys(COMMANDS)]
      const suggestion = closest(topic, topics)
      return reportError(
        new UsageError(`Unknown help topic "${topic}".`, {
          code: 'unknown-topic',
          hint: `${suggestion ? `Did you mean "vib help ${suggestion}"? ` : ''}Topics: cases, or any command name.`,
          next: ['vib help cases', 'vib --help'],
        }),
        'help',
        json,
        false,
      )
    }
    return 0
  }
  if (first === '--version' || first === '-v') {
    console.log(version())
    return 0
  }
  let name = 'run'
  let args = argv
  if (first !== undefined && !first.startsWith('-')) {
    if (!Object.hasOwn(COMMANDS, first)) {
      const suggestion = closest(first, Object.keys(COMMANDS))
      return reportError(
        new UsageError(`Unknown command "${first}".`, {
          code: 'unknown-command',
          hint: `${suggestion ? `Did you mean "vib ${suggestion}"? ` : ''}Run vib --help to list commands.`,
          next: suggestion ? [`vib ${suggestion} --help`] : ['vib --help'],
        }),
        first,
        json,
        false,
      )
    }
    name = first
    args = argv.slice(1)
  }
  const spec = COMMANDS[name]
  const [own] = splitAtDoubleDash(args)
  if (own.includes('--help') || own.includes('-h')) {
    console.log(formatCommandHelp(spec))
    return 0
  }
  try {
    assertKnownFlags(own, acceptedFlags(spec), name)
    return await spec.run(args)
  } catch (err) {
    return reportError(err, name, json, Boolean(spec.protocolStdout))
  }
}

/**
 * Grace period before a forced exit. The process normally exits on its own once `main`
 * returned (every session is closed by then); calling process.exit while a socket or pipe
 * is still closing aborts on Windows (UV_HANDLE_CLOSING), so it is only the fallback for
 * something holding the event loop open.
 */
const FORCE_EXIT_AFTER_MS = 2000

/** Run `main` and exit with its code once pending I/O has drained. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const code = await main(argv)
  process.exitCode = code
  setTimeout(() => process.exit(code), FORCE_EXIT_AFTER_MS).unref()
}

function isEntryModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// `node dist/cli.js ...` runs directly; bin/vib-test.js imports this module and calls runCli().
if (isEntryModule()) await runCli()
