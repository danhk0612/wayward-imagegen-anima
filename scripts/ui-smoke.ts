import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const uiDir = path.resolve(process.cwd(), 'ui')
for (const file of ['index.html', 'setup.html']) {
  const full = path.join(uiDir, file)
  const html = fs.readFileSync(full, 'utf8')
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
  assert(scripts.length > 0, `${file}: no inline script found`)

  for (const [index, script] of scripts.entries()) {
    try {
      // Parse only; do not execute browser code in the CI runtime.
      new Function(script)
    } catch (err) {
      throw new Error(`${file}: inline script #${index + 1} does not parse: ${(err as Error).message}`)
    }
  }
}

const setup = fs.readFileSync(path.join(uiDir, 'setup.html'), 'utf8')
for (const id of [
  'comfyUrl',
  'profiles',
  'validateSetup',
  'renderTest',
  'testCharacter',
  'globalLoras',
  'addGlobalLora',
  'exportSettings',
  'importSettings',
  'configBackup',
  'restoreBackup',
  'pauseBatch',
  'resumeBatch',
  'cancelActive',
  'shutdown',
]) {
  assert(setup.includes(`id="${id}"`), `setup.html: missing required control #${id}`)
}

console.log('UI smoke test passed')
