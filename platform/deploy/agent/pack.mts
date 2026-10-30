import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { collectEntries, sha256File, verifyEntries } from '../manifest.mts'
import { inspectImageArchive, verifyImageInfo } from '../image.mts'
import { safeRelative } from '../fsutil.mts'
import { inspectKnowledge, collectKnowledge } from '../knowledge/index.mts'
import { inspectAgentSnapshot, copyAgentSnapshot, assertDependencyArchitecture, dependencyEntries } from './snapshot.mts'
import { inspectAgentResources, defaultAgentResourcesDir } from './prepare.mts'
import { agentSeed } from './seed.mts'
import { agentCommand } from './process.mts'
import { stageSelectedExtensions } from './extensions.mts'
import { writeRuntimeBundle } from './runtime/index.mts'
import type { AgentPackageHooks, AgentPackageInput, AgentPackageManifest } from './types.mts'

export { defaultAgentResourcesDir } from './prepare.mts'
export { agentSeed } from './seed.mts'
export type { AgentPackageInput, AgentPackageHooks, AgentPackageManifest } from './types.mts'

const knowledgeRoots = (base: string) => ['workspace', 'presets', 'managed'].map(name => ({ root: join(base, name), label: name }))

/** 预览只公开摘要和缺口，不返回连接 Header、模型 Key 或配置种子。 */
export function previewAgentPackage(input: AgentPackageInput) {
  const normalized = { ...input, resourcesDir: input.resourcesDir ?? defaultAgentResourcesDir(input) }
  const snapshot = inspectAgentSnapshot(normalized)
  const resources = inspectAgentResources(normalized)
  const issues = [...resources.issues, ...snapshot.dependencies.filter(item => !item.ready).map(item => ({ code: 'dependencies_missing', message: `业务依赖尚未准备：${item.name}${item.reason ? `；${item.reason}` : ''}`, path: item.sourceFile ?? item.path }))]
  const knowledge = inspectKnowledge({ roots: knowledgeRoots(join(snapshot.candidate, 'dsh')), mode: input.mode })
  return {
    agentId: snapshot.agentId, experimentId: snapshot.experimentId, arch: input.arch, mode: input.mode,
    candidateSha256: snapshot.candidateSha256, dirty: snapshot.git.dirty,
    files: snapshot.files.map(file => ({ path: file.path, sha256: file.sha256 })),
    omitted: snapshot.omitted,
    dependencyPackages: snapshot.dependencies.map(({ path, kind, name, dependencies, ready, reason }) => ({ path, kind: kind ?? 'node', name, dependencies, ready, reason })),
    resourceReady: issues.length === 0, issues,
    image: resources.manifest?.image,
    knowledge,
  }
}

async function copy(source: string, target: string, hooks: AgentPackageHooks): Promise<void> {
  hooks.signal?.throwIfAborted()
  mkdirSync(dirname(target), { recursive: true })
  await agentCommand('/bin/cp', ['-a', '--no-preserve=ownership', '--', source, target], { signal: hooks.signal })
}

/** 一次生成单个固定 Agent 的敏感安装包，不复制全数据根和历史仓库。 */
export async function packAgent(input: AgentPackageInput, hooks: AgentPackageHooks = {}) {
  const resourcesDir = resolve(input.resourcesDir ?? defaultAgentResourcesDir(input))
  const normalized = { ...input, resourcesDir }
  hooks.signal?.throwIfAborted()
  hooks.onProgress?.({ stage: 'preview', message: '正在核对版本和运行资源' })
  const snapshot = inspectAgentSnapshot(normalized)
  const resources = inspectAgentResources(normalized)
  const missing = snapshot.dependencies.filter(item => !item.ready)
  if (resources.issues.length || !resources.manifest || missing.length) throw new Error([...resources.issues.map(item => item.message), ...missing.map(item => `缺少 ${item.name} 的 ${input.arch} 依赖`)].join('；'))
  const resourceManifest = resources.manifest
  const imagePath = join(resourcesDir, safeRelative(resourceManifest.image.archive))
  const image = inspectImageArchive(imagePath, resourceManifest.image.tag!)
  const imageProblems = verifyImageInfo(image, { id: resourceManifest.image.id, arch: input.arch, fingerprint: resourceManifest.image.fingerprint })
  if (imageProblems.length) throw new Error(`标准镜像校验失败：${imageProblems.join('；')}`)
  const dockerProblems = verifyEntries(join(resourcesDir, 'docker'), resourceManifest.docker.files)
  if (dockerProblems.length) throw new Error(`Docker 离线资源校验失败：${dockerProblems.join('；')}`)

  const out = resolve(input.out ?? join(input.assetRoot, '.local/artifacts/agent-deployments'))
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const name = `${input.agentId}-${snapshot.candidateSha256.slice(0, 12)}-${input.arch}-${input.mode}-${randomUUID().slice(0, 8)}`
  const stagingParent = join(out, '.staging')
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(stagingParent, 'agent-'))
  const archive = join(out, `${name}.tar.gz`), partial = archive + '.partial'
  try {
    hooks.onProgress?.({ stage: 'snapshot', message: '正在冻结所选版本的实际资产', total: snapshot.files.length })
    // 与资产一起冻结环境；后续知识下载期间不再读取源 .env。
    const supplied = agentSeed(snapshot, input.seed)
    copyAgentSnapshot(snapshot, staging, hooks.signal)
    for (const dependency of snapshot.dependencies) {
      hooks.signal?.throwIfAborted()
      if (dependency.preparedTarget && (dependency.preparedTarget.imageId !== image.id || dependency.preparedTarget.image !== resourceManifest.image.tag)) throw new Error(`业务依赖对应另一标准镜像：${dependency.name}；请重新准备`)
      const prepared = resourceManifest.dependencies.find(item => item.path === dependency.path)
      if (dependency.modulesPath?.startsWith(resourcesDir) && (!prepared || prepared.lockSha256 !== dependency.lockSha256)) throw new Error(`依赖锁已变化，请重新准备 ${dependency.name}`)
      if (prepared && dependency.modulesPath?.startsWith(resourcesDir)) {
        const problems = verifyEntries(dependency.modulesPath, prepared.files)
        if (problems.length) throw new Error(`业务依赖资源已变化：${dependency.name}`)
      }
      assertDependencyArchitecture(dependency.modulesPath!, input.arch)
      const destination = dependency.kind === 'python' ? join(staging, 'runtime', dependency.path, 'site-packages') : join(staging, 'assets', dependency.path, 'node_modules')
      await copy(dependency.modulesPath!, destination, hooks)
      if (dependency.preparedFiles && JSON.stringify(dependencyEntries(destination)) !== JSON.stringify(dependency.preparedFiles)) throw new Error(`业务依赖在导出期间变化：${dependency.name}，请重试`)
      if (prepared && dependency.modulesPath?.startsWith(resourcesDir) && verifyEntries(destination, prepared.files).length) throw new Error(`业务依赖在导出期间变化：${dependency.name}，请重试`)
    }
    hooks.onProgress?.({ stage: 'knowledge', message: input.mode === 'offline' ? '正在收集离线知识引用' : '正在核对已有本地知识' })
    const localSources = (input.knowledgeSources ?? []).map(item => {
      const file = snapshot.files.find(file => file.sourcePath === item.path || file.path === item.path)
      if (!file) throw new Error('提供的离线资料不在当前版本已冻结的资产中')
      return { url: item.url, path: join(staging, file.path) }
    })
    const knowledge = await collectKnowledge({ roots: knowledgeRoots(join(staging, 'assets')), mode: input.mode,
      outDir: join(staging, 'assets/workspace/knowledge/offline'), signal: hooks.signal,
      localSources,
      onProgress: (progress: any) => hooks.onProgress?.({ stage: 'knowledge', message: progress.message ?? '正在收集引用资料' }) })
    if (knowledge.missing.some((item: any) => item.required)) throw new Error(`运行必需的离线知识尚未补齐（${knowledge.missing.filter((item: any) => item.required).length} 项）；请提供本地资料或恢复文档访问后重试`)

    const extensions = await stageSelectedExtensions({ programRoot: input.programRoot, assetRoot: input.assetRoot, staging,
      compositions: supplied.compositions, signal: hooks.signal, onProgress: hooks.onProgress })
    const environment = supplied.environment ?? {}
    const pythonPaths = snapshot.dependencies.filter(item => item.kind === 'python').map(item => `/opt/standalone/runtime/${item.path}/site-packages`)
    if (pythonPaths.length) environment.PYTHONPATH = [...pythonPaths, ...(environment.PYTHONPATH ? [environment.PYTHONPATH] : [])].join(':')
    const seed = { ...supplied, environment: undefined, agentId: input.agentId, experimentId: input.experimentId,
      extensions: extensions.extensions,
      presetId: snapshot.source.preset_id, profilePatch: snapshot.source.patch,
      environmentKeys: Object.keys(environment), sourceDigest: snapshot.candidateSha256,
      ...(input.mode === 'offline' && knowledge.indexPath ? { offlineKnowledge: { indexPath: '/work/harness/workspace/knowledge/offline/index.json' } } : {}) }
    if (/\bsk-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(seed.modelPatch ?? []))) throw new Error('模型凭据须通过专用环境配置引用，不可写入模型 Patch 常量')
    mkdirSync(join(staging, 'config-seed'), { mode: 0o700 })
    writeFileSync(join(staging, 'config-seed/standalone.json'), JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 })
    writeFileSync(join(staging, 'config-seed/environment.llm-api-key'), JSON.stringify(environment, null, 2) + '\n', { mode: 0o600 })
    hooks.onProgress?.({ stage: 'runtime', message: '正在装配独立 DSH 运行入口' })
    await writeRuntimeBundle(staging, { programRoot: resolve(input.programRoot), imageTag: resourceManifest.image.tag!, imageId: resourceManifest.image.id,
      imageFingerprint: resourceManifest.image.fingerprint,
      arch: input.arch, agentId: input.agentId, experimentId: input.experimentId, presetId: snapshot.source.preset_id,
      profilePatch: snapshot.source.patch, bridgeRequired: Boolean((seed.mcp?.groups?.length ?? 0) || (seed.compositions as any)?.compositions?.length
        || seed.mcp?.servers?.some((server: any) => server.specUrl || server.transport === 'openapi')) })
    hooks.onProgress?.({ stage: 'image', message: '正在归档标准镜像与离线安装资源' })
    await copy(imagePath, join(staging, 'images/dsh-runtime.tar'), hooks)
    await copy(join(resourcesDir, 'docker'), join(staging, 'offline/docker'), hooks)
    writeFileSync(join(staging, '.gitignore'), 'state/\nconfig-seed/\n*.llm-api-key\n', { mode: 0o644 })
    const manifest: AgentPackageManifest = {
      schemaVersion: 1, kind: 'standalone-agent', package: { name, arch: input.arch, mode: input.mode, createdAt: new Date().toISOString(), sensitive: true },
      source: { agentId: input.agentId, experimentId: input.experimentId, candidateSha256: snapshot.candidateSha256,
        commit: snapshot.git.commit, dirty: snapshot.git.dirty,
        paths: { workspace: 'assets/workspace', presets: 'assets/presets', managed: 'assets/managed',
          profilePatch: `assets/managed/${snapshot.source.patch}`, preset: `assets/presets/${snapshot.source.preset}` },
        files: snapshot.files, omitted: snapshot.omitted },
      image: { ...resourceManifest.image, archive: 'images/dsh-runtime.tar' }, knowledge, extensions,
      files: collectEntries(staging), sensitivePaths: ['config-seed/standalone.json', 'config-seed/environment.llm-api-key'],
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    const checksumLines = [...manifest.files.filter(file => file.type === 'file').map(file => ({ path: file.path, sha256: file.sha256! })),
      { path: 'manifest.json', sha256: sha256File(join(staging, 'manifest.json')) }].map(file => {
      const escaped = /[\\\n]/.test(file.path)
      const path = file.path.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
      return `${escaped ? '\\' : ''}${file.sha256}  ${path}`
    })
    writeFileSync(join(staging, 'SHA256SUMS'), checksumLines.join('\n') + '\n', { mode: 0o600 })
    hooks.signal?.throwIfAborted()
    hooks.onProgress?.({ stage: 'archive', message: '正在生成安装包' })
    writeFileSync(partial, '', { mode: 0o600 })
    chmodSync(partial, 0o600)
    await agentCommand('tar', ['-C', staging, '-czf', partial, '.'], { signal: hooks.signal })
    const sha256 = sha256File(partial)
    hooks.signal?.throwIfAborted()
    renameSync(partial, archive)
    writeFileSync(archive + '.sha256', `${sha256}  ${name}.tar.gz\n`, { mode: 0o600 })
    hooks.onProgress?.({ stage: 'completed', message: '独立运行包已生成' })
    return { archive, size: statSync(archive).size, sha256, manifest }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(partial)) rmSync(partial)
  }
}
