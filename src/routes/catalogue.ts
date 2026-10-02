/**
 * Catalogue, hits, and health.
 *
 * `/api/pack` is what makes locally generated art visible to the game as art
 * rather than as a one-off response — see `packProjection.ts`.
 */

import * as crypto from 'node:crypto'
import type { Config } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HitStore } from '../cache/hitStore.ts'
import type { ComfyClient } from '../comfy/client.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'
import { projectPack, characterCounts } from '../cache/packProjection.ts'
import { describeJobs } from './image.ts'

export interface CatalogueDeps {
  config: Config
  cache: CacheStore
  hits: HitStore
  comfy: ComfyClient
  jobs: JobRunner
  version: string
  /** Route patterns, so `/api/image/health` can describe what it serves. */
  patterns: () => string[]
}

export function registerCatalogueRoutes(router: Router, deps: CatalogueDeps): void {
  const { config, cache, hits, comfy, jobs } = deps

  /**
   * The probe target. The game pings this to decide whether a backend exists,
   * so it must be cheap and must answer even when ComfyUI is down — "I am here
   * but cannot render" is a different and more useful answer than silence.
   *
   * `capabilities` is how one review UI serves both this server and the private
   * dev server: the page hides the buttons whose capability is absent, instead
   * of the two forking into copies that drift.
   */
  router.get('/api/image/health', async ctx => {
    const comfyUp = await comfy.isReachable()
    sendJson(ctx.res, comfyUp ? 200 : 503, {
      status: comfyUp ? 'ok' : 'error',
      comfyui: comfyUp ? 'connected' : 'unavailable',
      server: 'wayward-imagegen',
      version: deps.version,
      // The bind address, so whoever finds this server on the port can tell
      // whether a phone on the LAN could reach it too (scripts/dev.ts).
      host: config.host,
      capabilities: [],
      images: cache.size,
      jobs: describeJobs(jobs),
    })
  })

  /** What this server can serve, in the game's own pack format. */
  router.get('/api/pack', ctx => {
    const sinceRaw = ctx.query.get('since')
    const since = sinceRaw ? Number(sinceRaw) : undefined
    if (sinceRaw && !Number.isFinite(since)) throw new HttpError(400, 'since must be epoch ms')

    const charsRaw = ctx.query.get('characters')
    const pack = projectPack(cache, {
      since,
      characters: charsRaw ? charsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    })

    // The catalogue changes only when a render lands, and the game fetches it
    // on every boot. An ETag turns the common case into a 304.
    const body = JSON.stringify(pack)
    const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, { ETag: etag }).end()
      return
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ETag: etag,
      'Cache-Control': 'no-cache',
    })
    ctx.res.end(body)
  })

  router.get('/api/wife-image-counts', ctx => {
    // Playable wives only — `patron` is shared art, not a pickable character.
    const wives = config.characterDirs.filter(c => c !== 'patron')
    sendJson(ctx.res, 200, { counts: characterCounts(cache, wives) })
  })

  /**
   * The display beacon.
   *
   * The game resolves cached images to URLs itself, so a display never
   * otherwise reaches this server; without this we could not tell a hot image
   * from one nothing has ever shown. Fire-and-forget: it always answers ok, and
   * a rejected path is silently ignored rather than surfaced to a player.
   */
  router.post('/api/image-hit', async ctx => {
    const body = await readJson<{ imagePath?: string }>(ctx.req, 8 * 1024)
    if (typeof body.imagePath === 'string') {
      // Accept only paths that name a real art file. The beacon carries a
      // client-supplied string; it is used purely as a JSON key, so there is no
      // traversal risk, but an unfiltered one lets any local page grow the
      // tally file without bound.
      hits.record(body.imagePath, p => cache.existingImagePaths().has(p))
    }
    sendJson(ctx.res, 200, { ok: true })
  })

  router.get('/api/hits', ctx => {
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 1000)
    const rows = Object.entries(hits.entries)
      .map(([imagePath, e]) => ({ imagePath, ...e }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
    sendJson(ctx.res, 200, { total: Object.keys(hits.entries).length, rows })
  })

}
