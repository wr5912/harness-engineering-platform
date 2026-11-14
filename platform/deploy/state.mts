import { existsSync, rmSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { copyTree } from './fsutil.mts'
import { managerHome } from '../manager-home.mts'

export const dataStatePaths = ['config', '.local', 'mcp/.local'] as const
export const isDataState = (path: string) => path === 'workspace.json'
  || dataStatePaths.some(root => path === root || path.startsWith(root + '/'))

const regenerated = ['.local/build-cache', '.local/cache', '.local/tmp', '.local/platform-service', '.local/platform-runtime', 'mcp/.local/build-cache', 'mcp/.local/cache']
const homeTransient = new Set(['.git', 'node_modules', 'cache', 'tmp', 'logs'])

export function copyDataState(source: string, target: string, includeHome = true, excluded: readonly string[] = []): void {
  for (const path of dataStatePaths) {
    if (!existsSync(join(source, path))) continue
    rmSync(join(target, path), { recursive: true, force: true })
    copyTree(join(source, path), join(target, path), file => {
      const name = relative(source, file).split('\\').join('/')
      if (excluded.some(root => name === root || name.startsWith(root + '/'))) return false
      if (!includeHome && (name === '.local/platform-home' || name.startsWith('.local/platform-home/'))) return false
      if (regenerated.some(root => name === root || name.startsWith(root + '/'))) return false
      return !name.startsWith('.local/platform-home/') || !homeTransient.has(basename(file))
    })
  }
  if (!includeHome) return
  const home = managerHome(source)
  if (home === join(source, '.local/platform-home')) return
  const destination = join(target, '.local/platform-home')
  rmSync(destination, { recursive: true, force: true })
  copyTree(home, destination, path => !homeTransient.has(basename(path)))
}
