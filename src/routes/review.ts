/**
 * Curating your own art.
 *
 * A queue of everything rendered, plus a good/regen verdict per image. The
 * point is that a human verdict OUTRANKS anything a model scored: if you say a
 * picture is wrong, it is wrong, and the regeneration loop should act on that
 * rather than argue.
 *
 * The queue deliberately does not include prompts. It used to, and the response
 * for a full library ran to tens of megabytes of text the list never displayed
 * — several seconds before the first thumbnail appeared on a phone. Prompts are
 * fetched one at a time from `/api/review/entry` instead.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'
import { imageUrlFor } from './image.ts'
import { toPosix } from '../cache/paths.ts'

export type Verdict = 'good' | 'regen'

export interface ReviewDecision {
  rating: Verdict
  at: number
  /** What the person said was wrong. The most useful field in the file. */
  note?: string
}

interface ProgressFile {
  version: 1
  decisions: Record<string, ReviewDecision>
}

export class ReviewStore {
  readonly filePath: string
  private data: ProgressFile = { version: 1, decisions: {} }

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.filePath = path.join(path.resolve(stateDir), 'review-progress.json')
  }

  load(): this {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ProgressFile
        if (parsed?.decisions) this.data = parsed
      }
    } catch (err) {
      console.warn('[review] unreadable progress, starting fresh:', (err as Error).message)
    }
    return this
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('[review] could not save progress:', (err as Error).message)
    }
  }

  get(key: string): ReviewDecision | undefined {
    return this.data.decisions[key]
  }

  set(key: string, rating: Verdict, note?: string): ReviewDecision {
    const decision: ReviewDecision = {
      rating,
      at: this.now(),
      ...(note && note.trim() ? { note: note.trim() } : {}),
    }
    this.data.decisions[key] = decision
    this.save()
    return decision
  }

  clear(key?: string): number {
    if (key) {
      const had = key in this.data.decisions
      delete this.data.decisions[key]
      this.save()
      return had ? 1 : 0
    }
    const n = Object.keys(this.data.decisions).length
    this.data = { version: 1, decisions: {} }
    this.save()
    return n
  }

  get decisions(): Readonly<Record<string, ReviewDecision>> {
    return this.data.decisions
  }
}

export interface ReviewDeps {
  config: Config
  cache: CacheStore
  jobs: JobRunner
  review: ReviewStore
}

export function registerReviewRoutes(router: Router, deps: ReviewDeps): void {
  const { cache, jobs, review } = deps

  /**
   * A page of images to look at.
   *
   * `undecided=1` is the mode that matters in practice — reviewing is a long
   * job and nobody wants to scroll past what they already judged.
   */
  router.get('/api/review/queue', ctx => {
    const character = ctx.query.get('character')
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500)
    const offset = Math.max(Number(ctx.query.get('offset') ?? 0) || 0, 0)
    const undecidedOnly = ctx.query.get('undecided') === '1'

    const onDisk = cache.existingImagePaths()
    const rows: {
      key: string
      talentName: string
      imageType: string
      workflow: string
      imageUrl: string
      createdAt: number
      rating?: Verdict
      note?: string
    }[] = []

    for (const [key, entry] of Object.entries(cache.entries)) {
      const imagePath = toPosix(entry.imagePath)
      // An entry whose file is gone would render as a broken tile.
      if (!onDisk.has(imagePath)) continue
      if (character && !imagePath.includes(`characters/${character}/`)) continue

      const decision = review.get(key)
      if (undecidedOnly && decision) continue

      rows.push({
        key,
        talentName: entry.talentName,
        imageType: entry.imageType,
        workflow: key.split('_')[0],
        imageUrl: imageUrlFor(imagePath),
        createdAt: entry.createdAt,
        ...(decision ? { rating: decision.rating, ...(decision.note ? { note: decision.note } : {}) } : {}),
      })
    }

    rows.sort((a, b) => b.createdAt - a.createdAt)
    sendJson(ctx.res, 200, {
      total: rows.length,
      offset,
      limit,
      entries: rows.slice(offset, offset + limit),
    })
  })

  /** The heavy per-image detail the queue leaves out. */
  router.get('/api/review/entry', ctx => {
    const key = ctx.query.get('key')
    if (!key) throw new HttpError(400, 'key is required')
    const entry = cache.entries[key]
    if (!entry) throw new HttpError(404, 'unknown key')

    const decision = review.get(key)
    sendJson(ctx.res, 200, {
      key,
      talentName: entry.talentName,
      imageType: entry.imageType,
      promptHash: entry.promptHash,
      prompt: entry.prompt ?? '',
      imagePath: entry.imagePath,
      imageUrl: imageUrlFor(toPosix(entry.imagePath)),
      createdAt: entry.createdAt,
      decision: decision ?? null,
    })
  })

  /**
   * Record a verdict.
   *
   * Callers give either the cache `key` (the review page has it) or
   * `talentName` plus type and workflow — which is what the in-game thumbs
   * buttons send, because the game knows the image key but not the prompt hash
   * that completes the cache key.
   */
  router.post('/api/review/mark', async ctx => {
    const body = await readJson<{
      key?: string
      talentName?: string
      imageType?: string
      workflow?: string
      rating?: Verdict
      note?: string
    }>(ctx.req, 64 * 1024)

    if (body.rating !== 'good' && body.rating !== 'regen') {
      throw new HttpError(400, "rating must be 'good' or 'regen'")
    }

    let key = body.key
    if (!key && body.talentName) {
      const wantedType = body.imageType || 'portrait'
      const wantedWorkflow = body.workflow || 'illustrious'
      // Newest first, so a thumbs-down lands on the image being looked at
      // rather than an older render of the same state.
      const candidates = Object.entries(cache.entries)
        .filter(([k, e]) =>
          e.talentName === body.talentName
          && e.imageType === wantedType
          && k.startsWith(wantedWorkflow + '_'))
        .sort((a, b) => b[1].createdAt - a[1].createdAt)
      key = candidates[0]?.[0]
    }
    if (!key) throw new HttpError(404, 'no image matches that request')
    if (!(key in cache.entries)) throw new HttpError(404, 'unknown key')

    sendJson(ctx.res, 200, { ok: true, key, decision: review.set(key, body.rating, body.note) })
  })

  router.post('/api/review/reset', async ctx => {
    const body = await readJson<{ key?: string }>(ctx.req)
    sendJson(ctx.res, 200, { cleared: review.clear(body.key) })
  })

  /** What the GPU is doing right now, for the review page's status line. */
  router.get('/api/review/inflight', ctx => {
    sendJson(ctx.res, 200, {
      jobs: jobs.activeJobs().map(j => ({
        promptId: j.promptId,
        talentName: j.talentName,
        status: j.status,
        startedAt: j.startedAt,
        bulk: j.bulk === true,
      })),
    })
  })
}
