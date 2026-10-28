/**
 * Plausible values for the JSON Schema `format`s MCP tools use. Every generator's output
 * passes ajv-formats' "full" mode, which is what `src/schema.ts` validates with.
 */
import type { Rng } from './random.js'

const HEX = '0123456789abcdef'
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'nova', 'orbit', 'pixel', 'zulu']
const TLDS = ['com', 'org', 'net']

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function word(rng: Rng): string {
  return rng.pick(WORDS)
}

function date(rng: Rng): string {
  return `${rng.int(2000, 2030)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`
}

function time(rng: Rng): string {
  const frac = rng.chance(0.3) ? `.${pad(rng.int(0, 999), 3)}` : ''
  const offsets = ['Z', 'Z', '+00:00', '+02:00', '-05:00', '+05:30']
  return `${pad(rng.int(0, 23))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}${frac}${rng.pick(offsets)}`
}

function host(rng: Rng): string {
  return rng.chance(0.5) ? `${word(rng)}.example.${rng.pick(TLDS)}` : `example.${rng.pick(TLDS)}`
}

function ipv4(rng: Rng): string {
  return [rng.int(1, 223), rng.int(0, 255), rng.int(0, 255), rng.int(1, 254)].join('.')
}

function ipv6(rng: Rng): string {
  const groups = ['2001', 'db8']
  for (let i = 0; i < 6; i++) groups.push(rng.int(0, 0xffff).toString(16))
  return groups.join(':')
}

function uuid(rng: Rng): string {
  const h = (n: number) => rng.string(n, HEX)
  return `${h(8)}-${h(4)}-4${h(3)}-${rng.pick(['8', '9', 'a', 'b'])}${h(3)}-${h(12)}`
}

function uriPath(rng: Rng): string {
  const segments = rng.int(0, 3)
  let out = ''
  for (let i = 0; i < segments; i++) out += `/${word(rng)}${rng.chance(0.3) ? rng.int(1, 99) : ''}`
  return out
}

function uri(rng: Rng): string {
  const query = rng.chance(0.3) ? `?q=${word(rng)}&page=${rng.int(1, 9)}` : ''
  const frag = rng.chance(0.2) ? `#${word(rng)}` : ''
  return `https://${host(rng)}${uriPath(rng) || '/'}${query}${frag}`
}

function base64(rng: Rng): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  return `${rng.string(4 * rng.int(1, 4), alphabet)}`
}

const GENERATORS: Record<string, (rng: Rng) => string> = {
  email: (rng) =>
    `${word(rng)}${rng.chance(0.5) ? `.${word(rng)}` : ''}${rng.chance(0.3) ? `+${rng.int(1, 99)}` : ''}@${host(rng)}`,
  'idn-email': (rng) => `${word(rng)}@${host(rng)}`,
  uri,
  iri: uri,
  url: (rng) => `https://${word(rng)}.example.${rng.pick(TLDS)}${uriPath(rng)}`,
  'uri-reference': (rng) => (rng.chance(0.5) ? uri(rng) : `${uriPath(rng) || '/'}${word(rng)}`),
  'iri-reference': (rng) => uri(rng),
  'uri-template': (rng) => `https://${host(rng)}/${word(rng)}/{id}`,
  'date-time': (rng) => `${date(rng)}T${time(rng)}`,
  'iso-date-time': (rng) => `${date(rng)}T${time(rng)}`,
  date,
  time,
  'iso-time': time,
  duration: (rng) =>
    rng.pick([
      `P${rng.int(1, 30)}D`,
      `PT${rng.int(1, 23)}H${rng.int(1, 59)}M`,
      `P1DT${rng.int(1, 12)}H`,
    ]),
  uuid,
  ipv4,
  ipv6,
  hostname: host,
  'idn-hostname': host,
  'json-pointer': (rng) => `/${word(rng)}/${rng.int(0, 9)}`,
  'relative-json-pointer': (rng) => `${rng.int(0, 3)}/${word(rng)}`,
  regex: () => '^[a-z]+$',
  byte: base64,
  password: (rng) =>
    `${rng.string(12, 'abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789')}`,
  binary: (rng) => rng.string(8, 'abcdef0123456789'),
}

/** Known string formats (others are treated as plain strings). */
export const KNOWN_STRING_FORMATS: readonly string[] = Object.keys(GENERATORS)

/** A plausible value for `format`, or undefined if the format is unknown. */
export function formatValue(format: string, rng: Rng): string | undefined {
  const gen = GENERATORS[format]
  return gen ? gen(rng) : undefined
}

/** An obviously wrong value for `format` (used by the boundary strategy). */
export function invalidFormatValue(format: string): string {
  switch (format) {
    case 'email':
    case 'idn-email':
      return 'not-an-email'
    case 'uri':
    case 'iri':
    case 'url':
      return 'not a uri'
    case 'date-time':
    case 'iso-date-time':
      return '2026-13-45T25:61:00'
    case 'date':
      return '2026-02-30'
    case 'time':
    case 'iso-time':
      return '25:61:00'
    case 'uuid':
      return 'not-a-uuid'
    case 'ipv4':
      return '999.1.1.1'
    case 'ipv6':
      return 'gggg::1'
    case 'hostname':
    case 'idn-hostname':
      return '-bad-.host-'
    case 'duration':
      return 'P'
    case 'json-pointer':
      return 'no-leading-slash'
    case 'regex':
      return '(unclosed'
    default:
      return `not-a-${format}`
  }
}
