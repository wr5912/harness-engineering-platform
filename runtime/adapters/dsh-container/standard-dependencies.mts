import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 实例准备和独立导出共用标准镜像的依赖锁。 */
export function standardDependencies(programRoot: string) {
  const directory = join(programRoot, 'runtime/adapters/dsh-container/standalone-deps')
  const catalog = existsSync(join(directory, 'package.json')) ? JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies ?? {} : {}
  const { satisfies } = createRequire(join(programRoot, 'platform/plugin/package.json'))('semver')
  const normalize = (line: string) => line.split(' --hash=')[0].trim().toLowerCase().replace(/[-_.]+/g, '_')
  const python = new Set((existsSync(join(directory, 'requirements.txt')) ? readFileSync(join(directory, 'requirements.txt'), 'utf8') : '').split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#')).map(normalize))
  return {
    node(manifest: Record<string, any>, names = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      return names.filter(name => !catalog[name] || !satisfies(catalog[name], manifest.dependencies?.[name] ?? manifest.optionalDependencies?.[name] ?? manifest.peerDependencies?.[name] ?? '', { includePrerelease: true }))
    },
    python(requirements: string[]) { return requirements.filter(line => !python.has(normalize(line))) },
  }
}
