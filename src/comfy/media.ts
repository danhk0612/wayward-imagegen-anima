/**
 * Writing finished renders into the art library.
 *
 * The layout is `<imagesDir>/<workflow>/characters/<character>/<descriptor>_<type>_<ts>.<ext>`,
 * which is what the shipped catalogue and the release packer both expect — it
 * is a published format, not an internal detail.
 *
 * WebP conversion is OPTIONAL here. The dev server shelled out to a Python
 * script for it; this package spawns no subprocesses, so it uses `sharp` when
 * the player happens to have it and stores PNG otherwise. Since every cache
 * entry records the extension it actually wrote, a library with both kinds
 * mixed together works fine.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkflowType } from '../config.ts'
import { extractCharacterName, buildActivityDescriptor, sanitizeName } from '../naming.ts'
import { toPosix } from '../cache/paths.ts'

export interface SavedMedia {
  /** Path relative to the images root, forward-slashed. */
  relativePath: string
  absolutePath: string
  bytes: number
  mime: string
}

/** Loaded once, lazily. `null` means "not installed" — a normal state. */
let sharpModule: unknown | null | undefined

async function loadSharp(): Promise<{ (input: string): { webp(o: typeof WEBP_OPTIONS): { toFile(p: string): Promise<unknown> } } } | null> {
  if (sharpModule !== undefined) {
    return sharpModule as never
  }
  try {
    const mod = await import('sharp')
    sharpModule = (mod as { default?: unknown }).default ?? mod
  } catch {
    sharpModule = null
  }
  return sharpModule as never
}

/** Whether WebP conversion is possible here, for the startup hint. */
export async function webpAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null
}

/**
 * The encoding every picture in the library shares. Quality 85 at the slowest,
 * tightest effort lands a render near 75 KB; quality 90 at the default effort
 * was ~105 KB for no visible gain (measured 2026-09-29).
 */
export const WEBP_OPTIONS = { quality: 85, effort: 6 } as const

/**
 * Re-encode a PNG as WebP. Anime-style renders shrink roughly fifteenfold with no
 * visible loss, which is the difference between a 3 GB art pack and a 40 GB one.
 * Returns null when sharp is absent or the conversion fails — the caller keeps
 * the PNG, which is correct, just larger.
 */
export async function convertToWebp(pngPath: string): Promise<string | null> {
  const sharp = await loadSharp()
  if (!sharp) return null
  const webpPath = pngPath.replace(/\.png$/i, '.webp')
  try {
    await sharp(pngPath).webp(WEBP_OPTIONS).toFile(webpPath)
    if (!fs.existsSync(webpPath) || fs.statSync(webpPath).size === 0) return null
    fs.unlinkSync(pngPath)
    return webpPath
  } catch (err) {
    console.warn('[media] webp conversion failed, keeping png:', (err as Error).message)
    try { if (fs.existsSync(webpPath)) fs.unlinkSync(webpPath) } catch { /* ignore */ }
    return null
  }
}

export interface SaveImageArgs {
  imagesDir: string
  bytes: Buffer
  talentName: string
  imageType: string
  workflow: WorkflowType
  characters: readonly string[]
  /** Convert to WebP when possible. Needs the optional `sharp` package. */
  webp?: boolean
  now?: () => number
}

export async function saveImage(args: SaveImageArgs): Promise<SavedMedia> {
  const now = args.now ?? Date.now

  // An unrecognised character gets its own folder rather than being filed under
  // someone else's. A wrong folder becomes a wrong image later, and the miss is
  // worth seeing.
  const character = extractCharacterName(args.talentName, args.characters) ?? 'unknown'
  const folder = path.join(args.imagesDir, args.workflow, 'characters', character)
  fs.mkdirSync(folder, { recursive: true })

  const descriptor = buildActivityDescriptor(args.talentName, args.characters)
  const stamp = now()
  const pngName = `${descriptor}_${args.imageType}_${stamp}.png`
  const pngPath = path.join(folder, pngName)
  fs.writeFileSync(pngPath, args.bytes)

  let finalPath = pngPath
  let mime = 'image/png'
  if (args.webp) {
    const converted = await convertToWebp(pngPath)
    if (converted) {
      finalPath = converted
      mime = 'image/webp'
    }
  }

  const relativePath = toPosix(path.relative(args.imagesDir, finalPath))
  return {
    relativePath,
    absolutePath: finalPath,
    bytes: fs.statSync(finalPath).size,
    mime,
  }
}

export function mimeForVideo(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.gif') return 'image/gif'
  return 'video/mp4'
}

export interface SaveVideoArgs {
  imagesDir: string
  bytes: Buffer
  talentId: string
  promptHash: string
  sourceFilename: string
  now?: () => number
}

export function saveVideo(args: SaveVideoArgs): SavedMedia {
  const now = args.now ?? Date.now
  const folder = path.join(args.imagesDir, 'videos', sanitizeName(args.talentId))
  fs.mkdirSync(folder, { recursive: true })

  const ext = path.extname(args.sourceFilename) || '.mp4'
  const name = `${args.promptHash}_${now()}${ext}`
  const full = path.join(folder, name)
  fs.writeFileSync(full, args.bytes)

  return {
    relativePath: toPosix(path.relative(args.imagesDir, full)),
    absolutePath: full,
    bytes: args.bytes.length,
    mime: mimeForVideo(name),
  }
}

/** Find an already-rendered video for this state, newest first. */
export function findCachedVideo(
  imagesDir: string,
  talentId: string,
  promptHash: string,
): SavedMedia | null {
  const folder = path.join(imagesDir, 'videos', sanitizeName(talentId))
  let names: string[]
  try {
    names = fs.readdirSync(folder)
  } catch {
    return null
  }
  const matches = names.filter(n => n.startsWith(`${promptHash}_`)).sort().reverse()
  if (matches.length === 0) return null

  const full = path.join(folder, matches[0])
  return {
    relativePath: toPosix(path.relative(imagesDir, full)),
    absolutePath: full,
    bytes: fs.statSync(full).size,
    mime: mimeForVideo(matches[0]),
  }
}
