/**
 * Image-to-video, via a Wan i2v workflow.
 *
 * Unlike the image workflows, this one is not built from scratch — it patches a
 * workflow JSON the operator supplies with `--wan-workflow`, because the node
 * ids belong to whatever they exported from ComfyUI. Video therefore needs a
 * deliberate opt-in: models, a workflow, and the patience for a render measured
 * in minutes.
 *
 * With no workflow configured, `check` reports "no video" (which is true and
 * lets the game move on) and `generate` explains what is missing rather than
 * failing obscurely.
 */

import * as fs from 'node:fs'
import type { Config } from '../config.ts'
import type { ComfyClient } from '../comfy/client.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson, VIDEO_BODY_LIMIT } from '../http/body.ts'
import { buildWanVideoPrompt } from '../comfy/workflows/index.ts'
import { findCachedVideo } from '../comfy/media.ts'
import { hashPrompt, sanitizeName } from '../naming.ts'

export interface VideoDeps {
  config: Config
  comfy: ComfyClient
  jobs: JobRunner
}

function videoUrlFor(relativePath: string): string {
  return `/images/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

export function registerVideoRoutes(router: Router, deps: VideoDeps): void {
  const { config, comfy, jobs } = deps

  const workflowEnabled = (): boolean =>
    config.wanWorkflowPath !== null && fs.existsSync(config.wanWorkflowPath)

  /**
   * Is there already a video for this state?
   *
   * Answers 200 with `exists: false` rather than 404 even when video is turned
   * off entirely. The game asks this for every portrait it shows; a 404 would
   * fill the player's console with errors describing a feature they never
   * enabled.
   */
  router.get('/api/video/check', ctx => {
    const talentId = ctx.query.get('talentId')
    const hash = ctx.query.get('hash')
    if (!talentId || !hash) throw new HttpError(400, 'talentId and hash are required')

    const found = findCachedVideo(config.imagesDir, talentId, hash)
    if (!found) {
      sendJson(ctx.res, 200, { exists: false })
      return
    }
    sendJson(ctx.res, 200, {
      exists: true,
      videoPath: found.relativePath,
      videoUrl: videoUrlFor(found.relativePath),
      bytes: found.bytes,
    })
  })

  router.post('/api/video/generate', async ctx => {
    if (!workflowEnabled()) {
      throw new HttpError(501,
        'Video generation is not configured. Start the backend with '
        + '--wan-workflow <path to your exported Wan i2v workflow JSON>.')
    }

    // The source still arrives as base64 — it is one frame the client already
    // has in hand, not something on disk here — so this route gets its own,
    // larger body cap rather than raising the ceiling for every request.
    const body = await readJson<{
      talentId?: string
      prompt?: string
      negativePrompt?: string
      imageData?: string
      promptHash?: string
      seed?: number
    }>(ctx.req, VIDEO_BODY_LIMIT)

    const talentId = body.talentId
    if (!talentId) throw new HttpError(400, 'talentId is required')
    if (!body.imageData) throw new HttpError(400, 'imageData (the source frame) is required')

    const prompt = body.prompt ?? ''
    const negativePrompt = body.negativePrompt ?? ''
    const promptHash = body.promptHash ?? hashPrompt(prompt, negativePrompt)

    const cached = findCachedVideo(config.imagesDir, talentId, promptHash)
    if (cached) {
      sendJson(ctx.res, 200, {
        promptId: `cached_${promptHash}`,
        status: 'completed',
        cached: true,
        videoPath: cached.relativePath,
        videoUrl: videoUrlFor(cached.relativePath),
      })
      return
    }

    const comma = body.imageData.indexOf(',')
    const bytes = Buffer.from(comma === -1 ? body.imageData : body.imageData.slice(comma + 1), 'base64')
    if (bytes.length === 0) throw new HttpError(400, 'imageData did not decode to anything')

    const uploaded = await comfy.upload(bytes, `${sanitizeName(talentId)}_source.png`)
    if (!uploaded) throw new HttpError(502, 'ComfyUI would not accept the source frame')

    const workflowJson = fs.readFileSync(config.wanWorkflowPath as string, 'utf-8')
    let graph
    try {
      graph = buildWanVideoPrompt(
        workflowJson,
        prompt,
        negativePrompt,
        uploaded,
        `video/${sanitizeName(talentId)}_${promptHash}`,
        body.seed,
      )
    } catch (err) {
      // A workflow with different node ids is the likely cause, and saying so
      // is far more useful than the raw "cannot read property of undefined".
      throw new HttpError(400, (err as Error).message)
    }

    const promptId = await comfy.submit(graph, false)
    jobs.trackVideo({
      promptId,
      talentId,
      talentName: talentId,
      imageType: 'video',
      promptHash,
      prompt,
      workflow: 'illustrious',
    })

    sendJson(ctx.res, 200, { promptId, status: 'queued' })
  })

  router.get('/api/video/status/:promptId', ctx => {
    const job = jobs.get(ctx.params.promptId)
    if (!job) throw new HttpError(404, 'unknown promptId')

    const body: Record<string, unknown> = { status: job.status }
    if (job.error) body.error = job.error
    if (job.media) {
      body.videoPath = job.media.relativePath
      body.videoUrl = videoUrlFor(job.media.relativePath)
      body.bytes = job.media.bytes
    }
    sendJson(ctx.res, job.status === 'queued' || job.status === 'processing' ? 202 : 200, body)
  })
}
