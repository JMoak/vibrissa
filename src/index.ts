export type { HooksConfig, RunCasesOptions, ServerConfig, TestCase, JsonValue } from './types.js'
export { defaultRunCasesOptions } from './defaults.js'
import { ConsoleResultsDisplay } from './display.js'
import { Runner } from './runner.js'
import type { RunCasesOptions } from './types.js'

export async function runCases(options: RunCasesOptions): Promise<number> {
  const runner = new Runner(options, new ConsoleResultsDisplay())
  return runner.run()
}
