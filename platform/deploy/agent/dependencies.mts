import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { standardDependencies } from '../../../runtime/adapters/dsh-container/standard-dependencies.mts'
import type { AgentPackageInput, AgentSourceSnapshot } from './types.mts'

/** 导出只使用标准镜像已锁定的第三方依赖，不复制宿主 node_modules 或 venv。 */
export function runtimeDependencies(input: AgentPackageInput, snapshot: AgentSourceSnapshot) {
  if (!snapshot.dependencies.length) return []
  const catalog = standardDependencies(input.programRoot)
  return snapshot.dependencies.map(dependency => {
    let missing: string[]
    if (dependency.kind === 'python') {
      const declared = dependency.requirements ?? []
      missing = dependency.unresolved ? ['未解析的 Python 环境声明'] : catalog.python(declared)
    } else {
      const path = dependency.path.startsWith('candidate/') ? dependency.path.slice(10) : `dsh/${dependency.path}`
      const pkg = JSON.parse(readFileSync(join(snapshot.candidate, path, 'package.json'), 'utf8'))
      missing = catalog.node(pkg, dependency.dependencies)
    }
    return { ...dependency, ready: missing.length === 0, reason: missing.length ? `标准镜像尚未包含兼容依赖：${missing.join('、')}；请更新平台 Runtime 依赖锁并重建共享标准镜像` : undefined }
  })
}
