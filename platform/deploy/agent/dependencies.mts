import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { AgentPackageInput, AgentSourceSnapshot } from './types.mts'

/** 导出只使用标准镜像已锁定的第三方依赖，不复制宿主 node_modules 或 venv。 */
export function runtimeDependencies(input: AgentPackageInput, snapshot: AgentSourceSnapshot) {
  const directory = join(input.programRoot, 'runtime/adapters/dsh-container/standalone-deps')
  const catalog = existsSync(join(directory, 'package.json')) ? JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies ?? {} : {}
  const python = existsSync(join(directory, 'requirements.txt')) ? readFileSync(join(directory, 'requirements.txt'), 'utf8') : ''
  return snapshot.dependencies.map(dependency => {
    let missing: string[]
    if (dependency.kind === 'python') {
      const declared = dependency.requirements ?? []
      const normalize = (line: string) => line.split(' --hash=')[0].trim().toLowerCase().replace(/[-_.]+/g, '_')
      const available = python.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(normalize)
      missing = dependency.unresolved ? ['未解析的 Python 环境声明'] : declared.filter(line => !available.includes(normalize(line)))
    } else {
      const path = dependency.path.startsWith('candidate/') ? dependency.path.slice(10) : `dsh/${dependency.path}`
      const pkg = JSON.parse(readFileSync(join(snapshot.candidate, path, 'package.json'), 'utf8'))
      const require = createRequire(join(input.programRoot, 'platform/plugin/package.json'))
      const { satisfies } = require('semver')
      missing = dependency.dependencies.filter(name => !catalog[name] || !satisfies(catalog[name], pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name] ?? '', { includePrerelease: true }))
    }
    return { ...dependency, ready: missing.length === 0, reason: missing.length ? `标准镜像尚未包含兼容依赖：${missing.join('、')}；请更新平台 Runtime 依赖锁并重建共享标准镜像` : undefined }
  })
}
