import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import layout from '../../assets/mcp-credential-layout.json' with { type: 'json' }

export function mcpCredentialPaths(root: string) {
  const directory = join(root, layout.directory)
  return { directory, file: join(directory, layout.file), lock: join(directory, layout.lock),
    legacyFile: join(root, layout.legacyFile), legacyLock: join(root, layout.legacyLock) }
}

/** 迁移只由平台 prepare 执行；Runtime 构造与读取不修改只读挂载。 */
export function mcpCredentialFile(root: string): string {
  const paths = mcpCredentialPaths(root)
  const stateOf = (path: string) => {
    try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const directory of [join(root, '.local'), join(root, '.local/credentials'), paths.directory]) {
    const state = stateOf(directory)
    if (state && (!state.isDirectory() || state.isSymbolicLink())) throw new Error('MCP 凭据目录必须是实体目录')
  }
  for (const [legacy, target] of [[paths.legacyFile, paths.file], [paths.legacyLock, paths.lock]]) {
    let state
    try { state = lstatSync(legacy) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (state.isSymbolicLink() && readlinkSync(legacy) !== relative(dirname(legacy), target)) throw new Error('MCP 旧路径不是受信迁移引用')
    if (!state.isSymbolicLink() && !state.isFile()) throw new Error('MCP 凭据路径必须是普通文件')
  }
  const current = stateOf(paths.file)
  if (current) {
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('MCP 凭据必须是实体文件')
    if (existsSync(paths.legacyFile) && !lstatSync(paths.legacyFile).isSymbolicLink()) throw new Error('MCP 新旧凭据并存；请运行平台 prepare 核对迁移')
    return paths.file
  }
  return existsSync(paths.legacyFile) ? paths.legacyFile : paths.file
}
