import path from 'node:path'
import { ConsoleResultsDisplay, PrettyConsoleResultsDisplay } from '../display.js'
import { Runner } from '../runner.js'
import { hasFlag, resolvePathFromCwd, takeFlag } from './args.js'
import { mergeCliOptions, parseCommonFlags } from './resolve.js'

export async function runCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const casesGlob = takeFlag(argv, '--cases')
  const failFast = hasFlag(argv, '--fail-fast')
  const allowEmpty = hasFlag(argv, '--allow-empty')
  let display: 'plain' | 'pretty' | undefined
  if (hasFlag(argv, '--pretty')) display = 'pretty'
  if (hasFlag(argv, '--no-pretty')) display = 'plain'
  const displayFlag = takeFlag(argv, '--display')
  if (displayFlag === 'plain' || displayFlag === 'pretty') display = displayFlag

  const options = mergeCliOptions(flags, {
    ...(display ? { display } : {}),
    ...(casesGlob
      ? {
          globs: [
            path.isAbsolute(casesGlob)
              ? casesGlob
              : resolvePathFromCwd(casesGlob).replace(/\\/g, '/'),
          ],
        }
      : {}),
    ...(failFast ? { failFast: true } : {}),
    ...(allowEmpty ? { allowEmpty: true } : {}),
  })

  const runner = new Runner(
    options,
    options.display === 'pretty' ? new PrettyConsoleResultsDisplay() : new ConsoleResultsDisplay(),
  )
  return runner.run()
}
