/**
 * Tiny ANSI color helper (no chalk). Every reporter takes a `Colors` object so the
 * same rendering code produces colored output in pretty mode and plain text otherwise.
 */

export type Paint = (text: string) => string

export interface Colors {
  readonly enabled: boolean
  bold: Paint
  dim: Paint
  inverse: Paint
  red: Paint
  green: Paint
  yellow: Paint
  cyan: Paint
  magenta: Paint
  gray: Paint
  bgRed: Paint
  bgGreen: Paint
  bgYellow: Paint
  bgCyan: Paint
}

const identity: Paint = (text) => text

function wrap(open: number, close: number): Paint {
  return (text) => (text === '' ? '' : `\x1b[${open}m${text}\x1b[${close}m`)
}

const ON: Colors = {
  enabled: true,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgYellow: wrap(43, 49),
  bgCyan: wrap(46, 49),
}

const OFF: Colors = {
  enabled: false,
  bold: identity,
  dim: identity,
  inverse: identity,
  red: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
  magenta: identity,
  gray: identity,
  bgRed: identity,
  bgGreen: identity,
  bgYellow: identity,
  bgCyan: identity,
}

export function createColors(enabled: boolean): Colors {
  return enabled ? ON : OFF
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length
}

export type EnvLike = Record<string, string | undefined>

/**
 * Decide whether console output should be pretty (colors + unicode glyphs) or plain.
 * Plain wins when the caller asked for it, when NO_COLOR is set (https://no-color.org),
 * when TERM=dumb, or when stdout is not a TTY. FORCE_COLOR (non-"0") overrides the TTY
 * check so CI systems that render ANSI can opt in.
 */
export function resolveStyle(pretty: boolean, env: EnvLike, isTTY: boolean): 'pretty' | 'plain' {
  if (!pretty) return 'plain'
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'plain'
  if (env.TERM === 'dumb') return 'plain'
  const force = env.FORCE_COLOR
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') return 'pretty'
  return isTTY ? 'pretty' : 'plain'
}
