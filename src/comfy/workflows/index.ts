/**
 * ComfyUI workflow builders.
 *
 * The game sends only the semantic request — portrait, character, prompt — and
 * the server decides how to render it. That is what lets a player swap the
 * backing workflow from the shipped Illustrious setup to a custom Anima setup
 * without changing the game.
 */

import type { Config, WorkflowType, LoraSpec, CharacterProfile } from '../../config.ts'
import { extractCharacterName } from '../../naming.ts'

export interface GenOverrides {
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  dimensions?: string
}

export type ComfyGraph = Record<string, object>

const Z_IMAGE = {
  unet: 'zit\\moodyPornMix_zitV6.safetensors',
  clip: 'qwen_3_4b.safetensors',
  clipType: 'lumina2',
  vae: 'ae.safetensors',
  steps: 9,
  cfg: 1,
  sampler: 'dpmpp_2m_sde',
  scheduler: 'beta',
  defaultDimensions: '1024 x 1024 (1:1)',
} as const

const FACE_ID = {
  preset: 'FACEID',
  loraStrength: 0.4,
  weight: 2,
  weightV2: 2,
} as const

const DEFAULT_DIMENSIONS = '1024 x 1024 (1:1)'

function randomSeed(): number {
  return Math.floor(Math.random() * 1000000000000000)
}

function composePrompt(prefix: string, prompt: string, suffix: string): string {
  return [prefix, prompt, suffix].map(s => s.trim()).filter(Boolean).join(', ')
}

function composeNegativePrompt(prefix: string, prompt: string, suffix: string): string {
  return [prefix, prompt, suffix].map(s => s.trim()).filter(Boolean).join(', ')
}

function stripGamePromptPrefix(prompt: string, prefix: string | undefined): string {
  const wanted = (prefix ?? '').trim().replace(/,+\s*$/, '')
  if (!wanted) return prompt.trim()
  const text = prompt.trim()
  if (text.toLowerCase().startsWith(wanted.toLowerCase())) {
    return text.slice(wanted.length).replace(/^\s*,\s*/, '').trim()
  }
  return text
}

function extractSceneSlug(talentName?: string): string | null {
  if (!talentName) return null
  const match = talentName.match(/__scene-(.+?)__outfit-/i)
  return match?.[1]?.trim().toLowerCase() || null
}

const OTHER_PERSON_MARKERS = [
  '1boy', '2boys', '3boys', 'multiple boys', 'faceless male',
  'looking at another', 'with a man', 'with another person',
]

const COMPLEX_INTERACTION_MARKERS = [
  'sex', 'vaginal', 'anal', 'cunnilingus', 'fellatio', 'blowjob',
  'handjob', 'paizuri', 'titfuck', 'breast press', 'doggystyle',
  'from behind', 'kneeling', 'straddling', 'spread legs', 'on chair',
  'kissing', 'hugging', 'embrace', 'grabbing', 'touching',
]

function hasPromptMarker(prompt: string, marker: string): boolean {
  const text = prompt.toLowerCase().replace(/_/g, ' ')
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
}

export function isComplexInteractionScene(prompt: string): boolean {
  const hasOtherPerson = OTHER_PERSON_MARKERS.some(marker => hasPromptMarker(prompt, marker))
  if (!hasOtherPerson) return false
  return COMPLEX_INTERACTION_MARKERS.some(marker => hasPromptMarker(prompt, marker))
}

export function buildComfyPrompt(
  cfg: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  workflowType: WorkflowType = 'z-image',
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
  talentName?: string,
): ComfyGraph {
  if (workflowType === 'illustrious') {
    if (cfg.imagePreset === 'anima') {
      return buildAnimaPrompt(cfg, textPrompt, negativePrompt, filenamePrefix, seed, overrides, referenceImagePath, talentName)
    }
    return buildIllustriousPrompt(cfg, textPrompt, negativePrompt, filenamePrefix, seed, overrides, referenceImagePath, talentName)
  }
  return buildZImagePrompt(textPrompt, filenamePrefix, seed, overrides)
}

export function buildZImagePrompt(
  textPrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: Pick<GenOverrides, 'steps' | 'cfg'>,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const steps = overrides?.steps ?? Z_IMAGE.steps
  const cfg = overrides?.cfg ?? Z_IMAGE.cfg

  return {
    '39': {
      inputs: { clip_name: Z_IMAGE.clip, type: Z_IMAGE.clipType },
      class_type: 'CLIPLoader',
      _meta: { title: 'Load CLIP' },
    },
    '40': {
      inputs: { vae_name: Z_IMAGE.vae },
      class_type: 'VAELoader',
      _meta: { title: 'Load VAE' },
    },
    '45': {
      inputs: { text: textPrompt, clip: ['39', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'CLIP Text Encode (Prompt)' },
    },
    '61': {
      inputs: { dimensions: Z_IMAGE.defaultDimensions, invert: false, batch_size: 1 },
      class_type: 'EmptyLatentImagePresets',
      _meta: { title: 'Empty Latent Image Presets' },
    },
    '43': {
      inputs: { samples: ['44', 0], vae: ['40', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '9': {
      inputs: { filename_prefix: filenamePrefix, images: ['43', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
    '62': {
      inputs: { unet_name: Z_IMAGE.unet, weight_dtype: 'default' },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '47': {
      inputs: { shift: 1, model: ['62', 0] },
      class_type: 'ModelSamplingAuraFlow',
      _meta: { title: 'ModelSamplingAuraFlow' },
    },
    '42': {
      inputs: { conditioning: ['45', 0] },
      class_type: 'ConditioningZeroOut',
      _meta: { title: 'Conditioning Zero Out' },
    },
    '44': {
      inputs: {
        seed: actualSeed,
        steps,
        cfg,
        sampler_name: Z_IMAGE.sampler,
        scheduler: Z_IMAGE.scheduler,
        denoise: 1,
        model: ['47', 0],
        positive: ['45', 0],
        negative: ['42', 0],
        latent_image: ['61', 0],
      },
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
    },
  }
}

export function buildIllustriousPrompt(
  config: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
  talentName?: string,
): ComfyGraph {
  return buildSdxlLikePrompt('Illustrious', config, textPrompt, negativePrompt, filenamePrefix, seed, overrides, referenceImagePath, talentName)
}

/**
 * Native Anima Base v1 path.
 *
 * Anima is loaded as separate diffusion model, Qwen text encoder and VAE.
 * Character/style LoRAs patch the diffusion model with LoraLoaderModelOnly.
 */
export function buildAnimaPrompt(
  config: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
  talentName?: string,
): ComfyGraph {
  if (referenceImagePath) {
    throw new Error('reference-image FaceID is not supported by the native Anima preset yet')
  }

  const actualSeed = seed ?? randomSeed()
  const steps = overrides?.steps ?? config.steps
  const cfg = overrides?.cfg ?? config.cfg
  const modelName = overrides?.checkpoint?.trim() || config.animaModel
  const { width, height } = parseDimensions(overrides?.dimensions)

  const characterName = talentName ? extractCharacterName(talentName, config.characterDirs) : null
  const profile: CharacterProfile | undefined = characterName ? config.characterProfiles[characterName] : undefined
  const characterPrefix = [
    profile?.triggerPrompt ?? '',
    profile?.basePrompt ?? '',
    profile?.positivePromptPrefix ?? '',
  ].map(part => part.trim()).filter(Boolean).join(', ')
  const scenePrompt = stripGamePromptPrefix(textPrompt, profile?.gamePromptPrefixToStrip)
  const sceneSlug = extractSceneSlug(talentName)
  const isComplexInteraction = config.complexScenePolicy.enabled && isComplexInteractionScene(scenePrompt)
  const genericSceneHint = isComplexInteraction ? config.complexScenePolicy.positivePrompt : ''
  const genericSceneNegativeHint = isComplexInteraction ? config.complexScenePolicy.negativePrompt : ''
  const specificSceneHint = sceneSlug ? config.scenePromptHints[sceneSlug] ?? '' : ''
  const specificSceneNegativeHint = sceneSlug ? config.sceneNegativePromptHints[sceneSlug] ?? '' : ''
  const sceneHint = [genericSceneHint, specificSceneHint].map(s => s.trim()).filter(Boolean).join(', ')
  const sceneNegativeHint = [genericSceneNegativeHint, specificSceneNegativeHint].map(s => s.trim()).filter(Boolean).join(', ')
  const finalTextPrompt = composePrompt(
    composePrompt(config.positivePromptPrefix, characterPrefix, sceneHint),
    scenePrompt,
    composePrompt('', profile?.positivePromptSuffix ?? '', config.positivePromptSuffix),
  )
  const finalNegativePrompt = composeNegativePrompt(
    composeNegativePrompt(config.negativePromptPrefix, profile?.negativePromptPrefix ?? '', sceneNegativeHint),
    negativePrompt,
    composeNegativePrompt('', profile?.negativePromptSuffix ?? '', config.negativePromptSuffix),
  )
  const profileLoraScale = isComplexInteraction ? config.complexScenePolicy.characterLoraScale : 1

  const nodes: ComfyGraph = {
    '3000': {
      inputs: { unet_name: modelName, weight_dtype: 'default' },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Anima Diffusion Model' },
    },
    '3001': {
      inputs: {
        clip_name: config.animaTextEncoder,
        type: 'stable_diffusion',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Load Anima Text Encoder' },
    },
    '3002': {
      inputs: { vae_name: config.animaVae },
      class_type: 'VAELoader',
      _meta: { title: 'Load Anima VAE' },
    },
    '3003': {
      inputs: { text: finalTextPrompt, clip: ['3001', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Anima Positive Prompt' },
    },
    '3004': {
      inputs: { text: finalNegativePrompt, clip: ['3001', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Anima Negative Prompt' },
    },
    '3005': {
      inputs: { width, height, batch_size: 1 },
      class_type: 'EmptyLatentImage',
      _meta: { title: 'Empty Latent Image' },
    },
    '3007': {
      inputs: { samples: ['3006', 0], vae: ['3002', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '3008': {
      inputs: { filename_prefix: filenamePrefix, images: ['3007', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
  }

  let nextNodeId = 3100
  const allocNodeId = (): string => String(nextNodeId++)
  let modelOutput: [string, number] = ['3000', 0]

  if (config.lora) {
    const id = allocNodeId()
    nodes[id] = {
      inputs: {
        lora_name: config.lora,
        strength_model: overrides?.loraStrength ?? config.loraStrength ?? 1,
        model: modelOutput,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Anima Speed LoRA: ${config.lora}` },
    }
    modelOutput = [id, 0]
  }

  const applyAnimaLora = (spec: LoraSpec, scale = 1): void => {
    const id = allocNodeId()
    nodes[id] = {
      inputs: {
        lora_name: spec.name,
        strength_model: spec.strengthModel * scale,
        model: modelOutput,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Anima Character/Style LoRA: ${spec.name}` },
    }
    modelOutput = [id, 0]
  }

  for (const spec of config.characterLoras) applyAnimaLora(spec)
  for (const spec of profile?.loras ?? []) applyAnimaLora(spec, profileLoraScale)

  nodes['3006'] = {
    inputs: {
      seed: actualSeed,
      steps,
      cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      denoise: 1,
      model: modelOutput,
      positive: ['3003', 0],
      negative: ['3004', 0],
      latent_image: ['3005', 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'Anima KSampler' },
  }

  return nodes
}

function parseDimensions(value?: string): { width: number; height: number } {
  if (!value) return { width: 1024, height: 1024 }
  const match = value.match(/(\d+)\s*x\s*(\d+)/i)
  if (!match) return { width: 1024, height: 1024 }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) {
    return { width: 1024, height: 1024 }
  }
  return { width, height }
}

function buildSdxlLikePrompt(
  label: string,
  config: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
  talentName?: string,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const steps = overrides?.steps ?? config.steps
  const cfg = overrides?.cfg ?? config.cfg
  const speedLoraStrength = overrides?.loraStrength ?? config.loraStrength ?? 1
  const checkpoint = overrides?.checkpoint?.trim() || config.checkpoint
  const characterName = talentName ? extractCharacterName(talentName, config.characterDirs) : null
  const profile: CharacterProfile | undefined = characterName ? config.characterProfiles[characterName] : undefined
  const characterPrefix = [
    profile?.triggerPrompt ?? '',
    profile?.basePrompt ?? '',
    profile?.positivePromptPrefix ?? '',
  ].map(part => part.trim()).filter(Boolean).join(', ')
  const scenePrompt = stripGamePromptPrefix(textPrompt, profile?.gamePromptPrefixToStrip)
  const sceneSlug = extractSceneSlug(talentName)
  const isComplexInteraction = config.complexScenePolicy.enabled && isComplexInteractionScene(scenePrompt)
  const genericSceneHint = isComplexInteraction ? config.complexScenePolicy.positivePrompt : ''
  const genericSceneNegativeHint = isComplexInteraction ? config.complexScenePolicy.negativePrompt : ''
  const specificSceneHint = sceneSlug ? config.scenePromptHints[sceneSlug] ?? '' : ''
  const specificSceneNegativeHint = sceneSlug ? config.sceneNegativePromptHints[sceneSlug] ?? '' : ''
  const sceneHint = [genericSceneHint, specificSceneHint].map(s => s.trim()).filter(Boolean).join(', ')
  const sceneNegativeHint = [genericSceneNegativeHint, specificSceneNegativeHint].map(s => s.trim()).filter(Boolean).join(', ')
  const finalTextPrompt = composePrompt(
    composePrompt(config.positivePromptPrefix, characterPrefix, sceneHint),
    scenePrompt,
    composePrompt('', profile?.positivePromptSuffix ?? '', config.positivePromptSuffix),
  )
  const finalNegativePrompt = composeNegativePrompt(
    composeNegativePrompt(config.negativePromptPrefix, profile?.negativePromptPrefix ?? '', sceneNegativeHint),
    negativePrompt,
    composeNegativePrompt('', profile?.negativePromptSuffix ?? '', config.negativePromptSuffix),
  )
  const profileLoraScale = isComplexInteraction ? config.complexScenePolicy.characterLoraScale : 1

  const nodes: ComfyGraph = {
    '1407': {
      inputs: { ckpt_name: checkpoint },
      class_type: 'CheckpointLoaderSimple',
      _meta: { title: `Load ${label} Checkpoint` },
    },
    '1457': {
      inputs: {
        dimensions: overrides?.dimensions ?? DEFAULT_DIMENSIONS,
        invert: overrides?.dimensions ? true : false,
        batch_size: 1,
      },
      class_type: 'EmptyLatentImagePresets',
      _meta: { title: 'Empty Latent Image Presets' },
    },
    '1458': {
      inputs: {
        value: actualSeed,
        mode: true,
        action: 'increment',
        last_seed: String(actualSeed - 1),
      },
      class_type: 'GlobalSeed //Inspire',
      _meta: { title: 'GlobalSeed //Inspire' },
    },
    '1291': {
      inputs: { samples: ['1536', 1], vae: ['1536', 2] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '1441': {
      inputs: { filename_prefix: filenamePrefix, images: ['1291', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
  }

  let nextNodeId = 2000
  const allocNodeId = (): string => String(nextNodeId++)

  let modelOutput: [string, number] = ['1407', 0]
  let clipOutput: [string, number] = ['1407', 1]

  const applyCharacterLora = (spec: LoraSpec): void => {
    const id = allocNodeId()
    nodes[id] = {
      inputs: {
        lora_name: spec.name,
        strength_model: spec.strengthModel,
        strength_clip: spec.strengthClip,
        model: modelOutput,
        clip: clipOutput,
      },
      class_type: 'LoraLoader',
      _meta: { title: `Character LoRA: ${spec.name}` },
    }
    modelOutput = [id, 0]
    clipOutput = [id, 1]
  }

  for (const spec of config.characterLoras) applyCharacterLora(spec)
  for (const spec of profile?.loras ?? []) {
    applyCharacterLora({
      ...spec,
      strengthModel: spec.strengthModel * profileLoraScale,
      strengthClip: spec.strengthClip * profileLoraScale,
    })
  }

  nodes['15'] = {
    inputs: { stop_at_clip_layer: config.clipSkip ?? -2, clip: clipOutput },
    class_type: 'CLIPSetLastLayer',
    _meta: { title: 'Clip Skip' },
  }
  nodes['522'] = {
    inputs: { text: finalTextPrompt, clip: ['15', 0] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Prompt' },
  }
  nodes['1440'] = {
    inputs: { text: finalNegativePrompt, clip: ['15', 0] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Negative' },
  }

  if (referenceImagePath) {
    const loadImageId = allocNodeId()
    const loaderId = allocNodeId()
    const faceIdId = allocNodeId()

    nodes[loadImageId] = {
      inputs: { image: referenceImagePath, upload: 'image' },
      class_type: 'LoadImage',
      _meta: { title: 'Load Image' },
    }
    nodes[loaderId] = {
      inputs: {
        preset: FACE_ID.preset,
        lora_strength: FACE_ID.loraStrength,
        provider: 'CPU',
        model: modelOutput,
      },
      class_type: 'IPAdapterUnifiedLoaderFaceID',
      _meta: { title: 'IPAdapterUnifiedLoaderFaceID' },
    }
    nodes[faceIdId] = {
      inputs: {
        weight: FACE_ID.weight,
        weight_faceidv2: FACE_ID.weightV2,
        weight_type: 'ease in',
        combine_embeds: 'concat',
        start_at: 0,
        end_at: 1,
        embeds_scaling: 'V only',
        model: [loaderId, 0],
        ipadapter: [loaderId, 1],
        image: [loadImageId, 0],
      },
      class_type: 'IPAdapterFaceID',
      _meta: { title: 'IPAdapterFaceID' },
    }
    modelOutput = [faceIdId, 0]
  }

  if (config.lora) {
    const speedLoraId = allocNodeId()
    nodes[speedLoraId] = {
      inputs: {
        lora_name: config.lora,
        strength_model: speedLoraStrength,
        model: modelOutput,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Speed LoRA: ${config.lora}` },
    }
    modelOutput = [speedLoraId, 0]
  }

  nodes['158'] = {
    inputs: {
      model: modelOutput,
      clip: ['15', 0],
      vae: ['1407', 2],
      positive: ['522', 0],
      negative: ['1440', 0],
    },
    class_type: 'ToBasicPipe',
    _meta: { title: 'ToBasicPipe' },
  }

  nodes['1536'] = {
    inputs: {
      seed: actualSeed,
      steps,
      cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      denoise: 1,
      basic_pipe: ['158', 0],
      latent_image: ['1457', 0],
    },
    class_type: 'ImpactKSamplerBasicPipe',
    _meta: { title: 'ImpactKSamplerBasicPipe' },
  }

  return nodes
}

export function buildWanVideoPrompt(
  workflowJson: string,
  textPrompt: string,
  negativePrompt: string,
  sourceImagePath: string,
  filenamePrefix: string,
  seed?: number,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const workflow = JSON.parse(workflowJson) as Record<string, { inputs?: Record<string, unknown> }>

  const patch = (id: string, inputs: Record<string, unknown>): void => {
    const node = workflow[id]
    if (!node) {
      throw new Error(
        `Wan video workflow is missing node "${id}". The bundled workflow expects `
        + `the node ids from ComfyUI_00033_.json; a differently-exported workflow `
        + `needs its ids remapped.`,
      )
    }
    node.inputs = { ...node.inputs, ...inputs }
  }

  patch('241', { image: sourceImagePath })
  patch('207:93', { text: textPrompt })
  patch('207:89', { text: negativePrompt })
  patch('216', { value: actualSeed, mode: true, action: 'fixed', last_seed: actualSeed })
  patch('207:86', { noise_seed: actualSeed, motion_amplitude: 1 })
  patch('207:178', { noise_seed: actualSeed })
  patch('221', { filename_prefix: filenamePrefix })

  return workflow as ComfyGraph
}
