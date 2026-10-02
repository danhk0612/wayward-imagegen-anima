import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { isComplexInteractionScene } from '../src/comfy/workflows/index.ts'

type CacheEntry = {
  talentName: string
  imageType?: string
  createdAt?: number
  prompt: string
  negativePrompt?: string
}

type GenerateResponse = {
  promptId?: string
  status?: string
  imagePath?: string
  error?: string
}

const DEFAULT_MODELS = [
  'waiANIMA_v10Base10.safetensors',
  'anima_baseV10.safetensors',
  'animaAestheticEnhanced_v10.safetensors',
  'miaomiaoHarem_anima15.safetensors',
]

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.slice(2).find(v => v.startsWith(prefix))
  return hit?.slice(prefix.length)
}

function numArg(name: string, fallback: number): number {
  const value = Number(arg(name))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function sceneSlug(talentName: string): string {
  return talentName.match(/__scene-(.+?)__outfit-/i)?.[1] ?? 'unknown'
}

function safeName(value: string): string {
  return value
    .replace(/\.safetensors$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out)
  }
  return out
}

function resolveChoice(candidate: string, choices: string[]): string | null {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase()
  const base = path.basename(normalized)
  return choices.find(choice => {
    const c = choice.replace(/\\/g, '/').toLowerCase()
    return c === normalized || c.endsWith('/' + normalized) || path.basename(c) === base
  }) ?? null
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`)
  }
  if (!response.ok) {
    const message = (parsed as { error?: string }).error ?? JSON.stringify(parsed)
    throw new Error(`${response.status} ${message}`)
  }
  return parsed as T
}

async function waitForJob(server: string, promptId: string): Promise<GenerateResponse> {
  for (;;) {
    await Bun.sleep(1500)
    const status = await jsonFetch<GenerateResponse>(
      `${server}/api/image/status/${encodeURIComponent(promptId)}`,
    )
    if (status.status !== 'queued' && status.status !== 'processing') return status
  }
}

const cwd = process.cwd()
const cfg = resolveConfig([], cwd)
const server = (arg('server') ?? `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '')
const character = (arg('character') ?? 'elena').toLowerCase()
const sceneCount = numArg('scenes', 6)
const width = numArg('width', 1216)
const height = numArg('height', 832)
const models = (arg('models')?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_MODELS)

const cachePath = arg('cache')
  ? path.resolve(cwd, arg('cache')!)
  : path.join(cfg.imagesDir, '.image-cache.json')

if (!fs.existsSync(cachePath)) {
  throw new Error(`Cache not found: ${cachePath}\nGenerate a pool of game scenes first, then rerun this benchmark.`)
}

const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { entries?: Record<string, CacheEntry> }
const entries = Object.values(cache.entries ?? {})
  .filter(entry => entry.talentName?.toLowerCase().startsWith(character + '__'))
  .filter(entry => typeof entry.prompt === 'string' && isComplexInteractionScene(entry.prompt))
  .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

if (entries.length === 0) {
  throw new Error(`No complex interaction prompts for "${character}" were found in ${cachePath}`)
}

// Prefer scene diversity first, then fill with distinct prompt variants if necessary.
const selected: CacheEntry[] = []
const usedScenes = new Set<string>()
for (const entry of entries) {
  const slug = sceneSlug(entry.talentName)
  if (usedScenes.has(slug)) continue
  selected.push(entry)
  usedScenes.add(slug)
  if (selected.length >= sceneCount) break
}
if (selected.length < sceneCount) {
  const usedTalents = new Set(selected.map(e => e.talentName))
  for (const entry of entries) {
    if (usedTalents.has(entry.talentName)) continue
    selected.push(entry)
    usedTalents.add(entry.talentName)
    if (selected.length >= sceneCount) break
  }
}

console.log('Anima model A/B benchmark')
console.log(`  server      ${server}`)
console.log(`  cache       ${cachePath}`)
console.log(`  character   ${character}`)
console.log(`  scenes      ${selected.length}`)
console.log(`  dimensions  ${width}x${height}`)
console.log('  render      36 steps / CFG 4.5 / er_sde / simple')
console.log('  policy      complex-scene adaptive policy disabled for clean model comparison')
console.log('')

const [unetObjectInfo, checkpointObjectInfo] = await Promise.all([
  jsonFetch<unknown>(`${cfg.comfyUrl}/object_info/UNETLoader`),
  jsonFetch<unknown>(`${cfg.comfyUrl}/object_info/CheckpointLoaderSimple`).catch(() => ({})),
])
const unetChoices = [...new Set(collectStrings(unetObjectInfo).filter(v => v.toLowerCase().endsWith('.safetensors')))]
const checkpointChoices = [...new Set(collectStrings(checkpointObjectInfo).filter(v => v.toLowerCase().endsWith('.safetensors')))]
const resolvedModels = models
  .map(requested => ({
    requested,
    actual: resolveChoice(requested, unetChoices),
    checkpointOnly: resolveChoice(requested, checkpointChoices),
  }))
  .filter((item): item is { requested: string; actual: string; checkpointOnly: string | null } => {
    if (item.actual) return true
    if (item.checkpointOnly) {
      console.warn(`SKIP  ${item.requested} — visible to CheckpointLoaderSimple as "${item.checkpointOnly}", but not to UNETLoader`)
    } else {
      console.warn(`SKIP  ${item.requested} — not visible to ComfyUI UNETLoader`)
    }
    return false
  })

if (resolvedModels.length === 0) {
  console.log('')
  console.log('UNETLoader-visible .safetensors files:')
  for (const name of unetChoices) console.log(`  ${name}`)
  throw new Error('None of the requested Anima models are visible to UNETLoader.')
}

console.log('Models:')
for (const model of resolvedModels) {
  console.log(`  ${model.requested} -> ${model.actual}`)
}
console.log('')

console.log('Scenes:')
selected.forEach((entry, index) => {
  console.log(`  ${String(index + 1).padStart(2, '0')}  ${sceneSlug(entry.talentName)}  ${entry.talentName}`)
})
console.log('')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.resolve(cwd, 'AB-anima-models', stamp)
fs.mkdirSync(outputRoot, { recursive: true })

const manifest: Array<Record<string, unknown>> = []

for (let sceneIndex = 0; sceneIndex < selected.length; sceneIndex++) {
  const entry = selected[sceneIndex]
  const slug = sceneSlug(entry.talentName)
  const seed = 910000001 + sceneIndex

  for (const model of resolvedModels) {
    const modelLabel = safeName(model.requested)
    const label = `${String(sceneIndex + 1).padStart(2, '0')}-${safeName(slug)}__${modelLabel}`
    process.stdout.write(`[${sceneIndex + 1}/${selected.length}] ${slug} | ${modelLabel} ... `)

    try {
      const body = {
        talentName: entry.talentName,
        imageType: entry.imageType ?? 'portrait',
        workflow: 'illustrious',
        prompt: entry.prompt,
        negativePrompt: entry.negativePrompt ?? '',
        seed,
        steps: 36,
        cfg: 4.5,
        sampler: 'er_sde',
        scheduler: 'simple',
        checkpoint: model.actual,
        width,
        height,
        disableComplexScenePolicy: true,
        promptHash: `anima-model-ab-v1-${sceneIndex}-${modelLabel}-${seed}`,
      }

      const job = await jsonFetch<GenerateResponse>(`${server}/api/image/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!job.promptId) throw new Error(job.error ?? 'server returned no promptId')

      const status = await waitForJob(server, job.promptId)
      if (status.status !== 'completed' || !status.imagePath) {
        throw new Error(status.error ?? `job finished as ${status.status ?? 'unknown'}`)
      }

      const source = path.join(cfg.imagesDir, ...status.imagePath.split('/'))
      const ext = path.extname(source) || '.webp'
      const dest = path.join(outputRoot, label + ext)
      fs.copyFileSync(source, dest)

      manifest.push({
        scene: slug,
        talentName: entry.talentName,
        seed,
        requestedModel: model.requested,
        actualModel: model.actual,
        file: path.basename(dest),
        prompt: entry.prompt,
      })

      console.log('OK')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      manifest.push({
        scene: slug,
        talentName: entry.talentName,
        seed,
        requestedModel: model.requested,
        actualModel: model.actual,
        error: message,
      })
      console.log(`FAIL — ${message}`)
    }
  }
}

fs.writeFileSync(
  path.join(outputRoot, 'manifest.json'),
  JSON.stringify({
    createdAt: new Date().toISOString(),
    server,
    character,
    settings: {
      steps: 36,
      cfg: 4.5,
      sampler: 'er_sde',
      scheduler: 'simple',
      width,
      height,
      disableComplexScenePolicy: true,
    },
    results: manifest,
  }, null, 2),
  'utf8',
)

const guide = [
  'ANIMA MODEL A/B',
  '',
  'Compare files with the same numeric prefix. They use the same game prompt and the same seed.',
  'Judge: anatomy/pose first, then character likeness, then sharpness/detail.',
  '',
  ...selected.map((entry, index) =>
    `${String(index + 1).padStart(2, '0')}  seed=${910000001 + index}  scene=${sceneSlug(entry.talentName)}`
  ),
  '',
  'Render settings: 36 steps / CFG 4.5 / er_sde / simple',
  'Adaptive complex-scene policy: disabled',
].join('\r\n')
fs.writeFileSync(path.join(outputRoot, 'README.txt'), guide, 'utf8')

console.log('')
console.log(`Done: ${outputRoot}`)
console.log(`Generated ${manifest.filter(x => !x.error).length} successful comparison images.`)
