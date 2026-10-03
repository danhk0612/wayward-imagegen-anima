/**
 * Local lifecycle controls for the browser UI.
 *
 * These endpoints are loopback-only. They intentionally do not expose a
 * general remote kill switch when the image server is bound to the LAN.
 */

import type { BatchQueue } from '../batch/queue.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import type { RuntimeActivity } from '../runtime/activity.ts'
import { Router, sendJson, HttpError, type RequestContext } from '../http/router.ts'

function requireLocal(ctx: RequestContext): void {
  const address = ctx.req.socket.remoteAddress
  const local = address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
  if (!local) throw new HttpError(403, 'control API is available only from this computer')
}

export function registerControlRoutes(
  router: Router,
  deps: {
    batch: BatchQueue
    jobs: JobRunner
    runtime: RuntimeActivity
    shutdown: () => void
  },
): void {
  router.get('/api/control/status', ctx => {
    requireLocal(ctx)
    sendJson(ctx.res, 200, deps.runtime.snapshot())
  })

  router.post('/api/control/cancel-active', async ctx => {
    requireLocal(ctx)
    deps.batch.pause()
    const result = await deps.jobs.cancelAllOwn()
    sendJson(ctx.res, 200, {
      ok: true,
      batch: deps.batch.status(),
      ...result,
    })
  })

  router.post('/api/control/shutdown', async ctx => {
    requireLocal(ctx)
    deps.batch.pause()
    const result = await deps.jobs.cancelAllOwn()
    sendJson(ctx.res, 200, {
      ok: true,
      message: 'wayward-imagegen is shutting down',
      ...result,
    })
    setTimeout(deps.shutdown, 50).unref()
  })
}
