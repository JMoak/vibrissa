/**
 * McpSession: one live connection to an MCP server (stdio or Streamable HTTP), on either
 * protocol era, with raw-wire results.
 *
 * Design notes (see docs/V2_ARCHITECTURE.md "Session"):
 * - Results are the exact `result` objects the server put on the wire (captured at the
 *   transport), so `resultType` and `_meta` are present on 2026-07-28 servers. The session
 *   never normalizes; the runner does.
 * - Operations on one session are serialized (one in flight at a time). That keeps raw-result
 *   capture and per-call MRTR responders unambiguous. Use one session per worker.
 * - MRTR (`input_required`) is fulfilled by the SDK's auto-fulfil driver through handlers we
 *   register for elicitation/create, sampling/createMessage and roots/list. Those handlers ask
 *   the per-call responder, then the session responder; when neither answers, the handler
 *   throws, the flow stops (no retry), and the call resolves to `{ kind: 'input_required' }`.
 *   On legacy (2025) connections the same handlers answer real server→client requests.
 * - Tasks extension (SEP-2663): the client declares `io.modelcontextprotocol/tasks`; a
 *   `resultType: "task"` answer is returned as-is, or polled via `tasks/get` with `await`.
 */
import {
  Client,
  type ClientCapabilities,
  type JSONRPCMessage,
  ProtocolError,
  SERVER_INFO_META_KEY,
  SdkError,
  SdkErrorCode,
  type StandardSchemaV1,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UriTemplate,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type {
  AwaitOptions,
  DiscoverInfo,
  JsonObject,
  JsonValue,
  ListResult,
  PromptArgumentSummary,
  PromptSummary,
  ProtocolMode,
  ResourceSummary,
  ResourceTemplateSummary,
  ServerConfig,
  ServerIdentity,
  ToolSummary,
  TranscriptEntry,
} from '../types.js'
import { isHttpServerConfig } from '../types.js'
import {
  type ToolError,
  fromJsonRpcError,
  sdkErrorCodeName,
  textFromContent,
  toToolError,
} from './errors.js'

export * from './errors.js'

export const MODERN_PROTOCOL_VERSION = '2026-07-28'
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
export const VIBRISSA_CLIENT_INFO = { name: 'vibrissa', version: '2.0.0-alpha.0' }

const DEFAULT_AWAIT_TIMEOUT_MS = 30000
const DEFAULT_POLL_MS = 500
const STDERR_TAIL_CHARS = 4000

/**
 * Answers one embedded input request (MRTR round or legacy server→client request).
 * Return the bare result (e.g. `{ action: "accept", content: {...} }`), or `undefined`
 * to leave it unanswered (the call then resolves to `kind: 'input_required'`).
 */
export type InputResponder = (
  method: string,
  params: JsonValue,
) => JsonValue | undefined | Promise<JsonValue | undefined>

export interface SessionOptions {
  /** Default per-request timeout (ms). Also bounds a whole MRTR flow. */
  timeoutMs: number
  /** Called for every JSON-RPC message in/out (and stderr chunks when piped). */
  transcript?: (entry: TranscriptEntry) => void
  /** Session-level responder; `CallOptions.respond` is consulted first. */
  inputResponder?: InputResponder
  /**
   * Server stderr (stdio only): `inherit` (default) forwards to this process's stderr,
   * `capture` keeps it out of the console (transcript / onStderr only), `ignore` drops it.
   */
  stderr?: 'inherit' | 'capture' | 'ignore'
  onStderr?: (text: string) => void
  /** Declare the tasks extension (servers may then answer with tasks). Default true. */
  tasks?: boolean
  clientInfo?: { name: string; version: string }
}

export interface CallOptions {
  timeoutMs?: number
  /** Per-call responder: a function, or a map keyed by request method (`elicitation/create`). */
  respond?: InputResponder | Record<string, JsonValue>
  /** Tasks extension: poll `tasks/get` until terminal. `true` = defaults. */
  await?: AwaitOptions | boolean
}

interface OutcomeBase {
  durationMs: number
  /** Every InputRequests map the server sent during this call, one per round, in order. */
  inputRequests?: JsonValue[]
  /** The CreateTaskResult, when the server answered with a task. */
  task?: JsonValue
}

export type Outcome =
  | (OutcomeBase & { kind: 'result'; result: JsonValue })
  | (OutcomeBase & { kind: 'error'; error: ToolError; result?: JsonValue })
  | (OutcomeBase & { kind: 'input_required'; requests: JsonValue; requestState?: string })

export type SessionStartErrorCode =
  | 'spawn'
  | 'exited'
  | 'timeout'
  | 'negotiation'
  | 'http'
  | 'config'

/** Thrown by McpSession.start when the server cannot be reached / spawned / negotiated. */
export class SessionStartError extends Error {
  constructor(
    message: string,
    readonly code: SessionStartErrorCode,
    readonly stderr?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SessionStartError'
  }
}

/** Thrown by list/discover verbs (which return plain data, not an Outcome). */
export class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly error: ToolError,
  ) {
    super(message)
    this.name = 'SessionRequestError'
  }
}

/** Expand an RFC 6570 URI template with case args (non-strings are stringified). */
export function expandUriTemplate(template: string, args: Record<string, JsonValue> = {}): string {
  const vars: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue
    vars[key] = Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      : typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  }
  return new UriTemplate(template).expand(vars)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type RawMessage = Record<string, unknown>

interface RawResponse {
  method: string
  message: RawMessage
}

class UnansweredInputError extends Error {
  constructor(readonly method: string) {
    super(
      `No scripted response for ${method}. Add a "respond" entry for "${method}" to the step (or pass --respond).`,
    )
    this.name = 'UnansweredInputError'
  }
}

/** Per-operation wire bookkeeping. Operations are serialized, so at most one is live. */
class OpTracker {
  readonly sent = new Map<string | number, string>()
  readonly responses: RawResponse[] = []
  readonly inputRounds: JsonValue[] = []
  readonly unanswered: Array<{ key: string; method: string; params: JsonValue }> = []
  constructor(readonly respond?: InputResponder) {}

  last(method: string): RawMessage | undefined {
    for (let i = this.responses.length - 1; i >= 0; i--) {
      if (this.responses[i].method === method) return this.responses[i].message
    }
    return undefined
  }

  results(method: string): RawMessage[] {
    return this.responses
      .filter((r) => r.method === method && isObject(r.message.result))
      .map((r) => r.message.result as RawMessage)
  }
}

const PASSTHROUGH: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'vibrissa', validate: (value: unknown) => ({ value }) },
}

const TAPPED = Symbol('vibrissa.tapped')

function isObject(value: unknown): value is RawMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequest(message: RawMessage): boolean {
  return typeof message.method === 'string' && message.id !== undefined
}

function isResponse(message: RawMessage): boolean {
  return (
    message.method === undefined &&
    message.id !== undefined &&
    ('result' in message || 'error' in message)
  )
}

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T)
}

function json(value: unknown): JsonValue {
  return clone(value) as JsonValue
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inheritedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, ...overrides }
}

function responderFrom(respond: CallOptions['respond']): InputResponder | undefined {
  if (respond === undefined) return undefined
  if (typeof respond === 'function') return respond
  return (method) => (Object.hasOwn(respond, method) ? respond[method] : undefined)
}

async function askResponders(
  responders: Array<InputResponder | undefined>,
  method: string,
  params: JsonValue,
): Promise<JsonValue | undefined> {
  for (const responder of responders) {
    if (!responder) continue
    const answer = await responder(method, params)
    if (answer !== undefined) return answer
  }
  return undefined
}

function pick(source: RawMessage, keys: string[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = json(source[key])
  }
  return out
}

function toolSummary(tool: RawMessage): ToolSummary {
  return {
    name: String(tool.name),
    ...pick(tool, ['title', 'description']),
    inputSchema: tool.inputSchema === undefined ? null : json(tool.inputSchema),
    ...pick(tool, ['outputSchema', 'annotations', 'icons', 'execution', '_meta']),
  } as ToolSummary
}

function resourceSummary(resource: RawMessage): ResourceSummary {
  return {
    uri: String(resource.uri),
    name: String(resource.name),
    ...pick(resource, [
      'title',
      'description',
      'mimeType',
      'size',
      'annotations',
      'icons',
      '_meta',
    ]),
  } as ResourceSummary
}

function resourceTemplateSummary(template: RawMessage): ResourceTemplateSummary {
  return {
    uriTemplate: String(template.uriTemplate),
    name: String(template.name),
    ...pick(template, ['title', 'description', 'mimeType', 'annotations', 'icons', '_meta']),
  } as ResourceTemplateSummary
}

function promptSummary(prompt: RawMessage): PromptSummary {
  const args = Array.isArray(prompt.arguments)
    ? prompt.arguments.filter(isObject).map(
        (arg) =>
          ({
            name: String(arg.name),
            ...pick(arg, ['title', 'description', 'required']),
          }) as PromptArgumentSummary,
      )
    : undefined
  return {
    name: String(prompt.name),
    ...pick(prompt, ['title', 'description']),
    ...(args ? { arguments: args } : {}),
    ...pick(prompt, ['icons', '_meta']),
  } as PromptSummary
}

function negotiationFor(protocol: ProtocolMode, timeoutMs: number): VersionNegotiationOptions {
  const probe = { timeoutMs }
  if (protocol === 'legacy') return { mode: 'legacy' }
  if (protocol === 'auto') return { mode: 'auto', probe }
  if (protocol === 'modern') return { mode: { pin: MODERN_PROTOCOL_VERSION }, probe }
  if (isObject(protocol) && typeof protocol.pin === 'string')
    return { mode: { pin: protocol.pin }, probe }
  throw new SessionStartError(
    `Invalid protocol at server.protocol: expected "auto" | "legacy" | "modern" | { "pin": "<version>" }, got ${JSON.stringify(protocol)}. Fix the server entry in vibrissa.json or pass --protocol auto.`,
    'config',
  )
}

function describeServer(server: ServerConfig): string {
  if (isHttpServerConfig(server)) return `server url ${server.url}`
  const cmd = [server.cmd, ...(server.args ?? [])].join(' ')
  return `server.cmd "${cmd}"`
}

// ---------------------------------------------------------------------------
// McpSession
// ---------------------------------------------------------------------------

export class McpSession {
  private queue: Promise<unknown> = Promise.resolve()
  private active: OpTracker | undefined
  private readonly toolDefs = new Map<string, RawMessage>()
  private toolsListed = false
  private initializeRaw: RawMessage | undefined
  private stderrBuffer = ''
  private isClosed = false
  private _era: 'legacy' | 'modern' = 'legacy'
  private _protocolVersion = ''

  private constructor(
    private readonly client: Client,
    private readonly transport: Transport,
    readonly server: ServerConfig,
    private readonly opts: SessionOptions,
  ) {}

  /** Negotiated era: `modern` = 2026-07-28+ via server/discover, `legacy` = 2025 initialize. */
  get era(): 'legacy' | 'modern' {
    return this._era
  }

  /** Negotiated protocol revision, e.g. "2026-07-28". */
  get protocolVersion(): string {
    return this._protocolVersion
  }

  /** True once the connection closed (server exit, transport failure, or close()). */
  get closed(): boolean {
    return this.isClosed
  }

  /** The last few KB of server stderr (stdio, unless stderr: 'ignore'). */
  get stderrTail(): string {
    return this.stderrBuffer
  }

  /** Escape hatch: the underlying SDK client. Calls made here bypass serialization/capture. */
  get sdk(): Client {
    return this.client
  }

  static async start(server: ServerConfig, opts: SessionOptions): Promise<McpSession> {
    const protocol = server.protocol ?? 'auto'
    const spawnTimeoutMs = server.spawnTimeoutMs ?? clamp(opts.timeoutMs, 2000, 10000)
    const versionNegotiation = negotiationFor(protocol, spawnTimeoutMs)
    const http = isHttpServerConfig(server)

    let transport: Transport
    let stdio: StdioClientTransport | undefined
    if (http) {
      let url: URL
      try {
        url = new URL(server.url)
      } catch {
        throw new SessionStartError(
          `Invalid server url at server.url: expected an absolute http(s) URL, got ${JSON.stringify(server.url)}.`,
          'config',
        )
      }
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      })
    } else {
      if (typeof server.cmd !== 'string' || server.cmd.length === 0) {
        throw new SessionStartError(
          'Invalid server at server.cmd: expected a command string or a { url } entry. Set "servers" in vibrissa.json or pass --server "<cmd> <args>".',
          'config',
        )
      }
      stdio = new StdioClientTransport({
        command: server.cmd,
        args: server.args ?? [],
        cwd: server.cwd ?? process.cwd(),
        env: inheritedEnv(server.env ?? {}),
        stderr: opts.stderr === 'ignore' ? 'ignore' : 'pipe',
      })
      transport = stdio
    }

    const capabilities: ClientCapabilities = {
      elicitation: { form: {}, url: {} },
      sampling: {},
      roots: {},
      ...(opts.tasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }),
    }
    const client = new Client(opts.clientInfo ?? VIBRISSA_CLIENT_INFO, {
      capabilities,
      versionNegotiation,
      inputRequired: { autoFulfill: true },
    })
    const session = new McpSession(client, transport, server, opts)
    session.wire(stdio)
    await session.connect(spawnTimeoutMs, protocol === 'auto' && !http)
    return session
  }

  /** Install transport taps, stderr capture, and the input-request handlers. */
  private wire(stdio: StdioClientTransport | undefined): void {
    const transport = this.transport
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      this.tap('out', message)
      return send(message, options)
    }
    // Wrap whatever handler the SDK installs (probe window, then Protocol.connect).
    // Identity-dedupe guards against chained handlers seeing the same message twice.
    let current: Transport['onmessage']
    let lastIn: unknown
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (handler: Transport['onmessage']) => {
        if (handler === undefined || (handler as unknown as Record<symbol, unknown>)[TAPPED]) {
          current = handler
          return
        }
        const wrapped = ((message: JSONRPCMessage, extra?: unknown) => {
          if (message !== lastIn) {
            lastIn = message
            this.tap('in', message)
          }
          ;(handler as (m: JSONRPCMessage, e?: unknown) => void)(message, extra)
        }) as unknown as NonNullable<Transport['onmessage']> & Record<symbol, unknown>
        wrapped[TAPPED] = true
        current = wrapped
      },
    })

    stdio?.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_TAIL_CHARS)
      if ((this.opts.stderr ?? 'inherit') === 'inherit') process.stderr.write(text)
      this.opts.onStderr?.(text)
      this.opts.transcript?.({ dir: 'stderr', ts: Date.now(), text })
    })

    this.client.onerror = () => {
      // Out-of-band noise (late responses after a timeout, dropped requests): visible in the transcript.
    }
    this.client.onclose = () => {
      this.isClosed = true
    }
    for (const method of ['elicitation/create', 'sampling/createMessage', 'roots/list'] as const) {
      this.client.setRequestHandler(method, ((
        request: { params?: unknown },
        ctx: { mcpReq: { id: unknown } },
      ) => this.answerInputRequest(method, request, ctx)) as never)
    }
  }

  private tap(dir: 'in' | 'out', message: JSONRPCMessage): void {
    const raw = message as unknown as RawMessage
    const tracker = this.active
    if (tracker) {
      if (dir === 'out' && isRequest(raw))
        tracker.sent.set(raw.id as string | number, raw.method as string)
      if (dir === 'in' && isResponse(raw)) {
        const method = tracker.sent.get(raw.id as string | number)
        if (method !== undefined) {
          tracker.responses.push({ method, message: raw })
          const result = raw.result
          if (isObject(result) && result.resultType === 'input_required') {
            tracker.inputRounds.push(json(result.inputRequests ?? {}))
          }
        }
      }
    }
    if (this.opts.transcript) this.opts.transcript({ dir, ts: Date.now(), message: json(message) })
  }

  private async answerInputRequest(
    method: string,
    request: { params?: unknown },
    ctx: { mcpReq: { id: unknown } },
  ): Promise<never> {
    const params = json(request.params ?? {})
    const tracker = this.active
    const key = String(ctx.mcpReq.id)
    // Legacy servers push real requests; record them as rounds (modern rounds come from the wire tap).
    if (this._era === 'legacy' && tracker) tracker.inputRounds.push({ [key]: { method, params } })
    const answer = await askResponders([tracker?.respond, this.opts.inputResponder], method, params)
    if (answer === undefined) {
      tracker?.unanswered.push({ key, method, params })
      throw new UnansweredInputError(method)
    }
    return answer as never
  }

  private async connect(spawnTimeoutMs: number, autoOnStdio: boolean): Promise<void> {
    const where = describeServer(this.server)
    const tracker = new OpTracker()
    this.active = tracker
    const guardMs = spawnTimeoutMs * (autoOnStdio ? 2 : 1) + 1000
    let guard: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.client.connect(this.transport, { timeout: spawnTimeoutMs }),
        new Promise<never>((_, reject) => {
          guard = setTimeout(
            () => reject(new SdkError(SdkErrorCode.RequestTimeout, 'Server spawn timeout')),
            guardMs,
          )
        }),
      ])
    } catch (err) {
      await this.client.close().catch(() => {})
      throw this.startError(err, where, spawnTimeoutMs)
    } finally {
      if (guard) clearTimeout(guard)
      this.active = undefined
    }
    this._era = this.client.getProtocolEra() ?? 'legacy'
    this._protocolVersion = this.client.getNegotiatedProtocolVersion() ?? ''
    const init = tracker.last('initialize')
    if (init && isObject(init.result)) this.initializeRaw = init.result
  }

  private startError(err: unknown, where: string, spawnTimeoutMs: number): SessionStartError {
    const stderr = this.stderrBuffer.trim()
    const tail = stderr ? ` Last stderr: ${stderr.split(/\r?\n/).slice(-5).join(' | ')}` : ''
    const message = err instanceof Error ? err.message : String(err)
    const errno = (err as { code?: unknown })?.code
    const http = isHttpServerConfig(this.server)
    const protocol = this.server.protocol ?? 'auto'
    const eraHint =
      protocol === 'auto'
        ? 'Try --protocol legacy for 2025-era servers.'
        : protocol === 'legacy'
          ? 'Try --protocol auto.'
          : 'Use --protocol auto to allow the 2025 fallback.'
    // cross-spawn on Windows runs unresolvable commands through cmd.exe, so ENOENT shows up
    // as an early exit with a "not recognized" message on stderr.
    const notFound =
      errno === 'ENOENT' ||
      /ENOENT/.test(message) ||
      /is not recognized as an internal or external command|command not found|No such file or directory/i.test(
        stderr,
      )
    if (!http && notFound) {
      return new SessionStartError(
        `Server failed to start at ${where}: command not found (ENOENT). Check the command and PATH, or pass --server "<cmd> <args>".${tail}`,
        'spawn',
        stderr,
        { cause: err },
      )
    }
    if (
      http &&
      /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(message)
    ) {
      return new SessionStartError(
        `Server connection failed at ${where}: ${message}. Is the server running and reachable at that URL?`,
        'http',
        stderr,
        { cause: err },
      )
    }
    if (err instanceof SdkError) {
      switch (err.code) {
        case SdkErrorCode.ConnectionClosed:
        case SdkErrorCode.NotConnected:
        case SdkErrorCode.SendFailed:
          return new SessionStartError(
            `Server exited early before completing MCP initialization at ${where}: ${message}. Run the command by hand to see why it exits.${tail}`,
            'exited',
            stderr,
            { cause: err },
          )
        case SdkErrorCode.RequestTimeout:
          return new SessionStartError(
            `Server spawn timeout at ${where}: no MCP handshake within ${spawnTimeoutMs}ms. Make sure the server writes only JSON-RPC to stdout, or raise server.spawnTimeoutMs.${tail}`,
            'timeout',
            stderr,
            { cause: err },
          )
        case SdkErrorCode.EraNegotiationFailed:
          return new SessionStartError(
            `Protocol negotiation failed at ${where}: ${message}. ${eraHint}${tail}`,
            'negotiation',
            stderr,
            { cause: err },
          )
        default:
          if (String(err.code).startsWith('CLIENT_HTTP')) {
            return new SessionStartError(
              `Server connection failed at ${where}: ${message} (${sdkErrorCodeName(err.code)}). Check the URL and headers (auth tokens via \${ENV} in vibrissa.json).`,
              'http',
              stderr,
              { cause: err },
            )
          }
      }
    }
    if (err instanceof ProtocolError) {
      return new SessionStartError(
        `Protocol negotiation failed at ${where}: server answered ${err.code} ${message}. ${eraHint}${tail}`,
        'negotiation',
        stderr,
        { cause: err },
      )
    }
    return new SessionStartError(
      `Server ${http ? 'connection' : 'start'} failed at ${where}: ${message}.${http ? ' Is the server running and reachable?' : ''}${tail}`,
      http ? 'http' : 'exited',
      stderr,
      { cause: err },
    )
  }

  /** Run `fn` exclusively, with a fresh wire tracker. */
  private exclusive<T>(
    respond: InputResponder | undefined,
    fn: (tracker: OpTracker) => Promise<T>,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const tracker = new OpTracker(respond)
      this.active = tracker
      try {
        return await fn(tracker)
      } finally {
        this.active = undefined
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  // ---- discovery & lists --------------------------------------------------

  /** `server/discover` on modern; synthesized from the `initialize` result on legacy. */
  discover(): Promise<DiscoverInfo> {
    if (this._era === 'legacy') return Promise.resolve(this.synthesizeDiscover())
    return this.exclusive(undefined, async (tracker) => {
      let thrown: unknown
      let sdkValue: unknown
      try {
        sdkValue = await this.client.discover({ timeout: this.opts.timeoutMs })
      } catch (err) {
        thrown = err
      }
      const last = tracker.last('server/discover')
      if (last && isObject(last.error)) {
        const error = fromJsonRpcError(last.error)
        throw new SessionRequestError(
          `server/discover failed at ${describeServer(this.server)}: ${error.message}`,
          error,
        )
      }
      const raw =
        last && isObject(last.result) ? last.result : isObject(sdkValue) ? sdkValue : undefined
      if (!raw) {
        const error = toToolError(thrown, {
          what: 'server/discover',
          timeoutMs: this.opts.timeoutMs,
        })
        throw new SessionRequestError(error.message, error)
      }
      const meta = isObject(raw._meta) ? raw._meta : {}
      const identity = isObject(meta[SERVER_INFO_META_KEY])
        ? meta[SERVER_INFO_META_KEY]
        : this.client.getServerVersion()
      const capabilities = isObject(raw.capabilities) ? raw.capabilities : {}
      return {
        era: 'modern',
        protocolVersion: this._protocolVersion,
        supportedVersions: Array.isArray(raw.supportedVersions)
          ? raw.supportedVersions.map(String)
          : [this._protocolVersion],
        ...(identity ? { serverInfo: json(identity) as ServerIdentity } : {}),
        capabilities: json(capabilities),
        extensions: isObject(capabilities.extensions) ? Object.keys(capabilities.extensions) : [],
        ...(typeof raw.instructions === 'string' ? { instructions: raw.instructions } : {}),
        synthesized: false,
        raw: json(raw),
      }
    })
  }

  private synthesizeDiscover(): DiscoverInfo {
    const init = this.initializeRaw
    const capabilities = isObject(init?.capabilities)
      ? init.capabilities
      : ((this.client.getServerCapabilities() ?? {}) as RawMessage)
    const identity = isObject(init?.serverInfo) ? init.serverInfo : this.client.getServerVersion()
    const instructions =
      typeof init?.instructions === 'string' ? init.instructions : this.client.getInstructions()
    const raw: RawMessage = init ?? {
      protocolVersion: this._protocolVersion,
      capabilities,
      ...(identity ? { serverInfo: identity } : {}),
      ...(instructions ? { instructions } : {}),
    }
    return {
      era: 'legacy',
      protocolVersion: this._protocolVersion,
      supportedVersions: [this._protocolVersion],
      ...(identity ? { serverInfo: json(identity) as ServerIdentity } : {}),
      capabilities: json(capabilities),
      extensions: isObject(capabilities.extensions) ? Object.keys(capabilities.extensions) : [],
      ...(instructions ? { instructions } : {}),
      synthesized: true,
      raw: json(raw),
    }
  }

  async listTools(): Promise<ToolSummary[]> {
    return (await this.listToolsResult()).items
  }

  async listResources(): Promise<ResourceSummary[]> {
    return (await this.listResourcesResult()).items
  }

  async listResourceTemplates(): Promise<ResourceTemplateSummary[]> {
    return (await this.listResourceTemplatesResult()).items
  }

  async listPrompts(): Promise<PromptSummary[]> {
    return (await this.listPromptsResult()).items
  }

  listToolsResult(): Promise<ListResult<ToolSummary>> {
    return this.exclusive(undefined, async (tracker) => {
      const list = await this.listPages(tracker, 'tools/list', 'tools')
      return { ...list, items: list.items.map(toolSummary) }
    })
  }

  listResourcesResult(): Promise<ListResult<ResourceSummary>> {
    return this.exclusive(undefined, async (tracker) => {
      const list = await this.listPages(tracker, 'resources/list', 'resources')
      return { ...list, items: list.items.map(resourceSummary) }
    })
  }

  listResourceTemplatesResult(): Promise<ListResult<ResourceTemplateSummary>> {
    return this.exclusive(undefined, async (tracker) => {
      const list = await this.listPages(tracker, 'resources/templates/list', 'resourceTemplates')
      return { ...list, items: list.items.map(resourceTemplateSummary) }
    })
  }

  listPromptsResult(): Promise<ListResult<PromptSummary>> {
    return this.exclusive(undefined, async (tracker) => {
      const list = await this.listPages(tracker, 'prompts/list', 'prompts')
      return { ...list, items: list.items.map(promptSummary) }
    })
  }

  /** Walk all pages through the SDK, then rebuild the aggregate from the raw wire pages. */
  private async listPages(
    tracker: OpTracker,
    method: 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list',
    key: 'tools' | 'resources' | 'resourceTemplates' | 'prompts',
  ): Promise<ListResult<RawMessage>> {
    const options = { timeout: this.opts.timeoutMs, cacheMode: 'bypass' as const }
    let sdkValue: unknown
    let thrown: unknown
    try {
      if (method === 'tools/list') sdkValue = await this.client.listTools(undefined, options)
      else if (method === 'resources/list')
        sdkValue = await this.client.listResources(undefined, options)
      else if (method === 'resources/templates/list')
        sdkValue = await this.client.listResourceTemplates(undefined, options)
      else sdkValue = await this.client.listPrompts(undefined, options)
    } catch (err) {
      thrown = err
    }
    const last = tracker.last(method)
    if (last && isObject(last.error)) {
      const error = fromJsonRpcError(last.error)
      throw new SessionRequestError(
        `${method} failed at ${describeServer(this.server)}: ${error.message}`,
        error,
      )
    }
    const pages = tracker.results(method)
    const first = pages[0] ?? (isObject(sdkValue) ? sdkValue : undefined)
    if (!first) {
      if (thrown === undefined) return { items: [] }
      const error = toToolError(thrown, { what: method, timeoutMs: this.opts.timeoutMs })
      throw new SessionRequestError(error.message, error)
    }
    // Mirror the SDK walk: a page repeating the previous one (same items + cursor) ends it.
    const source = (pages.length > 0 ? pages : [first]).filter(
      (page, i, all) =>
        i === 0 ||
        JSON.stringify([page[key], page.nextCursor]) !==
          JSON.stringify([all[i - 1][key], all[i - 1].nextCursor]),
    )
    const items = source
      .flatMap((page) => (Array.isArray(page[key]) ? (page[key] as unknown[]) : []))
      .filter(isObject)
    if (method === 'tools/list') {
      this.toolsListed = true
      for (const tool of items)
        if (typeof tool.name === 'string') this.toolDefs.set(tool.name, tool)
    }
    return {
      items,
      ...(typeof first.ttlMs === 'number' ? { ttlMs: first.ttlMs } : {}),
      ...(typeof first.cacheScope === 'string' ? { cacheScope: first.cacheScope } : {}),
      ...(first._meta !== undefined ? { _meta: json(first._meta) } : {}),
    }
  }

  // ---- operations -----------------------------------------------------------

  callTool(
    name: string,
    args: Record<string, JsonValue> = {},
    opts: CallOptions = {},
  ): Promise<Outcome> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs
    return this.exclusive(responderFrom(opts.respond), async (tracker) => {
      const toolDefinition = await this.toolDefinitionFor(tracker, name)
      const started = performance.now()
      let sdkValue: unknown
      let thrown: unknown
      try {
        sdkValue = await this.client.callTool(
          { name, arguments: args },
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs, toolDefinition },
        )
      } catch (err) {
        thrown = err
      }
      return this.finish(
        tracker,
        'tools/call',
        `tools/call "${name}"`,
        timeoutMs,
        started,
        sdkValue,
        thrown,
        opts,
      )
    })
  }

  readResource(uri: string, opts: CallOptions = {}): Promise<Outcome> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs
    return this.exclusive(responderFrom(opts.respond), async (tracker) => {
      const started = performance.now()
      let sdkValue: unknown
      let thrown: unknown
      try {
        sdkValue = await this.client.readResource(
          { uri },
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs, cacheMode: 'bypass' },
        )
      } catch (err) {
        thrown = err
      }
      return this.finish(
        tracker,
        'resources/read',
        `resources/read "${uri}"`,
        timeoutMs,
        started,
        sdkValue,
        thrown,
        opts,
      )
    })
  }

  /** Expand `template` with `args`, then `resources/read`. */
  readResourceTemplate(
    template: string,
    args: Record<string, JsonValue> = {},
    opts: CallOptions = {},
  ): Promise<Outcome> {
    return this.readResource(expandUriTemplate(template, args), opts)
  }

  getPrompt(
    name: string,
    args: Record<string, JsonValue> = {},
    opts: CallOptions = {},
  ): Promise<Outcome> {
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs
    return this.exclusive(responderFrom(opts.respond), async (tracker) => {
      const started = performance.now()
      let sdkValue: unknown
      let thrown: unknown
      try {
        sdkValue = await this.client.getPrompt(
          { name, arguments: args as Record<string, string> },
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
        )
      } catch (err) {
        thrown = err
      }
      return this.finish(
        tracker,
        'prompts/get',
        `prompts/get "${name}"`,
        timeoutMs,
        started,
        sdkValue,
        thrown,
        opts,
      )
    })
  }

  /**
   * Liveness round trip; false when the server is gone or does not answer in time.
   * `ping` does not exist on 2026-07-28, so modern sessions use `server/discover`.
   */
  ping(timeoutMs = this.opts.timeoutMs): Promise<boolean> {
    return this.exclusive(undefined, async () => {
      try {
        if (this._era === 'modern') await this.client.discover({ timeout: timeoutMs })
        else await this.client.ping({ timeout: timeoutMs })
        return true
      } catch {
        return false
      }
    })
  }

  async close(): Promise<void> {
    this.isClosed = true
    await this.client.close().catch(() => {})
  }

  /**
   * The tool definition handed to the SDK: our cached one with `outputSchema` removed, so the
   * SDK never validates structuredContent itself (the runner does, with better errors and a
   * per-case opt-out). On modern HTTP, list once so SEP-2243 `Mcp-Param-*` mirroring has data.
   */
  private async toolDefinitionFor(tracker: OpTracker, name: string): Promise<Tool> {
    if (
      !this.toolDefs.has(name) &&
      !this.toolsListed &&
      this._era === 'modern' &&
      isHttpServerConfig(this.server)
    ) {
      await this.listPages(tracker, 'tools/list', 'tools').catch(() => undefined)
    }
    const cached = this.toolDefs.get(name)
    const { outputSchema: _ignored, ...rest } = cached ?? { name, inputSchema: { type: 'object' } }
    return clone(rest) as unknown as Tool
  }

  /** Turn what happened on the wire (and what the SDK threw) into an Outcome. */
  private async finish(
    tracker: OpTracker,
    method: string,
    what: string,
    timeoutMs: number,
    started: number,
    sdkValue: unknown,
    thrown: unknown,
    opts: CallOptions,
  ): Promise<Outcome> {
    const base = (): OutcomeBase => ({
      durationMs: elapsed(started),
      ...(tracker.inputRounds.length > 0
        ? { inputRequests: json(tracker.inputRounds) as JsonValue[] }
        : {}),
    })

    if (tracker.unanswered.length > 0) {
      const lastRaw = tracker.last(method)
      const lastResult = lastRaw && isObject(lastRaw.result) ? lastRaw.result : undefined
      const modernRound = lastResult?.resultType === 'input_required'
      const requests: JsonValue = modernRound
        ? json(lastResult.inputRequests ?? {})
        : Object.fromEntries(
            tracker.unanswered.map((u) => [u.key, { method: u.method, params: u.params }]),
          )
      return {
        kind: 'input_required',
        requests,
        ...(modernRound && typeof lastResult.requestState === 'string'
          ? { requestState: lastResult.requestState }
          : {}),
        ...base(),
      }
    }

    const last = tracker.last(method)
    if (last && isObject(last.error)) {
      return { kind: 'error', error: fromJsonRpcError(last.error), ...base() }
    }

    const raw = last && isObject(last.result) ? last.result : undefined
    if (raw?.resultType === 'task') {
      const task = json(raw)
      if (!opts.await) return { kind: 'result', result: task, task, ...base() }
      return this.awaitTask(tracker, raw, opts, what, timeoutMs, base)
    }

    if (thrown !== undefined) {
      const error = toToolError(thrown, { what, timeoutMs })
      return {
        kind: 'error',
        error: { ...error, local: true },
        ...(raw ? { result: json(raw) } : {}),
        ...base(),
      }
    }

    const result = raw ?? (isObject(sdkValue) ? sdkValue : undefined)
    if (!result) {
      return {
        kind: 'error',
        error: {
          kind: 'transport',
          codeName: 'NoResponse',
          message: `No response captured at ${what}.`,
          local: true,
        },
        ...base(),
      }
    }
    return this.resultOutcome(method, json(result), base())
  }

  private resultOutcome(method: string, result: JsonValue, base: OutcomeBase): Outcome {
    if (method === 'tools/call' && isObject(result) && result.isError === true) {
      return {
        kind: 'error',
        error: { kind: 'tool', message: textFromContent(result.content) },
        result,
        ...base,
      }
    }
    return { kind: 'result', result, ...base }
  }

  /** Tasks extension: poll `tasks/get` until completed / failed / cancelled. */
  private async awaitTask(
    tracker: OpTracker,
    seed: RawMessage,
    opts: CallOptions,
    what: string,
    timeoutMs: number,
    base: () => OutcomeBase,
  ): Promise<Outcome> {
    const awaitOpts = typeof opts.await === 'object' ? opts.await : {}
    const budgetMs = awaitOpts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS
    const deadline = performance.now() + budgetMs
    const task = json(seed)
    const taskId = String(seed.taskId)
    const answered = new Set<string>()
    let current: RawMessage = seed
    const withTask = (): OutcomeBase => ({ ...base(), task })

    while (true) {
      const status = current.status
      if (status === 'completed') {
        const result = isObject(current.result) ? json(current.result) : {}
        return this.resultOutcome('tools/call', result, withTask())
      }
      if (status === 'failed') {
        const error = isObject(current.error)
          ? fromJsonRpcError(current.error)
          : {
              kind: 'protocol' as const,
              codeName: 'TaskFailed',
              message: String(current.statusMessage ?? 'Task failed'),
            }
        return { kind: 'error', error, ...withTask() }
      }
      if (status === 'cancelled') {
        return {
          kind: 'error',
          error: {
            kind: 'protocol',
            codeName: 'TaskCancelled',
            message: `Task ${taskId} was cancelled at ${what}${current.statusMessage ? `: ${current.statusMessage}` : ''}.`,
          },
          ...withTask(),
        }
      }
      if (status === 'input_required' && isObject(current.inputRequests)) {
        const pending = Object.entries(current.inputRequests).filter(([key]) => !answered.has(key))
        if (pending.length > 0) {
          tracker.inputRounds.push(json(Object.fromEntries(pending)))
          const responses: Record<string, JsonValue> = {}
          for (const [key, entry] of pending) {
            const request = isObject(entry) ? entry : {}
            const answer = await askResponders(
              [tracker.respond, this.opts.inputResponder],
              String(request.method),
              json(request.params ?? {}),
            )
            if (answer === undefined) {
              return {
                kind: 'input_required',
                requests: json(current.inputRequests),
                ...withTask(),
              }
            }
            responses[key] = answer
          }
          const update = await this.taskRequest(
            tracker,
            'tasks/update',
            { taskId, inputResponses: responses },
            timeoutMs,
            what,
          )
          if ('error' in update) return { kind: 'error', error: update.error, ...withTask() }
          for (const key of Object.keys(responses)) answered.add(key)
        }
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        return {
          kind: 'error',
          error: {
            kind: 'timeout',
            codeName: 'RequestTimeout',
            message: `Task did not finish at ${what}: task ${taskId} still "${String(status)}" after ${budgetMs}ms. Raise await.timeoutMs if the work is legitimately slow.`,
            local: true,
          },
          ...withTask(),
        }
      }
      const serverPoll =
        typeof current.pollIntervalMs === 'number' ? current.pollIntervalMs : DEFAULT_POLL_MS
      await sleep(Math.max(0, Math.min(awaitOpts.pollMs ?? serverPoll, remaining)))
      const polled = await this.taskRequest(tracker, 'tasks/get', { taskId }, timeoutMs, what)
      if ('error' in polled) return { kind: 'error', error: polled.error, ...withTask() }
      current = polled.result
    }
  }

  private async taskRequest(
    tracker: OpTracker,
    method: 'tasks/get' | 'tasks/update',
    params: Record<string, unknown>,
    timeoutMs: number,
    what: string,
  ): Promise<{ result: RawMessage } | { error: ToolError }> {
    let thrown: unknown
    let sdkValue: unknown
    try {
      sdkValue = await this.client.request({ method, params }, PASSTHROUGH, { timeout: timeoutMs })
    } catch (err) {
      thrown = err
    }
    const last = tracker.last(method)
    if (last && isObject(last.error)) return { error: fromJsonRpcError(last.error) }
    if (last && isObject(last.result)) return { result: last.result }
    if (thrown === undefined && isObject(sdkValue)) return { result: sdkValue }
    return {
      error: { ...toToolError(thrown, { what: `${method} for ${what}`, timeoutMs }), local: true },
    }
  }
}
