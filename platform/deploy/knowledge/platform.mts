import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../fsutil.mts'
import type { RuntimeEntry } from '../manifest.mts'
import type { KnowledgeRoot } from './index.mts'

/** 完整平台只收集冻结快照中的管理身份与已声明扩展，不另扫业务 Candidate。 */
export function managementKnowledgeRoots(dataRoot: string): KnowledgeRoot[] {
  const root = resolve(dataRoot)
  const include = ['AGENTS.md', '.agents/skills'].filter(path => existsSync(join(root, path)))
  try {
    const workspace = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'))
    for (const extension of workspace.extensions ?? []) {
      if (typeof extension.path !== 'string') continue
      const path = resolve(root, extension.path, 'skills')
      if (path.startsWith(root + sep) && existsSync(path)) include.push(path.slice(root.length + 1))
    }
  } catch { /* 真实工作区格式由既有数据根校验处理。 */ }
  return include.length ? [{ root, label: 'management', include }] : []
}

export function collectPlatformKnowledge(staging: string): RuntimeEntry | undefined {
  const data = join(staging, 'data')
  const roots = managementKnowledgeRoots(data)
  if (!roots.length) return undefined
  const input = join(staging, '.knowledge-input.json'), output = join(staging, '.knowledge-result.json')
  writeFileSync(input, JSON.stringify({ roots, mode: 'offline', outDir: join(data, 'knowledge/offline') }))
  try {
    run(process.execPath, [fileURLToPath(new URL('./cli.mts', import.meta.url)), input, output], { timeout: 0 })
    return { path: 'data/knowledge/offline/index.json', version: '1', source: 'management-skills' }
  } finally {
    rmSync(input, { force: true }); rmSync(output, { force: true })
  }
}
