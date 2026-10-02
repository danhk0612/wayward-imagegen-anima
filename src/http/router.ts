/**
 * A small path router.
 *
 * The dev server matched routes with a chain of ~34 `if (url === ...)` /
 * `url.startsWith(...)` tests. Besides being linear, ordering bugs were
 * invisible: `/api/reviews/` as a prefix test shadowed `/api/reviews/human`,
 * and nothing said so. A table makes the whole surface readable at once and
 * matches on parsed segments, so a prefix cannot swallow a sibling.
 *
 * Patterns use `:name` for a single segment and a trailing `*` for a rest
 * match: `/api/image/status/:promptId`, `/images/*`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  /** Path segments captured by `:name` placeholders. */
  params: Record<string, string>
  /** Everything matched by a trailing `*`, undecoded. */
  rest: string
  query: URLSearchParams
  pathname: string
}

export type Handler = (ctx: RequestContext) => void | Promise<void>

export type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'

interface Route {
  method: Method
  segments: string[]
  wildcard: boolean
  handler: Handler
  pattern: string
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Thrown by a handler to produce a specific status without a stack trace. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

export class Router {
  private readonly routes: Route[] = []

  add(method: Method, pattern: string, handler: Handler): this {
    const wildcard = pattern.endsWith('/*')
    const clean = wildcard ? pattern.slice(0, -2) : pattern
    this.routes.push({ method, segments: splitPath(clean), wildcard, handler, pattern })
    return this
  }

  get(pattern: string, handler: Handler): this { return this.add('GET', pattern, handler) }
  post(pattern: string, handler: Handler): this { return this.add('POST', pattern, handler) }
  delete(pattern: string, handler: Handler): this { return this.add('DELETE', pattern, handler) }

  /** All registered patterns, for the health endpoint's self-description. */
  get patterns(): string[] {
    return this.routes.map(r => `${r.method} ${r.pattern}`)
  }

  /**
   * Route one request. Returns false when nothing matched, so the caller can
   * decide what a 404 looks like.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // The base is a placeholder — only the path and query are used. Node gives
    // us a path-and-query string, never an absolute URL.
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const segments = splitPath(pathname)
    const method = (req.method ?? 'GET') as Method

    // Exact-length matches first, so a wildcard route can never shadow a
    // more specific sibling registered after it.
    const ordered = [...this.routes].sort((a, b) => Number(a.wildcard) - Number(b.wildcard))

    for (const route of ordered) {
      if (route.method !== method) continue
      if (route.wildcard) {
        if (segments.length < route.segments.length) continue
      } else if (segments.length !== route.segments.length) {
        continue
      }

      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const spec = route.segments[i]
        const actual = segments[i]
        if (spec.startsWith(':')) {
          params[spec.slice(1)] = decodeURIComponent(actual)
        } else if (spec !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue

      const rest = route.wildcard ? segments.slice(route.segments.length).join('/') : ''

      await route.handler({ req, res, params, rest, query: url.searchParams, pathname })
      return true
    }

    return false
  }
}
