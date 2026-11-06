import { createHash } from 'node:crypto'
import { codeCatalog, readCode, type CodeLocation } from '../components/generated-code-files.ts'
import { selectedComposition, versionConfig, type Catalog } from './compositions.ts'
import { lfxDigest, loadLfxBundle, type LfxBundle } from './lfx-assets.ts'

export function compositionCodeSource(assetRoot: string, catalog: Catalog, request: any) {
  const selection = request?.selection
  if (!selection || typeof selection.id !== 'string' || !['draft', 'published'].includes(selection.version)) throw new Error('请选择已保存的编排版本')
  if (selection.versionId !== undefined && (selection.version !== 'published' || typeof selection.versionId !== 'string')) throw new Error('固定编排版本参数无效')
  const config = selection.versionId ? versionConfig(catalog, selection.id, selection.versionId) : selectedComposition(catalog, { compositionId: selection.id, version: selection.version })
  const locations: CodeLocation[] = [], notes: string[] = []
  const bundle = config.engine === 'lfx' ? loadLfxBundle(assetRoot, config.workflow!, config, catalog) : undefined
  const identity = `composition:${selection.id}:${createHash('sha256').update(JSON.stringify([config, bundle ? lfxDigest(bundle) : null])).digest('hex')}`
  const add = (path: string, content: string, label: string, kind: CodeLocation['kind'] = 'source', entry = false) => {
    locations.push({ root: assetRoot, file: `mcp/compositions/${selection.id}/${path}`, path, content, label, kind, entry })
  }
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
  function flowCode(flow: any, prefix: string) {
    for (const node of flow.data.nodes) {
      const template = node.data.node.template, id = encodeURIComponent(node.id)
      add(`${prefix}components/${id}.py`, template.code.value, `${node.data.node.display_name ?? node.id} · ${node.id}`)
      if (node.data.type === 'HepBatch') {
        add(`${prefix}components/${id}/flow.json`, json(template.body.value), `批量内部流程 · ${node.id}`, 'support')
        flowCode(template.body.value, `${prefix}components/${id}/`)
      }
    }
  }
  function bundleCode(value: LfxBundle, prefix = '') {
    add(`${prefix}flow.json`, json(value.flow), prefix ? '固定子编排流程' : '编排流程', 'support', !prefix)
    flowCode(value.flow, prefix)
    for (const [name, content] of Object.entries(value.modules)) {
      add(`${prefix}modules/${encodeURIComponent(name)}.py`, content, `业务模块 · ${name}`)
    }
    if ('typescript' in value && typeof value.typescript === 'string') add(`${prefix}execution.js`, value.typescript, '业务执行模块 · JavaScript', 'artifact')
    for (const [key, child] of Object.entries(value.children)) bundleCode(child, `${prefix}children/${encodeURIComponent(key)}/`)
  }
  if (bundle) {
    bundleCode(bundle)
    notes.push(config.flowDigest ? '所选固定发布包的只读视图；包含原生流程、节点组件、业务模块及固定子编排。' : '已保存草稿的只读视图；流程、节点组件和已声明业务依赖来自同一份 LFX 资产。')
    notes.push('节点名称和 ID 对应画布；children 目录标明固定子编排及版本。组件仍依赖平台提供的连接与运行环境。')
  } else {
    add('composition.json', json(config), '编排定义', 'support', true)
    notes.push('此版本不是原生 LFX 编排。仅展示已保存定义；未保存可核实的业务源码快照，不以当前平台源码替代。')
  }
  return request.path === undefined ? codeCatalog(identity, locations, notes) : readCode(identity, locations, request.path, request.expected_sha256)
}
