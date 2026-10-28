// A minimal hand-rolled 2025-era stdio MCP server that crashes on demand, for the
// `vib fuzz` crash/restart tests. Tool `fragile` exits the process when `crash` is true.
import readline from 'node:readline'

const TOOL = {
  name: 'fragile',
  description: 'Answers "fine", or crashes the server when crash is true',
  inputSchema: {
    type: 'object',
    properties: { crash: { type: 'boolean' } },
    required: ['crash'],
    additionalProperties: false,
  },
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
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
          serverInfo: { name: 'crashy', version: '1.0.0' },
        },
      })
      return
    case 'ping':
      send({ id: message.id, result: {} })
      return
    case 'tools/list':
      send({ id: message.id, result: { tools: [TOOL] } })
      return
    case 'tools/call': {
      const args = message.params?.arguments ?? {}
      if (typeof args.crash !== 'boolean' || Object.keys(args).length !== 1) {
        send({ id: message.id, error: { code: -32602, message: 'Invalid arguments for fragile' } })
        return
      }
      if (args.crash) {
        process.stderr.write('[crashy] crashing on purpose\n')
        process.exit(3)
      }
      send({ id: message.id, result: { content: [{ type: 'text', text: 'fine' }] } })
      return
    }
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      })
  }
})
