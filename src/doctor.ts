/**
 * `wayward-imagegen doctor` — end-to-end backend validation.
 */

import { ComfyClient, inputChoices, type ObjectInfoEntry } from './comfy/client.ts'
import { buildComfyPrompt } from './comfy/workflows/index.ts'
import type { Config } from './config.ts'

type NodeRequirement = { klass: string; from: string }
type Line = (text?: string) => void

const ILLUSTRIOUS_NODES: NodeRequirement[] = [
  { klass: 'CheckpointLoaderSimple', from: 'ComfyUI itself' },
  { klass: 'CLIPSetLastLayer', from: 'ComfyUI itself' },
  { klass: 'CLIPTextEncode', from: 'ComfyUI itself' },
  { klass: 'VAEDecode', from: 'ComfyUI itself' },
  { klass: 'SaveImage', from: 'ComfyUI itself' },
  { klass: 'LoraLoaderModelOnly', from: 'ComfyUI itself' },
  { klass: 'EmptyLatentImagePresets', from: 'KJ Nodes for ComfyUI (kijai)' },
  { klass: 'GlobalSeed //Inspire', from: 'ComfyUI Inspire Pack (ltdrdata)' },
  { klass: 'ToBasicPipe', from: 'ComfyUI Impact Pack (ltdrdata)' },
  { klass: 'ImpactKSamplerBasicPipe', from: 'ComfyUI Impact Pack (ltdrdata)' },
]

const ANIMA_NODES: NodeRequirement[] = [
  { klass: 'UNETLoader', from: 'ComfyUI itself' },
  { klass: 'CLIPLoader', from: 'ComfyUI itself' },
  { klass: 'VAELoader', from: 'ComfyUI itself' },
  { klass: 'LoraLoaderModelOnly', from: 'ComfyUI itself' },
  { klass: 'CLIPTextEncode', from: 'ComfyUI itself' },
  { klass: 'EmptyLatentImage', from: 'ComfyUI itself' },
  { klass: 'KSampler', from: 'ComfyUI itself' },
  { klass: 'VAEDecode', from: 'ComfyUI itself' },
  { klass: 'SaveImage', from: 'ComfyUI itself' },
]

const RENDER_TIMEOUT_MS = 180_000

function shortenList(values: string[], limit = 12): string {
  return `${values.slice(0, limit).join(', ')}${values.length > limit ? ', ...' : ''}`
}

function reportChoice(
  log: Line,
  problems: string[],
  available: string[] | null,
  wanted: string,
  label: string,
): void {
  if (!available) {
    problems.push(`${label} list unavailable`)
    log(`FAIL  ComfyUI did not report available ${label} files.`)
    return
  }
  if (!available.includes(wanted)) {
    problems.push(`${label} not found`)
    log(`FAIL  ComfyUI cannot see the ${label} "${wanted}".`)
    log(`      It has ${available.length}: ${shortenList(available)}`)
    return
  }
  log(`OK    ${label} "${wanted}" is installed`)
}

function allConfiguredLoras(config: Config): { character: string; name: string; strengthModel: number }[] {
  return [
    ...config.characterLoras.map(lora => ({ character: '(global)', ...lora })),
    ...Object.entries(config.characterProfiles)
      .flatMap(([character, profile]) => profile.loras.map(lora => ({ character, ...lora }))),
  ]
}

export async function runDoctor(config: Config, log: Line = console.log): Promise<number> {
  const comfy = new ComfyClient(config.comfyUrl)
  const problems: string[] = []

  log(`wayward-imagegen doctor`)
  log(`  comfyui        ${config.comfyUrl}`)
  log(`  images         ${config.imagesDir}`)
  log(`  image preset   ${config.imagePreset}`)
  if (config.imagePreset === 'anima') {
    log(`  anima model    ${config.animaModel}`)
    log(`  text encoder   ${config.animaTextEncoder}`)
    log(`  vae            ${config.animaVae}`)
  } else {
    log(`  checkpoint     ${config.checkpoint}`)
  }
  log(`  speed/turbo    ${config.lora || '(none)'}`)
  log(`  profiles       ${Object.keys(config.characterProfiles).length > 0 ? Object.keys(config.characterProfiles).join(', ') : '(none)'}`)
  log()

  const stats = await comfy.systemStats()
  if (!stats) {
    log(`FAIL  ComfyUI is not answering at ${config.comfyUrl}.`)
    log(`      Start ComfyUI, or pass --comfy-url if it runs somewhere else.`)
    return 1
  }
  const system = (stats.system ?? {}) as Record<string, unknown>
  const devices = Array.isArray(stats.devices) ? stats.devices : []
  const device = (devices[0] ?? {}) as Record<string, unknown>
  log(`OK    ComfyUI answers`)
  log(`      version ${String(system.comfyui_version ?? '?')}`
    + `  python ${String(system.python_version ?? '?').split(' ')[0]}`
    + `  ${String(system.os ?? '')}`)
  if (device.name) {
    const vram = typeof device.vram_total === 'number'
      ? ` (${(device.vram_total / 1024 ** 3).toFixed(1)} GB)`
      : ''
    log(`      device  ${String(device.name)}${vram}`)
  }
  log()

  const info = await comfy.objectInfo()
  if (!info) {
    log(`FAIL  ComfyUI answered /system_stats but not /object_info.`)
    return 1
  }

  const requirements = config.imagePreset === 'anima' ? ANIMA_NODES : ILLUSTRIOUS_NODES
  const missing = requirements.filter(n => !(n.klass in info))
  if (missing.length === 0) {
    log(`OK    all ${requirements.length} node types required by ${config.imagePreset} are installed`)
  } else {
    problems.push('missing nodes')
    log(`FAIL  ${missing.length} node type(s) missing:`)
    for (const n of missing) log(`        ${n.klass}   from ${n.from}`)
  }

  const saveImage: ObjectInfoEntry | undefined = info['SaveImage']
  if (saveImage && saveImage.output_node === false) {
    problems.push('SaveImage is not an output node')
    log(`FAIL  This ComfyUI's SaveImage is not an output node.`)
  }
  log()

  if (config.imagePreset === 'anima') {
    reportChoice(log, problems, inputChoices(info['UNETLoader'], 'unet_name'), config.animaModel, 'Anima diffusion model')
    reportChoice(log, problems, inputChoices(info['CLIPLoader'], 'clip_name'), config.animaTextEncoder, 'Anima text encoder')
    reportChoice(log, problems, inputChoices(info['VAELoader'], 'vae_name'), config.animaVae, 'Anima VAE')
  } else {
    reportChoice(log, problems, inputChoices(info['CheckpointLoaderSimple'], 'ckpt_name'), config.checkpoint, 'checkpoint')
  }

  const loras = inputChoices(info['LoraLoaderModelOnly'], 'lora_name')
  if (config.lora) {
    reportChoice(log, problems, loras, config.lora, 'speed/turbo LoRA')
  } else {
    log(`OK    no speed/turbo LoRA configured`)
  }

  const configuredLoras = allConfiguredLoras(config)
  if (configuredLoras.length === 0) {
    log(`OK    no character/style LoRAs configured`)
  } else if (!loras) {
    problems.push('could not list loras')
    log(`FAIL  ComfyUI did not report a LoRA list.`)
  } else {
    const missingLoras = configuredLoras.filter(l => !loras.includes(l.name))
    if (missingLoras.length > 0) {
      problems.push('character lora not found')
      log(`FAIL  ${missingLoras.length} configured character/style LoRA(s) are not visible to ComfyUI:`)
      for (const spec of missingLoras) log(`        [${spec.character}] ${spec.name}`)
      log(`      Available LoRAs include: ${shortenList(loras)}`)
    } else {
      log(`OK    all ${configuredLoras.length} configured character/style LoRA(s) are installed`)
    }
  }
  log()

  const doctorCharacter = Object.keys(config.characterProfiles)[0]
  log(`      rendering one test picture${doctorCharacter ? ` with profile "${doctorCharacter}"` : ''}...`)
  const graph = buildComfyPrompt(
    config,
    '1girl, brown hair, smiling, tavern',
    'worst quality, low quality',
    'doctor_portrait',
    'illustrious',
    undefined,
    undefined,
    undefined,
    doctorCharacter,
  )

  let promptId: string
  try {
    promptId = await comfy.submit(graph, true)
  } catch (err) {
    problems.push('ComfyUI refused the graph')
    log(`FAIL  ${(err as Error).message}`)
    return report(log, problems)
  }
  log(`      queued as ${promptId}`)

  const deadline = Date.now() + RENDER_TIMEOUT_MS
  for (;;) {
    await new Promise(r => setTimeout(r, 1500))
    const result = await comfy.history(promptId)
    if (result.error) {
      problems.push('the render failed')
      log(`FAIL  ComfyUI reported: ${result.error}`)
      break
    }
    if (result.done) {
      const images = result.images ?? []
      if (images.length > 0) {
        log(`OK    rendered ${images[0].filename}`)
      } else {
        problems.push('finished with no image')
        log(`FAIL  ComfyUI finished and produced no image.`)
        log(`      it said: ${result.report ?? '(nothing)'}`)
        log(`      full record: ${config.comfyUrl}/history/${promptId}`)
      }
      break
    }
    if (Date.now() > deadline) {
      problems.push('the render never finished')
      log(`FAIL  still not finished after ${RENDER_TIMEOUT_MS / 1000}s — is ComfyUI stuck?`)
      log(`      full record: ${config.comfyUrl}/history/${promptId}`)
      break
    }
  }
  log()
  return report(log, problems)
}

function report(log: Line, problems: string[]): number {
  if (problems.length === 0) {
    log(`All good — image generation works. If pictures still do not appear in the`)
    log(`game, check that Settings -> Image generation is set to Auto (or Custom`)
    log(`pointing at this server).`)
    return 0
  }
  log(`${problems.length} problem(s): ${problems.join(', ')}`)
  log(`Send this whole output along with your report.`)
  return 1
}
