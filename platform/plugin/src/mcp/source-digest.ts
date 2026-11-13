import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 开发装载和独立导出按同一文件边界计算实现身份。 */
export function sourceTreeDigest(root: string | Record<string, string>, paths: string[]): string {
  const hash = createHash('sha256')
  function visit(path: string) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('实现来源不能经过符号链接')
    if (stat.isDirectory()) for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b))) visit(join(path, name))
    else {
      const roots = typeof root === 'string' ? { '': root } : root
      const selected = Object.entries(roots).find(([, base]) => { const name = relative(resolve(base), resolve(path)); return name !== '..' && !name.startsWith('../') && !name.startsWith('..\\') })
      if (!selected) throw new Error('实现来源不在声明的程序或数据目录中')
      hash.update('/' + [selected[0], relative(selected[1], path)].filter(Boolean).join('/').split('\\').join('/')).update('\0').update(readFileSync(path))
    }
  }
  for (const path of paths) visit(path)
  return hash.digest('hex')
}
