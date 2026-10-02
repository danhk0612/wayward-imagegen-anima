/**
 * Batch routes: submit a list of images to render, then watch it happen.
 *
 * The game enumerates the work — it is the only thing that knows what prompts
 * this build produces — and posts it here in chunks. Doing it the other way
 * round, shipping a pre-built plan file, goes stale silently: change one string
 * in the prompt builder and the player spends a night rendering keys the game
 * will never ask for.
 */

import type { BatchQueue, BatchItem } from './queue.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'

/** One request's worth of work. Bigger lists arrive as several chunks. */
const MAX_ITEMS_PER_REQUEST = 5000
const ENQUEUE_BODY_LIMIT = 8 * 1024 * 1024

export function registerBatchRoutes(router: Router, queue: BatchQueue): void {
  router.post('/api/batch/enqueue', async ctx => {
    const body = await readJson<{ items?: BatchItem[]; jobId?: string; start?: boolean }>(
      ctx.req, ENQUEUE_BODY_LIMIT,
    )
    const items = body.items
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array')
    if (items.length > MAX_ITEMS_PER_REQUEST) {
      throw new HttpError(413, `at most ${MAX_ITEMS_PER_REQUEST} items per request`)
    }
    for (const item of items) {
      if (!item || typeof item.talentId !== 'string' || typeof item.prompt !== 'string') {
        throw new HttpError(400, 'each item needs a talentId and a prompt')
      }
    }

    const result = queue.enqueue(items, body.jobId)
    if (body.start !== false) queue.start()
    sendJson(ctx.res, 200, { ...result, status: queue.status() })
  })

  router.get('/api/batch/status', ctx => {
    sendJson(ctx.res, 200, queue.status())
  })

  router.post('/api/batch/pause', ctx => {
    queue.pause()
    sendJson(ctx.res, 200, queue.status())
  })

  router.post('/api/batch/resume', ctx => {
    queue.start()
    sendJson(ctx.res, 200, queue.status())
  })

  router.post('/api/batch/clear', ctx => {
    queue.clear()
    sendJson(ctx.res, 200, queue.status())
  })
}
