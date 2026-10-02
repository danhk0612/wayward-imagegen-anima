/**
 * The ComfyUI HTTP client.
 *
 * Everything that speaks to ComfyUI lives here. Two things make it more than a
 * thin fetch wrapper:
 *
 *  - ComfyUI's `/queue` returns entries in two different shapes depending on
 *    version (a positional array, or an object). Both are handled, because
 *    guessing wrong means the cancel path silently no-ops.
 *  - Cancelling has to distinguish OUR queued prompts from the user's own. A
 *    player may well have ComfyUI open in another tab; flushing their manual
 *    work because the game changed scene would be inexcusable.
 *
 * Every method fails soft. ComfyUI being down, restarted, or mid-model-load is
 * a normal condition, not an error worth propagating to a player looking at a
 * portrait.
 */

import * as path from 'node:path'

export interface ComfyOutput {
  filename: string
  subfolder: string
  type: string
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown }
  outputs?: Record<string, {
    images?: ComfyOutput[]
    videos?: ComfyOutput[]
    gifs?: ComfyOutput[]
    animated?: boolean[]
  }>
}

interface QueueEntryObject {
  prompt?: unknown[]
  prompt_id?: string
}

type QueueEntry = QueueEntryObject | unknown[]

interface QueueResponse {
  queue_running?: QueueEntry[]
  queue_pending?: QueueEntry[]
}

export type QueueState = 'running' | 'pending' | 'missing' | 'unknown'

/** One node class as `/object_info` describes it. */
export interface ObjectInfoEntry {
  output_node?: boolean
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
}

/**
 * The choices a node offers for one input — ComfyUI states an enum input as a
 * list-of-lists whose first element is the options. This is how a checkpoint or
 * LoRA filename is checked against what ComfyUI can actually see.
 */
export function inputChoices(entry: ObjectInfoEntry | undefined, name: string): string[] | null {
  const spec = entry?.input?.required?.[name] ?? entry?.input?.optional?.[name]
  if (!Array.isArray(spec) || spec.length === 0) return null
  const first = spec[0]
  if (!Array.isArray(first)) return null
  return first.filter((v): v is string => typeof v === 'string')
}

export interface HistoryResult {
  done: boolean
  error?: string
  images?: ComfyOutput[]
  videos?: ComfyOutput[]
  /**
   * ComfyUI's own account of the run, flattened to one line.
   *
   * This is the ONLY place the cause of a failed render is written down —
   * `status_str` says "error" and nothing else, while `status.messages` holds
   * the node id, the node type and the exception. Discarding it left players
   * with "Generation failed" and no next step.
   */
  report?: string
}

/** One entry of ComfyUI's `node_errors` map, as `/prompt` returns it. */
interface NodeErrorEntry {
  class_type?: string
  dependent_outputs?: unknown[]
  errors?: { type?: string; message?: string; details?: string }[]
}

export interface RefusedNodes {
  /** Human-readable, one line per refused node. */
  summary: string
  /** True when a refused node feeds an output — i.e. nothing will be rendered. */
  fatal: boolean
}

/**
 * Read the `node_errors` ComfyUI returns ALONGSIDE a successful queue.
 *
 * `/prompt` answers 200 as long as ONE output node survives validation, and
 * reports the rest here. Our graph carries a second, trivial output node
 * (`GlobalSeed //Inspire`), so a missing checkpoint or LoRA takes exactly that
 * path: Save Image is dropped, GlobalSeed survives, ComfyUI queues the prompt,
 * executes the one no-op node in about two milliseconds and reports success
 * with no outputs. Ignoring this field is what turned "your checkpoint filename
 * doesn't match" into "completed without a readable image output".
 */
export function summariseNodeErrors(nodeErrors: unknown): RefusedNodes | null {
  if (!nodeErrors || typeof nodeErrors !== 'object' || Array.isArray(nodeErrors)) return null
  const entries = Object.entries(nodeErrors as Record<string, NodeErrorEntry>)
  if (entries.length === 0) return null

  const lines: string[] = []
  let fatal = false
  for (const [nodeId, entry] of entries) {
    const at = `${entry?.class_type ?? 'node'} #${nodeId}`
    const reasons = (entry?.errors ?? []).map(e => {
      const detail = (e.details ?? '').trim()
      const short = detail.length > 200 ? `${detail.slice(0, 200)}...` : detail
      return [e.message, short].filter(Boolean).join(' — ')
    }).filter(Boolean)
    lines.push(`${at}: ${reasons.join('; ') || 'refused, with no reason given'}`)
    // A refused node that feeds an output kills that output. When ComfyUI does
    // not say either way, assume it matters: a graph we built and ComfyUI only
    // partly accepted is not one to render from quietly.
    const dependents = entry?.dependent_outputs
    if (!Array.isArray(dependents) || dependents.length > 0) fatal = true
  }
  return { summary: lines.join(' | '), fatal }
}

/**
 * Flatten ComfyUI's `status.messages` into one readable line.
 *
 * The shape is `[[kind, data], ...]`. Only the three kinds that explain a
 * disappointing result are read; `execution_start` and friends are noise.
 */
export function summariseStatusMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  const parts: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message) || typeof message[0] !== 'string') continue
    const kind = message[0]
    const data = (message[1] ?? {}) as Record<string, unknown>
    const at = [data.node_type, data.node_id].filter(Boolean).join(' #')
    if (kind === 'execution_error') {
      const type = String(data.exception_type ?? '').split('.').pop() ?? ''
      const detail = [type, data.exception_message].filter(Boolean).join(': ')
      parts.push(`${at || 'a node'} failed — ${detail || 'no exception text'}`)
    } else if (kind === 'execution_interrupted') {
      parts.push(`interrupted at ${at || 'an unknown node'}`)
    } else if (kind === 'execution_cached') {
      const nodes = Array.isArray(data.nodes) ? data.nodes.length : 0
      if (nodes > 0) parts.push(`${nodes} node(s) reused from ComfyUI's cache`)
    }
  }
  return parts.length > 0 ? parts.join('; ') : null
}

/** A rendered file that is a video rather than a still. */
export function isVideoOutput(output: ComfyOutput): boolean {
  const ext = path.extname(output.filename).toLowerCase()
  return ext === '.mp4' || ext === '.webm' || ext === '.mov' || ext === '.gif'
}

/** ComfyUI's queue entries come in two shapes; read the id out of either. */
export function queueEntryPromptId(entry: QueueEntry): string | null {
  if (Array.isArray(entry)) {
    const maybeId = entry[1]
    return typeof maybeId === 'string' ? maybeId : null
  }
  if (typeof entry.prompt_id === 'string') return entry.prompt_id
  const maybeId = entry.prompt?.[1]
  return typeof maybeId === 'string' ? maybeId : null
}

export function queueEntryWorkflow(entry: QueueEntry): Record<string, unknown> | null {
  const maybe = Array.isArray(entry) ? entry[2] : entry.prompt?.[2]
  if (!maybe || typeof maybe !== 'object' || Array.isArray(maybe)) return null
  return maybe as Record<string, unknown>
}

export function workflowSaveImagePrefix(workflow: Record<string, unknown>): string | null {
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    const typed = node as { class_type?: unknown; inputs?: { filename_prefix?: unknown } }
    if (typed.class_type !== 'SaveImage') continue
    const prefix = typed.inputs?.filename_prefix
    if (typeof prefix === 'string') return prefix
  }
  return null
}

/**
 * Is this queue entry one of ours?
 *
 * We name output files `${sanitizeName(talentName)}_${imageType}`, and the only
 * imageType the game emits is `portrait`. Matching on that keeps a cancel from
 * touching prompts the player queued by hand in ComfyUI's own UI.
 */
export function isOwnQueueEntry(entry: QueueEntry): boolean {
  const workflow = queueEntryWorkflow(entry)
  if (!workflow) return false
  const prefix = workflowSaveImagePrefix(workflow)
  if (!prefix) return false
  return /(^|_)portrait($|_v\d+$)/.test(prefix)
}

export class ComfyClient {
  constructor(private readonly baseUrl: string) {}

  /** True when ComfyUI answers. Used by the health probe. */
  async isReachable(timeoutMs = 4000): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** ComfyUI's build + hardware, or null when it does not answer. */
  async systemStats(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      return await res.json() as Record<string, unknown>
    } catch {
      return null
    }
  }

  /**
   * Every node class this ComfyUI has, and what each one accepts.
   *
   * The one authority on "is that custom node installed" and "is that
   * checkpoint filename spelled the way ComfyUI sees it" — both answers live
   * here, and both are otherwise guesswork.
   */
  async objectInfo(): Promise<Record<string, ObjectInfoEntry> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/object_info`, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) return null
      return await res.json() as Record<string, ObjectInfoEntry>
    } catch {
      return null
    }
  }

  /**
   * Queue a graph. `front: true` jumps ahead of pending bulk work — the player
   * staring at a portrait should not wait behind an overnight batch.
   */
  async submit(prompt: object, front = false): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, front }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ComfyUI error: ${res.status} - ${text}`)
    }
    const data = await res.json() as { prompt_id: string; node_errors?: unknown }

    // A 200 does NOT mean the whole graph was accepted — see summariseNodeErrors.
    const refused = summariseNodeErrors(data.node_errors)
    if (refused?.fatal) {
      throw new Error(
        'ComfyUI queued the prompt but refused part of the graph, so no image will '
        + `be rendered — ${refused.summary}`,
      )
    }
    if (refused) console.warn(`[comfy] ComfyUI refused a node we do not need: ${refused.summary}`)
    return data.prompt_id
  }

  async queue(): Promise<QueueResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/queue`)
      if (!res.ok) return null
      return await res.json() as QueueResponse
    } catch {
      return null
    }
  }

  async queueStateOf(promptId: string): Promise<QueueState> {
    const q = await this.queue()
    if (!q) return 'unknown'
    if ((q.queue_running ?? []).some(e => queueEntryPromptId(e) === promptId)) return 'running'
    if ((q.queue_pending ?? []).some(e => queueEntryPromptId(e) === promptId)) return 'pending'
    return 'missing'
  }

  /**
   * Drop prompts that have not started sampling. ComfyUI cannot cheaply preempt
   * a RUNNING sampler, so a job already in flight is left to finish and its
   * result simply ignored.
   */
  async deletePending(promptIds: string[]): Promise<boolean> {
    if (promptIds.length === 0) return true
    try {
      const res = await fetch(`${this.baseUrl}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: promptIds }),
      })
      return res.ok
    } catch {
      return false
    }
  }
  /** Running prompt ids, split into "ours" and "everything currently sampling". */
  async runningIds(): Promise<{ all: Set<string>; ours: Set<string> }> {
    const q = await this.queue()
    const all = new Set<string>()
    const ours = new Set<string>()
    if (!q) return { all, ours }
    for (const entry of q.queue_running ?? []) {
      const id = queueEntryPromptId(entry)
      if (!id) continue
      all.add(id)
      if (isOwnQueueEntry(entry)) ours.add(id)
    }
    return { all, ours }
  }

  /**
   * Interrupt ComfyUI's current sampling. /interrupt affects running work
   * globally, so callers must first prove every running prompt belongs to us.
   */
  async interrupt(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/interrupt`, { method: 'POST' })
      return res.ok
    } catch {
      return false
    }
  }



  /** Pending prompt ids, split into "ours" and "everything queued". */
  async pendingIds(): Promise<{ all: Set<string>; ours: Set<string> }> {
    const q = await this.queue()
    const all = new Set<string>()
    const ours = new Set<string>()
    if (!q) return { all, ours }
    for (const entry of q.queue_pending ?? []) {
      const id = queueEntryPromptId(entry)
      if (!id) continue
      all.add(id)
      if (isOwnQueueEntry(entry)) ours.add(id)
    }
    return { all, ours }
  }

  /**
   * Has this prompt finished, and what did it produce?
   *
   * `done: false` covers "not finished", "unknown id", and "ComfyUI is
   * unreachable" alike — the caller polls, so an indistinguishable
   * not-yet-ready is the right answer for all three.
   */
  async history(promptId: string): Promise<HistoryResult> {
    try {
      const res = await fetch(`${this.baseUrl}/history/${promptId}`)
      if (!res.ok) return { done: false }

      const history = await res.json() as Record<string, HistoryEntry>
      const entry = history[promptId]
      if (!entry) return { done: false }

      const report = summariseStatusMessages(entry.status?.messages) ?? undefined
      if (entry.status?.status_str === 'error') {
        return {
          done: true,
          error: report ?? 'ComfyUI reported the render failed and gave no reason',
          report,
        }
      }
      if (!entry.status?.completed) return { done: false }

      const images: ComfyOutput[] = []
      const videos: ComfyOutput[] = []
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        for (const output of nodeOutput.images ?? []) {
          // A node can emit an animation under `images`; sort by extension
          // rather than by which key it arrived in.
          if (isVideoOutput(output)) videos.push(output)
          else images.push(output)
        }
        if (nodeOutput.videos) videos.push(...nodeOutput.videos)
        if (nodeOutput.gifs) videos.push(...nodeOutput.gifs)
      }
      return { done: true, images, videos, report }
    } catch {
      return { done: false }
    }
  }

  /** Fetch a rendered file's bytes from ComfyUI's `/view`. */
  async view(output: ComfyOutput): Promise<Buffer | null> {
    try {
      const url = new URL(`${this.baseUrl}/view`)
      url.searchParams.set('filename', output.filename)
      url.searchParams.set('subfolder', output.subfolder ?? '')
      url.searchParams.set('type', output.type ?? 'output')
      const res = await fetch(url)
      if (!res.ok) return null
      return Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /** Upload a source image (for image-to-video). Returns ComfyUI's name for it. */
  async upload(bytes: Buffer, filename: string): Promise<string | null> {
    try {
      const form = new FormData()
      form.append('image', new Blob([new Uint8Array(bytes)]), filename)
      form.append('overwrite', 'true')
      const res = await fetch(`${this.baseUrl}/upload/image`, { method: 'POST', body: form })
      if (!res.ok) return null
      const data = await res.json() as { name?: string; subfolder?: string }
      if (!data.name) return null
      return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
    } catch {
      return null
    }
  }
}
