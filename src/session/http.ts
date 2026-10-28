/**
 * A minimal `fetch` for the Streamable HTTP transport, built on node:http(s) with a
 * per-session keep-alive agent that `destroy()` tears down completely.
 *
 * Why not global fetch: undici keeps pooled sockets (and SSE body machinery) alive past
 * `transport.close()`, and `process.exit()` while those handles are closing aborts the
 * process on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit 127).
 * Owning the sockets lets McpSession.close() leave no active handles behind.
 *
 * Redirects are never followed here; the SDK follows them itself (`redirect: 'manual'`
 * semantics) by reading the 3xx status and `Location` header.
 */
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface NodeHttpClient {
  fetch: FetchFn
  /** Abort in-flight requests and destroy every socket (active and pooled). Idempotent. */
  destroy(): void
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

async function bodyBytes(body: unknown, headers: Headers): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
    }
    return Buffer.from(body.toString())
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  if (body instanceof ReadableStream) return Buffer.from(await new Response(body).arrayBuffer())
  throw new TypeError(`Unsupported request body type: ${Object.prototype.toString.call(body)}`)
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else if (value !== undefined) headers.set(key, value)
  }
  return headers
}

export function createNodeHttpClient(): NodeHttpClient {
  const httpAgent = new http.Agent({ keepAlive: true })
  const httpsAgent = new https.Agent({ keepAlive: true })
  const live = new Set<http.ClientRequest>()
  let destroyed = false

  const fetchFn: FetchFn = async (input, init = {}) => {
    if (destroyed) throw new TypeError('fetch failed: the session HTTP client was closed')
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input))
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(request?.headers)
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    const signal = init.signal ?? request?.signal ?? undefined
    const body = await bodyBytes(
      init.body ?? (request?.body ? await request.arrayBuffer() : undefined),
      headers,
    )
    if (body) headers.set('content-length', String(body.length))
    if (signal?.aborted) throw abortReason(signal)

    const transport = url.protocol === 'https:' ? https : http
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError(`fetch failed: unsupported protocol ${url.protocol}`)
    }

    return new Promise<Response>((resolve, reject) => {
      const req = transport.request(url, {
        method,
        headers: Object.fromEntries(headers),
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      })
      live.add(req)
      const onAbort = () => req.destroy(abortReason(signal as AbortSignal) as Error)
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => {
        live.delete(req)
        signal?.removeEventListener('abort', onAbort)
      }
      req.on('error', (err) => {
        cleanup()
        reject(
          signal?.aborted
            ? abortReason(signal)
            : Object.assign(new TypeError('fetch failed'), { cause: err }),
        )
      })
      req.on('close', cleanup)
      req.on('response', (res) => {
        const status = res.statusCode ?? 0
        const nullBody = NULL_BODY_STATUS.has(status) || method === 'HEAD'
        if (nullBody) res.resume()
        try {
          resolve(
            new Response(
              nullBody ? null : (Readable.toWeb(res) as unknown as NodeReadableStream as never),
              { status, statusText: res.statusMessage, headers: toHeaders(res.headers) },
            ),
          )
        } catch (err) {
          res.destroy()
          reject(err)
        }
      })
      req.end(body)
    })
  }

  return {
    fetch: fetchFn,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const req of live) req.destroy()
      live.clear()
      httpAgent.destroy()
      httpsAgent.destroy()
    },
  }
}
