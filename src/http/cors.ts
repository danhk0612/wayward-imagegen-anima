/**
 * CORS.
 *
 * The game is a single HTML file the player opens from disk, so it reaches this
 * server from `Origin: null` — the origin a `file://` page sends. That has to be
 * allowed, and it is why this cannot use credentials: `Access-Control-Allow-
 * Credentials` is invalid alongside a null or wildcard origin, and there is
 * nothing here worth authenticating anyway.
 *
 * It is deliberately NOT `Access-Control-Allow-Origin: *`. This server writes
 * files and commands a GPU, and Chrome's Local Network Access explicitly
 * exempts `file://` pages from its permission gate, so the browser will not
 * stop a hostile local page on our behalf. An allowlist is the only filter
 * there is. It is a weak one — `Origin: null` is shared by every `file://` page
 * and every sandboxed iframe, so it cannot tell the player's game from someone
 * else's — which is why the real protection is that this server spawns nothing,
 * writes nowhere but its own art folder, and caps how much work it will do.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Origins allowed without configuration:
 *  - `null`      the downloaded game, opened from disk
 *  - loopback    the dev server, and the review UI served from here
 *  - the LAN     only when bound beyond loopback (`--host 0.0.0.0`): a page
 *                served from a machine on the same network — the dev server
 *                opened on a phone. Binding to the network already means every
 *                device on it may call this server; a browser page on one of
 *                them is not a wider set.
 *
 * Anything else — a hosted build, say — must be named with `--allow-origin`.
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

// RFC 1918, link-local and CGNAT (Tailscale) literals, mDNS `.local`, a
// Tailscale MagicDNS name, or a bare machine name (`http://desktop:5173`) —
// the ways a page on the same network names its host.
const PRIVATE_NETWORK =
  /^https?:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+(\.local)?|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net)(:\d+)?$/i

export interface OriginPolicy {
  /** Set when the server listens on more than loopback. */
  lan?: boolean
}

export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
  policy: OriginPolicy = {},
): boolean {
  // No Origin header at all: a non-browser caller (curl, the CLI runner). CORS
  // is a browser mechanism and has nothing to say about these.
  if (origin === undefined) return true
  if (origin === 'null') return true
  if (LOOPBACK.test(origin)) return true
  if (policy.lan && PRIVATE_NETWORK.test(origin)) return true
  return allowed.includes(origin)
}

/**
 * Apply CORS headers. Returns true if the request was a preflight and has been
 * fully answered, in which case the caller must not route it.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
  policy: OriginPolicy = {},
): boolean {
  const origin = req.headers.origin

  // Always vary: a cached response carrying one origin's headers would be
  // served to another.
  res.setHeader('Vary', 'Origin')

  if (origin !== undefined && isOriginAllowed(origin, allowed, policy)) {
    // Reflect rather than wildcard so the set stays explicit.
    res.setHeader('Access-Control-Allow-Origin', origin)
  }

  if (req.method === 'OPTIONS') {
    if (origin !== undefined && !isOriginAllowed(origin, allowed, policy)) {
      // No CORS headers were set, so the browser blocks the real request. 403
      // makes the reason visible to anyone reading the network tab.
      res.writeHead(403).end()
      return true
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    // A day, so a session's worth of JSON POSTs preflight once.
    res.setHeader('Access-Control-Max-Age', '86400')
    res.writeHead(204).end()
    return true
  }

  return false
}
