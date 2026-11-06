import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { readCompositions, versionConfig, type Catalog, type CompositionConfig } from './compositions.ts'

export type LfxBundle = { engine: 'lfx==1.13.1'; flow: any; modules: Record<string, string>; children: Record<string, LfxBundle> }
export const lfxDigest = (bundle: LfxBundle) => createHash('sha256').update(JSON.stringify(bundle)).digest('hex')

/** 只验证序列化结构，不导入组件、不构造 Graph、不访问上游。 */
export function validateLfxFlow(flow: any) {
  if (!Array.isArray(flow?.data?.nodes) || !flow.data.nodes.length || !Array.isArray(flow.data.edges)) throw new Error('需要原生 Langflow nodes/edges')
  const ids = new Set<string>()
  for (const node of flow.data.nodes) {
    if (!node?.id || ids.has(node.id) || node.data?.id !== node.id || typeof node.data?.node?.template?.code?.value !== 'string') throw new Error('LFX 节点身份或组件代码无效')
    if (!Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new Error('LFX 节点缺少画布位置')
    ids.add(node.id)
    if (node.data.type === 'HepBatch') validateLfxFlow(node.data.node.template.body.value)
  }
  if (flow.data.nodes.filter((node: any) => node.data.node.is_output).length !== 1) throw new Error('LFX 流程需要唯一的结果节点')
  for (const edge of flow.data.edges) {
    const source = flow.data.nodes.find((node: any) => node.id === edge.source), target = flow.data.nodes.find((node: any) => node.id === edge.target)
    const from = edge.data?.sourceHandle, to = edge.data?.targetHandle
    if (!source || !target || from?.id !== source.id || to?.id !== target.id
      || !source.data.node.outputs?.some((output: any) => output.name === from.name) || !target.data.node.template[to.fieldName]) throw new Error('LFX 边或端口引用无效')
  }
  return flow
}

function flowChildren(flow: any): { compositionId: string; versionId: string }[] {
  return flow.data.nodes.flatMap((node: any) => {
    const template = node.data.node.template
    if (node.data.type === 'HepBatch') return flowChildren(template.body.value)
    return node.data.type === 'HepChild' ? [{ compositionId: template.composition_id.value, versionId: template.version_id.value }] : []
  })
}

export function lfxDependencies(root: string, config: CompositionConfig) {
  return config.engine === 'lfx' ? flowChildren(loadLfxBundle(root, config.workflow!, config).flow) : config.steps ?? []
}

export function loadLfxBundle(root: string, id: string, config: CompositionConfig, catalog?: Catalog, ancestors = new Set<string>()): LfxBundle {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('LFX 编排身份无效')
  const base = join(root, 'mcp', 'compositions', id)
  if (config.flowDigest) {
    const bundle = JSON.parse(readFileSync(join(base, 'versions', config.flowDigest, 'bundle.json'), 'utf8'))
    if (lfxDigest(bundle) !== config.flowDigest) throw new Error('固定 LFX 流程内容与发布摘要不一致')
    validateLfxFlow(bundle.flow)
    return bundle
  }
  const flow = validateLfxFlow(JSON.parse(readFileSync(join(base, 'flow.json'), 'utf8')))
  const modules: Record<string, string> = {}
  for (const [name, path] of Object.entries(flow.metadata?.hep?.modules ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || typeof path !== 'string') throw new Error('LFX 模块引用无效')
    const source = realpathSync(resolve(root, 'mcp', path))
    if (relative(realpathSync(join(root, 'mcp')), source).startsWith('..')) throw new Error('LFX 模块必须属于 MCP 资产')
    modules[name] = readFileSync(source, 'utf8')
  }
  const children: Record<string, LfxBundle> = {}
  const versions = catalog ?? readCompositions(join(root, 'mcp', 'compositions.json')).catalog
  for (const child of flowChildren(flow)) {
    const key = `${child.compositionId}:${child.versionId}`
    if (ancestors.has(key)) throw new Error('LFX 固定子编排存在循环引用')
    const definition = versionConfig(versions, child.compositionId, child.versionId)
    if (definition.engine !== 'lfx' || !definition.flowDigest) throw new Error('LFX 子编排需要已冻结的原生版本')
    if (Object.entries(definition.connections ?? {}).some(([alias, connection]) => config.connections?.[alias] !== connection)) throw new Error('父 LFX 编排必须包含子编排的相同连接绑定')
    children[key] = loadLfxBundle(root, child.compositionId, definition, versions, new Set([...ancestors, key]))
  }
  return { engine: 'lfx==1.13.1', flow, modules, children }
}

export function freezeLfxBundle(root: string, id: string, config: CompositionConfig) {
  const bundle = loadLfxBundle(root, id, { ...config, flowDigest: undefined }), digest = lfxDigest(bundle)
  const file = join(root, 'mcp', 'compositions', id, 'versions', digest, 'bundle.json')
  if (existsSync(file)) {
    if (lfxDigest(JSON.parse(readFileSync(file, 'utf8'))) !== digest) throw new Error('固定 LFX 发布目录已损坏')
  } else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(bundle) + '\n'); renameSync(`${file}.tmp`, file)
  }
  return digest
}

/** 兼容既有详情面板的只读视图，原生 flow 同时原样返回；此视图从不持久化或执行。 */
export function lfxCanvas(flow: any): any {
  return { native: flow, nodes: flow.data.nodes.map((node: any) => {
    const template = node.data.node.template
    return { id: node.id, title: node.data.node.display_name, description: node.data.node.description,
      kind: node.data.node.metadata?.kind, position: node.position,
      ...(node.data.type === 'HepChild' ? { compositionId: template.composition_id.value, versionId: template.version_id.value } : {}),
      ...(node.data.type === 'HepBatch' ? { subgraph: lfxCanvas(template.body.value) } : {}) }
  }), edges: flow.data.edges.map((edge: any) => ({ ...edge, conditional: edge.data.sourceHandle.name !== 'result',
    label: flow.data.nodes.find((node: any) => node.id === edge.source)?.data.node.outputs.find((output: any) => output.name === edge.data.sourceHandle.name)?.display_name })) }
}
