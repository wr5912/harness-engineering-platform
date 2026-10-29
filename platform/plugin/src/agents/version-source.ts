import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'

export const VERSION_ID = /^EXP-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{3}(?:-r[0-9a-f]{12})?$/
type MapValue = Record<string, any>

function versionFile(root: string, path: string, commit?: string, optional = false): string | undefined {
    if (commit) {
      const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
      if (result.status === 0) return result.stdout
      if (optional) return undefined
      throw new Error(`固定提交缺少版本文件：${path}`)
    }
    let cursor = resolve(root)
    for (const part of path.split('/')) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`版本路径不能包含符号链接：${path}`)
    }
    if (optional && !existsSync(cursor)) return undefined
    if (!lstatSync(cursor).isFile() || lstatSync(cursor).size > 2 * 1024 * 1024) throw new Error(`版本文件不可读取：${path}`)
    return readFileSync(cursor, 'utf8')
}

export function versionIdentity(root: string, id: string, commit?: string): MapValue {
  const match = VERSION_ID.exec(id)
  if (!match || commit && !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('版本或固定提交格式无效')
  const change = load(versionFile(root, `evolution/experiments/${id}/change.yaml`, commit)!) as MapValue
  assertVersionIdentity(id, change)
  return change
}

export function assertVersionIdentity(id: string, change: MapValue) {
  const match = VERSION_ID.exec(id)
  if (!match || change?.agent_id !== match[1] || change.experiment_id !== id) throw new Error('change.yaml 与版本身份不一致')
}

/** 只读选定版本；固定父版的所有信息均来自同一提交。 */
export function versionSource(root: string, id: string, commit?: string): MapValue {
  const change = versionIdentity(root, id, commit)
  const base = `evolution/experiments/${id}`
  const read = (path: string, optional = false) => versionFile(root, path, commit, optional)
  const text = read(`${base}/candidate/harness.yaml`, true)
  const harness = text ? load(text) as MapValue : undefined
  let legacy: MapValue | undefined
  if (commit && !harness?.loadable_assets) {
    for (const path of ['config/sources.json', 'runtime/adapters/dsh-container/sources.json']) {
      const old = read(path, true)
      if (old) { legacy = JSON.parse(old).sources?.[id]; break }
    }
  }
  const assets = harness?.loadable_assets
  if (!assets && !legacy) throw new Error('版本缺少 candidate/harness.yaml 装载声明')
  if (assets && (assets.workspace !== 'dsh/workspace' || assets.preset_root !== 'dsh/presets' || assets.managed_root !== 'dsh/managed')) throw new Error('装载目录必须位于 Candidate 的 dsh/workspace、dsh/presets 和 dsh/managed')
  const relative = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('装载入口必须是版本内的相对路径')
    return value
  }
  const presetId = assets?.preset_id
  if (assets && (typeof presetId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetId))) throw new Error('preset_id 格式无效')
  const patch = assets ? relative(assets.profile_patch) : `dsh/managed/${relative(legacy!.patch)}`
  if (!patch.startsWith('dsh/managed/')) throw new Error('profile_patch 必须位于 dsh/managed')
  const names = harness?.credential_environment_keys ?? [...(legacy?.required_env_names ?? []), ...(legacy?.optional_env_names ?? [])]
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))) throw new Error('credential_environment_keys 必须是环境变量名称列表')
  const profile = assets?.profile_manifest ?? legacy?.profile_manifest?.replace(`${base}/candidate/`, '')
  return {
    agent_id: change.agent_id, candidate_root: `${base}/candidate/dsh`, profile: 'web',
    patch: patch.slice('dsh/managed/'.length),
    preset: assets ? relative(assets.preset_file ?? `${presetId}/agent.cordis.yml`) : relative(legacy!.preset),
    guard: assets?.guard ? relative(assets.guard) : legacy?.guard ?? null,
    config_markers: ['/opt/dsh-presets'], required_env_names: [], optional_env_names: [...new Set(names)],
    ...(profile ? { profile_manifest: `${base}/candidate/${relative(profile)}` } : {}),
  }
}

export function versionSources(root: string) {
  const directory = join(root, 'evolution/experiments')
  const sources: Record<string, MapValue> = {}, errors: Record<string, string> = {}
  if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!VERSION_ID.test(entry.name)) continue
    try { sources[entry.name] = versionSource(root, entry.name) }
    catch (error) { errors[entry.name] = (error as Error).message }
  }
  return { sources, errors }
}
