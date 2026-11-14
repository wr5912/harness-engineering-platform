import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectEntries } from '../manifest.mts'
import { copyAgentSnapshot } from './snapshot.mts'
import type { AgentSourceSnapshot } from './types.mts'

/** 摘要涵盖完整导出 Harness，包括新增文件、权限和链接。 */
export function harnessDigest(root: string): string {
  return createHash('sha256').update(JSON.stringify(collectEntries(root))).digest('hex')
}

export function copyNativeHarness(snapshot: AgentSourceSnapshot, root: string, signal?: AbortSignal) {
  copyAgentSnapshot({ ...snapshot, files: snapshot.files.map(file => ({ ...file, path: `harness/${file.sourcePath}` })) }, root, signal)
}

/** 详细证据留在调用方指定目录或平台本地制品目录；包内 manifest 保持简短。 */
export function writeExportRecord(assetRoot: string, name: string, value: unknown, evidenceDir?: string) {
  const path = join(evidenceDir ?? join(assetRoot, '.local/artifacts/agent-deployments'), `${name}.export.json`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  return path
}

export function packageCompose(root: string) {
  return join(root, existsSync(join(root, 'config/compose.yaml')) ? 'config/compose.yaml' : 'runtime/compose.yaml')
}
