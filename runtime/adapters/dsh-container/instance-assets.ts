import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

type RecordValue = Record<string, any>
export interface AssetFile { path: string; sha256: string }
export type AssetFileCache = Record<string, { stat: string; sha256: string }>
export const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const ignored = /^(?:\.git|\.cache|__pycache__|sessions?|cache|attachments?|runs|evaluation\.md|(?:notes?|remarks?|备注)(?:\.md|\.txt)?)$/i

/** 只读装载闭包；不读取 HOME、会话、评测或备注。路径使用容器命名，避免宿主路径成为版本身份。 */
function filesAt(host: string, target: string, files: AssetFile[], cache?: AssetFileCache, ancestors = new Set<string>()): void {
  const actual = realpathSync(host), info = statSync(actual, { bigint: true })
  if (info.isDirectory()) {
    if (ancestors.has(actual)) return
    const parents = new Set(ancestors).add(actual)
    for (const name of readdirSync(actual).sort()) if (!ignored.test(name)) filesAt(join(actual, name), posix.join(target, name), files, cache, parents)
  } else if (info.isFile()) {
    const signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
    const cached = cache?.[actual]
    const sha256 = cached?.stat === signature && /^[a-f0-9]{64}$/.test(cached.sha256) ? cached.sha256
      : createHash('sha256').update(readFileSync(actual)).digest('hex')
    if (cache) cache[actual] = { stat: signature, sha256 }
    files.push({ path: target, sha256 })
  } else throw new Error('装载资产不是普通文件或目录')
}

function runtimeFiles(contract: RecordValue, manifest: RecordValue, projected: boolean, directory?: string, cache?: AssetFileCache): AssetFile[] {
  const files: AssetFile[] = [], mounts = manifest.mounts ?? {}
  const workspace = projected ? mounts.workspace : contract.workspace
  if (workspace) {
    for (const name of ['AGENTS.md', '.agents/skills']) {
      if (existsSync(join(workspace, name))) filesAt(join(workspace, name), `/work/harness/workspace/${name}`, files, cache)
    }
  }
  for (const [key, target] of [['presets', '/opt/dsh-presets'], ['managed', '/opt/dsh-managed']] as const) {
    const host = projected ? mounts[key] : contract[key]
    if (!host) throw new Error('实例缺少装载资产路径')
    filesAt(host, target, files, cache)
  }
  for (const mount of (projected ? manifest.asset_dependencies : contract.asset_dependencies)?.mounts ?? []) filesAt(mount.source, mount.target, files, cache)
  if (mounts.plugin_node_modules) filesAt(mounts.plugin_node_modules, '/opt/node_modules', files, cache)
  const runtime = contract.harness_runtime
  for (const file of Object.values(runtime?.role_instructions ?? {}) as string[]) {
    filesAt(join(contract.candidate_source_root, file), `/opt/harness-candidate/${file}`, files, cache)
  }
  const profile = projected ? manifest.web_profile_manifest : contract.profile_manifest
  if (profile) filesAt(profile, '/var/lib/dsh/profiles/web/package.json', files, cache)
  // 与现有 Compose 的只读适配挂载一致；不扫描整个程序仓库或业务数据目录。
  const adapter = manifest.adapter_root
  if (adapter) {
    for (const file of ['runtime-compat', 'runtime-model.patch.yml', 'instance-load-observer.ts', 'instance-assets.ts', 'instance-load.patch.yml',
      'verification-home-controls/web-base-path.patch.yml', 'verification-home-controls/locked-user.patch.yml',
      'verification-home-controls/locked-global.AGENTS.md', 'verification-home-controls/locked-bootstrap.env',
      'verification-home-controls/module-deny',
      ...(manifest.lan_access ? ['verification-home-controls/lan-listen.patch.yml'] : []),
      ...(manifest.unsafe_no_auth ? ['verification-home-controls/web-unsafe-no-auth.patch.yml'] : []),
      ...(manifest.skip_testing_notice ? ['verification-home-controls/web-skip-testing-notice.patch.yml'] : []),
      ...(manifest.web_profile_manifest !== contract.profile_manifest ? ['schedule-compat'] : [])]) {
      filesAt(join(adapter, file), `/opt/dsh-adapter/${file}`, files, cache)
    }
    if (manifest.evaluation_patch?.startsWith('/opt/dsh-adapter/')) {
      const relative = manifest.evaluation_patch.slice('/opt/dsh-adapter/'.length)
      filesAt(join(adapter, relative), manifest.evaluation_patch, files, cache)
      if (relative === 'evaluation-registry.patch.yml') for (const file of ['evaluation-wait.mts', 'evaluation-presets', 'evaluation-judge-guard.mjs', 'scenario-analysis-guard.mjs']) {
        filesAt(join(adapter, file), `/opt/dsh-adapter/${file}`, files, cache)
      }
    }
    const plugin = resolve(adapter, '../../../platform/plugin')
    if (manifest.model_policy) filesAt(join(plugin, 'lib/model-runtime.js'), '/opt/harness-model-runtime/model-runtime.mjs', files, cache)
    if (contract.harness_runtime) filesAt(join(plugin, 'lib/model-binding-runtime.js'), '/opt/harness-model-runtime/model-binding-runtime.mjs', files, cache)
    if (manifest.business_control) {
      const saved = JSON.parse(readFileSync(manifest.business_control.launch_config_file, 'utf8'))
      const business = saved.pluginRoot ?? plugin
      for (const file of ['business/package.json', 'business/runtime.js', 'lib/business-runtime.js']) filesAt(join(business, file), `/opt/harness-platform/${file}`, files, cache)
      if (directory && existsSync(join(directory, 'business.patch.yml'))
        && readFileSync(join(directory, 'business.patch.yml'), 'utf8').includes('/opt/harness-platform/business/mcp-manager.js')) {
        for (const file of ['business/mcp-manager.js', 'lib/mcp-manager.js']) filesAt(join(business, file), `/opt/harness-platform/${file}`, files, cache)
      }
    }
  }
  if (manifest.sites_config_file) filesAt(manifest.sites_config_file, '/opt/harness-config/sites.json', files, cache)
  if (manifest.web_adapter_root) for (const file of ['container-webserver.mjs', 'container-web-app.mjs']) filesAt(join(manifest.web_adapter_root, 'lib', file), `/opt/dsh-web/lib/${file}`, files, cache)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function configuration(contract: RecordValue, manifest: RecordValue) {
  const { harness_sha256: _sourceText, ...runtime } = contract.harness_runtime ?? {}
  return {
    source_id: contract.source_id ?? manifest.source_id, source_ref: manifest.source_ref ?? null,
    image: contract.image?.build_fingerprint ?? manifest.image_build_fingerprint ?? manifest.image_id,
    runtime, patch: contract.patch, preset: manifest.target_preset, mode: manifest.mode,
    port: manifest.port, model: manifest.model_policy ? {
      default: manifest.model_policy.default, resolved_model_bindings: manifest.model_policy.resolved_model_bindings,
      credential_env_names: manifest.model_policy.credential_env_names,
    } : null,
    trusted_host: manifest.trusted_host ?? null, web_base_path: manifest.web_base_path,
    business: manifest.business_control ? {
      runtime_generation: manifest.business_control.runtime_generation,
      access_mode: manifest.business_control.access_mode, identity_mode: manifest.business_control.identity_mode,
    } : null,
  }
}

function runtimeConfiguration(directory?: string, cache?: AssetFileCache): AssetFile[] {
  const files: AssetFile[] = []
  if (directory) for (const [name, target] of [['model.patch.yml', '/opt/harness-model-runtime/model.patch.yml'],
    ['business.patch.yml', '/opt/harness-business/business.patch.yml'],
    ['mcp.fixture.patch.yml', '/opt/harness-evaluation/mcp.fixture.patch.yml']] as const) {
    if (existsSync(join(directory, name))) filesAt(join(directory, name), target, files, cache)
  }
  return files
}

export function sourceAssets(contract: RecordValue, manifest: RecordValue, directory?: string, cache?: AssetFileCache) {
  if (manifest.profile === 'sdk' || manifest.mounts?.analysis_workspace) throw new Error('此实例没有可重载的 Web Harness 装载闭包')
  const files = [...runtimeFiles(contract, manifest, false, directory, cache), ...runtimeConfiguration(directory, cache)]
  return { digest: digest({ configuration: configuration(contract, manifest), files }), files, configuration_digest: digest(configuration(contract, manifest)) }
}

export function appliedFiles(contract: RecordValue, manifest: RecordValue, directory: string): AssetFile[] {
  const files = runtimeFiles(contract, manifest, true, directory)
  files.push(...runtimeConfiguration(directory))
  if (manifest.runtime_managed_patch_host) filesAt(manifest.runtime_managed_patch_host, '/opt/dsh-profile-compat/managed.patch.yml', files)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function generationDigest(manifest: RecordValue, generation: unknown): string {
  const { asset_load: _receipt, asset_reload_attempt: _attempt, ...recorded } = manifest
  return digest({ manifest: recorded, generation })
}

export function assetStatus(contract: RecordValue, manifest: RecordValue, generation: RecordValue | null, state: string, directory?: string, cache?: AssetFileCache) {
  const current = sourceAssets(contract, manifest, directory, cache), loaded = manifest.asset_load ?? null
  const verifiedGeneration = state === 'running' && generation?.running === true && loaded?.verification === 'runtime-observer'
    && loaded.ok === true && typeof loaded.loaded_at === 'string' && Number.isInteger(loaded.pid)
    && loaded.source_id === manifest.source_id && loaded.preset_id === manifest.session_preset
    && /^sha256:[a-f0-9]{64}$/.test(loaded.digest) && /^sha256:[a-f0-9]{64}$/.test(loaded.files_digest)
    && loaded.container_id === generation.id && loaded.started_at === generation.started_at
  const status = !verifiedGeneration ? 'unknown' : current.digest === loaded.digest ? 'current' : 'pending_reload'
  const changed_files: { path: string; change: 'added' | 'modified' | 'removed' }[] = []
  if (loaded?.source_files) {
    const previous = new Map<string, string>(loaded.source_files.map((file: AssetFile) => [file.path, file.sha256]))
    for (const file of current.files) {
      if (previous.get(file.path) !== file.sha256) changed_files.push({ path: file.path, change: previous.has(file.path) ? 'modified' : 'added' })
      previous.delete(file.path)
    }
    for (const path of previous.keys()) changed_files.push({ path, change: 'removed' })
    if (loaded.configuration_digest !== current.configuration_digest) changed_files.push({ path: '运行配置', change: 'modified' })
  }
  // 逐文件清单留在实例登记中用于差异核对，状态查询只传回执摘要。
  const { source_files: _sourceFiles, ...receipt } = loaded ?? {}
  return { status, checked_at: new Date().toISOString(), changed_files, current_digest: current.digest, loaded: loaded ? receipt : null, last_attempt: manifest.asset_reload_attempt ?? null,
    generation_digest: generation ? generationDigest(manifest, generation) : null,
    reason: verifiedGeneration ? status === 'current' ? '运行代次与加载回执一致' : loaded.source_files ? '资产已变化需重载，变化项相对最后实际加载回执' : '资产已变化需重载；旧回执未记录逐项清单' : '当前运行代次缺少实际加载回执，尚未核验' }
}

export function verifyFiles(files: AssetFile[]): void {
  for (const file of files) {
    if (!file.path.startsWith('/') || createHash('sha256').update(readFileSync(file.path)).digest('hex') !== file.sha256) {
      throw new Error('实际挂载内容与装载计划不一致')
    }
  }
}
