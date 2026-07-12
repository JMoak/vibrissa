export type { HooksConfig, RunCasesOptions, ServerConfig, TestCase, JsonValue } from './types.js'
export { defaultRunCasesOptions } from './defaults.js'
export { matches, matchValue } from './match.js'
export type { Mismatch } from './match.js'
export { McpSession } from './mcp-session.js'
export type { ToolCallOutcome, ToolError, ToolSummary } from './mcp-session.js'
import { ConsoleResultsDisplay } from './display.js'
import { Runner } from './runner.js'
import type { RunCasesOptions } from './types.js'

export async function runCases(options: RunCasesOptions): Promise<number> {
  const runner = new Runner(options, new ConsoleResultsDisplay())
  return runner.run()
}
