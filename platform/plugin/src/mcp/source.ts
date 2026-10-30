import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { programRoot } from '../workspace.ts'
import { codeCatalog, codeDirectory, readCode, type CodeLocation } from '../components/generated-code-files.ts'
import { selectedComposition, versionConfig, type Catalog } from './compositions.ts'
import type { CompositionExtension } from './extension.ts'

export function compositionCodeSource(assetRoot: string, catalog: Catalog, extension: CompositionExtension | undefined, request: any, sourceRoot = programRoot(), loadedSourceDigest?: string) {
  const selection = request?.selection
  if (!selection || typeof selection.id !== 'string' || !['draft', 'published'].includes(selection.version)) throw new Error('请选择已保存的编排版本')
  if (selection.versionId !== undefined && (selection.version !== 'published' || typeof selection.versionId !== 'string')) throw new Error('固定编排版本参数无效')
  const config = selection.versionId ? versionConfig(catalog, selection.id, selection.versionId) : selectedComposition(catalog, { compositionId: selection.id, version: selection.version })
  const identity = `composition:${selection.id}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
  const prefix = 'platform/plugin/'
  const locations: CodeLocation[] = []
  const sourceIndex = join(sourceRoot, `${prefix}lib/composition-source-index.json`)
  let indexed = false
  if (existsSync(sourceIndex)) {
    const index = JSON.parse(readFileSync(sourceIndex, 'utf8'))
    if (index.schema_version === 1 && /^[0-9a-f]{64}$/.test(index.source_digest ?? '') && index.source_digest === loadedSourceDigest && Array.isArray(index.files)) {
      for (const file of [...index.files, ...(Array.isArray(index.artifacts) ? index.artifacts : [])]) {
        if (typeof file.path !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('组合实现构建清单无效')
        locations.push({ root: sourceRoot, file: file.path, path: file.path, entry: file.path === `${prefix}src/mcp/executor.ts`, built_sha256: file.sha256,
          kind: file.path.includes('/lib/') ? 'artifact' : /\.[cm]?js$/.test(file.path) ? 'support' : undefined })
      }
      indexed = true
    }
  }
  const notes = ['此编排按已保存配置构建 LangGraph，以下是当前平台实现文件；历史发布配置不表示当前源码就是当时装载的实现。运行采用的实现摘要以执行回执为准。']
  notes.push(indexed ? `平台文件清单对应已装载的组合实现摘要：${loadedSourceDigest}。逐文件显示当前内容与构建时是否一致。` : '尚无与已装载组合实现摘要匹配的构建文件清单；请重新构建并装载平台后查看平台实现源码。')
  if (extension?.id) {
    let registrations: any[] = []
    const workspace = join(assetRoot, 'workspace.json')
    if (existsSync(workspace)) registrations = JSON.parse(readFileSync(workspace, 'utf8')).extensions ?? []
    const matches = registrations.filter(item => item?.id === extension.id)
    if (matches.length > 1) throw new Error('业务扩展登记重复，无法确定源码来源')
    const registration = matches[0]
    if (registration && typeof registration.path === 'string') {
      const directory = registration.path.replace(/\/$/, '')
      const files = codeDirectory(assetRoot, `${directory}/src`)
      for (const name of ['build.mjs', 'package.json']) if (existsSync(join(assetRoot, directory, name))) files.push(`${directory}/${name}`)
      locations.push(...files.map(file => ({ root: assetRoot, file, path: `workspace/${file}`, entry: file === `${directory}/src/index.ts`, ...(file === `${directory}/build.mjs` ? { kind: 'support' as const } : {}) })))
      notes.push(`业务扩展 ${extension.id} 的源码目录来自当前工作区登记；运行中扩展摘要：${extension.sourceDigest ?? '未知'}。当前文件与该摘要的一致性尚未核对。`)
    } else notes.push(`业务扩展 ${extension.id} 未登记可读取的源码目录。`)
  }
  return request.path === undefined ? codeCatalog(identity, locations, notes) : readCode(identity, locations, request.path, request.expected_sha256)
}
