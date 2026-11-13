import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../fsutil.mts'
import type { RuntimeEntry } from '../manifest.mts'
import { inspectKnowledge, type KnowledgeRoot } from './index.mts'
import { managerHome } from '../../manager-home.mts'

/** 完整平台只收集冻结快照中的管理身份与已声明扩展，不另扫业务 Candidate。 */
export function managementKnowledgeRoots(dataRoot: string): KnowledgeRoot[] {
  const root = managerHome(resolve(dataRoot))
  const include = ['AGENTS.md', '.agents/skills', 'docs'].filter(path => existsSync(join(root, path)))
  return include.length ? [{ root, label: 'management', include }] : []
}

export function collectPlatformKnowledge(staging: string, cacheDir?: string): RuntimeEntry | undefined {
  const data = join(staging, 'data')
  const roots = managementKnowledgeRoots(data)
  if (!roots.length) return undefined
  const program = join(staging, 'program')
  const localSources = inspectKnowledge({ roots, mode: 'offline' }).references.flatMap(reference => {
    const url = new URL(reference.url)
    if (url.hostname !== 'github.com') return []
    for (const [repository, root] of [['harness-engineering-platform', program], ['harness-engineering-platform-data', data], ['platform-manager-dsh-home', managerHome(data)]]) {
      const prefix = `/wr5912/${repository}/blob/main/`
      if (!url.pathname.startsWith(prefix)) continue
      const path = resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)))
      return path.startsWith(resolve(root) + sep) && existsSync(path) ? [{ url: reference.url, path }] : []
    }
    return []
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
