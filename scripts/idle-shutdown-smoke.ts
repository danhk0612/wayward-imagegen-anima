import type { BatchStatus } from '../src/batch/queue.ts'
import { evaluateIdleShutdown } from '../src/runtime/activity.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function batch(overrides: Partial<BatchStatus> = {}): BatchStatus {
  return {
    jobId: null,
    running: false,
    paused: false,
    total: 0,
    done: 0,
    completed: 0,
    cached: 0,
    errored: 0,
    currentKey: null,
    startedAt: null,
    etaSeconds: null,
    lastError: null,
    ...overrides,
  }
}

const base = {
  enabled: true,
  minutes: 10,
  now: 700_000,
  lastGameRequestAt: 0,
  batch: batch(),
  activeJobs: [] as Array<{ bulk?: boolean }>,
  pendingSubmissions: 0,
  comfyOwnedWork: { reachable: true as boolean | null, pending: 0, running: 0, checkedAt: 699_000 },
}

let result = evaluateIdleShutdown(base)
assert(result.eligible, 'fully idle backend should be eligible after the timeout')

result = evaluateIdleShutdown({ ...base, enabled: false })
assert(!result.eligible && result.dueAt === null, 'idle shutdown must default safely to off')

result = evaluateIdleShutdown({
  ...base,
  activeJobs: [{ bulk: false }],
})
assert(!result.eligible && result.blockedBy.includes('foreground-job'), 'foreground work must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  batch: batch({ jobId: 'overnight', running: true, total: 100, done: 20 }),
  activeJobs: [{ bulk: true }],
})
assert(!result.eligible && result.blockedBy.includes('batch-running'), 'running batch must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  batch: batch({ jobId: 'overnight', paused: true, total: 100, done: 20 }),
})
assert(!result.eligible && result.blockedBy.includes('batch-paused'), 'paused incomplete batch must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  batch: batch({ jobId: 'queued', total: 100, done: 0 }),
})
assert(!result.eligible && result.blockedBy.includes('batch-pending'), 'queued incomplete batch must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  pendingSubmissions: 1,
})
assert(!result.eligible && result.blockedBy.includes('pending-submission'), 'submission race window must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  comfyOwnedWork: { reachable: true, pending: 1, running: 0, checkedAt: 699_000 },
})
assert(!result.eligible && result.blockedBy.includes('comfy-owned-work'), 'backend-owned ComfyUI work must block idle shutdown')

result = evaluateIdleShutdown({
  ...base,
  comfyOwnedWork: { reachable: false, pending: 0, running: 0, checkedAt: 699_000 },
})
assert(!result.eligible && result.blockedBy.includes('comfy-status-unknown'), 'unreachable ComfyUI must fail closed')

result = evaluateIdleShutdown({
  ...base,
  now: 300_000,
})
assert(!result.eligible && result.remainingSeconds === 300, 'timeout countdown should use the last game request time')

console.log('Idle shutdown smoke test passed')
