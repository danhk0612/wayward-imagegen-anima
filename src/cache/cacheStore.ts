/**
 * The persistent image cache.
 *
 * One JSON index (`<imagesDir>/.image-cache.json`) mapping a cache key to the
 * file that satisfies it. This is the memory that makes a render happen once:
 * without it, replaying the same game state would re-run the sampler every
 * time.
 *
 * Instance-scoped rather than module-global so tests can spin one up against a
 * temp directory, and so a future second library needs no new code.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkflowType } from '../config.ts'
import { getCacheKey, isUserCreatedVariant } from '../naming.ts'
import { safeJoin, toPosix } from './paths.ts'

export interface CacheEntry {
  promptHash: string
  /** Path relative to the images root, forward-slashed. */
  imagePath: string
  talentName: string
  imageType: string
  createdAt: number
  /** Kept for debugging and for re-deriving a render. */
  prompt: string
  /**
   * The negative prompt, when known.
   *
   * Optional because the historical index does not have it — entries written
   * before this field existed carry only the positive prompt. It matters for
   * contribution bundles: `promptHash` covers BOTH prompts, so without this the
   * receiving end cannot recompute the hash and has nothing to check the image
   * against.
   */
  negativePrompt?: string
  /**
   * The generation settings this render used.
   *
   * Recorded because `promptHash` FOLDS THEM IN when they are present: two
   * requests with the same text but different steps produce different pictures
   * and must not share a cache cell. Without them stored, the hash cannot be
   * recomputed from the entry, so nothing downstream can check that an entry
   * describes what it claims — which is exactly what a contribution bundle
   * needs to prove.
   */
  genParams?: { steps?: number; cfg?: number; loraStrength?: number; checkpoint?: string }
  /** Optional caller-supplied state snapshot; shape is deliberately open. */
  debug?: Record<string, unknown>
  /**
   * Created by an explicit user action rather than by autopilot. Such entries
   * sit at variant indices normal play never reaches, so without this flag a
   * cull would read them as dead weight and delete work someone asked for.
   */
  userCreated?: boolean
}

export interface ImageCacheFile {
  version: 1
  entries: Record<string, CacheEntry>
}

export interface CacheStoreOptions {
  imagesDir: string
  /** The game's `MAX_CACHED_VARIANTS`; indices at or above it are user-created. */
  userVariantThreshold?: number
  /** Injected for tests. */
  now?: () => number
}

export class CacheStore {
  readonly imagesDir: string
  readonly indexPath: string
  private readonly userVariantThreshold: number | undefined
  private readonly now: () => number
  private cache: ImageCacheFile = { version: 1, entries: {} }
  private existingCache: { builtAt: number; set: Set<string> } | null = null

  constructor(opts: CacheStoreOptions) {
    this.imagesDir = path.resolve(opts.imagesDir)
    this.indexPath = path.join(this.imagesDir, '.image-cache.json')
    this.userVariantThreshold = opts.userVariantThreshold
    this.now = opts.now ?? Date.now
  }

  /**
   * Read the index from disk. A corrupt file starts empty rather than throwing:
   * losing the index costs GPU time, but refusing to start costs the player
   * their whole session.
   */
  load(): this {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as ImageCacheFile
        if (data && data.entries) {
          this.cache = data
          console.log(`[cache] loaded ${Object.keys(data.entries).length} entries`)
        }
      } else {
        console.log('[cache] no index yet, starting fresh')
      }
    } catch (err) {
      console.error('[cache] unreadable index, starting fresh:', (err as Error).message)
      this.cache = { version: 1, entries: {} }
    }
    return this
  }

  save(): void {
    try {
      fs.mkdirSync(this.imagesDir, { recursive: true })
      fs.writeFileSync(this.indexPath, JSON.stringify(this.cache, null, 2))
    } catch (err) {
      console.error('[cache] could not save index:', (err as Error).message)
    }
  }

  get entries(): Readonly<Record<string, CacheEntry>> {
    return this.cache.entries
  }

  get size(): number {
    return Object.keys(this.cache.entries).length
  }

  /** Absolute path of an entry's file, or null if the entry's path is unsafe. */
  absolutePathOf(entry: CacheEntry): string | null {
    try {
      return safeJoin(this.imagesDir, entry.imagePath)
    } catch {
      return null
    }
  }

  /**
   * Look up a render, verifying the file is still there.
   *
   * The existence check is not paranoia: players move and prune art folders,
   * and an index pointing at a deleted file produces a broken image with no
   * error anywhere. A miss self-heals by dropping the stale entry.
   */
  get(
    talentName: string,
    imageType: string,
    promptHash: string,
    workflow: WorkflowType,
  ): CacheEntry | null {
    const key = getCacheKey(talentName, imageType, promptHash, workflow)
    const entry = this.cache.entries[key]
    if (!entry) return null

    const full = this.absolutePathOf(entry)
    if (!full || !fs.existsSync(full)) {
      console.log(`[cache] file gone, dropping entry: ${key}`)
      delete this.cache.entries[key]
      this.save()
      return null
    }
    return entry
  }

  add(args: {
    talentName: string
    imageType: string
    promptHash: string
    /** Relative to the images root. Stored forward-slashed. */
    imagePath: string
    prompt: string
    negativePrompt?: string
    genParams?: { steps?: number; cfg?: number; loraStrength?: number; checkpoint?: string }
    workflow: WorkflowType
    debug?: Record<string, unknown>
    userCreated?: boolean
  }): CacheEntry {
    const key = getCacheKey(args.talentName, args.imageType, args.promptHash, args.workflow)
    const entry: CacheEntry = {
      promptHash: args.promptHash,
      imagePath: toPosix(args.imagePath),
      talentName: args.talentName,
      imageType: args.imageType,
      createdAt: this.now(),
      prompt: args.prompt,
      ...(args.negativePrompt ? { negativePrompt: args.negativePrompt } : {}),
      ...(args.genParams && Object.values(args.genParams).some(v => v !== undefined)
        ? { genParams: args.genParams } : {}),
      ...(args.debug ? { debug: args.debug } : {}),
      ...(args.userCreated || isUserCreatedVariant(args.talentName, this.userVariantThreshold)
        ? { userCreated: true }
        : {}),
    }
    this.cache.entries[key] = entry
    this.existingCache = null
    this.save()
    return entry
  }

  /** Remove one entry by key. Returns whether it was there. */
  remove(key: string): boolean {
    if (!(key in this.cache.entries)) return false
    delete this.cache.entries[key]
    this.existingCache = null
    this.save()
    return true
  }

  /** Every entry for a talentName, newest first. */
  variantsOf(talentName: string): CacheEntry[] {
    return Object.values(this.cache.entries)
      .filter(e => e.talentName === talentName)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * The set of art files actually present, forward-slashed.
   *
   * The index and the folder drift apart in normal use: players prune art,
   * move folders, or restore an old library. An entry pointing at a file that
   * is gone renders as a broken image, so anything that reports what a player
   * can SEE — the catalogue, the per-character counts — filters through this.
   *
   * Built from a handful of directory listings rather than one `existsSync`
   * per entry, and cached briefly, because there are tens of thousands of them.
   */
  existingImagePaths(maxAgeMs = 30_000): Set<string> {
    const now = this.now()
    if (this.existingCache && now - this.existingCache.builtAt < maxAgeMs) {
      return this.existingCache.set
    }

    const set = new Set<string>()
    const workflowsDir = this.imagesDir
    let workflows: string[]
    try {
      workflows = fs.readdirSync(workflowsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    } catch {
      workflows = []
    }

    for (const wf of workflows) {
      const charsDir = path.join(workflowsDir, wf, 'characters')
      let chars: string[]
      try {
        chars = fs.readdirSync(charsDir)
      } catch {
        continue
      }
      for (const ch of chars) {
        let files: string[]
        try {
          files = fs.readdirSync(path.join(charsDir, ch))
        } catch {
          continue
        }
        for (const f of files) set.add(`${wf}/characters/${ch}/${f}`)
      }
    }

    this.existingCache = { builtAt: now, set }
    return set
  }

  /** Total bytes of the art library, for the disk ceiling. Walks lazily. */
  diskUsageBytes(): number {
    let total = 0
    const walk = (dir: string): void => {
      let items: fs.Dirent[]
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) walk(full)
        else {
          try { total += fs.statSync(full).size } catch { /* vanished mid-walk */ }
        }
      }
    }
    walk(this.imagesDir)
    return total
  }
}
