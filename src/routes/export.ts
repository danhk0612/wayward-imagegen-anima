/**
 * Exporting art to send upstream.
 *
 * A player who generates good pictures should be able to offer them back, and
 * a bundle has to carry enough for the receiving end to TRUST them: which key
 * each image answers, the prompt that produced it, and what model settings were
 * in use. An image rendered against a different checkpoint is not
 * interchangeable with the shipped art, so a bundle that omits that is not
 * really reviewable.
 *
 * The most valuable thing in here is not the pictures — it is the verdicts. A
 * person saying "this one is wrong" about a specific image is a signal nothing
 * else produces.
 *
 * The format is a directory, not a zip: this package spawns no subprocesses and
 * pulls in no archiver, and a folder someone can open and look through before
 * sending it is the honest shape for something they are about to share.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Config } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HitStore } from '../cache/hitStore.ts'
import type { ReviewStore } from './review.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'
import { toPosix, safeJoin } from '../cache/paths.ts'

export const BUNDLE_FORMAT = 1

export interface ExportDeps {
  config: Config
  cache: CacheStore
  hits: HitStore
  review: ReviewStore
  version: string
}

export interface ExportOptions {
  /** Only images created at or after this epoch ms. */
  since?: number
  /** Only these character folders. */
  characters?: string[]
  /** Only images the person marked good. */
  onlyKept?: boolean
  /** Hard cap, so an accidental click does not copy a whole library. */
  limit?: number
  /** Optional name to credit. Entirely up to the player. */
  contributor?: string
}

export interface ExportResult {
  bundleId: string
  directory: string
  images: number
  bytes: number
  skipped: number
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function buildBundle(deps: ExportDeps, opts: ExportOptions): ExportResult {
  const { config, cache, hits, review } = deps
  const limit = Math.min(opts.limit ?? 2000, 20000)
  const wanted = opts.characters ? new Set(opts.characters) : null
  const onDisk = cache.existingImagePaths()

  const bundleId = `contrib-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  const root = path.join(path.resolve(config.stateDir), 'contributions', bundleId)
  fs.mkdirSync(path.join(root, 'images'), { recursive: true })

  const entryLines: string[] = []
  const ratings: Record<string, unknown> = {}
  let images = 0
  let bytes = 0
  let skipped = 0

  for (const [key, entry] of Object.entries(cache.entries)) {
    if (images >= limit) break

    const rel = toPosix(entry.imagePath)
    if (!onDisk.has(rel)) { skipped++; continue }
    if (opts.since !== undefined && entry.createdAt < opts.since) continue

    const character = /characters\/([^/]+)\//.exec(rel)?.[1] ?? null
    if (wanted && (character === null || !wanted.has(character))) continue

    const decision = review.get(key)
    if (opts.onlyKept && decision?.rating !== 'good') continue

    let source: string
    try {
      source = safeJoin(cache.imagesDir, rel)
    } catch {
      skipped++
      continue
    }

    const dest = path.join(root, 'images', rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(source, dest)

    const size = fs.statSync(dest).size
    bytes += size
    images++

    entryLines.push(JSON.stringify({
      key: entry.talentName,
      cacheKey: key,
      imageType: entry.imageType,
      promptHash: entry.promptHash,
      // The prompt has to travel: the receiving end recomputes the hash from it
      // and rejects a mismatch, which is what catches a bundle built against a
      // drifted prompt builder.
      prompt: entry.prompt,
      // Present only for images rendered since the cache started recording it.
      // The importer treats its absence as "cannot verify" rather than "wrong".
      ...(entry.negativePrompt !== undefined ? { negativePrompt: entry.negativePrompt } : {}),
      // The hash folds these in when present, so verifying it upstream needs them.
      ...(entry.genParams ? { genParams: entry.genParams } : {}),
      imagePath: rel,
      bytes: size,
      sha256: sha256(dest),
      createdAt: entry.createdAt,
      hits: hits.get(rel)?.hits ?? 0,
      ...(decision ? { verdict: decision.rating, ...(decision.note ? { note: decision.note } : {}) } : {}),
    }))

    if (decision) ratings[entry.talentName] = decision
  }

  fs.writeFileSync(path.join(root, 'entries.jsonl'), entryLines.join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(root, 'ratings.json'), JSON.stringify(ratings, null, 2), 'utf8')
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    bundleFormat: BUNDLE_FORMAT,
    bundleId,
    createdAt: new Date().toISOString(),
    backendVersion: deps.version,
    images,
    bytes,
    ...(opts.contributor ? { contributor: opts.contributor } : {}),
    // Without these an image cannot be judged against the shipped art at all —
    // a different checkpoint is a different look, not a better or worse render.
    comfy: {
      checkpoint: config.checkpoint,
      lora: config.lora,
      loraStrength: config.loraStrength,
      sampler: config.sampler,
      scheduler: config.scheduler,
      clipSkip: config.clipSkip,
      steps: config.steps,
      cfg: config.cfg,
    },
  }, null, 2), 'utf8')

  return { bundleId, directory: root, images, bytes, skipped }
}

export function registerExportRoutes(router: Router, deps: ExportDeps): void {
  router.post('/api/contrib/export', async ctx => {
    const body = await readJson<ExportOptions>(ctx.req)
    if (body.since !== undefined && !Number.isFinite(body.since)) {
      throw new HttpError(400, 'since must be epoch ms')
    }
    const result = buildBundle(deps, body)
    sendJson(ctx.res, 200, {
      ...result,
      // Relative to the state dir: an absolute path names the operator's home
      // directory, and this response is shown in a browser.
      directory: path.relative(path.resolve(deps.config.stateDir), result.directory),
      note: 'Look through it before you send it — it contains your own images.',
    })
  })

  /** What an export WOULD contain, without copying anything. */
  router.get('/api/contrib/preview', ctx => {
    const since = ctx.query.get('since')
    const onlyKept = ctx.query.get('onlyKept') === '1'
    const cutoff = since ? Number(since) : undefined

    const onDisk = deps.cache.existingImagePaths()
    let images = 0
    let kept = 0
    let noted = 0

    for (const [key, entry] of Object.entries(deps.cache.entries)) {
      if (!onDisk.has(toPosix(entry.imagePath))) continue
      if (cutoff !== undefined && entry.createdAt < cutoff) continue
      const decision = deps.review.get(key)
      if (onlyKept && decision?.rating !== 'good') continue
      images++
      if (decision?.rating === 'good') kept++
      if (decision?.note) noted++
    }

    sendJson(ctx.res, 200, { images, kept, noted })
  })
}
