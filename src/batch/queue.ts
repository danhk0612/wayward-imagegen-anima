/**
 * Overnight pre-generation.
 *
 * The point of this server is that a player can fill in the pictures their own
 * playthrough will ask for, which takes hours. So the queue lives HERE, not in
 * the browser: they submit a list, close the game, and come back to it done.
 *
 * State is a pair of files per job — the work and the results — so a crash, a
 * reboot, or a closed laptop resumes instead of starting over. That shape is
 * borrowed from the CLI runner that already proved it over multi-day runs.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, WorkflowType } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import { derivePromptHash } from '../naming.ts'

export interface BatchItem {
  talentId: string
  prompt: string
  negativePrompt?: string
  workflow?: WorkflowType
  imageType?: string
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  width?: number
  height?: number
  /** How often play is expected to want this. Higher goes first. */
  weight?: number
}

export type ItemOutcome = 'completed' | 'cached' | 'error'

interface ResultLine {
  talentId: string
  outcome: ItemOutcome
  at: number
  error?: string
}

export interface BatchStatus {
  jobId: string | null
  running: boolean
  paused: boolean
  total: number
  done: number
  completed: number
  cached: number
  errored: number
  currentKey: string | null
  startedAt: number | null
  /** Seconds remaining, from the observed rate. Null until enough has finished. */
  etaSeconds: number | null
  lastError: string | null
}

/**
 * Consecutive failures that mean something is broken rather than one bad item —
 * ComfyUI gone, out of disk, a wrong checkpoint name. Stopping beats burning
 * hours failing thousands of times.
 */
const CIRCUIT_BREAK_AFTER = 10

export class BatchQueue {
  private readonly dir: string
  private items: BatchItem[] = []
  private results = new Map<string, ResultLine>()
  private jobId: string | null = null
  private running = false
  private paused = false
  private currentKey: string | null = null
  private startedAt: number | null = null
  private lastError: string | null = null
  private consecutiveFailures = 0
  private stopRequested = false

  constructor(
    private readonly config: Config,
    private readonly cache: CacheStore,
    private readonly jobs: JobRunner,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(path.resolve(config.stateDir), 'batch')
  }

  private workFile(id: string): string { return path.join(this.dir, `${id}.jsonl`) }
  private resultFile(id: string): string { return path.join(this.dir, `${id}.results.jsonl`) }

  /** Pick up an unfinished job left by a previous run. */
  resume(): this {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return this
    }
    const jobs = names.filter(n => n.endsWith('.jsonl') && !n.endsWith('.results.jsonl'))
      .map(n => n.replace(/\.jsonl$/, ''))
      .sort()
    const latest = jobs[jobs.length - 1]
    if (!latest) return this

    try {
      this.items = fs.readFileSync(this.workFile(latest), 'utf-8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l) as BatchItem)
      this.jobId = latest
      this.loadResults(latest)
      const left = this.items.length - this.results.size
      if (left > 0) {
        console.log(`[batch] resuming ${latest}: ${left} of ${this.items.length} left`)
        // Paused on resume: an overnight run that restarts on its own after a
        // crash is a surprise. The operator restarts it.
        this.paused = true
      }
    } catch (err) {
      console.warn('[batch] could not resume:', (err as Error).message)
    }
    return this
  }

  private loadResults(id: string): void {
    this.results.clear()
    try {
      for (const line of fs.readFileSync(this.resultFile(id), 'utf-8').split('\n')) {
        if (!line) continue
        const parsed = JSON.parse(line) as ResultLine
        this.results.set(parsed.talentId, parsed)
      }
    } catch { /* no results yet */ }
  }

  private recordResult(line: ResultLine): void {
    this.results.set(line.talentId, line)
    if (!this.jobId) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.resultFile(this.jobId), JSON.stringify(line) + '\n')
    } catch (err) {
      console.error('[batch] could not record result:', (err as Error).message)
    }
  }

  /**
   * Accept a list of work.
   *
   * Anything already rendered is dropped here rather than queued and skipped
   * later, so the reported total is the work that will actually happen — an
   * honest number to show a progress bar against.
   */
  enqueue(items: BatchItem[], jobId?: string): { accepted: number; alreadyCached: number; jobId: string } {
    const fresh: BatchItem[] = []
    let alreadyCached = 0

    for (const item of items) {
      const workflow = item.workflow ?? 'illustrious'
      const imageType = item.imageType ?? 'portrait'
      const promptHash = derivePromptHash(item.prompt, item.negativePrompt ?? '', item)
      if (this.cache.get(item.talentId, imageType, promptHash, workflow)) {
        alreadyCached++
        continue
      }
      fresh.push(item)
    }

    // Highest demand first: an overnight run rarely finishes the whole space,
    // so what it does get through should be what play actually asks for.
    fresh.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))

    const id = jobId ?? new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    this.jobId = id
    this.items = fresh
    this.results.clear()
    this.stopRequested = false
    this.consecutiveFailures = 0
    this.lastError = null

    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.workFile(id), fresh.map(i => JSON.stringify(i)).join('\n') + '\n')
      // A stale results file from a reused id would make everything look done.
      fs.rmSync(this.resultFile(id), { force: true })
    } catch (err) {
      console.error('[batch] could not persist the queue:', (err as Error).message)
    }

    return { accepted: fresh.length, alreadyCached, jobId: id }
  }

  start(): void {
    this.paused = false
    this.stopRequested = false
    if (this.running) return
    void this.run()
  }

  pause(): void { this.paused = true }

  clear(): void {
    this.stopRequested = true
    this.paused = true
    this.items = []
    this.results.clear()
    this.currentKey = null
    if (this.jobId) {
      try {
        fs.rmSync(this.workFile(this.jobId), { force: true })
        fs.rmSync(this.resultFile(this.jobId), { force: true })
      } catch { /* best effort */ }
    }
    this.jobId = null
  }

  status(): BatchStatus {
    const outcomes = [...this.results.values()]
    const completed = outcomes.filter(r => r.outcome === 'completed').length
    const cached = outcomes.filter(r => r.outcome === 'cached').length
    const errored = outcomes.filter(r => r.outcome === 'error').length
    const done = outcomes.length

    let etaSeconds: number | null = null
    // Needs a few finished items before the rate means anything.
    if (this.running && this.startedAt !== null && done >= 3 && done < this.items.length) {
      const elapsed = (this.now() - this.startedAt) / 1000
      etaSeconds = Math.round((elapsed / done) * (this.items.length - done))
    }

    return {
      jobId: this.jobId,
      running: this.running,
      paused: this.paused,
      total: this.items.length,
      done,
      completed,
      cached,
      errored,
      currentKey: this.currentKey,
      startedAt: this.startedAt,
      etaSeconds,
      lastError: this.lastError,
    }
  }

  private async run(): Promise<void> {
    this.running = true
    this.startedAt = this.now()
    try {
      for (const item of this.items) {
        if (this.stopRequested || this.paused) break
        if (this.results.has(item.talentId)) continue

        this.currentKey = item.talentId
        try {
          const outcome = await this.renderOne(item)
          this.recordResult({ talentId: item.talentId, outcome, at: this.now() })
          this.consecutiveFailures = 0
        } catch (err) {
          const message = (err as Error).message
          this.lastError = message
          this.recordResult({ talentId: item.talentId, outcome: 'error', at: this.now(), error: message })
          this.consecutiveFailures++
          if (this.consecutiveFailures >= CIRCUIT_BREAK_AFTER) {
            // Something is broken, not just this item. Stopping beats spending
            // the night failing thousands of times.
            this.paused = true
            this.lastError = `stopped after ${CIRCUIT_BREAK_AFTER} failures in a row: ${message}`
            console.error(`[batch] ${this.lastError}`)
            break
          }
        }
      }
    } finally {
      this.running = false
      this.currentKey = null
    }
  }

  private async renderOne(item: BatchItem): Promise<ItemOutcome> {
    const workflow = item.workflow ?? 'illustrious'
    const imageType = item.imageType ?? 'portrait'
    const promptHash = derivePromptHash(item.prompt, item.negativePrompt ?? '', item)

    if (this.cache.get(item.talentId, imageType, promptHash, workflow)) return 'cached'

    const job = await this.jobs.submit({
      talentId: item.talentId,
      talentName: item.talentId,
      imageType,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt ?? '',
      workflow,
      promptHash,
      overrides: {
        steps: item.steps,
        cfg: item.cfg,
        loraStrength: item.loraStrength,
        checkpoint: item.checkpoint,
      },
      // Always bulk: this must not cancel — or be cancelled by — whatever the
      // player is looking at, and it must not trip the interactive rate caps.
      bulk: true,
    })

    // Wait for the poller to finish it. A render takes tens of seconds, so this
    // is deliberately unhurried.
    const deadline = this.now() + 15 * 60_000
    while (this.now() < deadline) {
      if (this.stopRequested) throw new Error('cancelled')
      const current = this.jobs.get(job.promptId)
      if (!current) break  // reaped after completing
      if (current.status === 'completed') return 'completed'
      if (current.status === 'error') throw new Error(current.error ?? 'render failed')
      await new Promise(r => setTimeout(r, 500))
    }

    // The job may have completed and been reaped while we waited.
    if (this.cache.get(item.talentId, imageType, promptHash, workflow)) return 'completed'
    throw new Error('timed out waiting for the render')
  }
}
