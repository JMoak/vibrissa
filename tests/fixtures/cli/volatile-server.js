// A minimal hand-rolled 2025-era stdio MCP server whose answers change on every call, for
// `vib record` volatility tests:
//   stamp   structuredContent { at: ISO date-time, id: UUID, ms: epoch-ms, count: n, stable }
//           and a text that embeds the timestamp; declares an outputSchema
//   counter text "call #<n>" (changes between calls; no recognizable pattern)
//   broken  structuredContent that violates its outputSchema
//   wipe    annotated destructive (must not be repeated by the stable check)
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

let calls = 0

const TOOLS = [
  {
    name: 'stamp',
    description: 'Returns the current time and a fresh id',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        at: { type: 'string' },
        id: { type: 'string' },
        ms: { type: 'integer' },
        count: { type: 'integer' },
        stable: { type: 'string' },
      },
      required: ['at', 'id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'counter',
    description: 'Counts calls',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'broken',
    description: 'Returns structuredContent that violates its outputSchema',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    },
  },
  {
    name: 'wipe',
    description: 'Pretends to delete everything',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function call(name) {
  calls += 1
  switch (name) {
    case 'stamp': {
      const at = new Date(Date.now() + calls).toISOString()
      const structured = { at, id: randomUUID(), ms: Date.now(), count: 1, stable: 'same' }
      return { content: text(`stamped at ${at}`), structuredContent: structured }
    }
    case 'counter':
      return { content: text(`call #${calls}`) }
    case 'broken':
      return { content: text('{"sum":"3"}'), structuredContent: { sum: '3' } }
    case 'wipe':
      return { content: text(`wiped (call ${calls})`) }
    default:
      return undefined
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'volatile', version: '1.0.0' },
        },
      })
      return
    case 'ping':
      send({ id: message.id, result: {} })
      return
    case 'tools/list':
      send({ id: message.id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const result = call(message.params?.name)
      if (result) send({ id: message.id, result })
      else
        send({
          id: message.id,
          error: { code: -32602, message: `Unknown tool: ${message.params?.name}` },
        })
      return
    }
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      })
  }
})
