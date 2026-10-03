import * as path from 'node:path'
import type { Config } from '../config.ts'
import type { BatchQueue, BatchStatus } from '../batch/queue.ts'
import type { JobRunner } from '../comfy/jobRunner.ts'
import type { ComfyClient, OwnedQueueState } from '../comfy/client.ts'

export type RuntimeState = 'running' | 'generating' | 'paused'

export interface IdleShutdownStatus {
  enabled: boolean
  minutes: number
  dueAt: number | null
  remainingSeconds: number | null
  eligible: boolean
  blockedBy: string[]
}

export interface RuntimeStatus {
  version: string
  state: RuntimeState
  startedAt: number
  lastGameRequestAt: number
  lastGameRequestAgeSeconds: number
  instance: {
    pid: number
    configPath: string
    backendRoot: string
    waywardRoot: string
  }
  batch: BatchStatus
  activeJobs: Array<{
    promptId: string
    talentName: string
    status: string
    bulk: boolean
  }>
  pendingSubmissions: number
  comfyOwnedWork: OwnedQueueState & { checkedAt: number | null }
  idleShutdown: IdleShutdownStatus
}

export interface IdleEvaluationInput {
  enabled: boolean
  minutes: number
  now: number
  lastGameRequestAt: number
  batch: BatchStatus
  activeJobs: Array<{ bulk?: boolean }>
  pendingSubmissions: number
  comfyOwnedWork: OwnedQueueState & { checkedAt?: number | null }
}

export function evaluateIdleShutdown(input: IdleEvaluationInput): IdleShutdownStatus {
  const enabled = input.enabled === true && input.minutes > 0
  const minutes = Number.isFinite(input.minutes) && input.minutes > 0 ? input.minutes : 0
  const dueAt = enabled ? input.lastGameRequestAt + minutes * 60_000 : null
  const remainingSeconds = dueAt === null
    ? null
    : Math.max(0, Math.ceil((dueAt - input.now) / 1000))

  const blockedBy: string[] = []
  const incompleteBatch = input.batch.jobId !== null && input.batch.done < input.batch.total
  const foregroundJobs = input.activeJobs.filter(job => job.bulk !== true).length

  if (foregroundJobs > 0) blockedBy.push('foreground-job')
  if (input.activeJobs.length > 0) blockedBy.push('backend-job')
  if (input.pendingSubmissions > 0) blockedBy.push('pending-submission')
  if (input.batch.running) blockedBy.push('batch-running')
  else if (incompleteBatch && input.batch.paused) blockedBy.push('batch-paused')
  else if (incompleteBatch) blockedBy.push('batch-pending')

  if (input.comfyOwnedWork.reachable === false) {
    blockedBy.push('comfy-status-unknown')
  } else if (input.comfyOwnedWork.reachable === null || input.comfyOwnedWork.checkedAt == null) {
    blockedBy.push('comfy-status-unchecked')
  } else if (input.comfyOwnedWork.pending > 0 || input.comfyOwnedWork.running > 0) {
    blockedBy.push('comfy-owned-work')
  }

  return {
    enabled,
    minutes,
    dueAt,
    remainingSeconds,
    eligible: enabled && remainingSeconds === 0 && blockedBy.length === 0,
    blockedBy,
  }
}

export interface RuntimeActivityOptions {
  version: string
  now?: () => number
  checkIntervalMs?: number
}

export class RuntimeActivity {
  private readonly startedAt: number
  private lastGameRequestAt: number
  private comfyOwnedWork: OwnedQueueState & { checkedAt: number | null } = {
    reachable: null,
    pending: 0,
    running: 0,
    checkedAt: null,
  }
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  private readonly now: () => number
  private readonly checkIntervalMs: number

  constructor(
    private readonly config: Config,
    private readonly batch: BatchQueue,
    private readonly jobs: JobRunner,
    private readonly comfy: ComfyClient,
    private readonly shutdown: () => void,
    private readonly options: RuntimeActivityOptions,
  ) {
    this.now = options.now ?? Date.now
    this.checkIntervalMs = options.checkIntervalMs ?? 5000
    this.startedAt = this.now()
    this.lastGameRequestAt = this.startedAt
  }

  markGameRequest(at = this.now()): void {
    this.lastGameRequestAt = Math.max(this.lastGameRequestAt, at)
  }

  snapshot(): RuntimeStatus {
    const now = this.now()
    const batch = this.batch.status()
    const activeJobs = this.jobs.activeJobs().map(job => ({
      promptId: job.promptId,
      talentName: job.talentName,
      status: job.status,
      bulk: job.bulk === true,
    }))
    const pendingSubmissions = this.jobs.pendingSubmissionCount()
    const idleShutdown = evaluateIdleShutdown({
      enabled: this.config.idleShutdownEnabled,
      minutes: this.config.idleShutdownMinutes,
      now,
      lastGameRequestAt: this.lastGameRequestAt,
      batch,
      activeJobs,
      pendingSubmissions,
      comfyOwnedWork: this.comfyOwnedWork,
    })
    const incompleteBatch = batch.jobId !== null && batch.done < batch.total

    let state: RuntimeState = 'running'
    if (incompleteBatch && batch.paused) {
      state = 'paused'
    } else if (
      batch.running
      || activeJobs.length > 0
      || pendingSubmissions > 0
      || this.comfyOwnedWork.pending > 0
      || this.comfyOwnedWork.running > 0
    ) {
      state = 'generating'
    }

    const backendRoot = path.dirname(this.config.configFilePath)
    return {
      version: this.options.version,
      state,
      startedAt: this.startedAt,
      lastGameRequestAt: this.lastGameRequestAt,
      lastGameRequestAgeSeconds: Math.max(0, Math.floor((now - this.lastGameRequestAt) / 1000)),
      instance: {
        pid: process.pid,
        configPath: this.config.configFilePath,
        backendRoot,
        waywardRoot: path.dirname(backendRoot),
      },
      batch,
      activeJobs,
      pendingSubmissions,
      comfyOwnedWork: { ...this.comfyOwnedWork },
      idleShutdown,
    }
  }

  async checkNow(): Promise<RuntimeStatus> {
    const owned = await this.comfy.ownedQueueState()
    this.comfyOwnedWork = {
      ...owned,
      checkedAt: this.now(),
    }
    const status = this.snapshot()
    if (status.idleShutdown.eligible) {
      console.log(
        `[idle] shutting down after ${status.idleShutdown.minutes} minute(s) without a game request`,
      )
      this.stop()
      this.shutdown()
    }
    return status
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setTimeout(() => void this.loop(), 0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return
    try {
      await this.checkNow()
    } catch (err) {
      console.warn('[idle] activity check failed:', (err as Error).message)
    }
    if (this.stopped) return
    this.timer = setTimeout(() => void this.loop(), this.checkIntervalMs)
  }
}
