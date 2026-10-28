/**
 * The `vib tap` capture format (one JSON object per line, NDJSON) and the logic that turns
 * a capture back into replayable calls for `vib record --from-tap`.
 *
 * Entry (written when the response arrives, so file order = completion order):
 *
 *   { "ts": "2026-10-28T12:00:00.000Z",   // when the request was seen (ISO 8601)
 *     "seq": 4,                           // 1-based request counter for this tap session
 *     "from": "client",                   // who sent the request: client | server
 *     "method": "tools/call", "id": 7, "params": { ... },
 *     "result": { ... } | "error": { "code": -32602, "message": "..." },
 *     "durationMs": 12,
 *     "incomplete": true }                // only when no response arrived (server exited)
 */
import fs from 'node:fs'
import type { JsonValue } from '../types.js'

export interface TapEntry {
  ts: string
  seq: number
  from: 'client' | 'server'
  method: string
  id?: string | number
  params?: JsonValue
  result?: JsonValue
  error?: JsonValue
  durationMs: number
  incomplete?: true
}

/** Client → server methods worth recording (calls) and context methods. */
export const TAP_CALL_METHODS = ['tools/call', 'resources/read', 'prompts/get'] as const
export const TAP_CONTEXT_METHODS = [
  'initialize',
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'tasks/get',
  'tasks/update',
] as const
/** Server → client requests (2025-era elicitation / sampling / roots). */
export const TAP_SERVER_METHODS = [
  'elicitation/create',
  'sampling/createMessage',
  'roots/list',
] as const

export function isTappedMethod(method: string, from: 'client' | 'server'): boolean {
  if (from === 'server') return (TAP_SERVER_METHODS as readonly string[]).includes(method)
  return (
    (TAP_CALL_METHODS as readonly string[]).includes(method) ||
    (TAP_CONTEXT_METHODS as readonly string[]).includes(method)
  )
}

export interface ParsedTapFile {
  entries: TapEntry[]
  /** 1-based line numbers that were not valid entries. */
  badLines: number[]
}

export function parseTapText(text: string): ParsedTapFile {
  const entries: TapEntry[] = []
  const badLines: number[] = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return
    try {
      const value = JSON.parse(line) as TapEntry
      if (typeof value?.method !== 'string') throw new Error('no method')
      entries.push(value)
    } catch {
      badLines.push(i + 1)
    }
  })
  return { entries, badLines }
}

export function readTapFile(file: string): ParsedTapFile {
  return parseTapText(fs.readFileSync(file, 'utf8'))
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One user-visible call reconstructed from a capture (MRTR retries and task polls merged). */
export interface TapCall {
  /** 1-based position in the list of calls (what `--select <n>` refers to). */
  index: number
  method: (typeof TAP_CALL_METHODS)[number]
  /** Tool name, resource URI, or prompt name. */
  target: string
  args: Record<string, JsonValue>
  /** The final answer (after MRTR rounds / task polling). */
  result?: JsonValue
  error?: JsonValue
  /** InputRequests maps the server sent, one per round. */
  inputRequests: JsonValue[]
  /** Answers the client gave, keyed by request method. */
  respond: Record<string, JsonValue>
  /** Set when the server answered with a task. */
  task?: JsonValue
  /** The task reached a terminal state in the capture (so the case can `await`). */
  taskAwaited?: boolean
  durationMs: number
  ts: string
  incomplete?: boolean
}

function targetOf(entry: TapEntry): string {
  const params = isObject(entry.params) ? entry.params : {}
  if (entry.method === 'resources/read') return String(params.uri ?? '')
  return String(params.name ?? '')
}

function argsOf(entry: TapEntry): Record<string, JsonValue> {
  const params = isObject(entry.params) ? entry.params : {}
  return isObject(params.arguments) ? { ...params.arguments } : {}
}

function resultType(entry: TapEntry): string | undefined {
  return isObject(entry.result) && typeof entry.result.resultType === 'string'
    ? entry.result.resultType
    : undefined
}

function startMs(entry: TapEntry): number {
  const ms = Date.parse(entry.ts)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Reconstruct calls from a capture:
 * - 2026 MRTR: a `tools/call` answered `input_required`, followed by a retry of the same
 *   call carrying `inputResponses`, becomes one call with `respond` + `inputRequests`.
 * - 2025 elicitation: server→client requests made while a call was pending become its
 *   `respond` / `inputRequests`.
 * - Tasks: a `resultType: "task"` answer followed by `tasks/get` polls that reach
 *   `completed` becomes one call whose result is the task's final result.
 */
export function reconstructCalls(entries: TapEntry[]): TapCall[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq)
  const calls: TapCall[] = []
  const consumed = new Set<TapEntry>()

  for (const entry of ordered) {
    if (consumed.has(entry) || entry.from !== 'client') continue
    if (!(TAP_CALL_METHODS as readonly string[]).includes(entry.method)) continue
    consumed.add(entry)
    const call: TapCall = {
      index: 0,
      method: entry.method as TapCall['method'],
      target: targetOf(entry),
      args: argsOf(entry),
      inputRequests: [],
      respond: {},
      durationMs: entry.durationMs,
      ts: entry.ts,
      ...(entry.incomplete ? { incomplete: true } : {}),
    }
    let current = entry
    // 2026 MRTR rounds: input_required → retry with inputResponses.
    while (resultType(current) === 'input_required') {
      const requests =
        isObject(current.result) && isObject(current.result.inputRequests)
          ? current.result.inputRequests
          : {}
      call.inputRequests.push(requests)
      const retry = ordered.find(
        (e) =>
          !consumed.has(e) &&
          e.from === 'client' &&
          e.method === current.method &&
          e.seq > current.seq &&
          targetOf(e) === call.target &&
          isObject(e.params) &&
          isObject(e.params.inputResponses),
      )
      if (!retry) break
      consumed.add(retry)
      const responses = (retry.params as Record<string, JsonValue>).inputResponses as Record<
        string,
        JsonValue
      >
      for (const [key, answer] of Object.entries(responses)) {
        const request = requests[key]
        const method =
          isObject(request) && typeof request.method === 'string' ? request.method : key
        if (call.respond[method] === undefined) call.respond[method] = answer
      }
      call.durationMs += retry.durationMs
      current = retry
    }
    // 2025 server→client requests made while this call was pending.
    const from = startMs(entry)
    const to = startMs(current) + current.durationMs
    for (const serverReq of ordered) {
      if (serverReq.from !== 'server' || consumed.has(serverReq)) continue
      const at = startMs(serverReq)
      if (at < from || at > to) continue
      consumed.add(serverReq)
      call.inputRequests.push({
        [String(serverReq.id ?? serverReq.seq)]: {
          method: serverReq.method,
          params: serverReq.params ?? {},
        },
      })
      if (serverReq.result !== undefined && call.respond[serverReq.method] === undefined) {
        call.respond[serverReq.method] = serverReq.result
      }
    }
    if (current.error !== undefined) call.error = current.error
    else if (current.result !== undefined) call.result = current.result
    if (current.incomplete) call.incomplete = true
    // Tasks: follow tasks/get polls to a terminal state.
    if (resultType(current) === 'task' && isObject(current.result)) {
      call.task = current.result
      const taskId = current.result.taskId
      const polls = ordered.filter(
        (e) =>
          e.method === 'tasks/get' &&
          e.seq > current.seq &&
          isObject(e.params) &&
          e.params.taskId === taskId,
      )
      for (const poll of polls) consumed.add(poll)
      const terminal = polls.find(
        (p) =>
          isObject(p.result) &&
          ['completed', 'failed', 'cancelled'].includes(String(p.result.status)),
      )
      if (terminal && isObject(terminal.result)) {
        call.taskAwaited = true
        if (terminal.result.status === 'completed') {
          call.result = isObject(terminal.result.result) ? terminal.result.result : {}
        } else {
          call.result = undefined
          call.error = isObject(terminal.result.error)
            ? terminal.result.error
            : { message: String(terminal.result.statusMessage ?? `task ${terminal.result.status}`) }
        }
      }
    }
    calls.push(call)
  }
  calls.forEach((call, i) => {
    call.index = i + 1
  })
  return calls
}

/**
 * Pick calls by `--select` values: `all`, a 1-based index (`3`), a range (`2-5`), or a
 * tool / prompt name or resource URI (every call to it). Comma-separated lists allowed.
 */
export function selectCalls(
  calls: TapCall[],
  selectors: string[],
): { picked: TapCall[]; unmatched: string[] } {
  const picked = new Set<TapCall>()
  const unmatched: string[] = []
  for (const raw of selectors
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (raw === 'all') {
      for (const call of calls) picked.add(call)
      continue
    }
    const range = /^(\d+)-(\d+)$/.exec(raw)
    if (/^\d+$/.test(raw) || range) {
      const lo = Number(range ? range[1] : raw)
      const hi = Number(range ? range[2] : raw)
      const hits = calls.filter((c) => c.index >= lo && c.index <= hi)
      if (hits.length === 0) unmatched.push(raw)
      for (const hit of hits) picked.add(hit)
      continue
    }
    const hits = calls.filter((c) => c.target === raw)
    if (hits.length === 0) unmatched.push(raw)
    for (const hit of hits) picked.add(hit)
  }
  return { picked: calls.filter((c) => picked.has(c)), unmatched }
}
