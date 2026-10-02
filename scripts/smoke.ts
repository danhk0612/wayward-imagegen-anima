import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { buildComfyPrompt, isComplexInteractionScene } from '../src/comfy/workflows/index.ts'
import { resolvePromptHash } from '../src/routes/image.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wayward-anima-smoke-'))
const configPath = path.join(tmp, 'wayward-imagegen.config.json')
fs.writeFileSync(configPath, JSON.stringify({
  imagePreset: 'anima',
  animaModel: 'anima-base-v1.0.safetensors',
  animaTextEncoder: 'qwen_3_06b_base.safetensors',
  animaVae: 'qwen_image_vae.safetensors',
  animaDimensions: '1152 x 768 (1.5:1)',
  lora: '',
  steps: 36,
  cfg: 4.5,
  sampler: 'er_sde',
  scheduler: 'simple',
  characterProfiles: {
    elena: {
      loras: [{ name: 'elena.safetensors', strengthModel: 0.85 }],
      triggerPrompt: 'elena_trigger',
      basePrompt: 'silver hair, blue eyes',
      gamePromptPrefixToStrip: 'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts',
    },
  },
  complexScenePolicy: {
    enabled: true,
    characterLoraScale: 0.8,
    positivePrompt: 'two distinct people, clear body separation, coherent anatomy',
    negativePrompt: 'merged bodies, extra torso',
  },
  scenePromptHints: {},
  sceneNegativePromptHints: {},
}), 'utf8')

const cfg = resolveConfig([], tmp)
assert(isComplexInteractionScene('1girl, cunnilingus, lying on back'), 'Implicit two-person interaction must be detected without an explicit 1boy tag')
assert(!isComplexInteractionScene('1girl, kneeling alone in a tavern'), 'Solo pose must not be classified as a complex interaction')
const graph = buildComfyPrompt(
  cfg,
  'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts, 1boy, kneeling, hugging in a tavern',
  'bad anatomy',
  'smoke_portrait',
  'illustrious',
  123,
  undefined,
  undefined,
  'elena__scene-any_future_scene__outfit-casual',
)

const nodes = Object.values(graph) as Array<{ class_type?: string; inputs?: Record<string, unknown> }>
const classTypes = nodes.map(n => n.class_type)
assert(classTypes.includes('UNETLoader'), 'Anima graph must load a diffusion model with UNETLoader')
assert(classTypes.includes('CLIPLoader'), 'Anima graph must load the Qwen text encoder')
assert(classTypes.includes('VAELoader'), 'Anima graph must load the Qwen image VAE')
assert(classTypes.includes('LoraLoaderModelOnly'), 'Anima character LoRA must use model-only loader')
assert(!classTypes.includes('CheckpointLoaderSimple'), 'Anima graph must not use SDXL CheckpointLoaderSimple')
assert(!classTypes.includes('ModelSamplingAuraFlow'), 'Anima Base v1 graph must not add AuraFlow model-shift patching')
const latent = nodes.find(n => n.class_type === 'EmptyLatentImage')
assert(Number(latent?.inputs?.width) === 1152 && Number(latent?.inputs?.height) === 768, 'Configured Anima dimensions must override the game request')

const positive = nodes.find(n => n.class_type === 'CLIPTextEncode' && String(n.inputs?.text ?? '').includes('elena_trigger'))
assert(positive, 'Character trigger prompt must be present in the positive prompt')
const positiveText = String(positive.inputs?.text ?? '')
assert(positiveText.includes('silver hair, blue eyes'), 'Character base prompt must be present')
assert(positiveText.includes('1boy, kneeling, hugging in a tavern'), 'Wayward scene prompt must remain present')
assert(!positiveText.includes('old_elena'), 'Original game identity prompt must be stripped when configured')
assert(positiveText.includes('two distinct people'), 'Generic complex-scene positive hint must be applied')
const negative = nodes.find(n => n.class_type === 'CLIPTextEncode' && String(n.inputs?.text ?? '').includes('merged bodies'))
assert(negative, 'Generic complex-scene negative hint must be applied')
assert(positiveText.indexOf('elena_trigger') < positiveText.indexOf('1boy'), 'Character identity prompt must precede the dynamic scene')

const complexLora = nodes.find(n => n.class_type === 'LoraLoaderModelOnly' && n.inputs?.lora_name === 'elena.safetensors')
assert(complexLora, 'Complex scene must still apply the character LoRA')
assert(Math.abs(Number(complexLora.inputs?.strength_model) - 0.68) < 1e-9, 'Complex scene must scale only the character LoRA')

const simpleGraph = buildComfyPrompt(
  cfg,
  'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts, standing alone in a tavern',
  'bad anatomy',
  'smoke_simple',
  'illustrious',
  124,
  undefined,
  undefined,
  'elena__scene-solo_future_scene__outfit-casual',
)
const simpleNodes = Object.values(simpleGraph) as Array<{ class_type?: string; inputs?: Record<string, unknown> }>
const simplePositive = simpleNodes.find(n => n.class_type === 'CLIPTextEncode' && String(n.inputs?.text ?? '').includes('standing alone'))
assert(simplePositive, 'Simple scene positive prompt must exist')
assert(!String(simplePositive.inputs?.text ?? '').includes('two distinct people'), 'Simple scene must not receive complex-scene hints')
const simpleLora = simpleNodes.find(n => n.class_type === 'LoraLoaderModelOnly' && n.inputs?.lora_name === 'elena.safetensors')
assert(simpleLora, 'Simple scene must apply the character LoRA')
assert(Math.abs(Number(simpleLora.inputs?.strength_model) - 0.85) < 1e-9, 'Simple scene must preserve normal character LoRA strength')

const legacyOverrideGraph = buildComfyPrompt(
  cfg,
  'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts, standing alone',
  '',
  'smoke_ignore_game_tuning',
  'illustrious',
  125,
  {
    steps: 7,
    cfg: 1.1,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    checkpoint: 'wrong-game-checkpoint.safetensors',
  },
  undefined,
  'elena__scene-solo__outfit-casual',
)
const legacyOverrideNodes = Object.values(legacyOverrideGraph) as Array<{ class_type?: string; inputs?: Record<string, unknown> }>
const legacySampler = legacyOverrideNodes.find(n => n.class_type === 'KSampler')
const legacyUnet = legacyOverrideNodes.find(n => n.class_type === 'UNETLoader')
assert(Number(legacySampler?.inputs?.steps) === 36, 'Native Anima must ignore game-provided steps by default')
assert(Number(legacySampler?.inputs?.cfg) === 4.5, 'Native Anima must ignore game-provided CFG by default')
assert(legacySampler?.inputs?.sampler_name === 'er_sde', 'Native Anima must ignore game-provided sampler by default')
assert(legacySampler?.inputs?.scheduler === 'simple', 'Native Anima must ignore game-provided scheduler by default')
assert(legacyUnet?.inputs?.unet_name === 'anima-base-v1.0.safetensors', 'Native Anima must ignore game-provided checkpoint by default')

const explicitOverrideGraph = buildComfyPrompt(
  cfg,
  'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts, standing alone',
  '',
  'smoke_allow_test_tuning',
  'illustrious',
  126,
  {
    steps: 7,
    cfg: 1.1,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    checkpoint: 'benchmark-model.safetensors',
    dimensions: '1024 x 1024 (1:1)',
    allowAnimaTuningOverrides: true,
  },
  undefined,
  'elena__scene-solo__outfit-casual',
)
const explicitOverrideNodes = Object.values(explicitOverrideGraph) as Array<{ class_type?: string; inputs?: Record<string, unknown> }>
const explicitSampler = explicitOverrideNodes.find(n => n.class_type === 'KSampler')
const explicitUnet = explicitOverrideNodes.find(n => n.class_type === 'UNETLoader')
assert(Number(explicitSampler?.inputs?.steps) === 7, 'Explicit Anima benchmark override must apply steps')
assert(Number(explicitSampler?.inputs?.cfg) === 1.1, 'Explicit Anima benchmark override must apply CFG')
assert(explicitSampler?.inputs?.sampler_name === 'euler_ancestral', 'Explicit Anima benchmark override must apply sampler')
assert(explicitSampler?.inputs?.scheduler === 'normal', 'Explicit Anima benchmark override must apply scheduler')
assert(explicitUnet?.inputs?.unet_name === 'benchmark-model.safetensors', 'Explicit Anima benchmark override must apply checkpoint')
const explicitLatent = explicitOverrideNodes.find(n => n.class_type === 'EmptyLatentImage')
assert(Number(explicitLatent?.inputs?.width) === 1024 && Number(explicitLatent?.inputs?.height) === 1024, 'Explicit Anima benchmark override must apply dimensions')

const hashA = resolvePromptHash({
  talentName: 'elena__scene-tavern',
  prompt: 'standing in a tavern',
  negativePrompt: '',
}, cfg)

fs.writeFileSync(configPath, JSON.stringify({
  imagePreset: 'anima',
  animaModel: 'anima-base-v1.0.safetensors',
  animaTextEncoder: 'qwen_3_06b_base.safetensors',
  animaVae: 'qwen_image_vae.safetensors',
  animaDimensions: '1152 x 768 (1.5:1)',
  lora: '',
  characterProfiles: {
    elena: {
      loras: [{ name: 'elena.safetensors', strengthModel: 0.85 }],
      triggerPrompt: 'elena_trigger_v2',
      basePrompt: 'silver hair, blue eyes',
      gamePromptPrefixToStrip: 'masterpiece, best quality, 1girl, old_elena, black hair, medium breasts',
    },
  },
  complexScenePolicy: {
    enabled: true,
    characterLoraScale: 0.8,
    positivePrompt: 'two distinct people, clear body separation, coherent anatomy',
    negativePrompt: 'merged bodies, extra torso',
  },
  scenePromptHints: {},
  sceneNegativePromptHints: {},
}), 'utf8')
const cfg2 = resolveConfig([], tmp)
const hashB = resolvePromptHash({
  talentName: 'elena__scene-tavern',
  prompt: 'standing in a tavern',
  negativePrompt: '',
}, cfg2)
assert(hashA !== hashB, 'Changing character trigger/base configuration must invalidate the image cache')

console.log('Anima smoke test passed')
