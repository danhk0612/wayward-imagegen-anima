/**
 * Projecting the local cache into the shipped pack format.
 *
 * The game already knows how to merge image packs — that is how the downloaded
 * art library is loaded. Serving the local cache in the SAME shape means a
 * freshly generated image becomes a first-class catalogue entry: addressable by
 * URL, eligible for the closest-match fallback, and still there after a reload,
 * with no new client-side format.
 *
 * `priority` is the one field the shipped format does not have. Packs otherwise
 * resolve collisions by `generatedAt`, and a locally rendered image must always
 * beat a shipped one — but faking a far-future date to force that would corrupt
 * the "your art is older than your build" notice. An explicit priority says the
 * intent instead of encoding it in a lie about the date.
 */

import type { CacheStore } from './cacheStore.ts'
import { toPosix } from './paths.ts'

export const PACK_FORMAT = 1

export interface PackEntry {
  imagePath: string
  talentName: string
  imageType?: string
}

export interface ImagePack {
  packFormat: number
  packId: string
  generatedAt: string
  characters: string[]
  entryCount: number
  entries: Record<string, PackEntry>
  /** Higher wins a key collision. Shipped packs are absent/0; this is 1. */
  priority?: number
  /**
   * Where these files are served from. The game resolves shipped entries
   * relative to the HTML file and these against the server, so it must be able
   * to tell them apart after merging.
   */
  baseUrl?: string
}

function characterOf(imagePath: string): string | null {
  const m = /characters\/([^/]+)\//.exec(toPosix(imagePath))
  return m ? m[1] : null
}

export interface ProjectOptions {
  packId?: string
  baseUrl?: string
  /** Only entries created at or after this epoch ms. */
  since?: number
  /** Restrict to these character folders. */
  characters?: readonly string[]
  /**
   * Drop entries whose file is missing. On by default: a catalogue entry
   * pointing at a deleted file renders as a broken image, and the index drifts
   * from the folder in normal use (players prune art, restore old libraries).
   */
  requireOnDisk?: boolean
}

/**
 * Build a pack from the current cache contents.
 *
 * Entries are keyed by `talentName` — the game's image key — not by the cache
 * key, because that is what the client looks up. When one state has several
 * renders (variants, or drift under different prompt hashes) the NEWEST wins,
 * which matches what a player expects right after pressing regenerate.
 */
export function projectPack(cache: CacheStore, opts: ProjectOptions = {}): ImagePack {
  const entries: Record<string, PackEntry> = {}
  const newestAt: Record<string, number> = {}
  const characters = new Set<string>()
  let newestOverall = 0

  const wanted = opts.characters ? new Set(opts.characters) : null
  const onDisk = opts.requireOnDisk === false ? null : cache.existingImagePaths()

  for (const entry of Object.values(cache.entries)) {
    if (opts.since !== undefined && entry.createdAt < opts.since) continue

    const imagePath = toPosix(entry.imagePath)
    if (onDisk && !onDisk.has(imagePath)) continue

    const character = characterOf(imagePath)
    if (wanted && (character === null || !wanted.has(character))) continue

    const existing = newestAt[entry.talentName]
    if (existing !== undefined && existing >= entry.createdAt) continue

    newestAt[entry.talentName] = entry.createdAt
    entries[entry.talentName] = {
      imagePath,
      talentName: entry.talentName,
      ...(entry.imageType ? { imageType: entry.imageType } : {}),
    }
    if (character) characters.add(character)
    if (entry.createdAt > newestOverall) newestOverall = entry.createdAt
  }

  return {
    packFormat: PACK_FORMAT,
    packId: opts.packId ?? 'local-server',
    // The newest render's date, not "now": this is when the art was made, which
    // is what the staleness notice is actually asking about.
    generatedAt: new Date(newestOverall || Date.now()).toISOString().slice(0, 10),
    characters: [...characters].sort(),
    entryCount: Object.keys(entries).length,
    entries,
    priority: 1,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  }
}

/**
 * Per-character counts for the new-game picker badges.
 *
 * Counts only art that is actually on disk — the badge answers "how much will
 * I see", and an index entry for a deleted file would inflate it. The character
 * comes from the image KEY rather than the folder, because the key is what the
 * game asked for; a legacy entry filed in the wrong folder still belongs to the
 * wife it depicts.
 */
export function characterCounts(
  cache: CacheStore,
  characters: readonly string[],
): Record<string, number> {
  const wanted = new Set(characters)
  const onDisk = cache.existingImagePaths()
  const counts: Record<string, number> = {}
  for (const c of wanted) counts[c] = 0

  for (const entry of Object.values(cache.entries)) {
    const character = entry.talentName.toLowerCase().split('__')[0]
    if (!wanted.has(character)) continue
    if (!onDisk.has(toPosix(entry.imagePath))) continue
    counts[character]++
  }
  return counts
}
