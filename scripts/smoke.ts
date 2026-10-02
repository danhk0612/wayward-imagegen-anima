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
  lora: '',
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
