import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { startServer, type ServerHandle } from '../src/server.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object', 'Mock ComfyUI did not bind')
  return address.port
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wayward-http-lifecycle-'))
let backend: ServerHandle | null = null

let holdNewPrompts = false
let interrupted = false
let sequence = 0
const prompts = new Map<string, { graph: Record<string, unknown>; completed: boolean }>()

const comfyServer = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'POST' && url.pathname === '/prompt') {
      const body = await readBody(req)
      const id = `http-fake-${++sequence}`
      prompts.set(id, {
        graph: body.prompt ?? {},
        completed: !holdNewPrompts,
      })
      json(res, 200, { prompt_id: id, node_errors: {} })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length))
      const item = prompts.get(id)
      if (!item) {
        json(res, 200, {})
        return
      }
      if (!item.completed) {
        json(res, 200, {
          [id]: {
            status: { completed: false, status_str: 'running', messages: [] },
            outputs: {},
          },
        })
        return
      }
      json(res, 200, {
        [id]: {
          status: { completed: true, status_str: 'success', messages: [] },
          outputs: {
            output: {
              images: [{
                filename: `${id}.png`,
                subfolder: '',
                type: 'output',
              }],
            },
          },
        },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/view') {
      const bytes = Buffer.from('http-fake-png')
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', bytes.length)
      res.end(bytes)
      return
    }

    if (req.method === 'GET' && url.pathname === '/queue') {
      const running = [...prompts.entries()]
        .filter(([, item]) => !item.completed)
        .map(([id, item], index) => [index + 1, id, item.graph, {}, []])
      json(res, 200, {
        queue_running: running,
        queue_pending: [],
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/queue') {
      const body = await readBody(req)
      for (const id of Array.isArray(body.delete) ? body.delete : []) prompts.delete(String(id))
      json(res, 200, {})
      return
    }

    if (req.method === 'POST' && url.pathname === '/interrupt') {
      interrupted = true
      for (const item of prompts.values()) {
        if (!item.completed) item.completed = true
      }
      json(res, 200, {})
      return
    }

    json(res, 404, { error: 'mock route not found' })
  })().catch(err => {
    json(res, 500, { error: (err as Error).message })
  })
})

try {
  const comfyPort = await listen(comfyServer)
  fs.writeFileSync(path.join(tmp, 'wayward-imagegen.config.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 0,
    comfyUrl: `http://127.0.0.1:${comfyPort}`,
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
  backend = await startServer(config)
  const base = `http://127.0.0.1:${backend.port}`

  // Complete one real HTTP on-demand request first so shutdown preservation
  // checks an actual saved/cache-backed image, not a hand-made fixture.
  const generatedRes = await fetch(`${base}/api/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      talentName: 'test__scene-direct',
      talentId: 'test__scene-direct',
      imageType: 'portrait',
      workflow: 'illustrious',
      prompt: 'masterpiece, best quality, 1girl, old_identity, tavern, standing',
      negativePrompt: '',
    }),
  })
  assert(generatedRes.ok, `On-demand HTTP generate failed: ${generatedRes.status}`)
  const generated = await generatedRes.json() as { promptId: string }

  let completed: any = null
  const directDeadline = Date.now() + 4000
  while (Date.now() < directDeadline) {
    const statusRes = await fetch(`${base}/api/image/status/${encodeURIComponent(generated.promptId)}`)
    const status = await statusRes.json() as any
    if (status.status === 'completed') {
      completed = status
      break
    }
    await sleep(30)
  }
  assert(completed?.imagePath, 'On-demand HTTP image never completed')

  const savedPath = path.join(config.imagesDir, completed.imagePath)
  assert(fs.existsSync(savedPath), 'Completed on-demand image is missing from disk')
  const beforeBytes = fs.readFileSync(savedPath).toString('hex')

  // Hold the next ComfyUI prompt in the running queue, then exercise the exact
  // HTTP control/shutdown route used by the setup UI.
  holdNewPrompts = true
  const batchRes = await fetch(`${base}/api/batch/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: 'http-shutdown-active',
      items: [{
        talentId: 'test__scene-running',
        imageType: 'portrait',
        workflow: 'illustrious',
        prompt: 'masterpiece, best quality, 1girl, old_identity, garden, running',
      }],
    }),
  })
  assert(batchRes.ok, `Batch enqueue failed: ${batchRes.status}`)

  const activeDeadline = Date.now() + 4000
  let sawActive = false
  while (Date.now() < activeDeadline) {
    const statusRes = await fetch(`${base}/api/control/status`)
    const status = await statusRes.json() as any
    if (status.batch?.running && Array.isArray(status.activeJobs) && status.activeJobs.length > 0) {
      sawActive = true
      break
    }
    await sleep(30)
  }
  assert(sawActive, 'Active batch render was never visible through control status')

  const shutdownRes = await fetch(`${base}/api/control/shutdown`, { method: 'POST' })
  assert(shutdownRes.ok, `Shutdown endpoint failed: ${shutdownRes.status}`)
  const shutdown = await shutdownRes.json() as any
  assert(shutdown.runningInterrupted === true, 'Shutdown did not interrupt the backend-owned running ComfyUI prompt')
  assert(interrupted, 'Mock ComfyUI did not receive /interrupt during shutdown')

  const closeDeadline = Date.now() + 4000
  let closed = false
  while (Date.now() < closeDeadline) {
    try {
      await fetch(`${base}/api/pack`)
    } catch {
      closed = true
      break
    }
    await sleep(40)
  }
  assert(closed, 'HTTP shutdown did not close the backend listener')

  assert(fs.existsSync(savedPath), 'Shutdown removed a previously completed image')
  assert(fs.readFileSync(savedPath).toString('hex') === beforeBytes, 'Shutdown modified a previously completed image')

  backend = null
  console.log('HTTP lifecycle smoke test passed')
} finally {
  if (backend) await backend.close()
  await closeServer(comfyServer)
  fs.rmSync(tmp, { recursive: true, force: true })
}
