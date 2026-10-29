import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { programRoot } from '../workspace.ts'

export type ProviderProtocolKind = 'risk-assessment' | 'access-control'
const documents = {
  'risk-assessment': { title: '第三方风险评估接口协议', filename: '24_第三方风险评估接口协议.md' },
  'access-control': { title: '第三方访问控制接口协议', filename: '25_第三方访问控制接口协议.md' },
} as const

/** 查看与下载共用程序仓库中的规范，不从业务工作区读取另一份副本。 */
export function readProviderProtocol(kind: ProviderProtocolKind, root = programRoot()) {
  if (!Object.hasOwn(documents, kind)) throw new Error('请选择风险评估或访问控制接口规范')
  const document = documents[kind]
  const content = readFileSync(join(root, 'docs/platform-design', document.filename), 'utf8')
  const version = /^协议版本：([\d.]+)。$/m.exec(content)?.[1]
  if (!version) throw new Error('接口规范缺少版本信息')
  return { kind, ...document, version, content, sha256: createHash('sha256').update(content).digest('hex') }
}
