import { posix } from 'node:path'
import { codeCatalog, codeDirectory, readCode, type CodeLocation } from '../components/generated-code-files.ts'

export function computeCodeSource(root: string, id: string, generation: any, build: any, request: { path?: unknown; expected_sha256?: unknown } = {}) {
  const entry = generation?.entry_path
  if (typeof entry !== 'string' || !/^dsh\/managed\//.test(entry) || entry.includes('..') || entry.includes('\\')) throw new Error('此版本尚未保存有效的生成代码入口')
  const candidate = `evolution/experiments/${id}/candidate`
  const directory = posix.dirname(entry)
  const currentBuild = build?.entry_path === entry ? build : null
  // 专用工作流目录包含编译时未引用的CLI/集成源码；通用managed目录只取受控构建参与文件。
  const files = new Set<string>([entry, ...(Array.isArray(currentBuild?.source_files) ? currentBuild.source_files.map((item: any) => item.path) : []), ...(typeof currentBuild?.output_path === 'string' ? [currentBuild.output_path] : [])])
  if (directory !== 'dsh/managed') for (const file of codeDirectory(root, `${candidate}/${directory}`)) files.add(file.slice(candidate.length + 1))
  const locations: CodeLocation[] = [...files].map(file => {
    if (typeof file !== 'string' || posix.isAbsolute(file) || file.split('/').some(part => part === '..' || part === '') || file.includes('\\')) throw new Error('构建源码路径不在当前 Candidate 范围内')
    const built = currentBuild?.source_files?.find((item: any) => item.path === file)?.sha256 ?? (currentBuild?.output_path === file ? currentBuild?.esm_sha256 : undefined)
    return { root, file: `${candidate}/${file}`, path: file, entry: file === entry, asset_path: `${candidate}/${file}`, ...(typeof built === 'string' && /^[0-9a-f]{64}$/.test(built) ? { built_sha256: built } : {}) }
  })
  const identity = `compute:${id}:${entry}`
  return request.path === undefined ? codeCatalog(identity, locations, ['目录来自当前工作流实际文件与构建参与清单。源码、构建产物和运行配置分开标记；模型文件请到智能体资产查看。'])
    : readCode(identity, locations, request.path, request.expected_sha256)
}
