/**
 * The server: wiring, not policy.
 *
 * Everything it composes is instance-scoped and injected, so a test can stand
 * a whole server up against a temp directory and a stub ComfyUI.
 */

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundBeyondLoopback, type Config } from './config.ts'
import { CacheStore } from './cache/cacheStore.ts'
import { HitStore } from './cache/hitStore.ts'
import { ComfyClient } from './comfy/client.ts'
import { JobRunner } from './comfy/jobRunner.ts'
import { Router, sendJson, HttpError } from './http/router.ts'
import { applyCors } from './http/cors.ts'
import { serveFile } from './http/static.ts'
import { BodyTooLargeError, MalformedBodyError } from './http/body.ts'
import { registerImageRoutes } from './routes/image.ts'
import { registerCatalogueRoutes } from './routes/catalogue.ts'
import { registerReviewRoutes, ReviewStore } from './routes/review.ts'
import { registerVideoRoutes } from './routes/video.ts'
import { registerExportRoutes } from './routes/export.ts'
import { registerSetupRoutes } from './routes/setup.ts'
import { registerControlRoutes } from './routes/control.ts'
import { BatchQueue } from './batch/queue.ts'
import { registerBatchRoutes } from './batch/routes.ts'

export const VERSION = '0.1.0'

export interface ServerHandle {
  server: http.Server
  config: Config
  cache: CacheStore
  hits: HitStore
  jobs: JobRunner
  comfy: ComfyClient
  batch: BatchQueue
  /** Actual bound port — differs from config only when config asked for 0. */
  port: number
  close(): Promise<void>
}

/** Append-only miss log. Best-effort: losing a line is not worth an error. */
function makeMissLogger(stateDir: string): (line: Record<string, unknown>) => void {
  const file = path.join(stateDir, 'cache-misses.jsonl')
  return line => {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
    } catch { /* best effort */ }
  }
}

/**
 * Discard the remainder of a request body we have refused, up to `budget`
 * bytes, so the sender can finish writing and read our response. Past the
 * budget the connection is dropped.
 */
function drainAndClose(req: http.IncomingMessage, budget: number): void {
  let drained = 0
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length
    if (drained > budget) req.destroy()
  })
  req.on('error', () => { /* the sender gave up; nothing to do */ })
  req.resume()
}

export function buildRouter(deps: {
  config: Config
  cache: CacheStore
  hits: HitStore
  comfy: ComfyClient
  jobs: JobRunner
  review: ReviewStore
  batch: BatchQueue
  shutdown: () => void
}): Router {
  const router = new Router()
  registerImageRoutes(router, {
    config: deps.config,
    cache: deps.cache,
    jobs: deps.jobs,
    logMiss: makeMissLogger(deps.config.stateDir),
  })
  registerSetupRoutes(router, deps.config, deps.cache)
  registerControlRoutes(router, {
    batch: deps.batch,
    jobs: deps.jobs,
    shutdown: deps.shutdown,
  })
  registerBatchRoutes(router, deps.batch)
  registerExportRoutes(router, {
    config: deps.config,
    cache: deps.cache,
    hits: deps.hits,
    review: deps.review,
    version: VERSION,
  })
  registerVideoRoutes(router, {
    config: deps.config,
    comfy: deps.comfy,
    jobs: deps.jobs,
  })
  registerReviewRoutes(router, {
    config: deps.config,
    cache: deps.cache,
    jobs: deps.jobs,
    review: deps.review,
  })
  registerCatalogueRoutes(router, {
    config: deps.config,
    cache: deps.cache,
    hits: deps.hits,
    comfy: deps.comfy,
    jobs: deps.jobs,
    version: VERSION,
    patterns: () => router.patterns,
  })
  return router
}

export async function startServer(config: Config): Promise<ServerHandle> {
  const cache = new CacheStore({
    imagesDir: config.imagesDir,
    // The game's MAX_CACHED_VARIANTS. Variants above it only exist because
    // someone pressed "another variant", so they are marked to survive a cull.
    userVariantThreshold: 4,
  }).load()
  const hits = new HitStore({ stateDir: config.stateDir }).load()
  const comfy = new ComfyClient(config.comfyUrl)
  const jobs = new JobRunner({ config, comfy, cache })
  const review = new ReviewStore(config.stateDir).load()
  // Picks up an unfinished overnight run, paused — restarting hours of GPU work
  // unasked would be a surprise.
  const batch = new BatchQueue(config, cache, jobs).resume()

  let requestShutdown: () => void = () => {}
  const router = buildRouter({
    config,
    cache,
    hits,
    comfy,
    jobs,
    review,
    batch,
    shutdown: () => requestShutdown(),
  })
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(err => {
      console.error('[http] unhandled:', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (applyCors(req, res, config.allowedOrigins, { lan: boundBeyondLoopback(config.host) })) return

    if (config.verbose) console.log(`${req.method} ${req.url}`)

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname

    // The art library. Renders are immutable — a different prompt produces a
    // different file — so they can be cached hard.
    if (pathname.startsWith('/images/')) {
      if (serveFile(req, res, config.imagesDir, pathname.slice('/images/'.length), { immutable: true })) return
      sendJson(res, 404, { error: 'no such image' })
      return
    }

    try {
      if (await router.handle(req, res)) return
    } catch (err) {
      if (err instanceof HttpError) { sendJson(res, err.status, { error: err.message }); return }
      if (err instanceof BodyTooLargeError) {
        // The caller is still mid-upload. Closing the socket now would reset
        // the connection under their write and they would see ECONNRESET
        // instead of the 413 that explains the problem. So: answer, then DRAIN
        // the rest of the body so their write can complete and they can read
        // the response. The drain is bounded — a caller that keeps sending
        // forever gets hung up on rather than tying us up.
        res.setHeader('Connection', 'close')
        sendJson(res, 413, { error: err.message })
        drainAndClose(req, err.limit * 8)
        return
      }
      if (err instanceof MalformedBodyError) { sendJson(res, 400, { error: `malformed JSON: ${err.message}` }); return }
      throw err
    }

    // The review UI, served last so it can never shadow an API route.
    const uiPath = pathname === '/' ? 'index.html' : pathname.slice(1)
    if (serveFile(req, res, uiDir, uiPath)) return

    sendJson(res, 404, { error: `no route for ${req.method} ${pathname}` })
  }

  await new Promise<void>((resolve, reject) => {
    // Bind exactly what was asked for. NEVER auto-increment on a busy port:
    // the game probes a fixed port, so a server that quietly moves is a server
    // nothing can find, and the failure looks like "generation is broken".
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `port ${config.port} is already in use.\n`
          + `Another wayward-imagegen may already be running — if so, use it.\n`
          + `Otherwise start this one with --port <n> and set the same port in the game's settings.`,
        ))
      } else {
        reject(err)
      }
    })
    server.listen(config.port, config.host, resolve)
  })

  jobs.start()

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  let closing = false
  const closeRuntime = async (): Promise<void> => {
    if (closing) return
    closing = true
    batch.pause()
    jobs.stop()
    hits.close()
    // `server.close()` only resolves once every connection has ended, and a
    // keep-alive socket never ends on its own — so without this a shutdown
    // waits forever on an idle browser tab.
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  requestShutdown = () => { void closeRuntime() }

  return {
    server, config, cache, hits, jobs, comfy, batch, port,
    close: closeRuntime,
  }
}
