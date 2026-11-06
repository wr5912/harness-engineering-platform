import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 开发装载和独立导出按同一文件边界计算实现身份。 */
export function sourceTreeDigest(root: string, paths: string[]): string {
  const hash = createHash('sha256')
  function visit(path: string) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('实现来源不能经过符号链接')
    if (stat.isDirectory()) for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b))) visit(join(path, name))
    else hash.update('/' + relative(root, path).split('\\').join('/')).update('\0').update(readFileSync(path))
  }
  for (const path of paths) visit(path)
  return hash.digest('hex')
}
