/**
 * Local setup/configuration API.
 *
 * This surface is intentionally loopback-only even when the image server is
 * bound to the LAN. It can read model filenames and write the local config.
 * The game itself never needs these routes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, CharacterProfile, LoraSpec } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import { ComfyClient, inputChoices } from '../comfy/client.ts'
import { Router, sendJson, HttpError, type RequestContext } from '../http/router.ts'
import { readJson } from '../http/body.ts'
import { buildComfyPrompt } from '../comfy/workflows/index.ts'

const SETUP_BODY_LIMIT = 2 * 1024 * 1024
const MAX_PROMPT_LENGTH = 100_000
const MAX_PROFILES = 64
const MAX_LORAS_PER_PROFILE = 16
const CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface SetupSettings {
  comfyUrl: string
  imagePreset: 'anima'
  animaModel: string
  animaTextEncoder: string
  animaVae: string
  animaDimensions: string
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  positivePromptPrefix: string
  positivePromptSuffix: string
  negativePromptPrefix: string
  negativePromptSuffix: string
  characterLoras: LoraSpec[]
  characterDirs: string[]
  characterProfiles: Record<string, CharacterProfile>
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function requireLocal(ctx: RequestContext): void {
  if (!isLoopbackAddress(ctx.req.socket.remoteAddress)) {
    throw new HttpError(403, 'setup API is available only from this computer')
  }
}

function stringValue(value: unknown, label: string, { allowEmpty = false } = {}): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`)
  const text = value.trim()
  if (!allowEmpty && !text) throw new HttpError(400, `${label} cannot be empty`)
  if (value.length > MAX_PROMPT_LENGTH) throw new HttpError(400, `${label} is too long`)
  return value
}

function numberValue(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${label} must be a finite number`)
  }
  if (integer && !Number.isInteger(value)) throw new HttpError(400, `${label} must be an integer`)
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`)
  return value
}

function normalizeLora(value: unknown, profileId: string): LoraSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `characterProfiles.${profileId}.loras contains an invalid item`)
  }
  const typed = value as Record<string, unknown>
  const name = stringValue(typed.name, `characterProfiles.${profileId}.loras.name`).trim()
  const strengthModel = numberValue(
    typed.strengthModel,
    `characterProfiles.${profileId}.loras.strengthModel`,
    -4,
    4,
  )
  const rawClip = typed.strengthClip
  const strengthClip = rawClip === undefined
    ? strengthModel
    : numberValue(rawClip, `characterProfiles.${profileId}.loras.strengthClip`, -4, 4)
  return { name, strengthModel, strengthClip }
}

function promptField(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  return stringValue(value, label, { allowEmpty: true })
}

function normalizeProfile(id: string, value: unknown): CharacterProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `characterProfiles.${id} must be an object`)
  }
  const typed = value as Record<string, unknown>
  const rawLoras = typed.loras ?? []
  if (!Array.isArray(rawLoras)) throw new HttpError(400, `characterProfiles.${id}.loras must be an array`)
  if (rawLoras.length > MAX_LORAS_PER_PROFILE) {
    throw new HttpError(400, `characterProfiles.${id}.loras has too many entries`)
  }
  return {
    loras: rawLoras.map(item => normalizeLora(item, id)),
    triggerPrompt: promptField(typed.triggerPrompt, `characterProfiles.${id}.triggerPrompt`),
    basePrompt: promptField(typed.basePrompt, `characterProfiles.${id}.basePrompt`),
    gamePromptPrefixToStrip: promptField(
      typed.gamePromptPrefixToStrip,
      `characterProfiles.${id}.gamePromptPrefixToStrip`,
    ),
    positivePromptPrefix: promptField(typed.positivePromptPrefix, `characterProfiles.${id}.positivePromptPrefix`),
    positivePromptSuffix: promptField(typed.positivePromptSuffix, `characterProfiles.${id}.positivePromptSuffix`),
    negativePromptPrefix: promptField(typed.negativePromptPrefix, `characterProfiles.${id}.negativePromptPrefix`),
    negativePromptSuffix: promptField(typed.negativePromptSuffix, `characterProfiles.${id}.negativePromptSuffix`),
  }
}

function normalizeProfiles(value: unknown): Record<string, CharacterProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'characterProfiles must be an object')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_PROFILES) throw new HttpError(400, 'too many character profiles')

  const result: Record<string, CharacterProfile> = {}
  for (const [rawId, rawProfile] of entries) {
    const id = rawId.trim().toLowerCase()
    if (!CHARACTER_ID.test(id)) {
      throw new HttpError(400, `invalid character id "${rawId}"`)
    }
    result[id] = normalizeProfile(id, rawProfile)
  }
  return result
}

function normalizeCharacterDirs(value: unknown, profileIds: string[]): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'characterDirs must be an array')
  const set = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new HttpError(400, 'characterDirs must contain strings')
    const id = raw.trim().toLowerCase()
    if (!CHARACTER_ID.test(id)) throw new HttpError(400, `invalid character id "${raw}"`)
    set.add(id)
  }
  for (const id of profileIds) set.add(id)
  return [...set]
}

function normalizeSettings(value: unknown): SetupSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'settings must be an object')
  }
  const typed = value as Record<string, unknown>
  const imagePreset = typed.imagePreset ?? 'anima'
  if (imagePreset !== 'anima') throw new HttpError(400, 'setup UI currently supports the anima preset only')

  const characterProfiles = normalizeProfiles(typed.characterProfiles ?? {})
  const rawGlobalLoras = typed.characterLoras ?? []
  if (!Array.isArray(rawGlobalLoras)) throw new HttpError(400, 'characterLoras must be an array')
  if (rawGlobalLoras.length > MAX_LORAS_PER_PROFILE) {
    throw new HttpError(400, 'characterLoras has too many entries')
  }
  const characterLoras = rawGlobalLoras.map(item => normalizeLora(item, 'global'))
  const characterDirs = normalizeCharacterDirs(
    typed.characterDirs ?? Object.keys(characterProfiles),
    Object.keys(characterProfiles),
  )

  const comfyUrl = stringValue(typed.comfyUrl, 'comfyUrl').replace(/\/+$/, '')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(comfyUrl)
  } catch {
    throw new HttpError(400, 'comfyUrl must be a valid URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new HttpError(400, 'comfyUrl must use http or https')
  }

  const animaDimensions = promptField(typed.animaDimensions, 'animaDimensions').trim()
  if (animaDimensions && !/^\d+\s*x\s*\d+(?:\s*\([^)]*\))?$/i.test(animaDimensions)) {
    throw new HttpError(400, 'animaDimensions must look like "1216 x 832" or be empty')
  }

  return {
    comfyUrl,
    imagePreset: 'anima',
    animaModel: stringValue(typed.animaModel, 'animaModel').trim(),
    animaTextEncoder: stringValue(typed.animaTextEncoder, 'animaTextEncoder').trim(),
    animaVae: stringValue(typed.animaVae, 'animaVae').trim(),
    animaDimensions,
    steps: numberValue(typed.steps, 'steps', 1, 150, true),
    cfg: numberValue(typed.cfg, 'cfg', 0, 30),
    sampler: stringValue(typed.sampler, 'sampler').trim(),
    scheduler: stringValue(typed.scheduler, 'scheduler').trim(),
    positivePromptPrefix: promptField(typed.positivePromptPrefix, 'positivePromptPrefix'),
    positivePromptSuffix: promptField(typed.positivePromptSuffix, 'positivePromptSuffix'),
    negativePromptPrefix: promptField(typed.negativePromptPrefix, 'negativePromptPrefix'),
    negativePromptSuffix: promptField(typed.negativePromptSuffix, 'negativePromptSuffix'),
    characterLoras,
    characterDirs,
    characterProfiles,
  }
}

function currentSettings(config: Config): SetupSettings {
  const firstAnimaSetup = config.imagePreset !== 'anima'
  return {
    comfyUrl: config.comfyUrl,
    imagePreset: 'anima',
    animaModel: config.animaModel,
    animaTextEncoder: config.animaTextEncoder,
    animaVae: config.animaVae,
    animaDimensions: config.animaDimensions,
    steps: firstAnimaSetup ? 30 : config.steps,
    cfg: firstAnimaSetup ? 4.5 : config.cfg,
    sampler: firstAnimaSetup ? 'er_sde' : config.sampler,
    scheduler: firstAnimaSetup ? 'simple' : config.scheduler,
    positivePromptPrefix: firstAnimaSetup
      ? 'masterpiece, best quality'
      : config.positivePromptPrefix,
    positivePromptSuffix: config.positivePromptSuffix,
    negativePromptPrefix: firstAnimaSetup
      ? 'worst quality, low quality, score_1, score_2, score_3, bad anatomy, bad hands, text, watermark, signature'
      : config.negativePromptPrefix,
    negativePromptSuffix: config.negativePromptSuffix,
    characterLoras: firstAnimaSetup ? [] : config.characterLoras,
    characterDirs: [...config.characterDirs],
    characterProfiles: firstAnimaSetup ? {} : config.characterProfiles,
  }
}

function readRawConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const decoded = JSON.parse(raw)
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {}
  } catch (err) {
    throw new HttpError(500, `cannot read config file: ${(err as Error).message}`)
  }
}

function writeSettings(config: Config, settings: SetupSettings): { backupPath: string | null } {
  const file = config.configFilePath
  const raw = readRawConfig(file)

  for (const [key, value] of Object.entries(settings)) {
    raw[key] = value
  }

  // The simplified Anima setup does not expose a global speed LoRA.
  // Always clear a legacy Illustrious/turbo LoRA so converting an existing
  // installation cannot silently apply an incompatible model patch.
  raw.lora = ''
  raw.loraStrength = 1

  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })

  let backupPath: string | null = null
  if (fs.existsSync(file)) {
    const backups = path.join(config.stateDir, 'config-backups')
    fs.mkdirSync(backups, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(backups, `wayward-imagegen.config.${stamp}.json`)
    fs.copyFileSync(file, backupPath)
  }

  const temp = `${file}.tmp-${process.pid}`
  const text = JSON.stringify(raw, null, 2) + '\n'
  fs.writeFileSync(temp, text, { encoding: 'utf8' })
  fs.renameSync(temp, file)

  return { backupPath }
}

function sorted(values: string[] | null): string[] {
  return [...(values ?? [])].sort((a, b) => a.localeCompare(b))
}

function setupOptionsFromInfo(info: Awaited<ReturnType<ComfyClient['objectInfo']>>) {
  if (!info) return null
  return {
    diffusionModels: sorted(inputChoices(info.UNETLoader, 'unet_name')),
    checkpoints: sorted(inputChoices(info.CheckpointLoaderSimple, 'ckpt_name')),
    textEncoders: sorted(inputChoices(info.CLIPLoader, 'clip_name')),
    vaes: sorted(inputChoices(info.VAELoader, 'vae_name')),
    loras: sorted(
      inputChoices(info.LoraLoaderModelOnly, 'lora_name')
      ?? inputChoices(info.LoraLoader, 'lora_name'),
    ),
    samplers: sorted(inputChoices(info.KSampler, 'sampler_name')),
    schedulers: sorted(inputChoices(info.KSampler, 'scheduler')),
  }
}


function resolveWaywardRoot(config: Config): string | null {
  const backendRoot = path.dirname(config.configFilePath)
  const candidate = path.dirname(backendRoot)
  return fs.existsSync(path.join(candidate, 'index.html')) ? candidate : null
}

function activePackManifests(gameRoot: string, characterId: string): string[] {
  const prefix = `images-${characterId}-`
  try {
    return fs.readdirSync(gameRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.js'))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function disabledPackManifests(gameRoot: string, characterId: string): string[] {
  const dir = path.join(gameRoot, '_disabled-imagepacks', characterId)
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function generatedCount(cache: CacheStore, characterId: string): number {
  const prefix = characterId + '__'
  return Object.values(cache.entries).filter(entry => entry.talentName.toLowerCase().startsWith(prefix)).length
}

function movePath(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination)) {
    throw new HttpError(409, `destination already exists: ${destination}`)
  }
  fs.renameSync(source, destination)
}

function executeMoves(pairs: Array<{ source: string; destination: string }>): void {
  for (const pair of pairs) {
    if (fs.existsSync(pair.destination)) {
      throw new HttpError(409, `destination already exists: ${pair.destination}`)
    }
  }
  for (const pair of pairs) movePath(pair.source, pair.destination)
}

function disableStaticPack(gameRoot: string, characterId: string): { moved: string[] } {
  const disabledRoot = path.join(gameRoot, '_disabled-imagepacks', characterId)
  const pairs: Array<{ source: string; destination: string }> = []

  for (const name of activePackManifests(gameRoot, characterId)) {
    pairs.push({
      source: path.join(gameRoot, name),
      destination: path.join(disabledRoot, name),
    })
  }

  const staticDir = path.join(gameRoot, 'images', 'illustrious', 'characters', characterId)
  if (fs.existsSync(staticDir)) {
    pairs.push({
      source: staticDir,
      destination: path.join(disabledRoot, 'images', 'illustrious', 'characters', characterId),
    })
  }

  executeMoves(pairs)
  return {
    moved: pairs.map(pair => path.relative(gameRoot, pair.source).replace(/\\/g, '/')),
  }
}

function restoreStaticPack(gameRoot: string, characterId: string): { restored: string[] } {
  const disabledRoot = path.join(gameRoot, '_disabled-imagepacks', characterId)
  const pairs: Array<{ source: string; destination: string }> = []

  for (const name of disabledPackManifests(gameRoot, characterId)) {
    pairs.push({
      source: path.join(disabledRoot, name),
      destination: path.join(gameRoot, name),
    })
  }

  const disabledImages = path.join(disabledRoot, 'images', 'illustrious', 'characters', characterId)
  if (fs.existsSync(disabledImages)) {
    pairs.push({
      source: disabledImages,
      destination: path.join(gameRoot, 'images', 'illustrious', 'characters', characterId),
    })
  }

  executeMoves(pairs)
  try { fs.rmSync(disabledRoot, { recursive: true, force: false }) } catch { /* keep non-empty backups */ }
  return {
    restored: pairs.map(pair => path.relative(gameRoot, pair.destination).replace(/\\/g, '/')),
  }
}

function deleteGeneratedCharacterArt(config: Config, cache: CacheStore, characterId: string): number {
  const prefix = characterId + '__'
  let removed = 0
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (!entry.talentName.toLowerCase().startsWith(prefix)) continue
    cache.remove(key)
    removed++
  }

  const characterDir = path.join(config.imagesDir, 'illustrious', 'characters', characterId)
  fs.rmSync(characterDir, { recursive: true, force: true })
  return removed
}

export function registerSetupRoutes(router: Router, config: Config, cache: CacheStore): void {
  router.get('/api/setup/settings', ctx => {
    requireLocal(ctx)
    sendJson(ctx.res, 200, {
      configPath: config.configFilePath,
      configured: fs.existsSync(config.configFilePath)
        && config.imagePreset === 'anima'
        && Object.keys(config.characterProfiles).length > 0,
      settings: currentSettings(config),
      note: 'Saving changes writes the JSON config. Restart wayward-imagegen to apply them.',
    })
  })

  router.post('/api/setup/settings', async ctx => {
    requireLocal(ctx)
    const body = await readJson<{ settings?: unknown }>(ctx.req, SETUP_BODY_LIMIT)
    const settings = normalizeSettings(body.settings)
    const restartRequired = settings.comfyUrl !== config.comfyUrl
    const { backupPath } = writeSettings(config, settings)

    // All setup fields except the ComfyUI client endpoint are read through the
    // shared Config object at render time, so they can take effect immediately.
    // A changed ComfyUI URL still needs a restart because JobRunner owns a
    // ComfyClient created when the server starts.
    if (!restartRequired) {
      Object.assign(config, settings)
    }

    sendJson(ctx.res, 200, {
      ok: true,
      backupPath,
      restartRequired,
      appliedImmediately: !restartRequired,
      settings,
    })
  })

  router.post('/api/setup/validate', async ctx => {
    requireLocal(ctx)
    const body = await readJson<{ settings?: unknown }>(ctx.req, SETUP_BODY_LIMIT)
    const settings = normalizeSettings(body.settings)
    const comfy = new ComfyClient(settings.comfyUrl)
    const [stats, info] = await Promise.all([comfy.systemStats(), comfy.objectInfo()])

    const errors: string[] = []
    const warnings: string[] = []
    if (!stats || !info) {
      sendJson(ctx.res, 200, {
        ok: false,
        errors: ['ComfyUI에 연결할 수 없거나 object_info를 읽을 수 없습니다.'],
        warnings,
      })
      return
    }

    const requireChoice = (label: string, choices: string[] | null, wanted: string): void => {
      if (!choices) {
        errors.push(`${label} 목록을 ComfyUI에서 읽을 수 없습니다.`)
        return
      }
      if (!choices.includes(wanted)) errors.push(`${label}을 찾을 수 없습니다: ${wanted}`)
    }

    requireChoice('Anima diffusion model', inputChoices(info.UNETLoader, 'unet_name'), settings.animaModel)
    requireChoice('Text encoder', inputChoices(info.CLIPLoader, 'clip_name'), settings.animaTextEncoder)
    requireChoice('VAE', inputChoices(info.VAELoader, 'vae_name'), settings.animaVae)
    requireChoice('Sampler', inputChoices(info.KSampler, 'sampler_name'), settings.sampler)
    requireChoice('Scheduler', inputChoices(info.KSampler, 'scheduler'), settings.scheduler)

    const loraChoices = inputChoices(info.LoraLoaderModelOnly, 'lora_name')
      ?? inputChoices(info.LoraLoader, 'lora_name')
    for (const lora of settings.characterLoras) {
      if (!loraChoices?.includes(lora.name)) {
        errors.push(`공통 LoRA를 찾을 수 없습니다: ${lora.name}`)
      }
    }
    for (const [characterId, profile] of Object.entries(settings.characterProfiles)) {
      if (profile.loras.length === 0) {
        warnings.push(`${characterId}: 캐릭터 LoRA가 설정되지 않았습니다.`)
      }
      for (const lora of profile.loras) {
        if (!loraChoices?.includes(lora.name)) {
          errors.push(`${characterId}: LoRA를 찾을 수 없습니다: ${lora.name}`)
        }
      }
      if (!profile.triggerPrompt.trim()) warnings.push(`${characterId}: Trigger Prompt가 비어 있습니다.`)
      if (!profile.basePrompt.trim()) warnings.push(`${characterId}: 기본 캐릭터 Prompt가 비어 있습니다.`)
    }

    if (Object.keys(settings.characterProfiles).length === 0) {
      errors.push('연결된 캐릭터가 없습니다.')
    }

    sendJson(ctx.res, 200, {
      ok: errors.length === 0,
      errors,
      warnings,
      system: {
        comfyVersion: (stats.system as Record<string, unknown> | undefined)?.comfyui_version ?? null,
      },
    })
  })

  router.post('/api/setup/render-test', async ctx => {
    requireLocal(ctx)
    const body = await readJson<{ settings?: unknown; characterId?: string }>(ctx.req, SETUP_BODY_LIMIT)
    const settings = normalizeSettings(body.settings)
    const characterId = (body.characterId ?? Object.keys(settings.characterProfiles)[0] ?? '').trim().toLowerCase()
    if (!CHARACTER_ID.test(characterId) || !settings.characterProfiles[characterId]) {
      throw new HttpError(400, 'choose a configured character for the test render')
    }

    const testConfig: Config = {
      ...config,
      ...settings,
      imagePreset: 'anima',
      lora: '',
      loraStrength: 1,
    }
    const comfy = new ComfyClient(settings.comfyUrl)
    if (!await comfy.isReachable(5000)) {
      throw new HttpError(503, 'ComfyUI is not reachable')
    }

    const graph = buildComfyPrompt(
      testConfig,
      '1girl, portrait, looking at viewer, simple background, natural expression',
      'worst quality, low quality, bad anatomy, bad hands, text, watermark',
      `setup_test_${characterId}`,
      'illustrious',
      Math.floor(Date.now() % 2_000_000_000),
      { disableComplexScenePolicy: true },
      undefined,
      `${characterId}__setup-test`,
    )

    let promptId: string
    try {
      promptId = await comfy.submit(graph, true)
    } catch (err) {
      throw new HttpError(500, (err as Error).message)
    }

    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      const result = await comfy.history(promptId)
      if (result.error) throw new HttpError(500, result.error)
      if (!result.done) continue
      const output = result.images?.[0]
      if (!output) throw new HttpError(500, result.report ?? 'test render completed without an image')
      const bytes = await comfy.view(output)
      if (!bytes) throw new HttpError(500, 'could not read the rendered image from ComfyUI')
      const ext = path.extname(output.filename).toLowerCase()
      const mime = ext === '.webp' ? 'image/webp'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : 'image/png'
      sendJson(ctx.res, 200, {
        ok: true,
        promptId,
        filename: output.filename,
        imageData: `data:${mime};base64,${bytes.toString('base64')}`,
      })
      return
    }

    throw new HttpError(504, 'test render did not finish within 240 seconds')
  })

  router.get('/api/setup/wayward', ctx => {
    requireLocal(ctx)
    const gameRoot = resolveWaywardRoot(config)
    if (!gameRoot) {
      sendJson(ctx.res, 200, { detected: false, gameRoot: null, characters: {} })
      return
    }

    const ids = new Set<string>([
      ...config.characterDirs,
      ...Object.keys(config.characterProfiles),
    ])
    try {
      for (const entry of fs.readdirSync(gameRoot, { withFileTypes: true })) {
        const match = entry.isFile() ? entry.name.match(/^images-([a-z0-9_-]+)-\d+\.js$/i) : null
        if (match) ids.add(match[1].toLowerCase())
      }
    } catch { /* optional discovery */ }

    const characters: Record<string, unknown> = {}
    for (const id of [...ids].sort()) {
      const staticDir = path.join(gameRoot, 'images', 'illustrious', 'characters', id)
      characters[id] = {
        configured: !!config.characterProfiles[id],
        activeManifests: activePackManifests(gameRoot, id),
        disabledManifests: disabledPackManifests(gameRoot, id),
        staticImagesPresent: fs.existsSync(staticDir),
        generatedCount: generatedCount(cache, id),
      }
    }

    sendJson(ctx.res, 200, {
      detected: true,
      gameRoot,
      indexHtml: path.join(gameRoot, 'index.html'),
      characters,
    })
  })

  router.post('/api/setup/static-pack', async ctx => {
    requireLocal(ctx)
    const body = await readJson<{ characterId?: string; mode?: string }>(ctx.req, 64 * 1024)
    const characterId = typeof body.characterId === 'string' ? body.characterId.trim().toLowerCase() : ''
    if (!CHARACTER_ID.test(characterId)) throw new HttpError(400, 'invalid characterId')
    if (body.mode !== 'disable' && body.mode !== 'restore') {
      throw new HttpError(400, 'mode must be disable or restore')
    }
    const gameRoot = resolveWaywardRoot(config)
    if (!gameRoot) throw new HttpError(404, 'Wayward game root could not be detected')

    const result = body.mode === 'disable'
      ? disableStaticPack(gameRoot, characterId)
      : restoreStaticPack(gameRoot, characterId)
    sendJson(ctx.res, 200, { ok: true, characterId, mode: body.mode, ...result })
  })

  router.post('/api/setup/generated-art/delete', async ctx => {
    requireLocal(ctx)
    const body = await readJson<{ characterId?: string; confirmation?: string }>(ctx.req, 64 * 1024)
    const characterId = typeof body.characterId === 'string' ? body.characterId.trim().toLowerCase() : ''
    if (!CHARACTER_ID.test(characterId)) throw new HttpError(400, 'invalid characterId')
    const required = `DELETE ${characterId}`
    if (body.confirmation !== required) {
      throw new HttpError(400, `generated-art deletion requires exact confirmation: ${required}`)
    }
    const cacheEntriesRemoved = deleteGeneratedCharacterArt(config, cache, characterId)
    sendJson(ctx.res, 200, { ok: true, characterId, cacheEntriesRemoved })
  })

  router.get('/api/setup/comfy-options', async ctx => {
    requireLocal(ctx)
    const requested = ctx.query.get('url')?.trim()
    const comfyUrl = (requested || config.comfyUrl).replace(/\/+$/, '')
    let parsed: URL
    try {
      parsed = new URL(comfyUrl)
    } catch {
      throw new HttpError(400, 'url must be a valid ComfyUI URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, 'url must use http or https')
    }

    const comfy = requested ? new ComfyClient(comfyUrl) : new ComfyClient(config.comfyUrl)
    const [stats, info] = await Promise.all([
      comfy.systemStats(),
      comfy.objectInfo(),
    ])
    if (!stats || !info) {
      sendJson(ctx.res, 503, {
        connected: false,
        comfyUrl,
        error: 'ComfyUI did not answer system_stats/object_info',
      })
      return
    }

    const system = (stats.system ?? {}) as Record<string, unknown>
    const devices = Array.isArray(stats.devices) ? stats.devices : []
    const device = (devices[0] ?? {}) as Record<string, unknown>

    sendJson(ctx.res, 200, {
      connected: true,
      comfyUrl,
      system: {
        version: system.comfyui_version ?? null,
        python: typeof system.python_version === 'string'
          ? system.python_version.split(' ')[0]
          : null,
        device: device.name ?? null,
        vramBytes: typeof device.vram_total === 'number' ? device.vram_total : null,
      },
      options: setupOptionsFromInfo(info),
    })
  })
}
