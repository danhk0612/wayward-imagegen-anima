/**
 * Path safety.
 *
 * Every filesystem path derived from a request goes through here. The rule is
 * one line long — a resolved path must stay inside its root — but it has to be
 * applied at every entry point, because a single unguarded join is a full
 * arbitrary-read of the player's disk.
 *
 * Note this is defence in depth: keys are also run through `sanitizeName`,
 * whose output alphabet cannot express `..` or a drive letter. The static file
 * route is the case that genuinely needs this, since it takes a path directly
 * from the URL.
 */

import * as path from 'node:path'

export class UnsafePathError extends Error {
  constructor(public readonly attempted: string) {
    super(`refusing path outside the permitted root: ${attempted}`)
    this.name = 'UnsafePathError'
  }
}

/**
 * Resolve `relative` inside `root`, or throw.
 *
 * Handles the cases that matter: `..` segments, absolute paths (which
 * `path.join` would happily accept and `path.resolve` would honour), Windows
 * drive letters and UNC prefixes, backslash separators, and percent-encoding —
 * including double-encoding, which is why decoding is repeated until stable.
 */
export function safeJoin(root: string, relative: string): string {
  let decoded = relative
  // A single decode pass leaves `%252e%252e%252f` as `%2e%2e%2f`, which a
  // later consumer might decode again. Keep going until it stops changing.
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      // Malformed escapes are not something a legitimate caller sends.
      throw new UnsafePathError(relative)
    }
    if (next === decoded) break
    decoded = next
  }

  if (decoded.includes('\0')) throw new UnsafePathError(relative)

  // Normalise separators so a Windows-style path is checked the same way.
  const slashed = decoded.replace(/\\/g, '/')

  // A UNC prefix (`//host/share`) must be rejected BEFORE leading slashes are
  // stripped, or it degrades into an innocent-looking relative path and the
  // check never fires. `path.resolve` treats it as a network location on
  // Windows and as a plain path elsewhere — differing by platform is itself
  // the hazard. One leading slash is fine and means "relative to the root".
  if (slashed.startsWith('//')) throw new UnsafePathError(relative)

  const unified = slashed.replace(/^\/+/, '')

  // `path.isAbsolute` misses drive-relative `C:foo` when the check runs on a
  // posix host, so reject drive letters explicitly.
  if (/^[a-zA-Z]:/.test(unified)) throw new UnsafePathError(relative)

  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, unified)
  const rel = path.relative(resolvedRoot, resolved)

  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafePathError(relative)
  }

  return resolved
}

/** True when `relative` resolves safely inside `root`. */
export function isSafeRelative(root: string, relative: string): boolean {
  try {
    safeJoin(root, relative)
    return true
  } catch {
    return false
  }
}

/**
 * Store paths forward-slashed regardless of host OS.
 *
 * The art catalogue is shipped to players and read in a browser, so a
 * backslash written by a Windows dev becomes a broken `<img src>` on someone
 * else's machine.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}
