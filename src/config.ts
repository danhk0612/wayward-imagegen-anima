/**
 * Configuration — the one place that resolves settings.
 *
 * Precedence: CLI flags > environment > config file > defaults.
 *
 * Every path the server touches hangs off `imagesDir`, so a player can point
 * a second instance at a second art library without any other change. Nothing
 * here reads `process.cwd()` implicitly — the caller decides.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'

/** What the game ships pointed at. v17 replaced v12 on 2026-09-21 after a blind
 *  A/B on the game's own prompts (`gin images ab-checkpoint`); the cache key
 *  does not carry the default checkpoint, so art rendered on v12 keeps serving
 *  and only new renders use this. */
export const DEFAULT_CHECKPOINT = 'waiIllustriousSDXL_v170.safetensors'
export const DEFAULT_ANIMA_MODEL = 'anima-base-v1.0.safetensors'
export const DEFAULT_ANIMA_TEXT_ENCODER = 'qwen_3_06b_base.safetensors'
export const DEFAULT_ANIMA_VAE = 'qwen_image_vae.safetensors'

export type WorkflowType = 'z-image' | 'illustrious'
export type ImagePreset = 'illustrious' | 'anima'

export interface LoraSpec {
  name: string
  strengthModel: number
  strengthClip: number
}

export interface CharacterProfile {
  loras: LoraSpec[]
  /** LoRA activation token(s), e.g. a trained character trigger. */
  triggerPrompt: string
  /** Stable identity tags that should accompany every scene for this character. */
  basePrompt: string
  /** Exact leading game prompt fragment to remove before applying this custom identity. */
  gamePromptPrefixToStrip: string
  positivePromptPrefix: string
  positivePromptSuffix: string
  negativePromptPrefix: string
  negativePromptSuffix: string
}

export interface ComplexScenePolicy {
  enabled: boolean
  characterLoraScale: number
  positivePrompt: string
  negativePrompt: string
}

export interface Config {
  host: string
  port: number
  imagesDir: string
  stateDir: string
  comfyUrl: string
  wanWorkflowPath: string | null

  /** Image workflow preset used when the game asks for the standard still-image backend. */
  imagePreset: ImagePreset

  /** Native Anima components. Anima is loaded as diffusion model + text encoder + VAE. */
  animaModel: string
  animaTextEncoder: string
  animaVae: string

  /** Prompt text affixes automatically applied before sending work to ComfyUI. */
  positivePromptPrefix: string
  positivePromptSuffix: string
  negativePromptPrefix: string
  negativePromptSuffix: string

  /** Global character/style LoRAs applied to every character. */
  characterLoras: LoraSpec[]

  /** Per-character LoRAs and trigger/base prompt fragments, keyed by character folder name. */
  characterProfiles: Record<string, CharacterProfile>

  /** Generic prompt-driven handling for multi-person/contact scenes. */
  complexScenePolicy: ComplexScenePolicy

  /** Optional scene-specific exceptions keyed by Wayward scene slug. */
  scenePromptHints: Record<string, string>
  sceneNegativePromptHints: Record<string, string>

  allowedOrigins: string[]
  allowDelete: boolean
  maxDiskGb: number
  concurrency: number
  maxQueued: number
  maxImagesPerHour: number
  characterDirs: string[]

  checkpoint: string
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  clipSkip: number
  /** Optional model-only speed LoRA (legacy/default behaviour). */
  lora: string
  loraStrength: number

  webp: boolean
  requireWebp: boolean
  pollIntervalMs: number
  parentPid: number | null
  verbose: boolean
}

export const DEFAULT_PORT = 8189

export const DEFAULT_CHARACTER_DIRS = ['elena', 'mara', 'pippa', 'patron']

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function normalizeImagePreset(value: string): ImagePreset {
  return value === 'anima' ? 'anima' : 'illustrious'
}

function normalizeLoraSpec(value: unknown): LoraSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const typed = value as Record<string, unknown>
  const name = typeof typed.name === 'string' ? typed.name.trim() : ''
  if (!name) return null
  const strengthModel = typeof typed.strengthModel === 'number' && Number.isFinite(typed.strengthModel)
    ? typed.strengthModel
    : 1
  const strengthClip = typeof typed.strengthClip === 'number' && Number.isFinite(typed.strengthClip)
    ? typed.strengthClip
    : strengthModel
  return { name, strengthModel, strengthClip }
}

function parseLoraList(value: unknown): LoraSpec[] {
  if (value == null || value === '') return []

  let decoded = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      decoded = JSON.parse(trimmed)
    } catch {
      return []
    }
  }

  if (!Array.isArray(decoded)) return []
  return decoded
    .map(normalizeLoraSpec)
    .filter((item): item is LoraSpec => item !== null)
}

function normalizeCharacterProfile(value: unknown): CharacterProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const typed = value as Record<string, unknown>
  return {
    loras: parseLoraList(typed.loras),
    triggerPrompt: typeof typed.triggerPrompt === 'string' ? typed.triggerPrompt : '',
    basePrompt: typeof typed.basePrompt === 'string' ? typed.basePrompt : '',
    gamePromptPrefixToStrip: typeof typed.gamePromptPrefixToStrip === 'string' ? typed.gamePromptPrefixToStrip : '',
    positivePromptPrefix: typeof typed.positivePromptPrefix === 'string' ? typed.positivePromptPrefix : '',
    positivePromptSuffix: typeof typed.positivePromptSuffix === 'string' ? typed.positivePromptSuffix : '',
    negativePromptPrefix: typeof typed.negativePromptPrefix === 'string' ? typed.negativePromptPrefix : '',
    negativePromptSuffix: typeof typed.negativePromptSuffix === 'string' ? typed.negativePromptSuffix : '',
  }
}

function parseStringMap(value: unknown): Record<string, string> {
  let decoded = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      decoded = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {}
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(decoded as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase()
    if (!key || typeof rawValue !== 'string') continue
    const text = rawValue.trim()
    if (text) result[key] = text
  }
  return result
}

function normalizeComplexScenePolicy(value: unknown): ComplexScenePolicy {
  const defaults: ComplexScenePolicy = {
    enabled: false,
    characterLoraScale: 0.85,
    positivePrompt: 'two distinct people, clear body separation, coherent anatomy, correct limb count',
    negativePrompt: 'merged bodies, fused bodies, conjoined bodies, duplicate body, duplicate person, extra torso, extra arms, extra legs, disconnected limbs, malformed limbs',
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const typed = value as Record<string, unknown>
  const rawScale = typeof typed.characterLoraScale === 'number' && Number.isFinite(typed.characterLoraScale)
    ? typed.characterLoraScale
    : defaults.characterLoraScale
  return {
    enabled: typeof typed.enabled === 'boolean' ? typed.enabled : defaults.enabled,
    characterLoraScale: Math.max(0, Math.min(2, rawScale)),
    positivePrompt: typeof typed.positivePrompt === 'string' ? typed.positivePrompt : defaults.positivePrompt,
    negativePrompt: typeof typed.negativePrompt === 'string' ? typed.negativePrompt : defaults.negativePrompt,
  }
}

function parseCharacterProfiles(value: unknown): Record<string, CharacterProfile> {
  let decoded = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      decoded = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {}
  const result: Record<string, CharacterProfile> = {}
  for (const [rawKey, rawValue] of Object.entries(decoded as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase()
    const profile = normalizeCharacterProfile(rawValue)
    if (key && profile) result[key] = profile
  }
  return result
}

export function boundBeyondLoopback(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next != null && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function readConfigFile(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    console.warn(`[config] ignoring unreadable ${file}: ${(err as Error).message}`)
    return {}
  }
}

export function resolveConfig(argv: string[] = [], cwd = process.cwd()): Config {
  const flags = parseArgs(argv)
  const file = readConfigFile(path.resolve(cwd, flags['config'] ?? 'wayward-imagegen.config.json'))

  const pick = (flag: string, env: string, fileKey: string, fallback: string): string => {
    if (flags[flag] != null) return flags[flag]
    const e = process.env[env]
    if (e != null) return e
    const f = file[fileKey]
    if (typeof f === 'string') return f
    return fallback
  }
  const pickNum = (flag: string, env: string, fileKey: string, fallback: number): number => {
    if (flags[flag] != null) {
      const n = Number(flags[flag])
      if (Number.isFinite(n)) return n
    }
    const f = file[fileKey]
    const base = typeof f === 'number' && Number.isFinite(f) ? f : fallback
    return envNumber(env, base)
  }

  const imagesDir = path.resolve(cwd, pick('images-dir', 'WAYWARD_IMAGES_DIR', 'imagesDir', 'images'))
  const stateDir = path.resolve(cwd, pick('state-dir', 'WAYWARD_STATE_DIR', 'stateDir', path.join(imagesDir, '.state')))

  const wanRaw = pick('wan-workflow', 'WAYWARD_WAN_WORKFLOW', 'wanWorkflowPath', '')
  const wanWorkflowPath = wanRaw ? path.resolve(cwd, wanRaw) : null

  const originsRaw = flags['allow-origin']
    ?? process.env.WAYWARD_ALLOW_ORIGIN
    ?? (Array.isArray(file.allowedOrigins) ? (file.allowedOrigins as string[]).join(',') : '')
  const allowedOrigins = originsRaw
    ? originsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : []

  const charsRaw = flags['characters']
    ?? process.env.WAYWARD_CHARACTER_DIRS
    ?? (Array.isArray(file.characterDirs) ? (file.characterDirs as string[]).join(',') : '')
  const characterDirs = charsRaw
    ? charsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_CHARACTER_DIRS

  const imagePreset = normalizeImagePreset(
    pick('image-preset', 'WAYWARD_IMAGE_PRESET', 'imagePreset', 'illustrious'),
  )

  const characterLoras = parseLoraList(
    flags['character-loras']
    ?? process.env.COMFYUI_CHARACTER_LORAS
    ?? file.characterLoras,
  )

  const characterProfiles = parseCharacterProfiles(
    flags['character-profiles']
    ?? process.env.WAYWARD_CHARACTER_PROFILES
    ?? file.characterProfiles,
  )

  const complexScenePolicy = normalizeComplexScenePolicy(
    file.complexScenePolicy,
  )

  const scenePromptHints = parseStringMap(
    flags['scene-prompt-hints']
    ?? process.env.WAYWARD_SCENE_PROMPT_HINTS
    ?? file.scenePromptHints,
  )
  const sceneNegativePromptHints = parseStringMap(
    flags['scene-negative-prompt-hints']
    ?? process.env.WAYWARD_SCENE_NEGATIVE_PROMPT_HINTS
    ?? file.sceneNegativePromptHints,
  )

  return {
    host: pick('host', 'WAYWARD_HOST', 'host', '127.0.0.1'),
    port: pickNum('port', 'WAYWARD_PORT', 'port', DEFAULT_PORT),
    imagesDir,
    stateDir,
    comfyUrl: pick('comfy-url', 'COMFYUI_URL', 'comfyUrl', 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    wanWorkflowPath,

    imagePreset,
    animaModel: pick('anima-model', 'ANIMA_MODEL', 'animaModel', DEFAULT_ANIMA_MODEL),
    animaTextEncoder: pick('anima-text-encoder', 'ANIMA_TEXT_ENCODER', 'animaTextEncoder', DEFAULT_ANIMA_TEXT_ENCODER),
    animaVae: pick('anima-vae', 'ANIMA_VAE', 'animaVae', DEFAULT_ANIMA_VAE),
    positivePromptPrefix: pick('positive-prefix', 'WAYWARD_POSITIVE_PREFIX', 'positivePromptPrefix', ''),
    positivePromptSuffix: pick('positive-suffix', 'WAYWARD_POSITIVE_SUFFIX', 'positivePromptSuffix', ''),
    negativePromptPrefix: pick('negative-prefix', 'WAYWARD_NEGATIVE_PREFIX', 'negativePromptPrefix', ''),
    negativePromptSuffix: pick('negative-suffix', 'WAYWARD_NEGATIVE_SUFFIX', 'negativePromptSuffix', ''),
    characterLoras,
    characterProfiles,
    complexScenePolicy,
    scenePromptHints,
    sceneNegativePromptHints,

    allowedOrigins,
    allowDelete: flags['allow-delete'] === 'true' || envBool('WAYWARD_ALLOW_DELETE', file.allowDelete === true),

    maxDiskGb: pickNum('max-disk-gb', 'WAYWARD_MAX_DISK_GB', 'maxDiskGb', 0),
    concurrency: pickNum('concurrency', 'WAYWARD_CONCURRENCY', 'concurrency', 2),
    maxQueued: pickNum('max-queued', 'WAYWARD_MAX_QUEUED', 'maxQueued', 64),
    maxImagesPerHour: pickNum('max-images-per-hour', 'WAYWARD_MAX_IMAGES_PER_HOUR', 'maxImagesPerHour', 400),

    characterDirs,

    checkpoint: pick('checkpoint', 'COMFYUI_CHECKPOINT', 'checkpoint', DEFAULT_CHECKPOINT),
    steps: pickNum('steps', 'COMFYUI_STEPS', 'steps', imagePreset === 'anima' ? 30 : 9),
    cfg: pickNum('cfg', 'COMFYUI_CFG', 'cfg', imagePreset === 'anima' ? 4 : 1.5),
    sampler: pick('sampler', 'COMFYUI_SAMPLER', 'sampler', imagePreset === 'anima' ? 'er_sde' : 'euler_ancestral'),
    scheduler: pick('scheduler', 'COMFYUI_SCHEDULER', 'scheduler', 'simple'),
    clipSkip: pickNum('clip-skip', 'COMFYUI_CLIP_SKIP', 'clipSkip', -2),
    lora: pick('lora', 'COMFYUI_LORA', 'lora', imagePreset === 'anima' ? '' : 'sdxl_lightning_8step_lora.safetensors'),
    loraStrength: pickNum('lora-strength', 'COMFYUI_LORA_STRENGTH', 'loraStrength', 1),

    webp: flags['no-webp'] === 'true' ? false : !envBool('WAYWARD_NO_WEBP', file.webp === false),
    requireWebp: flags['require-webp'] === 'true' || envBool('WAYWARD_REQUIRE_WEBP', file.requireWebp === true),

    pollIntervalMs: pickNum('poll-interval-ms', 'WAYWARD_POLL_INTERVAL_MS', 'pollIntervalMs', 2000),

    parentPid: (() => {
      const raw = flags['parent-pid'] ?? process.env.WAYWARD_PARENT_PID
      if (!raw) return null
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : null
    })(),

    verbose: flags['verbose'] === 'true' || envBool('WAYWARD_VERBOSE', false),
  }
}
