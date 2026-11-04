import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../fsutil.mts'
import type { RuntimeEntry } from '../manifest.mts'
import { inspectKnowledge, type KnowledgeRoot } from './index.mts'

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

export function collectPlatformKnowledge(staging: string, cacheDir?: string): RuntimeEntry | undefined {
  const data = join(staging, 'data')
  const roots = managementKnowledgeRoots(data)
  if (!roots.length) return undefined
  const program = join(staging, 'program')
  const localSources = inspectKnowledge({ roots, mode: 'offline' }).references.flatMap(reference => {
    const url = new URL(reference.url)
    const prefix = '/wr5912/harness-engineering-platform/blob/main/'
    if (url.hostname !== 'github.com' || !url.pathname.startsWith(prefix)) return []
    const path = resolve(program, decodeURIComponent(url.pathname.slice(prefix.length)))
    return path.startsWith(program + sep) && existsSync(path) ? [{ url: reference.url, path }] : []
  })
  if (localSources.length) roots.push({ root: program, label: 'program', include: [] })
  if (cacheDir && existsSync(cacheDir)) roots.push({ root: resolve(cacheDir), label: 'prepared-knowledge', include: [] })
  const input = join(staging, '.knowledge-input.json'), output = join(staging, '.knowledge-result.json')
  writeFileSync(input, JSON.stringify({ roots, localSources, mode: 'offline', outDir: join(data, 'knowledge/offline') }))
  try {
    run(process.execPath, [fileURLToPath(new URL('./cli.mts', import.meta.url)), input, output], { timeout: 0 })
    return { path: 'data/knowledge/offline/index.json', version: '1', source: 'management-skills' }
  } finally {
    rmSync(input, { force: true }); rmSync(output, { force: true })
  }
}
