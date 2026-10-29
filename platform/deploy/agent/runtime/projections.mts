import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, linkSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** 仅迁移已知旧 SDK 接缝；未知编译形态明确失败，不能取消固定版本校验。 */
export function projectLegacyFixedBindings(source: string, programRoot: string): { content: string; changed: boolean } {
  const ts = createRequire(join(programRoot, 'platform/plugin/package.json'))('typescript') as any
  const file = ts.createSourceFile('managed.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let declaresBindings = false
  function declared(node: any) {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name?.getText(file).replace(/["']/g, '') === 'fixedCompositions') declaresBindings = true
    ts.forEachChild(node, declared)
  }
  declared(file)
  if (!declaresBindings) return { content: source, changed: false }
  const functions: any[] = []
  function find(node: any) { if (ts.isFunctionDeclaration(node) && /^registerFixedCompositionTools\d*$/.test(node.name?.text || '')) functions.push(node); ts.forEachChild(node, find) }
  find(file)
  if (functions.length !== 1) throw new Error('固定组合编译制品无法定位唯一 SDK 接缝；请从当前工作流运行库重新构建')
  const fn = functions[0]
  if (fn.getText(file).includes('standaloneBindings')) return { content: source, changed: false }
  const contexts = fn.parameters[0]?.name?.getText(file)
  if (!contexts || !/^[A-Za-z_$][\w$]*$/.test(contexts)) throw new Error('固定组合 SDK 上下文参数无法识别')
  const binding: any[] = [], execute: any[] = []
  function inspect(node: any) {
    if (ts.isVariableDeclaration(node) && node.name?.text === 'binding' && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(file) === 'structuredClone' && node.initializer.arguments[0]?.getText(file) === 'supplied') binding.push(node)
    if (ts.isMethodDeclaration(node) && node.name?.getText(file) === 'execute' && node.body) execute.push(node.body)
    ts.forEachChild(node, inspect)
  }
  inspect(fn)
  if (binding.length !== 1 || execute.length !== 1) throw new Error('固定组合 SDK 编译形态不受支持；请从当前工作流运行库重新构建')
  const replacement = `\n binding = ((original) => { const projected = ${contexts}.standaloneBindings?.resolve(name, original); if (projected && (projected.compositionId !== original.compositionId || projected.versionId !== original.versionId || projected.group_id !== original.group_id || projected.group_link_version !== original.group_link_version || projected.tool_name !== original.tool_name || JSON.stringify(projected.input_schema) !== JSON.stringify(original.input_schema))) throw new Error('部署绑定不得改变固定组合的版本或工具合同'); return projected ?? original; })(structuredClone(supplied));\n`
  const edits = [{ start: execute[0].getStart(file) + 1, end: execute[0].getStart(file) + 1, content: replacement }]
  const declarations = binding[0].parent
  if (declarations.flags & ts.NodeFlags.Const) edits.push({ start: declarations.getStart(file), end: declarations.getStart(file) + 5, content: 'let' })
  edits.sort((a, b) => b.start - a.start)
  let content = source
  for (const edit of edits) content = content.slice(0, edit.start) + edit.content + content.slice(edit.end)
  return { content, changed: true }
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
        const result = projectLegacyFixedBindings(bytes.toString('utf8'), programRoot)
        if (result.changed) changes.push({ path: name, content: result.content, sourceSha256: sha(bytes), exportSha256: sha(result.content) })
      }
    }
  }
  inspect(managed)
  if (!changes.length) return []
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
  writeFileSync(join(staging, 'runtime/managed-projection.json'), JSON.stringify({ schemaVersion: 1, rule: 'legacy-fixed-composition-deployment-binding-v1', files: records }, null, 2) + '\n')
  return records
}
