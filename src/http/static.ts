/**
 * Static file serving for the art library.
 *
 * In the dev setup Vite served `/images/*`; a player has no Vite, so this
 * server must serve its own art. Two things matter here:
 *
 *  - This is the one route that takes a filesystem path straight from a URL,
 *    so it is the reason `safeJoin` exists.
 *  - Images are the bulk of what this server does, so they get proper caching
 *    headers. A rendered file never changes once written — the cache key
 *    includes the prompt hash, so a different prompt is a different file — which
 *    means it can be marked immutable.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { safeJoin } from '../cache/paths.ts'

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function mimeFor(filename: string): string {
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

export interface ServeOptions {
  /** Send `immutable`. Correct for renders, wrong for anything hand-edited. */
  immutable?: boolean
}

/**
 * Serve one file from under `root`. Returns false when there is nothing to
 * serve, so the caller can 404 in its own voice.
 *
 * Supports range requests: video playback in Chrome depends on them, and
 * without a `206` the browser re-downloads the whole file on every seek.
 */
export function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  relative: string,
  opts: ServeOptions = {},
): boolean {
  let full: string
  try {
    full = safeJoin(root, relative)
  } catch {
    // A traversal attempt is indistinguishable from a typo to the caller; both
    // get "not here". Saying more would confirm the shape of the filesystem.
    return false
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(full)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const headers: Record<string, string> = {
    'Content-Type': mimeFor(full),
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': opts.immutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  }

  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      const start = m[1] === '' ? undefined : Number(m[1])
      const end = m[2] === '' ? undefined : Number(m[2])
      let from: number
      let to: number
      if (start === undefined && end !== undefined) {
        // `bytes=-500` means the LAST 500 bytes, not the first.
        from = Math.max(0, stat.size - end)
        to = stat.size - 1
      } else {
        from = start ?? 0
        to = end ?? stat.size - 1
      }
      if (from > to || from >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end()
        return true
      }
      to = Math.min(to, stat.size - 1)
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${from}-${to}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(to - from + 1),
      })
      if (req.method === 'HEAD') { res.end(); return true }
      fs.createReadStream(full, { start: from, end: to }).pipe(res)
      return true
    }
  }

  res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size) })
  if (req.method === 'HEAD') { res.end(); return true }
  fs.createReadStream(full).pipe(res)
  return true
}
