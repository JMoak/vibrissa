import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text back, optionally uppercased',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        uppercase: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns a tool execution error',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
    },
  },
]

const server = new Server(
  { name: 'vibrissa-echo-fixture', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  if (name === 'echo') {
    if (typeof args.text !== 'string') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid arguments for echo: "text" must be a string',
      )
    }
    const text = args.uppercase === true ? args.text.toUpperCase() : args.text
    return { content: [{ type: 'text', text }] }
  }
  if (name === 'fail') {
    const message = typeof args.message === 'string' ? args.message : 'intentional failure'
    return { content: [{ type: 'text', text: message }], isError: true }
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[echo-server] ready\n')
