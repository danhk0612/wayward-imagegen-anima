#!/usr/bin/env bun
/**
 * Command-line entry point.
 *
 * Run it with bun and it works from source — no build step — which is what
 * makes "readable TypeScript you can change" true rather than a slogan.
 */

import { resolveConfig, boundBeyondLoopback, DEFAULT_PORT } from './config.ts'
import { runDoctor } from './doctor.ts'
import { startServer, VERSION } from './server.ts'
import { webpAvailable } from './comfy/media.ts'

const HELP = `wayward-imagegen ${VERSION}

Generates Wayward's character art locally, against your own ComfyUI.
Start it, then set the game's image server to Auto.

Usage: wayward-imagegen [options]
       wayward-imagegen doctor [options]

  doctor                  Check ComfyUI end to end and say what is wrong:
                          is it reachable, are the custom nodes installed, can
                          it see the checkpoint and LoRA, and does one test
                          render actually come back. Prints a report to paste
                          into a bug report.

  --port <n>              Port to listen on (default ${DEFAULT_PORT})
  --host <addr>           Interface to bind (default 127.0.0.1, this machine only;
                          0.0.0.0 lets a phone on your network play)
  --images-dir <path>     Where art is stored (default ./images)
  --state-dir <path>      Where counters and logs go (default <images-dir>/.state)
  --comfy-url <url>       ComfyUI base URL (default http://127.0.0.1:8188)
  --wan-workflow <path>   Wan i2v workflow JSON, to enable video

  --checkpoint <file>     Illustrious checkpoint (or per-request model override)
  --image-preset <name>   Image preset: illustrious | anima
  --anima-model <file>    Anima diffusion model (default anima-base-v1.0.safetensors)
  --anima-text-encoder <file>
                          Anima text encoder (default qwen_3_06b_base.safetensors)
  --anima-vae <file>      Anima VAE (default qwen_image_vae.safetensors)
  --anima-dimensions <txt> Optional fixed native Anima size, e.g. "1152 x 768";
                          empty means use Wayward's requested dimensions
  --lora <file>           Optional speed LoRA ('' to disable)
  --lora-strength <n>     Speed LoRA weight
  --character-loras <json>
                          JSON array of global character/style LoRAs.
  --character-profiles <json>
                          JSON object keyed by Wayward character name. Usually
                          easier to keep this in the config file.
  --positive-prefix <txt> --positive-suffix <txt>
  --negative-prefix <txt> --negative-suffix <txt>
  --steps <n>  --cfg <n>  Sampler settings
  --sampler <name>  --scheduler <name>  --clip-skip <n>

  --allow-origin <list>   Extra origins allowed to call the API.
                          Loopback and file:// pages are always allowed; pages
                          on your own network are too when --host is 0.0.0.0.
  --allow-delete          Permit DELETE /api/image/delete (off by default)
  --max-disk-gb <n>       Refuse new renders past this library size
  --max-queued <n>        Cap on waiting interactive requests
  --max-images-per-hour <n>
  --concurrency <n>

  --no-webp               Keep renders as PNG instead of converting to WebP
  --require-webp          Refuse to start if WebP conversion is unavailable
  --parent-pid <pid>      Exit when that process is gone (see below)
  --config <file>         JSON config (default ./wayward-imagegen.config.json)
  --verbose               Log every request
  --help                  This text

Settings may also come from the environment (COMFYUI_URL, COMFYUI_CHECKPOINT,
WAYWARD_PORT, ...). Flags win, then environment, then the config file.
`

const HEARTBEAT_TIMEOUT_MS = 8000

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    return
  }

  const config = resolveConfig(argv.filter(a => a !== 'doctor'))

  if (argv[0] === 'doctor') {
    process.exitCode = await runDoctor(config)
    return
  }

  if (config.webp && config.requireWebp && !await webpAvailable()) {
    console.error(
      `\n"sharp" will not load, so renders would be stored as PNG.`
      + ` Install it (pnpm add -D sharp) or drop --require-webp.\n`,
    )
    process.exitCode = 1
    return
  }

  let handle
  try {
    handle = await startServer(config)
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`)
    process.exitCode = 1
    return
  }

  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host
  console.log(`wayward-imagegen ${VERSION}`)
  console.log(`  listening   http://${shown}:${handle.port}`)
  console.log(`  comfyui     ${config.comfyUrl}`)
  console.log(`  images      ${config.imagesDir}  (${handle.cache.size} cached)`)
  console.log(`  review UI   http://${shown}:${handle.port}/`)
  console.log(`  setup UI    http://${shown}:${handle.port}/setup.html`)
  if (config.webp && !await webpAvailable()) {
    console.log(
      `  note        install "sharp" to store WebP instead of PNG`
      + ` — around 8x smaller for no visible loss`,
    )
  }

  if (boundBeyondLoopback(config.host)) {
    console.warn(
      `\n  WARNING: bound to ${config.host}, so anything that can reach this machine\n`
      + `  can drive your GPU and read your art library. Use 127.0.0.1 unless you\n`
      + `  specifically want other devices to connect.\n`,
    )
  }

  if (!await handle.comfy.isReachable()) {
    console.warn(
      `\n  ComfyUI is not answering at ${config.comfyUrl}.\n`
      + `  The game will still run and show whatever art you already have;\n`
      + `  start ComfyUI (or pass --comfy-url) to generate new images.\n`,
    )
  }

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    console.log(`\n${signal} — shutting down`)
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  if (config.parentPid !== null) {
    const parent = config.parentPid
    let lastBeat = Date.now()
    let sawBeat = false

    process.stdin.on('data', () => { lastBeat = Date.now(); sawBeat = true })
    process.stdin.on('end', () => shutdown('parent closed stdin'))
    process.stdin.resume()

    const watchdog = setInterval(() => {
      if (sawBeat && Date.now() - lastBeat > HEARTBEAT_TIMEOUT_MS) {
        shutdown('parent stopped responding')
        return
      }
      try {
        process.kill(parent, 0)
      } catch {
        shutdown(`parent ${parent} is gone`)
      }
    }, 2000)
    watchdog.unref()
  }
}

void main()
