import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entries = JSON.parse(readFileSync(new URL('./entries.json', import.meta.url), 'utf8')) as Record<string, string>
export function extensionEntry(id: string) {
  const root = process.env.HARNESS_PROGRAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '../..')
  return join(root, entries[id] ?? `platform/extensions/${id}/build.mjs`)
}
