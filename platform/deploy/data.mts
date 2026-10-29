import { versionSources } from '../plugin/src/agents/version-source.ts'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { copyTree, run, safeRelative } from './fsutil.mts'

/** 依赖来自目标架构资源；不把开发机的原生模块混进跨架构包。 */
export function copyDataDependencies(root: string, assets: string): void {
  const { sources, errors } = versionSources(root)
  if (Object.keys(errors).length) throw new Error(`离线资源版本声明无效：${JSON.stringify(errors)}`)
  for (const candidate of new Set<string>(Object.values(sources).map((source: any) => safeRelative(source.candidate_root)))) {
    const managed = join(root, candidate, 'managed')
    if (!existsSync(managed)) continue
    for (const name of readdirSync(managed)) {
      const manifest = join(managed, name, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const dependencies = new Set([...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}).filter(name => !pkg.peerDependenciesMeta?.[name]?.optional)])
      if (!dependencies.size) continue
      const relative = join(candidate, 'managed', name, 'node_modules')
      const prepared = join(assets, 'data', relative)
      for (const dependency of dependencies) {
        if (!existsSync(join(prepared, safeRelative(dependency)))) throw new Error(`离线资源缺少业务插件依赖：${join(prepared, dependency)}`)
      }
      copyTree(prepared, join(root, relative))
      run('chmod', ['-R', 'a+rX', join(root, relative)])
    }
  }
}

export interface DataRootCheck {
  kind: 'workspace' | 'fixture'
  workspaceId?: string
  skills: number
  missing: string[]
}

function countSkills(root: string): number {
  const directory = join(root, '.agents', 'skills')
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return 0
  return readdirSync(directory).filter(name => existsSync(join(directory, name, 'SKILL.md'))).length
}

/** 识别数据根是否为可部署的真实工作区，而不是只够启动平台的最小夹具。 */
export function inspectDataRoot(root: string): DataRootCheck {
  const missing: string[] = []
  for (const name of ['workspace.json', 'AGENTS.md', 'agents', 'evolution', 'config']) {
    if (!existsSync(join(root, name))) missing.push(name)
  }
  const skills = countSkills(root)
  if (skills === 0) missing.push('.agents/skills/*/SKILL.md')
  let workspaceId: string | undefined
  try {
    const value = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'))
    if (typeof value?.id === 'string') workspaceId = value.id
  } catch {
    if (!missing.includes('workspace.json')) missing.push('workspace.json（无效）')
  }
  return { kind: missing.length === 0 ? 'workspace' : 'fixture', workspaceId, skills, missing }
}

export function assertRealWorkspace(root: string, allowFixture = false): DataRootCheck {
  const check = inspectDataRoot(root)
  if (check.kind !== 'workspace' && !allowFixture) {
    throw new Error(
      `数据根不是完整工作区：${root}；缺少 ${check.missing.join('、')}。` +
      '真实部署必须使用数据仓库；仅测试可显式使用 --allow-fixture-data。',
    )
  }
  return check
}
