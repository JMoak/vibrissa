// Vibrissa test fixture: a small MCP server on @modelcontextprotocol/server v2.
//
// Serves BOTH protocol eras from one definition:
//   - 2026-07-28 ("modern") clients via `server/discover` + per-request `_meta` envelopes
//   - 2025-era ("legacy") clients via the `initialize` handshake
//
// Transports:
//   node server/index.js               stdio (default; `serveStdio` picks the era per connection)
//   node server/index.js --http 0      Streamable HTTP on 127.0.0.1:<port> (0 = random), path /mcp.
//                                      Prints `[echo-server] listening <url>` on stderr once bound.
//   node server/index.js --noisy       stdio, but first writes a non-JSON-RPC line to stdout
//                                      (stdout-pollution tests).
//
// Surface (keep in sync with tests/session.test.ts):
//   tools      echo, fail, confirm (MRTR elicitation), slow (tasks extension), typed (outputSchema),
//              sleep (plain delay, for timeout tests); tools/list is paginated (4 + 2)
//   resources  fixture://readme (static), fixture://users/{id} (template; id "404" → not found)
//   prompts    greet(name, style?)
//
// Tasks: `slow` returns a CreateTaskResult (`resultType: "task"`) when the request is served on the
// modern era AND the request's client capabilities declare the `io.modelcontextprotocol/tasks`
// extension (SEP-2663); `tasks/get` serves the task state. The v2 server SDK has no tasks runtime,
// so the extension methods are registered by hand with explicit param schemas. On legacy
// connections (or without the extension) `slow` just waits and answers synchronously.
import http from 'node:http'
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  UriTemplate,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import Ajv from 'ajv'

const SERVER_INFO = { name: 'vibrissa-echo-fixture', version: '2.0.0' }
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo text back, optionally uppercased',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        uppercase: { type: 'boolean' },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
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
  {
    name: 'confirm',
    description: 'Asks the client to confirm an action (MRTR elicitation), then reports the answer',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' } },
    },
  },
  {
    name: 'slow',
    description:
      'Long-running work: returns a task on modern clients that support the tasks extension',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'number' },
        text: { type: 'string' },
        fail: { type: 'boolean' },
      },
    },
  },
  {
    name: 'typed',
    description: 'Adds two numbers and returns structured output',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
        broken: {
          type: 'boolean',
          description: 'Return structuredContent that violates outputSchema',
        },
      },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    },
  },
  {
    name: 'sleep',
    description: 'Waits `ms` milliseconds, then answers',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
    },
  },
]

const TOOLS_PAGE_SIZE = 4

const README_URI = 'fixture://readme'
const USER_TEMPLATE = 'fixture://users/{id}'

const PROMPTS = [
  {
    name: 'greet',
    title: 'Greeting',
    description: 'Ask the model to greet someone',
    arguments: [
      { name: 'name', description: 'Who to greet', required: true },
      { name: 'style', description: 'Tone of the greeting', required: false },
    ],
  },
]

/** Tasks are module-level so every per-connection Server instance (and HTTP request) sees them. */
const tasks = new Map()
let taskCounter = 0

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clientDeclaresTasks(ctx) {
  const caps = ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']
  return Boolean(caps?.extensions?.[TASKS_EXTENSION])
}

function createTask({ ms, text: label, fail }) {
  taskCounter += 1
  const now = new Date().toISOString()
  const task = {
    taskId: `task-${taskCounter}`,
    status: 'working',
    statusMessage: 'working on it',
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 60000,
    pollIntervalMs: 25,
  }
  tasks.set(task.taskId, task)
  setTimeout(() => {
    task.lastUpdatedAt = new Date().toISOString()
    if (fail) {
      task.status = 'failed'
      task.statusMessage = 'slow work failed'
      task.error = { code: ProtocolErrorCode.InternalError, message: 'slow work failed' }
    } else {
      task.status = 'completed'
      task.statusMessage = 'done'
      task.result = text(`done: ${label}`)
    }
  }, ms)
  return task
}

// Every tool's arguments are validated against its declared inputSchema; violations are a
// JSON-RPC InvalidParams error (the low-level Server does not validate for us).
const ajv = new Ajv({ allErrors: true, strict: false })
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))
const VALIDATORS = new Map(TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]))

function withArticle(type) {
  const name = Array.isArray(type) ? type.join(' or ') : String(type)
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`
}

function describeViolation(tool, error) {
  if (error.keyword === 'required') {
    const prop = error.params.missingProperty
    const type = tool.inputSchema.properties?.[prop]?.type
    return `"${prop}" is required${type ? ` and must be ${withArticle(type)}` : ''}`
  }
  const where = error.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'arguments'
  if (error.keyword === 'type') return `"${where}" must be ${withArticle(error.params.type)}`
  return `"${where}" ${error.message}`
}

function validateArgs(name, args) {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`)
  const validate = VALIDATORS.get(name)
  if (validate(args)) return
  const problems = (validate.errors ?? []).map((error) => describeViolation(tool, error))
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Invalid arguments for ${name}: ${problems.join('; ')}`,
  )
}

async function callTool(request, ctx) {
  const { name, arguments: args = {} } = request.params
  validateArgs(name, args)
  switch (name) {
    case 'echo':
      return text(args.uppercase === true ? args.text.toUpperCase() : args.text)
    case 'fail': {
      const message = typeof args.message === 'string' ? args.message : 'intentional failure'
      return { ...text(message), isError: true }
    }
    case 'confirm': {
      const action = typeof args.action === 'string' ? args.action : 'the action'
      const answer = ctx.mcpReq.inputResponses?.confirm
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Proceed with ${action}?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', description: 'Go ahead?' } },
                required: ['confirm'],
              },
            }),
          },
        })
      }
      if (answer.action !== 'accept') return text(`${answer.action}: ${action}`)
      return text(
        answer.content?.confirm === true ? `confirmed: ${action}` : `cancelled: ${action}`,
      )
    }
    case 'slow': {
      const ms = typeof args.ms === 'number' ? args.ms : 100
      const label = typeof args.text === 'string' ? args.text : 'slow'
      if (clientDeclaresTasks(ctx)) {
        const task = createTask({ ms, text: label, fail: args.fail === true })
        return { resultType: 'task', ...task }
      }
      await sleep(ms)
      if (args.fail === true)
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'slow work failed')
      return text(`done: ${label}`)
    }
    case 'typed': {
      const structuredContent =
        args.broken === true ? { sum: String(args.a + args.b) } : { sum: args.a + args.b }
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      }
    }
    case 'sleep': {
      const ms = typeof args.ms === 'number' ? args.ms : 100
      await sleep(ms)
      return text(`slept ${ms}ms`)
    }
    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`)
  }
}

function readResource(request) {
  const { uri } = request.params
  if (uri === README_URI) {
    return { contents: [{ uri, mimeType: 'text/plain', text: 'Vibrissa echo fixture' }] }
  }
  const match = new UriTemplate(USER_TEMPLATE).match(uri)
  if (match && match.id !== '404') {
    const id = String(match.id)
    return {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify({ id, name: `user-${id}` }) },
      ],
    }
  }
  throw new ResourceNotFoundError(uri)
}

function getPrompt(request) {
  const { name, arguments: args = {} } = request.params
  if (name !== 'greet')
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`)
  if (typeof args.name !== 'string') {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Invalid arguments for greet: "name" is required',
    )
  }
  const style = typeof args.style === 'string' ? ` in a ${args.style} way` : ''
  return {
    description: 'Greeting prompt',
    messages: [
      { role: 'user', content: { type: 'text', text: `Say hello to ${args.name}${style}.` } },
    ],
  }
}

const taskIdParams = fromJsonSchema({
  type: 'object',
  properties: { taskId: { type: 'string' } },
  required: ['taskId'],
})

function createServer() {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      extensions: { [TASKS_EXTENSION]: {} },
    },
    instructions: 'Fixture server for Vibrissa tests.',
    cacheHints: { 'tools/list': { ttlMs: 60000, cacheScope: 'public' } },
  })
  // Two pages (4 + rest) so clients must follow nextCursor.
  server.setRequestHandler('tools/list', (request) =>
    request.params?.cursor === 'page-2'
      ? { tools: TOOLS.slice(TOOLS_PAGE_SIZE) }
      : { tools: TOOLS.slice(0, TOOLS_PAGE_SIZE), nextCursor: 'page-2' },
  )
  server.setRequestHandler('tools/call', callTool)
  server.setRequestHandler('resources/list', () => ({
    resources: [{ uri: README_URI, name: 'readme', title: 'Readme', mimeType: 'text/plain' }],
  }))
  server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [
      {
        uriTemplate: USER_TEMPLATE,
        name: 'user',
        description: 'A user by id',
        mimeType: 'application/json',
      },
    ],
  }))
  server.setRequestHandler('resources/read', readResource)
  server.setRequestHandler('prompts/list', () => ({ prompts: PROMPTS }))
  server.setRequestHandler('prompts/get', getPrompt)
  server.setRequestHandler('tasks/get', { params: taskIdParams }, (params) => {
    const task = tasks.get(params.taskId)
    if (!task) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Failed to retrieve task: ${params.taskId} not found`,
      )
    }
    return { ...task }
  })
  return server
}

function httpPort(argv) {
  const index = argv.indexOf('--http')
  if (index === -1) return undefined
  const port = Number(argv[index + 1] ?? 0)
  return Number.isFinite(port) ? port : 0
}

async function toWebRequest(req, origin) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else if (value !== undefined) headers.set(key, value)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  })
}

async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) {
    res.end()
    return
  }
  for await (const chunk of response.body) res.write(chunk)
  res.end()
}

const port = httpPort(process.argv)
if (port === undefined) {
  // --noisy: the classic bug, a stray console.log on stdout before serving.
  if (process.argv.includes('--noisy')) console.log('Starting echo fixture...')
  serveStdio(() => createServer())
  process.stderr.write('[echo-server] ready\n')
} else {
  const handler = createMcpHandler(() => createServer())
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end()
        return
      }
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`
      await sendWebResponse(res, await handler.fetch(await toWebRequest(req, origin)))
    } catch (err) {
      process.stderr.write(`[echo-server] http error: ${err instanceof Error ? err.stack : err}\n`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  httpServer.listen(port, '127.0.0.1', () => {
    const address = httpServer.address()
    process.stderr.write(`[echo-server] listening http://127.0.0.1:${address.port}/mcp\n`)
  })
}
