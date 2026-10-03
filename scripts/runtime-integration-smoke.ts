import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import type { ComfyClient, HistoryResult, ComfyOutput } from '../src/comfy/client.ts'
import { CacheStore } from '../src/cache/cacheStore.ts'
import { JobRunner } from '../src/comfy/jobRunner.ts'
import { BatchQueue } from '../src/batch/queue.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

class FakeComfy {
  private seq = 0
  completeNewPrompts = true
  interrupted = false
  private readonly completed = new Set<string>()
  private readonly running = new Set<string>()

  async submit(_prompt: object, _front = false): Promise<string> {
    const id = `fake-${++this.seq}`
    if (this.completeNewPrompts) this.completed.add(id)
    else this.running.add(id)
    return id
  }

  async history(promptId: string): Promise<HistoryResult> {
    if (!this.completed.has(promptId)) return { done: false }
    const output: ComfyOutput = {
      filename: `${promptId}.png`,
      subfolder: '',
      type: 'output',
    }
    return { done: true, images: [output], videos: [] }
  }

  async view(_output: ComfyOutput): Promise<Buffer> {
    // saveImage writes raw bytes first; WebP conversion is disabled for this
    // integration test, so a minimal deterministic payload is sufficient.
    return Buffer.from('fake-png-payload')
  }

  async pendingIds(): Promise<{ all: Set<string>; ours: Set<string> }> {
    return { all: new Set(), ours: new Set() }
  }

  async deletePending(_ids: string[]): Promise<boolean> {
    return true
  }

  async runningIds(): Promise<{ all: Set<string>; ours: Set<string> }> {
    const all = new Set(this.running)
    return { all, ours: new Set(all) }
  }

  async interrupt(): Promise<boolean> {
    this.interrupted = true
    this.running.clear()
    return true
  }

  async queueStateOf(promptId: string): Promise<'running' | 'pending' | 'missing' | 'unknown'> {
    return this.running.has(promptId) ? 'running' : 'missing'
  }
}

async function waitFor(
  check: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(20)
  }
  throw new Error(message)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wayward-runtime-integration-'))
try {
  fs.writeFileSync(path.join(tmp, 'wayward-imagegen.config.json'), JSON.stringify({
    imagePreset: 'anima',
    animaModel: 'fake-anima.safetensors',
    animaTextEncoder: 'fake-qwen.safetensors',
    animaVae: 'fake-vae.safetensors',
    imagesDir: 'images',
    stateDir: 'state',
    webp: false,
    pollIntervalMs: 20,
    characterDirs: ['test'],
    characterProfiles: {
      test: {
        loras: [],
        triggerPrompt: 'test_trigger',
        basePrompt: 'blue hair, green eyes',
        gamePromptPrefixToStrip: 'masterpiece, best quality, 1girl, old_identity',
        positivePromptPrefix: '',
        positivePromptSuffix: '',
        negativePromptPrefix: '',
        negativePromptSuffix: '',
      },
    },
  }, null, 2))

  const config = resolveConfig([], tmp)
  const cache = new CacheStore({ imagesDir: config.imagesDir }).load()
  const fake = new FakeComfy()
  const jobs = new JobRunner({
    config,
    comfy: fake as unknown as ComfyClient,
    cache,
  })

  // 1) On-demand generation works with no static image pack at all.
  const direct = await jobs.submit({
    talentId: 'test__scene-direct',
    talentName: 'test__scene-direct',
    imageType: 'portrait',
    prompt: 'masterpiece, best quality, 1girl, old_identity, tavern, standing',
    negativePrompt: '',
    workflow: 'illustrious',
    promptHash: 'direct-hash',
  })
  await jobs.tick()
  assert(jobs.get(direct.promptId)?.status === 'completed', 'On-demand render did not complete')
  const directFiles = filesUnder(config.imagesDir)
  assert(directFiles.length === 1, 'On-demand render did not save exactly one image')
  assert(directFiles[0].includes(path.join('characters', 'test')), 'On-demand image was not filed under the character')

  // 2) Pre-generation uses the same profile/cache path and completes without a
  // downloaded/static image pack being present.
  const batch = new BatchQueue(config, cache, jobs)
  batch.enqueue([{
    talentId: 'test__scene-batch',
    prompt: 'masterpiece, best quality, 1girl, old_identity, garden, walking',
    workflow: 'illustrious',
    imageType: 'portrait',
  }], 'integration-complete')
  batch.start()

  while (batch.status().running) {
    await jobs.tick()
    await sleep(25)
  }
  assert(batch.status().completed === 1, 'Batch pre-generation did not complete')
  const completedFiles = filesUnder(config.imagesDir)
  assert(completedFiles.length === 2, 'Batch pre-generation did not add one image')

  // 3) Cancelling a running backend-owned batch render interrupts only that
  // active work and leaves already-completed art untouched.
  fake.completeNewPrompts = false
  batch.enqueue([{
    talentId: 'test__scene-cancel',
    prompt: 'masterpiece, best quality, 1girl, old_identity, street, running',
    workflow: 'illustrious',
    imageType: 'portrait',
  }], 'integration-cancel')
  batch.start()

  await waitFor(
    () => jobs.activeJobs().some(job => job.talentName === 'test__scene-cancel'),
    'Running batch job was never submitted',
  )
  await jobs.tick()
  const beforeCancel = filesUnder(config.imagesDir).map(file => ({
    file,
    bytes: fs.readFileSync(file).toString('hex'),
  }))

  batch.pause()
  const cancelled = await jobs.cancelAllOwn()
  assert(cancelled.runningInterrupted, 'Backend-owned running render was not interrupted')
  assert(fake.interrupted, 'Fake ComfyUI did not receive interrupt')
  await sleep(550)

  const afterCancel = filesUnder(config.imagesDir).map(file => ({
    file,
    bytes: fs.readFileSync(file).toString('hex'),
  }))
  assert(
    JSON.stringify(afterCancel) === JSON.stringify(beforeCancel),
    'Cancelling an active batch render changed previously completed art',
  )

  jobs.stop()
  console.log('Runtime integration smoke test passed')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
