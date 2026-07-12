import type { ToolSummary } from '../mcp-session.js'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const FG_CYAN = '\x1b[36m'
const FG_GRAY = '\x1b[90m'
const FG_GREEN = '\x1b[32m'
const FG_RED = '\x1b[31m'
const FG_YELLOW = '\x1b[33m'

function color(text: string, code: string): string {
  return `${code}${text}${RESET}`
}

export function formatToolList(tools: ToolSummary[]): string {
  if (tools.length === 0) return 'No tools registered on this server.'
  const lines: string[] = [
    color(`${tools.length} tool${tools.length === 1 ? '' : 's'}`, BOLD + FG_CYAN),
    '',
  ]
  for (const tool of tools) {
    lines.push(`${color('▸', FG_GREEN)} ${color(tool.name, BOLD + FG_CYAN)}`)
    if (tool.description) lines.push(`  ${color(tool.description, FG_GRAY)}`)
    const schema = tool.inputSchema
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      const props =
        typeof schema.properties === 'object' && schema.properties !== null
          ? Object.keys(schema.properties as Record<string, unknown>)
          : []
      const required = Array.isArray(schema.required)
        ? (schema.required as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      if (props.length > 0) {
        const rendered = props
          .map((name) => (required.includes(name) ? `${name}*` : name))
          .join(', ')
        lines.push(`  ${color(`args: ${rendered}`, DIM)}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export function formatCallHeader(tool: string, args: unknown): string {
  return `${color('call', FG_CYAN)} ${color(tool, BOLD)} ${color(JSON.stringify(args), FG_GRAY)}`
}

export function formatSuccessBanner(text: string): string {
  return color(text, FG_GREEN)
}

export function formatErrorBanner(text: string): string {
  return color(text, FG_RED)
}

export function formatWarnBanner(text: string): string {
  return color(text, FG_YELLOW)
}
