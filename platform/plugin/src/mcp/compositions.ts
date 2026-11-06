import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ThreatBindings, ThreatStage } from './extension.ts'
import { compositionQueries } from './definition.ts'
export type { ThreatBindings, ThreatStage } from './extension.ts'

export type CompositionStep = { id: string; compositionId: string; versionId: string; inputMap: Record<string, unknown>; when?: 'always' | 'five_source' | 'claimed' | 'completed' }
export type CompositionConfig = {
  toolName: string; title: string; description: string; connectionId: string; flow?: 'soc-asset-alerts'; alertsConnectionId?: string
  kind?: 'threat-stage' | 'composite' | 'workflow'; stage?: ThreatStage; bindings?: ThreatBindings; steps?: CompositionStep[]
  workflow?: string; connections?: Record<string, string>; options?: Record<string, any>
  implementation?: string
  engine?: 'lfx'; flowDigest?: string
}
export type CompositionVersion = { versionId: string; publishedAt?: string; implementationDigest?: string; config: CompositionConfig }
export type CompositionEntry = { id: string; draft?: CompositionConfig; published?: CompositionConfig & { publishedAt?: string }; versions?: CompositionVersion[]; publishedVersionId?: string }
export type Catalog = { schema_version: '1.0'; compositions: CompositionEntry[] }

export const COMPOSITION_SERVICE_ID = 'platform-compositions'
export function publishedCompositionService(catalog: Catalog, available: Catalog = catalog) {
  // 已保存分组引用服务身份；扩展装载前可暂时没有可调用工具，不能让服务 ID 消失。
  const publishedTools = [...available.compositions.flatMap(entry => entry.published ? [entry.published] : []), ...compositionQueries]
  return { id: COMPOSITION_SERVICE_ID, serverName: 'compositions', description: '工具组合编排（已发布）',
    enabled: true, platformComposition: true, publishedTools,
    tools: { mode: 'all', names: publishedTools.map(tool => tool.toolName) } }
}

export function compositionConfig(value: any): CompositionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编排配置无效')
  const { toolName, title, description, flow, alertsConnectionId, kind, stage } = value
  const connectionId = value.connectionId ?? (kind ? COMPOSITION_SERVICE_ID : undefined)
  if (typeof toolName !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(toolName)) throw new Error('工具名称须为 1–64 位字母、数字、点、横线或下划线')
  if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('编排标题须为 1–80 个字符')
  if (typeof description !== 'string' || description.length > 500) throw new Error('工具说明须不超过 500 个字符')
  if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) throw new Error('请选择 OpenAPI 服务器')
  if (kind !== undefined && !['threat-stage', 'composite', 'workflow'].includes(kind)) throw new Error('组合类型无效')
  const workflow = value.workflow
  if (workflow !== undefined && (typeof workflow !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(workflow) || !['workflow', 'composite'].includes(kind))) throw new Error('工作流标识无效')
  if (kind === 'workflow' && !workflow) throw new Error('请选择已登记工作流')
  if (value.connections !== undefined && (!value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections) || Object.values(value.connections).some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)))) throw new Error('工作流连接绑定无效')
  if (value.options !== undefined && (!value.options || typeof value.options !== 'object' || Array.isArray(value.options))) throw new Error('工作流选项无效')
  if (value.implementation !== undefined && !/^[0-9a-f]{64}$/.test(value.implementation)) throw new Error('组合实现摘要无效')
  if (value.engine !== undefined && (value.engine !== 'lfx' || kind !== 'workflow' || !workflow)) throw new Error('LFX 需要代码工作流身份')
  if (value.flowDigest !== undefined && (value.engine !== 'lfx' || !/^[0-9a-f]{64}$/.test(value.flowDigest))) throw new Error('LFX 发布摘要无效')
  const base = { toolName, title: title.trim(), description, connectionId, ...(value.implementation ? { implementation: value.implementation } : {}), ...(workflow ? { workflow, ...(value.connections ? { connections: value.connections } : {}), ...(value.options ? { options: value.options } : {}) } : {}) }
  if (kind === 'workflow') return { ...base, kind, ...(value.engine ? { engine: value.engine, ...(value.flowDigest ? { flowDigest: value.flowDigest } : {}) } : {}) }
  if (kind === 'threat-stage') {
    if (!['collect', 'infer', 'writeback', 'report'].includes(stage)) throw new Error('威胁分析阶段无效')
    const binding = value.bindings
    if (!binding || ![binding.socConnectionId, binding.reportConnectionId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error('请选择 SOC 与报告连接')
    const bindings: ThreatBindings = { socConnectionId: binding.socConnectionId, reportConnectionId: binding.reportConnectionId }
    if (binding.model !== undefined) {
      if (!binding.model || !['provider', 'model'].every(key => typeof binding.model[key] === 'string' && binding.model[key].trim())) throw new Error('模型路由无效')
      if (binding.model.reasoningEffort !== undefined && typeof binding.model.reasoningEffort !== 'string') throw new Error('推理强度无效')
      bindings.model = { provider: binding.model.provider, model: binding.model.model, ...(binding.model.reasoningEffort !== undefined ? { reasoningEffort: binding.model.reasoningEffort } : {}) }
    }
    return { ...base, kind, stage, bindings }
  }
  if (kind === 'composite') {
    if (!Array.isArray(value.steps) || !value.steps.length) throw new Error('请选择子组合')
    const ids = new Set<string>()
    const steps = value.steps.map((step: any): CompositionStep => {
      if (!step || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id) || ids.has(step.id)) throw new Error('子步骤 ID 无效或重复')
      if (['input', 'stepValues', 'latest', 'trace', 'receipts', 'errors'].includes(step.id) || Object.hasOwn(Object.prototype, step.id)) throw new Error('子步骤 ID 不能使用图状态保留字段')
      ids.add(step.id)
      if (typeof step.compositionId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(step.compositionId) || typeof step.versionId !== 'string') throw new Error('子组合版本引用无效')
      if (!step.inputMap || typeof step.inputMap !== 'object' || Array.isArray(step.inputMap)) throw new Error('子组合参数映射无效')
      if (step.when !== undefined && !['always', 'five_source', 'claimed', 'completed'].includes(step.when)) throw new Error('子组合执行条件无效')
      return { id: step.id, compositionId: step.compositionId, versionId: step.versionId, inputMap: step.inputMap, ...(step.when ? { when: step.when } : {}) }
    })
    return { ...base, kind, steps }
  }
  if (flow !== undefined && flow !== 'soc-asset-alerts') throw new Error('接口流程无效')
  if (flow && (typeof alertsConnectionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(alertsConnectionId))) throw new Error('请选择告警 OpenAPI 服务器')
  return { ...base, ...(flow ? { flow, alertsConnectionId } : {}) }
}

export function compositionVersionId(config: CompositionConfig) {
  return createHash('sha256').update(JSON.stringify(compositionConfig(config))).digest('hex')
}

export function versionConfig(catalog: Catalog, compositionId: string, versionId: string): CompositionConfig {
  const version = catalog.compositions.find(entry => entry.id === compositionId)?.versions?.find(item => item.versionId === versionId)
  if (!version) throw new Error('子组合已发布版本不存在，请选择具体版本')
  return version.config
}

export function publishCompositionVersion(entry: CompositionEntry, config: CompositionConfig, implementationDigest?: string) {
  const versionId = compositionVersionId(config)
  const publishedAt = new Date().toISOString()
  entry.versions ??= []
  if (!entry.versions.some(version => version.versionId === versionId)) entry.versions.push({ versionId, publishedAt, config: compositionConfig(config) })
  const version = entry.versions.find(version => version.versionId === versionId)!
  if (version.implementationDigest && implementationDigest && version.implementationDigest !== implementationDigest) throw new Error('固定版本实现不可替换，请重新发布新版本')
  if (implementationDigest) version.implementationDigest = implementationDigest
  entry.published = { ...compositionConfig(config), publishedAt }
  entry.publishedVersionId = versionId
  delete entry.draft
}

function validateCatalog(catalog: Catalog) {
  if (catalog.schema_version !== '1.0' || !Array.isArray(catalog.compositions)) throw new Error('编排目录格式无效')
  const ids = new Set<string>()
  const names = new Map<string, string>()
  for (const entry of catalog.compositions) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id) || (!entry.draft && !entry.published && !entry.versions?.length)) throw new Error('编排 ID 无效、重复或没有版本')
    ids.add(entry.id)
    for (const config of [entry.draft, entry.published].filter(Boolean)) {
      const valid = compositionConfig(config)
      if (names.has(valid.toolName) && names.get(valid.toolName) !== entry.id) throw new Error(`工具名称已被另一编排使用：${valid.toolName}`)
      names.set(valid.toolName, entry.id)
    }
    const versions = new Set<string>()
    for (const version of entry.versions ?? []) {
      if (!version || version.versionId !== compositionVersionId(version.config) || versions.has(version.versionId)) throw new Error('不可变组合版本无效或重复')
      versions.add(version.versionId)
    }
    if (entry.publishedVersionId && (!entry.published || entry.publishedVersionId !== compositionVersionId(entry.published) || !versions.has(entry.publishedVersionId))) throw new Error('当前发布版本指针无效')
  }
}

export function readCompositions(file: string, ownsLock = false) {
  if (!ownsLock && existsSync(`${file}.lock`)) throw new Error('组合目录正在保存，请稍后重试')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : JSON.stringify({ schema_version: '1.0', compositions: [] })
  const document = JSON.parse(text)
  const contents: string[] = []
  const catalog: Catalog = document.schema_version === '2.0' ? { schema_version: '1.0', compositions: document.compositions.map((item: any) => {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(item.id) || item.path !== `compositions/${item.id}/composition.json`) throw new Error('组合包索引无效')
    const content = readFileSync(join(dirname(file), item.path), 'utf8')
    contents.push(item.path, content)
    const entry = JSON.parse(content)
    if (entry.id !== item.id) throw new Error('组合包与索引身份不一致')
    return entry
  }) } : document
  validateCatalog(catalog)
  // 旧目录只有 published；派生一个初始版本，保存时再物化，不改变旧 published 内容。
  for (const entry of catalog.compositions) if (entry.published && !entry.publishedVersionId) {
    entry.publishedVersionId = compositionVersionId(entry.published)
    entry.versions ??= []
    if (!entry.versions.some(version => version.versionId === entry.publishedVersionId)) entry.versions.push({ versionId: entry.publishedVersionId, publishedAt: entry.published.publishedAt, config: compositionConfig(entry.published) })
  }
  return { catalog, revision: createHash('sha256').update([text, ...contents].join('\0')).digest('hex') }
}

export function writeCompositions(file: string, catalog: Catalog, expectedRevision: unknown, deletedId?: string) {
  if (deletedId !== undefined && (!/^[a-z0-9-]{1,80}$/.test(deletedId) || catalog.compositions.some(entry => entry.id === deletedId))) throw new Error('待删除编排身份无效或仍在目录中')
  const previous = readCompositions(file)
  if (previous.revision !== expectedRevision) throw new Error('编排目录已变化，请刷新后重试；当前草稿未覆盖')
  validateCatalog(catalog)
  for (const entry of previous.catalog.compositions) for (const version of entry.versions ?? []) {
    if (entry.id === deletedId && !catalog.compositions.some(item => item.id === deletedId)) continue
    const retained = catalog.compositions.find(item => item.id === entry.id)?.versions?.find(item => item.versionId === version.versionId)
    if (!retained || JSON.stringify(retained.config) !== JSON.stringify(version.config)) throw new Error('已发布组合版本不可修改或移除')
  }
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`, descriptor = openSync(lock, 'wx')
  try {
    if (readCompositions(file, true).revision !== expectedRevision) throw new Error('编排目录已变化，请刷新后重试')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).schema_version === '2.0') {
      const backups = new Map<string, string | undefined>()
      try {
        for (const entry of catalog.compositions) {
          const target = join(dirname(file), 'compositions', entry.id, 'composition.json')
          const value = JSON.stringify(entry, null, 2) + '\n'
          const old = existsSync(target) ? readFileSync(target, 'utf8') : undefined
          if (value === old) continue
          backups.set(target, old)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(`${target}.tmp`, value); renameSync(`${target}.tmp`, target)
        }
        const index = { schema_version: '2.0', compositions: catalog.compositions.map(entry => ({ id: entry.id, path: `compositions/${entry.id}/composition.json` })) }
        writeFileSync(`${file}.tmp`, JSON.stringify(index, null, 2) + '\n'); renameSync(`${file}.tmp`, file)
      } catch (error) {
        for (const [target, value] of backups) { if (value === undefined) unlinkSync(target); else writeFileSync(target, value) }
        throw error
      }
    } else {
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(catalog, null, 2) + '\n')
      renameSync(temp, file)
    }
    if (deletedId) {
      try { rmSync(join(dirname(file), 'compositions', deletedId), { recursive: true, force: true }) }
      catch (error) { throw new Error(`编排登记已移除，但资产目录清理失败（${(error as NodeJS.ErrnoException).code ?? '未知原因'}）；请核对目录后使用同一编排 ID 继续删除`) }
    }
  } finally { closeSync(descriptor); unlinkSync(lock) }
}

export function selectedComposition(catalog: Catalog, selection: any): CompositionConfig {
  if (!['draft', 'published'].includes(selection?.version)) throw new Error('请选择草稿或已发布版本')
  const config = catalog.compositions.find(entry => entry.id === selection.compositionId)?.[selection.version as 'draft' | 'published']
  if (!config) throw new Error('所选编排版本不存在')
  return config
}

/** 下架阻止新的固定版本和父子调用；已接受运行使用自己的冻结目录。 */
type Dependencies = (config: CompositionConfig) => { compositionId: string; versionId: string }[]
export function assertPublishedDependencies(catalog: Catalog, config: CompositionConfig, path = new Set<string>(), dependencies: Dependencies = config => config.steps ?? []) {
  for (const step of dependencies(config)) {
    const key = `${step.compositionId}:${step.versionId}`
    if (path.has(key)) throw new Error('组合版本存在循环引用')
    if (!catalog.compositions.find(entry => entry.id === step.compositionId)?.published) throw new Error(`子组合已下架或删除：${step.compositionId}`)
    assertPublishedDependencies(catalog, versionConfig(catalog, step.compositionId, step.versionId), new Set([...path, key]), dependencies)
  }
}

export function compositionReferences(catalog: Catalog, id: string, publishedOnly = false, dependencies: Dependencies = config => config.steps ?? []) {
  return catalog.compositions.filter(entry => entry.id !== id && [...(publishedOnly ? [] : [entry.draft]), entry.published, ...(entry.published ? (entry.versions ?? []).map(version => version.config) : [])].some(config => config && ((!publishedOnly && config.workflow === id) || dependencies(config).some(step => step.compositionId === id)))).map(entry => ({ id: entry.id, title: entry.published?.title ?? entry.draft?.title ?? entry.id }))
}
