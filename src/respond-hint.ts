/**
 * Paste-ready `respond` suggestions for unanswered input requests (MRTR rounds or 2025-era
 * server→client requests). Used by `vib call`/`vib record` hints and by the runner's
 * failure messages, so every surface suggests the same answer.
 */
import type { JsonValue } from './types.js'

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A plausible value for one requested elicitation field. */
function sampleValue(schema: JsonValue): JsonValue {
  if (!isObject(schema)) return null
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (
    Array.isArray(schema.oneOf) &&
    isObject(schema.oneOf[0]) &&
    schema.oneOf[0].const !== undefined
  ) {
    return schema.oneOf[0].const
  }
  switch (schema.type) {
    case 'boolean':
      return true
    case 'number':
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return '...'
  }
}

/**
 * A `respond` map (keyed by request method) that answers every request in an
 * InputRequests map (`{ key: { method, params } }`):
 * - `elicitation/create` → `{ action: "accept", content: { <each requested field>: <sample> } }`
 * - `sampling/createMessage` → a scripted assistant text message
 * - `roots/list` → `{ roots: [] }`
 * - anything else → `{}`
 * The first request of each method wins (a respond map holds one answer per method).
 */
export function suggestRespond(requests: JsonValue): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  const entries = isObject(requests) ? Object.values(requests) : []
  for (const entry of entries) {
    const request = isObject(entry) ? entry : {}
    const method = typeof request.method === 'string' ? request.method : undefined
    if (!method || out[method] !== undefined) continue
    const params = isObject(request.params) ? request.params : {}
    if (method === 'elicitation/create') {
      const schema = isObject(params.requestedSchema) ? params.requestedSchema : {}
      const props = isObject(schema.properties) ? schema.properties : {}
      const content: Record<string, JsonValue> = {}
      for (const [name, prop] of Object.entries(props)) content[name] = sampleValue(prop)
      out[method] = params.mode === 'url' ? { action: 'accept' } : { action: 'accept', content }
    } else if (method === 'sampling/createMessage') {
      out[method] = { role: 'assistant', content: { type: 'text', text: '...' }, model: 'scripted' }
    } else if (method === 'roots/list') {
      out[method] = { roots: [] }
    } else {
      out[method] = {}
    }
  }
  return out
}
