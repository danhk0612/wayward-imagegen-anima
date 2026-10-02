/**
 * Per-image view counts.
 *
 * The game resolves cache hits to file URLs entirely on its own — it holds the
 * catalogue and builds the `<img src>` directly — so a display never otherwise
 * reaches this server. The client therefore fires a tiny beacon per genuine
 * display and we tally it here.
 *
 * Kept in a SEPARATE compact sidecar keyed by image path, not on the cache
 * entry: the main index is tens of megabytes and must not be rewritten once per
 * view. Writes are debounced so a burst of views costs one write.
 *
 * These counts are what makes overnight pre-generation worth doing — they say
 * which images are actually seen rather than merely reachable.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { toPosix } from './paths.ts'

export interface ImageHitEntry {
  hits: number
  firstHitAt: number
  lastHitAt: number
}

export interface ImageHitsFile {
  version: 1
  entries: Record<string, ImageHitEntry>
}

/** Bound on a single key, so a hostile caller cannot grow the file unboundedly. */
const MAX_KEY_LENGTH = 512

const FLUSH_DEBOUNCE_MS = 10_000

export interface HitStoreOptions {
  stateDir: string
  flushDebounceMs?: number
  now?: () => number
}

export class HitStore {
  readonly filePath: string
  private readonly debounceMs: number
  private readonly now: () => number
  private hits: ImageHitsFile = { version: 1, entries: {} }
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private exitHookInstalled = false

  constructor(opts: HitStoreOptions) {
    this.filePath = path.join(path.resolve(opts.stateDir), 'image-hits.json')
    this.debounceMs = opts.flushDebounceMs ?? FLUSH_DEBOUNCE_MS
    this.now = opts.now ?? Date.now
  }

  load(): this {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ImageHitsFile
        if (data && data.entries) this.hits = data
      }
    } catch (err) {
      console.warn('[hits] unreadable, starting fresh:', (err as Error).message)
      this.hits = { version: 1, entries: {} }
    }
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true
      // Best-effort final flush. Synchronous on purpose — an async write during
      // 'exit' never lands.
      process.on('exit', () => this.flush())
    }
    return this
  }

  flush(): void {
    if (!this.dirty) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.hits))
      this.dirty = false
    } catch (err) {
      console.error('[hits] could not save:', (err as Error).message)
    }
  }

  /**
   * Register one display.
   *
   * `isKnown` lets the caller reject paths that are not in the catalogue. A
   * beacon carries a client-supplied string, and while it is only ever used as
   * a JSON key (so there is no traversal risk), an unfiltered one would let a
   * hostile page grow the file without bound.
   */
  record(relPath: string, isKnown?: (p: string) => boolean): boolean {
    const key = toPosix(relPath)
    if (!key || key.length > MAX_KEY_LENGTH) return false

    const existing = this.hits.entries[key]
    if (!existing && isKnown && !isKnown(key)) return false

    const now = this.now()
    if (existing) {
      existing.hits++
      existing.lastHitAt = now
    } else {
      this.hits.entries[key] = { hits: 1, firstHitAt: now, lastHitAt: now }
    }

    this.dirty = true
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.debounceMs)
      // Never hold the process open for a pending tally.
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
    return true
  }

  get(relPath: string): ImageHitEntry | undefined {
    return this.hits.entries[toPosix(relPath)]
  }

  get entries(): Readonly<Record<string, ImageHitEntry>> {
    return this.hits.entries
  }

  /** Stop the pending flush timer and write out. For clean shutdown. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }
}
