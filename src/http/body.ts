/**
 * Request body reading, with a hard byte cap.
 *
 * The cap is the point. The dev server's version concatenated chunks into a
 * string with no limit, so a single request could grow the process until it
 * died — fine behind a dev-only port, not fine on something a player runs.
 *
 * Video generation legitimately posts a base64 source image, so it gets a
 * larger cap of its own rather than raising the ceiling for everything.
 */

import type { IncomingMessage } from 'node:http'

export const JSON_BODY_LIMIT = 1024 * 1024          // 1 MB
export const VIDEO_BODY_LIMIT = 12 * 1024 * 1024    // 12 MB — a base64 PNG

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

export class MalformedBodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedBodyError'
  }
}

/** Read the raw body, aborting as soon as the cap is passed. */
export function readBody(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      // Stop consuming, but do NOT destroy the socket here. Destroying it
      // before the handler has written its response resets the connection, and
      // the caller sees ECONNRESET instead of the 413 explaining what happened.
      // The response path closes the connection once the status is on the wire.
      req.pause()
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > limit) {
        fail(new BodyTooLargeError(limit))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })

    req.on('error', fail)
  })
}

/** Read and parse a JSON body. An empty body is `{}`, not an error. */
export async function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  limit = JSON_BODY_LIMIT,
): Promise<T> {
  const raw = await readBody(req, limit)
  if (raw.length === 0) return {} as T
  try {
    return JSON.parse(raw.toString('utf-8')) as T
  } catch (err) {
    throw new MalformedBodyError((err as Error).message)
  }
}
