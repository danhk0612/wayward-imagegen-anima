import * as http from 'node:http'

const configIndex = process.argv.indexOf('--config')
if (configIndex < 0 || !process.argv[configIndex + 1]) {
  throw new Error('usage: bun scripts/legacy-backend-stub.ts --config <path>')
}
const configPath = process.argv[configIndex + 1]

const batch = {
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
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.method === 'GET' && pathname === '/api/pack') {
    res.end(JSON.stringify({ ok: true, legacy: true }))
    return
  }
  if (req.method === 'GET' && pathname === '/api/control/status') {
    // Pre-runtime-status shape: enough for game/server control, but there is
    // intentionally no instance/configPath field.
    res.end(JSON.stringify({ batch, activeJobs: [] }))
    return
  }
  if (req.method === 'GET' && pathname === '/api/setup/settings') {
    res.end(JSON.stringify({ configPath, settings: {} }))
    return
  }
  if (req.method === 'POST' && pathname === '/api/control/shutdown') {
    res.end(JSON.stringify({ ok: true }))
    setTimeout(() => server.close(), 25)
    return
  }

  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(8189, '127.0.0.1', () => {
  console.log(`legacy backend stub ready: ${configPath}`)
})
