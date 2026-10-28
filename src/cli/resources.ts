import { type McpSession, SessionRequestError } from '../session/index.js'
import type { JsonValue, ListResult } from '../types.js'
import { printJson } from './args.js'
import { formatResourceList, isObject } from './format.js'
import { parseCommonFlags, startSession } from './resolve.js'

export interface ListMetaEntry {
  ttlMs?: number
  cacheScope?: string
  _meta?: JsonValue
  /** The list was not fetched: capability not advertised, or MethodNotFound. */
  unsupported?: true
}

export interface OptionalList<T> {
  items: T[]
  meta: ListMetaEntry
  /** Human note when the list was skipped. */
  note?: string
}

export function metaOf<T>(list: ListResult<T>): ListMetaEntry {
  return {
    ...(list.ttlMs !== undefined ? { ttlMs: list.ttlMs } : {}),
    ...(list.cacheScope !== undefined ? { cacheScope: list.cacheScope } : {}),
    ...(list._meta !== undefined ? { _meta: list._meta } : {}),
  }
}

/**
 * Fetch a list the server may not support: skipped (with a note) when the capability is
 * not advertised, and treated as empty on MethodNotFound. Other errors propagate.
 */
export async function listOptional<T>(
  capabilities: JsonValue,
  capability: 'tools' | 'resources' | 'prompts',
  method: string,
  fetch: () => Promise<ListResult<T>>,
): Promise<OptionalList<T>> {
  if (isObject(capabilities) && capabilities[capability] === undefined) {
    return {
      items: [],
      meta: { unsupported: true },
      note: `Server does not advertise the "${capability}" capability; ${method} was not called.`,
    }
  }
  try {
    const list = await fetch()
    return { items: list.items, meta: metaOf(list) }
  } catch (err) {
    if (err instanceof SessionRequestError && err.error.code === -32601) {
      return {
        items: [],
        meta: { unsupported: true },
        note: `Server answered MethodNotFound for ${method} although it advertises "${capability}".`,
      }
    }
    throw err
  }
}

export async function listResourcesAndTemplates(session: McpSession) {
  const info = await session.discover()
  const resources = await listOptional(info.capabilities, 'resources', 'resources/list', () =>
    session.listResourcesResult(),
  )
  const resourceTemplates = await listOptional(
    info.capabilities,
    'resources',
    'resources/templates/list',
    () => session.listResourceTemplatesResult(),
  )
  return { resources, resourceTemplates }
}

export async function resourcesCommand(argv: string[]): Promise<number> {
  const flags = parseCommonFlags(argv)
  const { session } = await startSession(flags)
  try {
    const { resources, resourceTemplates } = await listResourcesAndTemplates(session)
    if (flags.json) {
      printJson({
        ok: true,
        resources: resources.items,
        resourceTemplates: resourceTemplates.items,
        listMeta: { resources: resources.meta, resourceTemplates: resourceTemplates.meta },
      })
    } else {
      const notes = [...new Set([resources.note, resourceTemplates.note].filter(Boolean))]
      console.log(
        formatResourceList(
          resources.items,
          resourceTemplates.items,
          { resources: resources.meta, resourceTemplates: resourceTemplates.meta },
          notes as string[],
        ),
      )
    }
    return 0
  } finally {
    await session.close()
  }
}
