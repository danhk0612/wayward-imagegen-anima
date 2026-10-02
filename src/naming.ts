/**
 * Naming, hashing, and key derivation.
 *
 * These decide where a render lands on disk and which cache cell it occupies.
 * They are pure and do no I/O, which is what lets the game's dev-tools plugin
 * import them back instead of keeping a second copy — there must be exactly
 * one definition of a cache key in the world.
 *
 * Every function here is behaviour-frozen: an existing art library was keyed
 * with them, so a "cleanup" that changes one character of output silently
 * orphans thousands of images. Change them only with a migration.
 */

import type { WorkflowType } from './config.ts'

/**
 * FNV-1a over the prompt pair, 8 hex chars. This is the identity of a render:
 * same prompt text, same cell.
 */
export function hashPrompt(prompt: string, negativePrompt?: string): string {
  const input = JSON.stringify({ prompt, negativePrompt })
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface GenParamsForHash {
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  /** Extra render conditions that materially change the image. */
  renderSignature?: string
}

/**
 * The identity of a render, from its prompts and settings.
 *
 * Generation settings are folded in WHEN PRESENT: the same text at nine steps
 * and at fourteen produces different pictures, and they must not share a cache
 * cell. When none are set the plain two-argument hash is used, which is what
 * keeps the historical index valid.
 *
 * This is a contract between whoever writes a cache entry and anything that
 * later verifies one — a contribution bundle cannot be checked if the two sides
 * derive the hash differently. One definition, here.
 */
export function derivePromptHash(
  prompt: string,
  negativePrompt: string,
  params?: GenParamsForHash,
): string {
  const { steps, cfg, loraStrength, checkpoint, renderSignature } = params ?? {}
  if (steps || cfg || loraStrength || checkpoint || renderSignature) {
    return hashPrompt(
      `${prompt}|${negativePrompt}|s${steps ?? ''}c${cfg ?? ''}l${loraStrength ?? ''}|ckpt:${checkpoint ?? ''}|sig:${renderSignature ?? ''}`,
    )
  }
  return hashPrompt(prompt, negativePrompt)
}

/**
 * Sanitize a name for the filesystem — matches the client-side sanitization.
 *
 * Permits dashes and preserves DOUBLED underscores so the structured image-key
 * format (`elena__scene-groped_ass__outfit-lingerie__...`) survives intact: the
 * game's cache fallback parses talentName by splitting on `__` and `-`, so
 * collapsing them here would break matching.
 *
 * It is also the first line of path defence — the output alphabet is
 * `[a-z0-9_-]`, so nothing derived from it can escape a directory.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_{3,}/g, '__')         // collapse 3+ underscores down to 2
    .replace(/^[_-]+|[_-]+$/g, '')   // trim leading/trailing separators
}

/** The persistent cache key. Includes the workflow so backends stay separate. */
export function getCacheKey(
  talentName: string,
  imageType: string,
  promptHash: string,
  workflow: WorkflowType = 'z-image',
): string {
  return `${workflow}_${sanitizeName(talentName)}_${imageType}_${promptHash}`
}

/** The in-flight dedup key — same identity, different separator. */
export function jobKey(
  talentName: string,
  imageType: string,
  promptHash: string,
  workflow: WorkflowType,
): string {
  return `${workflow}|${sanitizeName(talentName)}|${imageType}|${promptHash}`
}

/**
 * Variant indices at or above the game's cached ceiling are unreachable through
 * normal play (the runtime modulos into 0..ceiling-1). The "+ another variant"
 * button hands them out deliberately, so entries at those indices are flagged
 * `userCreated` and survive a cull.
 *
 * The ceiling belongs to the game (`MAX_CACHED_VARIANTS` in
 * `src/engine/imagePrompts.ts`); it is passed in rather than assumed so the two
 * cannot drift silently.
 */
export const DEFAULT_USER_VARIANT_THRESHOLD = 4

export function isUserCreatedVariant(
  talentName: string,
  threshold = DEFAULT_USER_VARIANT_THRESHOLD,
): boolean {
  const m = talentName.match(/__v-(\d+)/)
  return m ? Number(m[1]) >= threshold : false
}

/**
 * Extract the character folder from a talentName.
 *   "tavern_emma_break_kitchen_..." -> "emma"
 *   "emma_serving_abc123"           -> "emma"
 * Returns null when no known character matches; callers file those under
 * `unknown` rather than guessing, because a wrong folder is a wrong image later.
 */
export function extractCharacterName(
  talentName: string,
  characters: readonly string[],
): string | null {
  const lower = talentName.toLowerCase()

  if (lower.startsWith('tavern_')) {
    const afterTavern = lower.slice(7)
    for (const char of characters) {
      if (afterTavern.startsWith(char + '_') || afterTavern === char) return char
    }
  }

  for (const char of characters) {
    if (lower.startsWith(char + '_') || lower === char) return char
  }

  return null
}

/**
 * Build a descriptive filename body from a talentName, dropping the character
 * and `tavern_` prefixes:
 *   "pippa__task-idle__outfit-modest__room-taproom__v-13"
 *     -> "task-idle_outfit-modest_room-taproom_v-13"
 *
 * The cache KEY keeps `__` as a field separator; the on-disk FILENAME does not
 * need it, so this collapses to single underscores for readability. Lookups use
 * `talentName` from the cache JSON, never the filename, so the collapse is
 * cosmetic only.
 */
export function buildActivityDescriptor(
  talentName: string,
  characters: readonly string[],
): string {
  const sanitized = sanitizeName(talentName)
  let result = sanitized

  if (result.startsWith('tavern_')) {
    result = result.slice(7)
  }

  for (const char of characters) {
    if (result.startsWith(char + '_')) {
      result = result.slice(char.length + 1)
      break
    }
  }

  // Trim leftover separators: sanitizeName lets `__` through as a field
  // separator, so stripping `pippa_` from `pippa__task-...` leaves a leading `_`.
  result = result.replace(/^[_-]+/, '')

  // Filename-only collapse. The cache key still uses `__`.
  result = result.replace(/__+/g, '_')

  if (result.length > 100) {
    result = result.slice(0, 100)
  }

  return result || 'unknown'
}
