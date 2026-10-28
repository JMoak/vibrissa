// A minimal hand-rolled 2025-era (legacy) stdio server for era-negotiation tests.
//
// Like some older SDKs, it EXITS when it receives any request before `initialize`, so a
// `server/discover` probe kills it. Vibrissa's `protocol: "auto"` must still connect (the v2
// client probes on a disposable sibling process and falls back to `initialize`).
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
let initialized = false

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    initialized = true
    send({
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-strict', version: '1.0.0' },
      },
    })
    return
  }
  if (message.id === undefined) return // notifications
  if (!initialized) {
    process.stderr.write(`[legacy-strict] ${message.method} before initialize, exiting\n`)
    process.exit(3)
  }
  if (message.method === 'tools/list') {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: 'ping',
            inputSchema: { type: 'object' },
            // Unknown annotation keys must survive (the session reports the raw wire).
            annotations: { readOnlyHint: true, vendorHint: 'kept' },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'ping') {
    send({ id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
    return
  }
  send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
})
