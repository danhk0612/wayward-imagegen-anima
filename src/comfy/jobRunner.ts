/**
 * The generation lifecycle: submit, poll, save, cache.
 *
 * Four pieces of bookkeeping here look redundant and are not. Each covers a
 * race that produced duplicate renders or duplicate files in practice:
 *
 *  - `pendingSubmissions` covers the window between a cache miss and the job
 *    landing in the map. Without it two concurrent identical requests both see
 *    no in-flight job and queue two ComfyUI prompts.
 *  - `finalizing` is claimed SYNCHRONOUSLY before any await in the completion
 *    path, so two poll ticks cannot both save the same output.
 *  - `latestDesiredKey` lets a newer foreground request flush older queued ones.
 *    ComfyUI cannot cheaply preempt a running sampler, but it can be stopped
 *    from working through a backlog of states the player has already left.
 *  - `bulk` marks batch work as exempt from that flush, or one click in the game
 *    would cancel hundreds of queued overnight renders.
 *
 * Jobs live in memory only. A restart loses them, which is why the server is not
 * run under a file watcher by default — a reload mid-render leaves the client
 * polling a promptId that no longer exists.
 */

import type { Config, WorkflowType } from '../config.ts'
import type { ComfyClient, ComfyOutput } from './client.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import { jobKey, sanitizeName } from '../naming.ts'
import { buildComfyPrompt, type GenOverrides } from './workflows/index.ts'
import { saveImage, saveVideo, type SavedMedia } from './media.ts'

export type JobStatus = 'queued' | 'processing' | 'completed' | 'error'

export interface GenerationJob {
  promptId: string
  talentId: string
  talentName: string
  imageType: string
  promptHash: string
  prompt: string
  /** Kept so the cache entry can record it — see CacheEntry.negativePrompt. */
  negativePrompt?: string
  /** Likewise: the hash folds these in, so an entry needs them to be checkable. */
  genParams?: GenOverrides
  workflow: WorkflowType
  status: JobStatus
  startedAt: number
  completedAt?: number
  mediaKind: 'image' | 'video'
  /** Set once saved. The client turns this into a URL; no base64 changes hands. */
  media?: SavedMedia
  error?: string
  cancelRequested?: boolean
  /** Batch work: exempt from foreground supersedence. */
  bulk?: boolean
  debug?: Record<string, unknown>
}

/** Completed jobs linger this long so a client poll can still collect them. */
const JOB_TTL_MS = 60_000

export interface SubmitArgs {
  talentId: string
  talentName: string
  imageType: string
  prompt: string
  negativePrompt: string
  workflow: WorkflowType
  promptHash: string
  seed?: number
  overrides?: GenOverrides
  referenceImagePath?: string
  bulk?: boolean
  debug?: Record<string, unknown>
}

export interface JobRunnerOptions {
  config: Config
  comfy: ComfyClient
  cache: CacheStore
  now?: () => number
}

export class JobRunner {
  private readonly jobs = new Map<string, GenerationJob>()
  private readonly finalizing = new Set<string>()
  private readonly pendingSubmissions = new Map<string, Promise<string>>()
  private latestDesiredKey: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** Completion timestamps in the current rolling hour, for the rate cap. */
  private recentCompletions: number[] = []

  private readonly config: Config
  private readonly comfy: ComfyClient
  private readonly cache: CacheStore
  private readonly now: () => number
  private readonly pollIntervalMs: number

  constructor(opts: JobRunnerOptions) {
    this.config = opts.config
    this.comfy = opts.comfy
    this.cache = opts.cache
    this.now = opts.now ?? Date.now
    this.pollIntervalMs = opts.config.pollIntervalMs
  }

  get(promptId: string): GenerationJob | undefined {
    return this.jobs.get(promptId)
  }

  /** Jobs still queued or sampling. */
  activeJobs(): GenerationJob[] {
    return [...this.jobs.values()].filter(j => isActive(j))
  }

  /** How many interactive jobs are waiting — used to refuse an overlong queue. */
  queuedCount(): number {
    return this.activeJobs().filter(j => !j.bulk).length
  }

  /** Interactive images finished in the last rolling hour, for the per-hour ceiling. */
  completionsThisHour(): number {
    const cutoff = this.now() - 3_600_000
    this.recentCompletions = this.recentCompletions.filter(t => t > cutoff)
    return this.recentCompletions.length
  }

  /**
   * Submit a render, or join one already in flight for the same state.
   *
   * The dedup key is (workflow, talentName, imageType, promptHash) — the same
   * identity the persistent cache uses, so "already rendering" and "already
   * rendered" agree on what sameness means.
   */
  async submit(args: SubmitArgs): Promise<GenerationJob> {
    const key = jobKey(args.talentName, args.imageType, args.promptHash, args.workflow)

    const inFlight = this.findActiveByKey(key)
    if (inFlight) return inFlight

    const pending = this.pendingSubmissions.get(key)
    if (pending) {
      const promptId = await pending
      const job = this.jobs.get(promptId)
      if (job) return job
    }

    // Claim the key SYNCHRONOUSLY, before any await. Everything below yields at
    // least once, and a concurrent request for the same state must join this
    // submission rather than start a second render of the same picture.
    let claimed!: (promptId: string) => void
    let failed!: (err: unknown) => void
    this.pendingSubmissions.set(key, new Promise<string>((resolve, reject) => {
      claimed = resolve
      failed = reject
    }))

    try {
      if (!args.bulk) {
        this.latestDesiredKey = key
        // Flush queued foreground work the player has already moved past —
        // BEFORE submitting. Doing it concurrently is a self-cancel: a new
        // prompt reaches ComfyUI's queue before it reaches our job map, so the
        // sweep reads it as an unrecognised prompt of ours and drops the very
        // render it was called for.
        await this.supersede(key)
      }

      const graph = buildComfyPrompt(
        this.config,
        args.prompt,
        args.negativePrompt,
        filenamePrefixFor(args.talentName, args.imageType),
        args.workflow,
        args.seed,
        args.overrides,
        args.referenceImagePath,
        args.talentName,
      )

      // Foreground work jumps the queue; batch work waits its turn.
      const promptId = await this.comfy.submit(graph, !args.bulk)

      const job: GenerationJob = {
        promptId,
        talentId: args.talentId,
        talentName: args.talentName,
        imageType: args.imageType,
        promptHash: args.promptHash,
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        genParams: args.overrides,
        workflow: args.workflow,
        status: 'queued',
        startedAt: this.now(),
        mediaKind: 'image',
        bulk: args.bulk,
        debug: args.debug,
      }
      // Registered BEFORE the claim resolves, so a joiner always finds it.
      this.jobs.set(promptId, job)
      claimed(promptId)
      return job
    } catch (err) {
      failed(err)
      throw err
    } finally {
      this.pendingSubmissions.delete(key)
    }
  }

  /** Register an externally-submitted video job so the poller finalizes it. */
  trackVideo(job: Omit<GenerationJob, 'status' | 'startedAt' | 'mediaKind'>): GenerationJob {
    const full: GenerationJob = {
      ...job,
      status: 'queued',
      startedAt: this.now(),
      mediaKind: 'video',
    }
    this.jobs.set(job.promptId, full)
    return full
  }

  /**
   * Cancel one job if ComfyUI has not started sampling it. A running job is
   * left to finish — interrupting the sampler is not cheap — and its result is
   * simply ignored.
   */
  async cancel(promptId: string): Promise<{ cancelled: boolean; running: boolean; queueState: string }> {
    const job = this.jobs.get(promptId)
    if (!job || !isActive(job)) {
      return { cancelled: false, running: false, queueState: 'missing' }
    }
    job.cancelRequested = true

    const queueState = await this.comfy.queueStateOf(promptId)
    if (queueState !== 'pending') {
      return { cancelled: false, running: queueState === 'running', queueState }
    }
    if (!await this.comfy.deletePending([promptId])) {
      return { cancelled: false, running: false, queueState }
    }

    this.markCancelled(job, 'superseded by a newer request')
    return { cancelled: true, running: false, queueState }
  }

  /** Drop queued foreground prompts other than `exceptKey`. */
  private async supersede(exceptKey: string): Promise<number> {
    const { all, ours } = await this.comfy.pendingIds()
    if (all.size === 0) return 0

    const toCancel: string[] = []
    for (const [promptId, job] of this.jobs) {
      if (!isActive(job)) continue
      if (!all.has(promptId)) continue
      if (job.bulk) continue
      if (jobKey(job.talentName, job.imageType, job.promptHash, job.workflow) === exceptKey) continue
      job.cancelRequested = true
      toCancel.push(promptId)
    }

    // Prompts we recognise as ours but have no job record for — left over from
    // a previous run of this server. Safe to drop; still never anyone else's.
    for (const promptId of ours) {
      if (toCancel.includes(promptId)) continue
      if (this.jobs.get(promptId)?.bulk) continue
      toCancel.push(promptId)
    }

    if (toCancel.length === 0) return 0
    if (!await this.comfy.deletePending(toCancel)) return 0

    for (const promptId of toCancel) {
      const job = this.jobs.get(promptId)
      if (job) this.markCancelled(job, 'superseded')
    }
    return toCancel.length
  }

  private markCancelled(job: GenerationJob, reason: string): void {
    job.cancelRequested = true
    job.status = 'error'
    job.error = reason
    job.completedAt = this.now()
  }

  private findActiveByKey(key: string): GenerationJob | null {
    for (const job of this.jobs.values()) {
      if (!isActive(job)) continue
      if (jobKey(job.talentName, job.imageType, job.promptHash, job.workflow) === key) return job
    }
    return null
  }

  private reapStale(): void {
    const cutoff = this.now() - JOB_TTL_MS
    for (const [promptId, job] of this.jobs) {
      if (job.completedAt !== undefined && job.completedAt < cutoff) {
        this.jobs.delete(promptId)
      }
    }
  }

  /** One poll pass. Exposed so a test can drive it without the timer. */
  async tick(): Promise<void> {
    this.reapStale()

    const pending = [...this.jobs.entries()].filter(
      ([promptId, job]) => isActive(job) && !this.finalizing.has(promptId),
    )
    if (pending.length === 0) return

    for (const [promptId, job] of pending) {
      // Re-check: an earlier iteration's await may have let another tick in.
      if (this.finalizing.has(promptId) || !isActive(job)) continue

      try {
        const result = await this.comfy.history(promptId)
        if (this.finalizing.has(promptId) || !isActive(job)) continue

        if (result.error) {
          job.status = 'error'
          job.error = result.error
          job.completedAt = this.now()
          continue
        }
        if (!result.done) {
          job.status = 'processing'
          continue
        }

        // Claim synchronously, before any further await, so no other path can
        // enter the save.
        this.finalizing.add(promptId)
        try {
          await this.finalize(job, result.images ?? [], result.videos ?? [], result.report)
        } finally {
          this.finalizing.delete(promptId)
        }
      } catch (err) {
        console.error(`[jobs] error polling ${promptId}:`, (err as Error).message)
      }
    }
  }

  private async finalize(
    job: GenerationJob,
    images: ComfyOutput[],
    videos: ComfyOutput[],
    report?: string,
  ): Promise<void> {
    const outputs = job.mediaKind === 'video' ? videos : images
    if (outputs.length === 0) {
      // ComfyUI said the prompt finished and handed back nothing we can save.
      // The bare fact is useless to a player, so say what ComfyUI DID report:
      // it saw the wrong media kind, or it was cancelled, or it errored, or —
      // when there is genuinely nothing — where to go and look.
      const wrongKind = job.mediaKind === 'video' ? images : videos
      const detail =
        wrongKind.length > 0
          ? `it returned ${wrongKind.length} ${job.mediaKind === 'video' ? 'still' : 'animation'}(s) instead`
          : report
            ?? 'ComfyUI listed no outputs at all — the run was cancelled, or the graph no '
              + 'longer ends in a Save Image node'
      job.status = 'error'
      job.error = `completed without a readable ${job.mediaKind} output — ${detail}`
      job.completedAt = this.now()
      console.error(`[jobs] ${job.promptId}: ${job.error}`)
      console.error(`[jobs] what ComfyUI recorded: ${this.config.comfyUrl}/history/${job.promptId}`)
      return
    }

    const bytes = await this.comfy.view(outputs[0])
    if (!bytes) {
      job.status = 'error'
      job.error = 'could not read the rendered file from ComfyUI'
      job.completedAt = this.now()
      return
    }

    if (job.mediaKind === 'video') {
      job.media = saveVideo({
        imagesDir: this.config.imagesDir,
        bytes,
        talentId: job.talentId,
        promptHash: job.promptHash,
        sourceFilename: outputs[0].filename,
        now: this.now,
      })
    } else {
      job.media = await saveImage({
        imagesDir: this.config.imagesDir,
        bytes,
        talentName: job.talentName,
        imageType: job.imageType,
        workflow: job.workflow,
        characters: this.config.characterDirs,
        webp: this.config.webp,
        now: this.now,
      })
      this.cache.add({
        talentName: job.talentName,
        imageType: job.imageType,
        promptHash: job.promptHash,
        imagePath: job.media.relativePath,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        genParams: job.genParams && {
          steps: job.genParams.steps,
          cfg: job.genParams.cfg,
          loraStrength: job.genParams.loraStrength,
          checkpoint: job.genParams.checkpoint,
        },
        workflow: job.workflow,
        debug: job.debug,
      })
    }

    job.status = 'completed'
    job.completedAt = this.now()
    // The hourly ceiling is for interactive work; a batch run must not spend it.
    if (!job.bulk) this.recentCompletions.push(job.completedAt)
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Recurring timeout rather than an interval: the next tick is scheduled only
   * after the current one finishes, so a slow poll cannot pile up re-entrant runs.
   */
  private async loop(): Promise<void> {
    if (this.stopped) return
    try {
      await this.tick()
    } catch (err) {
      console.error('[jobs] poll threw:', (err as Error).message)
    }
    if (this.stopped) return
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
  }
}

function isActive(job: GenerationJob): boolean {
  return job.status === 'queued' || job.status === 'processing'
}

/**
 * ComfyUI writes output files under this prefix. It must keep the
 * `<name>_<imageType>` shape: the cancel path identifies our own queued prompts
 * by matching it, and a change here would make us start flushing the player's
 * manual ComfyUI work instead.
 */
function filenamePrefixFor(talentName: string, imageType: string): string {
  return `${sanitizeName(talentName)}_${imageType}`
}
