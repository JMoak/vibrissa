/**
 * `vib tap`: a transparent stdio proxy between an MCP client and a server that records
 * calls to an NDJSON capture (format: src/tap/entries.ts).
 *
 * Guarantees:
 * - Bytes are forwarded unchanged and immediately, in both directions (client stdin →
 *   server stdin, server stdout → client stdout, server stderr → our stderr). Parsing
 *   works on a copy; a frame that does not parse is forwarded all the same.
 * - Newline-delimited JSON-RPC (the MCP stdio framing) and LSP-style `Content-Length`
 *   framing (some older clients) are both understood, including frames split across
 *   chunks and several frames in one chunk.
 * - Nothing is ever written to stdout except the server's own bytes. Status goes to stderr.
 * - When the server exits, the proxy resolves with its exit code (128 + signal number for
 *   a signal), after recording any calls still pending as `incomplete`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { JsonValue } from '../types.js'
import { type TapEntry, isTappedMethod } from './entries.js'

const CONTENT_LENGTH = Buffer.from('content-length:')
/** A partial line or header larger than this is not JSON-RPC we can track; drop the copy. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/** Case-insensitive: does `buf` start with (a prefix of) `Content-Length:`? */
function headerState(buf: Buffer): 'header' | 'maybe' | 'none' {
  const n = Math.min(buf.length, CONTENT_LENGTH.length)
  for (let i = 0; i < n; i++) {
    const byte = buf[i] >= 0x41 && buf[i] <= 0x5a ? buf[i] + 0x20 : buf[i]
    if (byte !== CONTENT_LENGTH[i]) return 'none'
  }
  return buf.length >= CONTENT_LENGTH.length ? 'header' : 'maybe'
}

/**
 * Incremental JSON-RPC frame parser over a byte stream (read-only side channel).
 * Emits each parsed message; batches (arrays) are emitted element by element.
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes])
    this.drain()
    if (this.buf.length > MAX_PENDING_BYTES) this.buf = Buffer.alloc(0)
  }

  private emit(text: string): void {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return
    }
    if (Array.isArray(value)) for (const item of value) this.onMessage(item)
    else this.onMessage(value)
  }

  private drain(): void {
    while (true) {
      let start = 0
      while (start < this.buf.length && isWhitespace(this.buf[start])) start++
      if (start > 0) this.buf = this.buf.subarray(start)
      if (this.buf.length === 0) return
      const state = headerState(this.buf)
      if (state === 'maybe') return
      if (state === 'header') {
        let end = this.buf.indexOf('\r\n\r\n')
        let sep = 4
        if (end === -1) {
          end = this.buf.indexOf('\n\n')
          sep = 2
        }
        if (end === -1) return
        const headers = this.buf.subarray(0, end).toString('latin1')
        const match = /content-length:\s*(\d+)/i.exec(headers)
        if (!match) {
          // Not a real header block: treat the first line as garbage and move on.
          const nl = this.buf.indexOf(0x0a)
          this.buf = this.buf.subarray(nl === -1 ? this.buf.length : nl + 1)
          continue
        }
        const length = Number(match[1])
        const bodyStart = end + sep
        if (this.buf.length < bodyStart + length) return
        this.emit(this.buf.subarray(bodyStart, bodyStart + length).toString('utf8'))
        this.buf = this.buf.subarray(bodyStart + length)
        continue
      }
      const nl = this.buf.indexOf(0x0a)
      if (nl === -1) return
      const line = this.buf.subarray(0, nl).toString('utf8')
      this.buf = this.buf.subarray(nl + 1)
      if (line.trim() !== '') this.emit(line)
    }
  }
}

type Message = Record<string, unknown>

function isObject(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Pending {
  seq: number
  ts: string
  started: number
  from: 'client' | 'server'
  method: string
  id: string | number
  params?: JsonValue
}

/**
 * Pairs requests with responses for both directions and produces TapEntries.
 * `client` = messages the client wrote (our stdin); `server` = the server's stdout.
 */
export class TapRecorder {
  private seq = 0
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly write: (entry: TapEntry) => void) {}

  observe(from: 'client' | 'server', message: unknown): void {
    if (!isObject(message)) return
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (typeof message.method === 'string') {
      if (!hasId || !isTappedMethod(message.method, from)) return
      this.pending.set(`${from}:${id}`, {
        seq: ++this.seq,
        ts: new Date().toISOString(),
        started: performance.now(),
        from,
        method: message.method,
        id,
        ...(message.params !== undefined ? { params: message.params as JsonValue } : {}),
      })
      return
    }
    if (!hasId || !('result' in message || 'error' in message)) return
    // A response travels the other way: the client answers server requests and vice versa.
    const requester = from === 'client' ? 'server' : 'client'
    const key = `${requester}:${id}`
    const request = this.pending.get(key)
    if (!request) return
    this.pending.delete(key)
    this.write({
      ts: request.ts,
      seq: request.seq,
      from: request.from,
      method: request.method,
      id: request.id,
      ...(request.params !== undefined ? { params: request.params } : {}),
      ...('error' in message
        ? { error: message.error as JsonValue }
        : { result: message.result as JsonValue }),
      durationMs: Math.round(performance.now() - request.started),
    })
  }

  /** Record every request still waiting for an answer as incomplete. */
  flush(): void {
    for (const request of [...this.pending.values()].sort((a, b) => a.seq - b.seq)) {
      this.write({
        ts: request.ts,
        seq: request.seq,
        from: request.from,
        method: request.method,
        id: request.id,
        ...(request.params !== undefined ? { params: request.params } : {}),
        error: { message: 'no response: the server exited first' },
        durationMs: Math.round(performance.now() - request.started),
        incomplete: true,
      })
    }
    this.pending.clear()
  }
}

export interface TapProxyOptions {
  cmd: string
  args?: string[]
  cwd?: string
  /** Extra env vars for the server (merged over this process's env). */
  env?: Record<string, string>
  /** NDJSON capture file (appended to; parent directories are created). */
  out: string
  stdin?: Readable
  stdout?: Writable
  /** Server stderr passthrough and status lines. */
  stderr?: Writable
  /** No status lines on stderr (server stderr still passes through). */
  quiet?: boolean
  /** Forward SIGINT/SIGTERM to the server (CLI use). */
  forwardSignals?: boolean
}

export interface TapProxyResult {
  exitCode: number
  /** Entries written to the capture. */
  entries: number
  out: string
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }

function quoteForShell(arg: string): string {
  return /^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

export function runTapProxy(opts: TapProxyOptions): Promise<TapProxyResult> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const status = (text: string) => {
    if (!opts.quiet) stderr.write(`[vib tap] ${text}${os.EOL}`)
  }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  let written = 0
  let writeFailed = false
  const recorder = new TapRecorder((entry) => {
    try {
      fs.appendFileSync(opts.out, `${JSON.stringify(entry)}\n`, 'utf8')
      written++
    } catch (err) {
      if (!writeFailed) {
        writeFailed = true
        status(
          `cannot write ${opts.out}: ${err instanceof Error ? err.message : String(err)} (still proxying)`,
        )
      }
    }
  })
  const fromClient = new FrameParser((m) => recorder.observe('client', m))
  const fromServer = new FrameParser((m) => recorder.observe('server', m))

  return new Promise<TapProxyResult>((resolve) => {
    let child: ChildProcess
    let ready = false
    let triedShell = false
    let stdinEnded = false
    const early: Buffer[] = []

    const onClientData = (chunk: Buffer) => {
      if (!ready) {
        early.push(chunk)
        return
      }
      forward(chunk)
    }
    const forward = (chunk: Buffer) => {
      const sink = child.stdin
      if (sink && !sink.destroyed && sink.writable) {
        if (!sink.write(chunk)) {
          stdin.pause()
          sink.once('drain', () => stdin.resume())
        }
      }
      fromClient.push(chunk)
    }
    const onClientEnd = () => {
      stdinEnded = true
      if (ready) child.stdin?.end()
    }

    const signalHandlers: Array<[NodeJS.Signals, () => void]> = []
    const cleanup = () => {
      stdin.off('data', onClientData)
      stdin.off('end', onClientEnd)
      stdin.pause()
      for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    }

    const start = (shell: boolean) => {
      const env = { ...process.env, ...(opts.env ?? {}) }
      child = shell
        ? spawn([opts.cmd, ...(opts.args ?? [])].map(quoteForShell).join(' '), {
            cwd: opts.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            windowsHide: true,
          })
        : spawn(opts.cmd, opts.args ?? [], {
            cwd: opts.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
      child.once('spawn', () => {
        ready = true
        status(`proxying ${[opts.cmd, ...(opts.args ?? [])].join(' ')} → capturing to ${opts.out}`)
        for (const chunk of early.splice(0)) forward(chunk)
        if (stdinEnded) child.stdin?.end()
      })
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (
          !ready &&
          !triedShell &&
          process.platform === 'win32' &&
          (err.code === 'ENOENT' || err.code === 'EINVAL')
        ) {
          // Windows: .cmd/.bat shims (npx, npm, uv) need a shell.
          triedShell = true
          start(true)
          return
        }
        if (!ready) {
          cleanup()
          status(
            `could not start "${opts.cmd}": ${err.message}. Check the command after -- and your PATH.`,
          )
          resolve({ exitCode: 127, entries: written, out: opts.out })
        }
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!stdout.write(chunk)) {
          child.stdout?.pause()
          stdout.once('drain', () => child.stdout?.resume())
        }
        fromServer.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.write(chunk)
      })
      child.stdin?.on('error', () => {
        // EPIPE after the server exited: nothing left to deliver.
      })
      child.once('close', (code, signal) => {
        if (!ready) return
        recorder.flush()
        cleanup()
        const exitCode = code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 1) : 1)
        status(
          `server exited (${signal ?? `code ${code}`}); ${written} entr${written === 1 ? 'y' : 'ies'} in ${opts.out}`,
        )
        resolve({ exitCode, entries: written, out: opts.out })
      })
    }

    stdin.on('data', onClientData)
    stdin.on('end', onClientEnd)
    if (opts.forwardSignals) {
      for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
        const handler = () => {
          if (child && !child.killed) child.kill(signal)
        }
        signalHandlers.push([signal, handler])
        process.on(signal, handler)
      }
    }
    start(false)
  })
}
