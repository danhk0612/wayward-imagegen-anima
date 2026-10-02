/**
 * The image generation routes — the ones the game actually calls.
 *
 * Wire-compatible with what the game already sends, with one deliberate change:
 * responses carry a URL (`imageUrl`) rather than a base64 data URL. The old
 * shape meant 1-3 MB of JSON per image, no browser caching, and an image the
 * client could not address or re-find after a reload. `?inline=1` restores the
 * old behaviour for callers that genuinely want bytes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, WorkflowType } from '../config.ts'
import type { CacheStore, CacheEntry } from '../cache/cacheStore.ts'
import type { JobRunner, GenerationJob } from '../comfy/jobRunner.ts'
import { derivePromptHash, hashPrompt, jobKey, extractCharacterName } from '../naming.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson, JSON_BODY_LIMIT } from '../http/body.ts'
import { mimeFor } from '../http/static.ts'

const WORKFLOWS: readonly WorkflowType[] = ['illustrious', 'z-image']

const KNOWN_DIMS: Record<string, string> = {
  '512x512': '512 x 512 (1:1)',
  '768x512': '768 x 512 (1.5:1)',
  '960x512': '960 x 512 (1.875:1)',
  '1024x512': '1024 x 512 (2:1)',
  '1024x576': '1024 x 576 (1.778:1)',
  '1536x640': '1536 x 640 (2.4:1)',
  '1344x768': '1344 x 768 (1.75:1)',
  '1216x832': '1216 x 832 (1.46:1)',
  '1152x896': '1152 x 896 (1.286:1)',
  '1024x1024': '1024 x 1024 (1:1)',
}

export interface GenerateBody {
  talentId?: string
  talentName?: string
  imageType?: string
  prompt?: string
  negativePrompt?: string
  workflow?: string
  promptHash?: string
  seed?: number
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  width?: number
  height?: number
  dimensions?: string
  bulk?: boolean
  bypassCache?: boolean
  debug?: Record<string, unknown>
}

export interface ImageRouteDeps {
  config: Config
  cache: CacheStore
  jobs: JobRunner
  logMiss?: (line: Record<string, unknown>) => void
}

export function imageUrlFor(relativePath: string): string {
  return `/images/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

function sizeOf(cache: CacheStore, entry: CacheEntry): number {
  const full = cache.absolutePathOf(entry)
  if (!full) return 0
  try {
    return fs.statSync(full).size
  } catch {
    return 0
  }
}

function readAsDataUrl(cache: CacheStore, entry: CacheEntry): string | null {
  const full = cache.absolutePathOf(entry)
  if (!full) return null
  try {
    return `data:${mimeFor(full)};base64,${fs.readFileSync(full).toString('base64')}`
  } catch {
    return null
  }
}

function renderSignature(config: Config, body: GenerateBody): string {
  const modelIdentity = body.checkpoint ?? (config.imagePreset === 'anima' ? config.animaModel : config.checkpoint)
  const steps = body.steps ?? config.steps
  const cfg = body.cfg ?? config.cfg
  const speedLoraStrength = body.loraStrength ?? config.loraStrength
  const talentName = body.talentName ?? body.talentId ?? ''
  const characterName = extractCharacterName(talentName, config.characterDirs)
  const profile = characterName ? config.characterProfiles[characterName] : undefined
  const characterLoras = [...config.characterLoras, ...(profile?.loras ?? [])]
    .map(l => config.imagePreset === 'anima'
      ? `${l.name}:${l.strengthModel}`
      : `${l.name}:${l.strengthModel}:${l.strengthClip}`)
    .join(',')
  const scenePromptHints = Object.entries(config.scenePromptHints)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(';')
  const sceneNegativePromptHints = Object.entries(config.sceneNegativePromptHints)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(';')

  return [
    `preset:${config.imagePreset}`,
    `model:${modelIdentity}`,
    `animaTextEncoder:${config.imagePreset === 'anima' ? config.animaTextEncoder : ''}`,
    `animaVae:${config.imagePreset === 'anima' ? config.animaVae : ''}`,
    `steps:${steps}`,
    `cfg:${cfg}`,
    `clipSkip:${config.imagePreset === 'illustrious' ? config.clipSkip : ''}`,
    `sampler:${config.sampler}`,
    `scheduler:${config.scheduler}`,
    `speedLora:${config.lora}:${speedLoraStrength}`,
    `character:${characterName ?? 'unknown'}`,
    `characterLoras:${characterLoras}`,
    `trigger:${profile?.triggerPrompt ?? ''}`,
    `basePrompt:${profile?.basePrompt ?? ''}`,
    `gamePromptPrefixToStrip:${profile?.gamePromptPrefixToStrip ?? ''}`,
    `ppp:${config.positivePromptPrefix}|${profile?.positivePromptPrefix ?? ''}`,
    `pps:${profile?.positivePromptSuffix ?? ''}|${config.positivePromptSuffix}`,
    `npp:${config.negativePromptPrefix}|${profile?.negativePromptPrefix ?? ''}`,
    `nps:${profile?.negativePromptSuffix ?? ''}|${config.negativePromptSuffix}`,
    `scenePromptHints:${scenePromptHints}`,
    `sceneNegativePromptHints:${sceneNegativePromptHints}`,
    `complexScenePolicy:${JSON.stringify(config.complexScenePolicy)}`,
  ].join('|')
}

export function resolvePromptHash(body: GenerateBody, config: Config): string {
  const signature = renderSignature(config, body)
  if (body.promptHash) return hashPrompt(body.promptHash, signature)
  return derivePromptHash(body.prompt ?? '', body.negativePrompt ?? '', {
    ...body,
    renderSignature: signature,
  })
}

export function resolveDimensions(body: GenerateBody): string | undefined {
  if (body.dimensions) return body.dimensions
  if (!body.width || !body.height) return undefined
  return KNOWN_DIMS[`${body.width}x${body.height}`]
}

function jobResponse(job: GenerationJob, imagesDir: string, inline: boolean) {
  const base: Record<string, unknown> = {
    promptId: job.promptId,
    status: job.status,
    workflow: job.workflow,
  }
  if (job.error) base.error = job.error
  if (job.media) {
    base.imagePath = job.media.relativePath
    base.imageUrl = imageUrlFor(job.media.relativePath)
    base.bytes = job.media.bytes
    if (inline) {
      try {
        const buf = fs.readFileSync(path.join(imagesDir, job.media.relativePath))
        base.imageData = `data:${job.media.mime};base64,${buf.toString('base64')}`
      } catch { /* the URL is still usable */ }
    }
  }
  return base
}

export function registerImageRoutes(router: Router, deps: ImageRouteDeps): void {
  const { config, cache, jobs } = deps

  router.post('/api/image/generate', async ctx => {
    const body = await readJson<GenerateBody>(ctx.req, JSON_BODY_LIMIT)

    const talentName = body.talentName ?? body.talentId
    if (!talentName) throw new HttpError(400, 'talentId is required')
    const prompt = body.prompt
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new HttpError(400, 'prompt is required')
    }

    const workflow = (body.workflow ?? 'illustrious') as WorkflowType
    if (!WORKFLOWS.includes(workflow)) {
      throw new HttpError(400, `unknown workflow: ${workflow}. available: ${WORKFLOWS.join(', ')}`)
    }

    const imageType = body.imageType ?? 'portrait'
    const negativePrompt = body.negativePrompt ?? ''
    const promptHash = resolvePromptHash(body, config)
    const bulk = body.bulk === true
    const bypassCache = body.bypassCache === true
    const inline = ctx.query.get('inline') === '1'

    if (bypassCache) {
      // Bypass only the exact cache identity being regenerated. Older behavior
      // removed every variant for the same talentName, which made A/B testing
      // and review regeneration destroy unrelated renders of that scene.
      const key = jobKey(talentName, imageType, promptHash, workflow)
      const entry = cache.entries[key]
      if (entry) {
        const full = cache.absolutePathOf(entry)
        if (full && fs.existsSync(full)) {
          try { fs.unlinkSync(full) } catch { /* the entry still goes */ }
        }
        cache.remove(key)
        console.log(`[generate] bypass dropped exact cache entry for ${talentName}`)
      }
    }

    const cached = bypassCache ? null : cache.get(talentName, imageType, promptHash, workflow)
    if (cached) {
      const response: Record<string, unknown> = {
        promptId: `cached_${promptHash}`,
        status: 'completed',
        workflow,
        cached: true,
        imagePath: cached.imagePath,
        imageUrl: imageUrlFor(cached.imagePath),
        bytes: sizeOf(cache, cached),
      }
      if (inline) {
        const data = readAsDataUrl(cache, cached)
        if (data) response.imageData = data
      }
      sendJson(ctx.res, 200, response)
      return
    }

    if (!bulk && !bypassCache && deps.logMiss) {
      let priorVariants = 0
      for (const [k, e] of Object.entries(cache.entries)) {
        if (e.talentName === talentName && e.imageType === imageType && k.startsWith(workflow + '_')) {
          priorVariants++
        }
      }
      deps.logMiss({
        at: new Date().toISOString(),
        kind: priorVariants > 0 ? 'drift' : 'new',
        priorVariants,
        talentName,
        imageType,
        workflow,
        promptHash,
        prompt: prompt.slice(0, 300),
      })
    }

    if (!bulk) {
      if (jobs.queuedCount() >= config.maxQueued) {
        throw new HttpError(429, `too many queued requests (${config.maxQueued})`)
      }
      if (config.maxImagesPerHour > 0 && jobs.completionsThisHour() >= config.maxImagesPerHour) {
        throw new HttpError(429, `hourly image limit reached (${config.maxImagesPerHour})`)
      }
    }

    if (config.maxDiskGb > 0) {
      const usedGb = cache.diskUsageBytes() / 1024 ** 3
      if (usedGb >= config.maxDiskGb) {
        throw new HttpError(507, `art library is at the ${config.maxDiskGb} GB ceiling`)
      }
    }

    const job = await jobs.submit({
      talentId: body.talentId ?? talentName,
      talentName,
      imageType,
      prompt,
      negativePrompt,
      workflow,
      promptHash,
      seed: body.seed,
      overrides: {
        steps: body.steps,
        cfg: body.cfg,
        loraStrength: body.loraStrength,
        checkpoint: body.checkpoint,
        dimensions: resolveDimensions(body),
      },
      bulk,
      debug: body.debug,
    })

    sendJson(ctx.res, 200, jobResponse(job, config.imagesDir, inline))
  })

  router.get('/api/image/status/:promptId', ctx => {
    const { promptId } = ctx.params
    const job = jobs.get(promptId)
    if (!job) throw new HttpError(404, 'unknown promptId')
    const inline = ctx.query.get('inline') === '1'
    const body = jobResponse(job, config.imagesDir, inline)
    sendJson(ctx.res, job.status === 'queued' || job.status === 'processing' ? 202 : 200, body)
  })

  router.post('/api/image/cancel', async ctx => {
    const body = await readJson<{ promptId?: string }>(ctx.req)
    if (!body.promptId) throw new HttpError(400, 'promptId is required')
    const result = await jobs.cancel(body.promptId)
    sendJson(ctx.res, 200, { status: 'ok', ...result })
  })

  router.get('/api/image/check', ctx => {
    const name = ctx.query.get('name')
    const hash = ctx.query.get('hash')
    if (!name || !hash) throw new HttpError(400, 'name and hash are required')
    const imageType = ctx.query.get('type') ?? 'portrait'
    const workflow = (ctx.query.get('workflow') ?? 'illustrious') as WorkflowType

    const entry = cache.get(name, imageType, hash, workflow)
    if (!entry) {
      sendJson(ctx.res, 200, { exists: false })
      return
    }
    const response: Record<string, unknown> = {
      exists: true,
      cached: true,
      imagePath: entry.imagePath,
      imageUrl: imageUrlFor(entry.imagePath),
    }
    if (ctx.query.get('inline') === '1') {
      const data = readAsDataUrl(cache, entry)
      if (data) response.imageData = data
    }
    sendJson(ctx.res, 200, response)
  })

  router.delete('/api/image/delete', ctx => {
    if (!config.allowDelete) {
      throw new HttpError(403, 'deletion is disabled; start with --allow-delete to enable it')
    }
    const name = ctx.query.get('name')
    if (!name) throw new HttpError(400, 'name is required')
    const imageType = ctx.query.get('type') ?? 'portrait'
    const workflow = ctx.query.get('workflow') ?? 'illustrious'

    let deleted = 0
    for (const [key, entry] of Object.entries(cache.entries)) {
      if (entry.talentName !== name) continue
      if (entry.imageType !== imageType) continue
      if (!key.startsWith(workflow + '_')) continue
      const full = cache.absolutePathOf(entry)
      if (full && fs.existsSync(full)) {
        try { fs.unlinkSync(full) } catch { /* the entry still goes */ }
      }
      cache.remove(key)
      deleted++
    }
    sendJson(ctx.res, 200, { deleted })
  })
}

export function describeJobs(jobs: JobRunner): Record<string, unknown> {
  const active = jobs.activeJobs()
  return {
    active: active.length,
    queued: jobs.queuedCount(),
    completedThisHour: jobs.completionsThisHour(),
    keys: active.slice(0, 20).map(j => jobKey(j.talentName, j.imageType, j.promptHash, j.workflow)),
  }
}
