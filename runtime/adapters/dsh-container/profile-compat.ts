import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const legacyBundle = '@deepseek-ai/dsh-experimental-schedule-bundle'

/** 仅转换已退役的官方 Schedule bundle；固定 Candidate 始终保持原字节。 */
export function projectProfile(source: string, target: string): string {
  const original = readFileSync(source)
  const manifest = JSON.parse(original.toString('utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(legacyBundle)) return source
  if (bundles.filter((entry: unknown) => entry === legacyBundle).length !== 1) {
    throw new Error('Legacy Schedule bundle must occur exactly once')
  }
  manifest.dsh.profile.bundles = bundles.filter((entry: string) => entry !== legacyBundle)
  const projected = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) chmodSync(target, 0o644)
  writeFileSync(target, projected, { mode: 0o444 })
  chmodSync(target, 0o444)
  const digest = (value: Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`
  const origin = join(dirname(target), 'origin.json')
  if (existsSync(origin)) chmodSync(origin, 0o644)
  writeFileSync(origin, `${JSON.stringify({
    source, source_sha256: digest(original), projected_sha256: digest(projected),
    rule: 'experimental-schedule-to-native-v1',
    note: 'Generated runtime projection; edit the original Candidate, not this file.',
  }, null, 2)}\n`, { mode: 0o444 })
  return target
}

/** 旧前台委派的配置正文保持原字节，只替换已退役模块的运行入口。 */
export function projectManagedPatch(source: string, target: string): string {
  const original = readFileSync(source)
  const text = original.toString('utf8')
  if (!/\b(?:persona|toolFilter):/.test(text)) return source
  const projected = text.replace(/^([ \t]*name:[ \t]*)(['"]?)@deepseek-ai\/dsh-tool-subagent\2[ \t]*$/gm,
    '$1/opt/dsh-adapter/schedule-compat/delegate.ts')
  if (projected === text) return source
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) chmodSync(target, 0o644)
  writeFileSync(target, projected, { mode: 0o444 })
  chmodSync(target, 0o444)
  const digest = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
  const origin = join(dirname(target), 'managed-origin.json')
  if (existsSync(origin)) chmodSync(origin, 0o644)
  writeFileSync(origin, `${JSON.stringify({ source, source_sha256: digest(original),
    projected_sha256: digest(projected), rule: 'foreground-delegate-to-native-preset-v1' }, null, 2)}\n`)
  chmodSync(origin, 0o444)
  return target
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(process.argv[2] === '--managed'
    ? projectManagedPatch(process.argv[3], process.argv[4])
    : projectProfile(process.argv[2], process.argv[3]))
}
