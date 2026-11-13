import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, linkSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** 平台访问控制不随独立部署运行；业务 MCP 使用 Harness 声明的平台连接。 */
export function projectStandaloneBoundary(source: string, programRoot: string): { content: string; changed: boolean } {
  if (!source.includes('businessRuntime')) return { content: source, changed: false }
  const ts = createRequire(join(programRoot, 'platform/plugin/package.json'))('typescript') as any
  const file = ts.createSourceFile('managed.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits: Array<{ start: number; end: number; content: string }> = []
  let platformGuard = false
  function identify(node: any) {
    if (ts.isVariableDeclaration(node) && node.name?.text === 'name' && ts.isStringLiteral(node.initializer)
      && /^security-operations-(?:child-)?guard$/.test(node.initializer.text)) platformGuard = true
    ts.forEachChild(node, identify)
  }
  identify(file)
  function project(node: any) {
    if (ts.isVariableDeclaration(node) && node.name?.text === 'inject' && ts.isArrayLiteralExpression(node.initializer)) {
      const values = node.initializer.elements.filter((item: any) => !(ts.isStringLiteral(item) && item.text === 'businessRuntime'))
      edits.push({ start: node.initializer.getStart(file), end: node.initializer.end,
        content: platformGuard ? '[]' : `[${values.map((item: any) => item.getText(file)).join(', ')}]` })
    }
    if (ts.isFunctionDeclaration(node) && node.body) {
      if (platformGuard && node.name?.text === 'apply') edits.push({ start: node.body.getStart(file), end: node.body.end, content: '{}' })
      else if (node.name?.text === 'runtimeGroupConnection' && node.body.getText(file).includes('businessRuntime')) {
        edits.push({ start: node.body.getStart(file), end: node.body.end, content: `{
  const group = config.connections?.runtimeGroup
  const manager = ctx.mcpSessionManager
  return { groupUrl: manager.groupUrl(group.id), fetch: manager.groupFetch(group.id, sessionId) }
}` })
      }
    }
    ts.forEachChild(node, project)
  }
  project(file)
  let content = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.content + content.slice(edit.end)
  return { content, changed: content !== source }
}

export function stageManagedProjections(staging: string, programRoot: string) {
  const managed = join(staging, 'assets/managed'), projected = join(staging, 'runtime/projections/managed')
  const changes: Array<{ path: string; content: string; sourceSha256: string; exportSha256: string }> = []
  function inspect(directory: string, rel = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') inspect(join(directory, entry.name), name) }
      else if (entry.isFile() && /\.[mc]?js$/.test(entry.name)) {
        const bytes = readFileSync(join(directory, entry.name))
        const result = projectStandaloneBoundary(bytes.toString('utf8'), programRoot)
        if (result.changed) changes.push({ path: name, content: result.content, sourceSha256: sha(bytes), exportSha256: sha(result.content) })
      }
    }
  }
  inspect(managed)
  rmSync(projected, { recursive: true, force: true })
  if (!changes.length) {
    rmSync(join(staging, 'runtime/managed-projection.json'), { force: true })
    return []
  }
  function linkTree(source: string, target: string) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(target, entry.name)
      if (entry.isDirectory()) linkTree(from, to)
      else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
      else if (entry.isFile()) linkSync(from, to)
      else throw new Error('部署投影只支持普通文件与依赖符号链接')
    }
  }
  linkTree(managed, projected)
  for (const change of changes) {
    const target = join(projected, change.path), temporary = `${target}.projection-${process.pid}`
    writeFileSync(temporary, change.content, { mode: lstatSync(join(managed, change.path)).mode & 0o777 })
    renameSync(temporary, target) // 原子替换打断硬链接，冻结原件不被改写。
  }
  const records = changes.map(({ content: _content, ...value }) => ({ ...value, sourcePath: `assets/managed/${value.path}`, projectedPath: `runtime/projections/managed/${value.path}` }))
  writeFileSync(join(staging, 'runtime/managed-projection.json'), JSON.stringify({ schemaVersion: 1, rule: 'standalone-deployment-boundary-v1', files: records }, null, 2) + '\n')
  return records
}
