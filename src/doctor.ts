/**
 * `wayward-imagegen doctor` — find out why pictures are not appearing.
 *
 * Everything here is a question a player cannot answer by looking. ComfyUI
 * knows which node classes it has and which model files it can see; only a
 * real render proves the whole chain works. So this asks ComfyUI, then renders
 * one picture and reports exactly what came back.
 */

import { ComfyClient, inputChoices, type ObjectInfoEntry } from './comfy/client.ts'
import { buildComfyPrompt } from './comfy/workflows/index.ts'
import type { Config } from './config.ts'

/** Node classes the shipped illustrious/anima graph cannot render without. */
const REQUIRED_NODES: { klass: string; from: string }[] = [
  { klass: 'CheckpointLoaderSimple', from: 'ComfyUI itself' },
  { klass: 'CLIPSetLastLayer', from: 'ComfyUI itself' },
  { klass: 'CLIPTextEncode', from: 'ComfyUI itself' },
  { klass: 'VAEDecode', from: 'ComfyUI itself' },
  { klass: 'SaveImage', from: 'ComfyUI itself' },
  { klass: 'LoraLoader', from: 'ComfyUI itself' },
  { klass: 'LoraLoaderModelOnly', from: 'ComfyUI itself' },
  { klass: 'EmptyLatentImagePresets', from: 'KJ Nodes for ComfyUI (kijai)' },
  { klass: 'GlobalSeed //Inspire', from: 'ComfyUI Inspire Pack (ltdrdata)' },
  { klass: 'ToBasicPipe', from: 'ComfyUI Impact Pack (ltdrdata)' },
  { klass: 'ImpactKSamplerBasicPipe', from: 'ComfyUI Impact Pack (ltdrdata)' },
]

type Line = (text?: string) => void

/** How long to wait for the probe render before calling it stuck. */
const RENDER_TIMEOUT_MS = 180_000

function shortenList(values: string[], limit = 12): string {
  return `${values.slice(0, limit).join(', ')}${values.length > limit ? ', ...' : ''}`
}

/** All LoRA names visible through the graph's loaders. */
function availableLoras(info: Record<string, ObjectInfoEntry>): string[] | null {
  return inputChoices(info['LoraLoader'], 'lora_name')
    ?? inputChoices(info['LoraLoaderModelOnly'], 'lora_name')
}

export async function runDoctor(config: Config, log: Line = console.log): Promise<number> {
  const comfy = new ComfyClient(config.comfyUrl)
  const problems: string[] = []

  log(`wayward-imagegen doctor`)
  log(`  comfyui        ${config.comfyUrl}`)
  log(`  images         ${config.imagesDir}`)
  log(`  image preset   ${config.imagePreset}`)
  log(`  checkpoint     ${config.checkpoint}`)
  log(`  speed lora     ${config.lora || '(none)'}`)
  log(`  global loras    ${config.characterLoras.length > 0 ? config.characterLoras.map(l => `${l.name} (${l.strengthModel}/${l.strengthClip})`).join(', ') : '(none)'}`)
  log(`  profiles        ${Object.keys(config.characterProfiles).length > 0 ? Object.keys(config.characterProfiles).join(', ') : '(none)'}`)
  log()

  // 1. Is ComfyUI even there?
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

  // 2. Are the node classes the graph names actually installed?
  const info = await comfy.objectInfo()
  if (!info) {
    log(`FAIL  ComfyUI answered /system_stats but not /object_info.`)
    return 1
  }
  const missing = REQUIRED_NODES.filter(n => !(n.klass in info))
  if (missing.length === 0) {
    log(`OK    all ${REQUIRED_NODES.length} node types the graph uses are installed`)
  } else {
    problems.push('missing custom nodes')
    log(`FAIL  ${missing.length} node type(s) missing — install these in ComfyUI Manager:`)
    for (const n of missing) log(`        ${n.klass}   from ${n.from}`)
  }

  // A pack that re-registers SaveImage as a non-output node is silent murder:
  // ComfyUI drops the only node that saves anything and still queues the job.
  const saveImage: ObjectInfoEntry | undefined = info['SaveImage']
  if (saveImage && saveImage.output_node === false) {
    problems.push('SaveImage is not an output node')
    log(`FAIL  This ComfyUI's SaveImage is not an output node — something has`)
    log(`      replaced it, and nothing will ever be saved. Disable whichever`)
    log(`      custom node pack overrides SaveImage.`)
  }
  log()

  // 3. Can ComfyUI see the model files we name?
  const checkpoints = inputChoices(info['CheckpointLoaderSimple'], 'ckpt_name')
  if (checkpoints && !checkpoints.includes(config.checkpoint)) {
    problems.push('checkpoint not found')
    log(`FAIL  ComfyUI cannot see the checkpoint "${config.checkpoint}".`)
    log(`      It has ${checkpoints.length}: ${shortenList(checkpoints)}`)
    log(`      Rename your file to match, or set COMFYUI_CHECKPOINT to one of those.`)
  } else if (checkpoints) {
    log(`OK    checkpoint "${config.checkpoint}" is installed`)
  }

  const loras = availableLoras(info)
  if (config.lora && loras && !loras.includes(config.lora)) {
    problems.push('speed lora not found')
    log(`FAIL  ComfyUI cannot see the speed LoRA "${config.lora}".`)
    log(`      It has ${loras.length}: ${shortenList(loras)}`)
    log(`      Rename it to match, or set COMFYUI_LORA= (empty) to render without it.`)
  } else if (config.lora && loras) {
    log(`OK    speed LoRA "${config.lora}" is installed`)
  } else if (!config.lora) {
    log(`OK    no speed LoRA configured (renders may be slower)`)
  }

  const configuredProfileLoras = Object.entries(config.characterProfiles)
    .flatMap(([character, profile]) => profile.loras.map(lora => ({ character, ...lora })))
  const allConfiguredLoras = [
    ...config.characterLoras.map(lora => ({ character: '(global)', ...lora })),
    ...configuredProfileLoras,
  ]
  if (allConfiguredLoras.length === 0) {
    log(`OK    no character/style LoRAs configured`)
  } else if (!loras) {
    problems.push('could not list loras')
    log(`FAIL  ComfyUI did not report a LoRA list to validate character/style LoRAs.`)
  } else {
    const missingCharacterLoras = allConfiguredLoras.filter(l => !loras.includes(l.name))
    if (missingCharacterLoras.length > 0) {
      problems.push('character lora not found')
      log(`FAIL  ${missingCharacterLoras.length} configured character/style LoRA(s) are not visible to ComfyUI:`)
      for (const spec of missingCharacterLoras) {
        log(`        [${spec.character}] ${spec.name}`)
      }
      log(`      Available LoRAs include: ${shortenList(loras)}`)
    } else {
      log(`OK    all ${allConfiguredLoras.length} configured character/style LoRA(s) are installed`)
    }
  }
  log()

  // 4. The only proof that matters: render one picture.
  log(`      rendering one test picture...`)
  const graph = buildComfyPrompt(
    config,
    'masterpiece, best quality, 1girl, brown hair, smiling, tavern',
    'worst quality, low quality',
    'doctor_portrait',
    'illustrious',
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
