import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { JsonValue, ServerConfig } from './types.js'

export interface ToolError {
  kind: 'protocol' | 'tool'
  code?: number
  codeName?: string
  message: string
}

export type ToolCallOutcome =
  | { kind: 'result'; result: JsonValue }
  | { kind: 'error'; error: ToolError }

export interface ToolSummary {
  name: string
  description?: string
  inputSchema: JsonValue
}

const CLIENT_INFO = { name: 'vibrissa', version: '0.1.0' }

function inheritedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, ...overrides }
}

function errorCodeName(code: number): string | undefined {
  const name = (ErrorCode as Record<number, string | number>)[code]
  return typeof name === 'string' ? name : undefined
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: string; text: string } => {
      return (
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
      )
    })
    .map((item) => item.text)
    .join('\n')
}

function stripMcpErrorPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/, '')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let handle: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

export class McpSession {
  private constructor(private readonly client: Client) {}

  static async start(server: ServerConfig, timeoutMs: number): Promise<McpSession> {
    const transport = new StdioClientTransport({
      command: server.cmd,
      args: server.args ?? [],
      cwd: server.cwd ?? '.',
      env: inheritedEnv(server.env ?? {}),
      stderr: 'inherit',
    })
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    try {
      await withTimeout(client.connect(transport), timeoutMs, 'Server spawn timeout')
    } catch (err) {
      await transport.close().catch(() => {})
      if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
        throw new Error(`Server exited early before completing MCP initialization: ${err.message}`)
      }
      throw err
    }
    return new McpSession(client)
  }

  async callTool(
    name: string,
    args: Record<string, JsonValue>,
    timeoutMs: number,
  ): Promise<ToolCallOutcome> {
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: timeoutMs,
      })
      if (result.isError) {
        return {
          kind: 'error',
          error: { kind: 'tool', message: textFromContent(result.content) },
        }
      }
      return { kind: 'result', result: result as JsonValue }
    } catch (err) {
      if (err instanceof McpError) {
        return {
          kind: 'error',
          error: {
            kind: 'protocol',
            code: err.code,
            codeName: errorCodeName(err.code),
            message: stripMcpErrorPrefix(err.message),
          },
        }
      }
      throw err
    }
  }

  async listTools(): Promise<ToolSummary[]> {
    const { tools } = await this.client.listTools()
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JsonValue,
    }))
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {})
  }
}
