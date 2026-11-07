import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, posix } from 'node:path'
import { atomicWrite, dataPath, sha256 } from '../tasks/files.ts'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'

// 仅处理可编辑说明；版本资产、评测口径和运行证据使用各自的专用入口。
function excluded(path: string) {
  const parts = path.split('/')
  return /^(?:evolution|config|extensions|runs|sessions|cache|RuntimeHOME)$/.test(parts[0]) || parts.some(part =>
    (part.startsWith('.') && part !== '.agents') || /^(?:node_modules|__pycache__|sources|imports|evidence)$/.test(part) ||
    /\.llm-api-key$|credential|secret|token|password|private-key/i.test(part))
}
const editable = (path: string) => !excluded(path) && /\.md$/i.test(path) && !/(?:^|\/)(?:evaluation|decision|observations)\.md$/.test(path)
type File = { text: string; sha256: string; mode: number }
type Reference = { path: string; line: number; target: string; kind: 'link' | 'configuration' }
type Scan = { files: Map<string, File>; references: Reference[]; skipped: { path: string; reason: string }[]; complete: boolean }
type Row = { path: string; before: File | null; after: File | null }
type Operation = { operation_id: string; state: string; plan_sha256: string; snapshot_sha256: string; rows: Row[]; error?: string }
const hashFile = (text: string, mode: number): File => ({ text, mode, sha256: sha256(text) })
const fail = (message: string): never => { throw new Error(message) }
function textField(value: unknown, name: string): string {
  return typeof value === 'string' && value.trim() ? value : fail(`${name} 不能为空`)
}
function fileAt(root: string, path: string): File | null {
  const file = dataPath(root, path)
  if (!existsSync(file)) return null
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail(`${path} 不是可处理的文本文件（上限 2 MiB）`)
  const bytes = readFileSync(file)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (bytes.includes(0)) fail(`${path} 不是文本文件`)
  return hashFile(text, stat.mode & 0o777)
}
function same(a: File | null, b: File | null) { return a?.sha256 === b?.sha256 && a?.mode === b?.mode }
function links(path: string, text: string): Reference[] {
  const rows: Reference[] = []
  let fence = ''
  for (const [index, line] of text.split('\n').entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''; continue }
    if (marker) { fence = marker[1]; continue }
    for (const match of line.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)|^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/g)) {
      let href: string
      try { href = decodeURIComponent(match[1] || match[2]) } catch { continue }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue
      const target = posix.normalize(posix.join(posix.dirname(path), href.split(/[?#]/)[0]))
      rows.push({ path, line: index + 1, target, kind: 'link' })
    }
  }
  return rows
}
function scan(root: string): Scan {
  const result: Scan = { files: new Map(), references: [], skipped: [], complete: true }
  let visited = 0, bytes = 0
  function walk(path: string) {
    if (excluded(path)) { result.skipped.push({ path, reason: '凭据、运行状态或专用资产路径' }); return }
    const full = path ? join(root, ...path.split('/')) : root
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) { result.skipped.push({ path, reason: '符号链接' }); return }
    if (++visited > 10000) { result.complete = false; return }
    if (stat.isDirectory()) { for (const name of readdirSync(full).sort()) walk(path ? `${path}/${name}` : name); return }
    if (!stat.isFile() || !/\.(?:md|json|ya?ml|toml)$/i.test(path)) return
    if (stat.size > 2 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) { result.complete = false; result.skipped.push({ path, reason: '扫描大小上限' }); return }
    bytes += stat.size
    try {
      const value = fileAt(root, path)!
      result.files.set(path, value)
      if (/\.md$/i.test(path)) result.references.push(...links(path, value.text))
    } catch { result.complete = false; result.skipped.push({ path, reason: '不可读取的文本' }) }
  }
  walk('')
  // 配置中的字面路径只作为引用证据；插值和运行时装配需要语义核对。
  for (const [path, file] of result.files) if (!/\.md$/i.test(path)) {
    for (const match of file.text.matchAll(/["']([^"'\n]+\.md)(?:#[^"'\n]*)?["']/g)) {
      const literal = match[1].replace(/^\.\//, '')
      const target = result.files.has(literal) ? literal : posix.normalize(posix.join(posix.dirname(path), literal))
      result.references.push({ path, target, line: file.text.slice(0, match.index).split('\n').length, kind: 'configuration' })
    }
  }
  return result
}
const snapshot = (scan: Scan) => sha256(JSON.stringify([...scan.files].map(([path, file]) => [path, file.sha256, file.mode])))
function present(root: string, target: string) {
  if (target === '..' || target.startsWith('../')) return false
  try { return existsSync(dataPath(root, target)) } catch { return false }
}
function inspect(root: string, input: Record<string, any>) {
  const scope = textField(input.path, 'path（工作区相对目录或文件）').replace(/\/$/, '')
  if (scope !== '.') dataPath(root, scope)
  const included = (path: string) => scope === '.' || path === scope || path.startsWith(scope + '/')
  const scanned = scan(root)
  const findings: Record<string, any>[] = []
  for (const [path, file] of scanned.files) if (included(path) && /\.md$/i.test(path)) {
    const references = scanned.references.filter(ref => ref.target === path)
    const broken = scanned.references.filter(ref => ref.path === path && !present(root, ref.target))
    const reasons = broken.length ? ['存在失效的本地链接'] : []
    if (!references.length && !/(?:^|\/)(?:README|AGENTS|SKILL)\.md$/.test(path)) reasons.push('未发现静态入站引用；用途仍需判断')
    if (!editable(path)) reasons.push('专用事实源，只读核对')
    if (reasons.length) findings.push({ path, group: editable(path) ? '需判断' : '受保护', reason: reasons.join('；'), source_sha256: file.sha256,
      evidence: broken, references, suggested_action: broken.length ? '核对目标并修订直接引用' : '核对真实消费者与用途', recovery_basis: '整理预览保存本次涉及文件的原文与摘要' })
  }
  return { scope, findings, scanned_files: [...scanned.files.keys()].filter(included), complete: scanned.complete,
    unscanned: scanned.skipped.filter(item => included(item.path)), limitations: ['为检查入站引用，会读取所选范围外的当前文本；跳过凭据、运行状态和专用资产，不保证动态消费者完整。', '仅核对普通 Markdown 链接和配置中的字面 Markdown 路径；锚点、代码消费者、插值和语义重复需进一步阅读。', '无入站引用、同名或时间久均不构成删除依据；受保护路径不作为通用整理目标。'] }
}
function directory(root: string, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail('operation_id 无效')
  return dataPath(root, `.local/document-operations/${id}/operation.json`)
}
function save(root: string, op: Operation) { atomicWrite(directory(root, op.operation_id), JSON.stringify(op, null, 2), 0o600) }
function read(root: string, input: Record<string, any>): Operation { return JSON.parse(readFileSync(directory(root, textField(input.operation_id, 'operation_id')), 'utf8')) }
function receipt(root: string, op: Operation) {
  return { operation_id: op.operation_id, state: op.state, plan_sha256: op.plan_sha256, error: op.error,
    files: op.rows.map(row => ({ path: row.path, before_sha256: row.before?.sha256 ?? null, after_sha256: row.after?.sha256 ?? null,
      current_sha256: fileAt(root, row.path)?.sha256 ?? null })), next_action: op.state === 'prepared' ? 'documents/apply' : op.state === 'applied' ? 'documents/status' : 'documents/recover' }
}
function prepare(root: string, input: Record<string, any>) {
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100) fail('changes 需要 1–100 项明确修改')
  const scanned = scan(root)
  if (!scanned.complete) fail('当前引用扫描不完整，请缩小工作区或先处理不可读文本')
  const changes = new Map<string, Row>()
  function add(path: string, after: File | null, expected: unknown) {
    dataPath(root, path)
    if (!editable(path)) fail(`${path} 不是通用可编辑文档，请使用专用入口`)
    if (changes.has(path)) fail(`${path} 在同一预览中重复修改`)
    const before = fileAt(root, path)
    if (expected !== (before?.sha256 ?? null)) fail(`${path} 摘要已变化，请重新读取`)
    if (after && containsLiteralLlmKey(path, after.text)) fail('文档不得包含 LLM API Key')
    changes.set(path, { path, before, after })
  }
  for (const item of input.changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('changes 每项必须是对象')
    const path = textField(item.path, 'path')
    dataPath(root, path)
    if (!editable(path)) fail(`${path} 不是通用可编辑文档，请使用专用入口`)
    if (item.kind === 'update') add(path, hashFile(textField(item.content, 'content'), fileAt(root, path)?.mode ?? 0o644), item.expected_sha256)
    else if (item.kind === 'delete') { if (!fileAt(root, path)) fail(`${path} 不存在`); add(path, null, item.expected_sha256) }
    else if (item.kind === 'move') {
      const to = textField(item.to, 'to'), source = fileAt(root, path) ?? fail(`${path} 不存在`)
      dataPath(root, to)
      if (!editable(to)) fail(`${to} 不是通用可编辑文档，请使用专用入口`)
      if (fileAt(root, to)) fail(`${to} 已存在，不能覆盖移动`)
      add(path, null, item.expected_sha256); add(to, item.content === undefined ? source : hashFile(textField(item.content, 'content'), source.mode), null)
    } else fail('kind 只能为 update、move 或 delete')
  }
  // 修改后的直接引用必须指向存在的对象；原有失效引用只在本次修改触及时要求修正。
  const after = new Map(scanned.files)
  for (const row of changes.values()) { if (row.after) after.set(row.path, row.after); else after.delete(row.path) }
  for (const [path, file] of after) {
    const refs = /\.md$/i.test(path) ? links(path, file.text) : scanned.references.filter(ref => ref.path === path)
    for (const ref of refs) if (changes.get(ref.target)?.after === null || (changes.has(path) && !after.has(ref.target) && !present(root, ref.target))) fail(`${path}:${ref.line} 仍引用缺失目标 ${ref.target}；请在同批 changes 中修订引用`)
  }
  const rows = [...changes.values()]
  const op: Operation = { operation_id: randomUUID(), state: 'prepared', rows, snapshot_sha256: snapshot(scanned), plan_sha256: sha256(JSON.stringify(rows)) }
  save(root, op)
  return { ...receipt(root, op), preview: rows.map(row => ({ path: row.path, before_sha256: row.before?.sha256 ?? null, content: row.after?.text ?? null })),
    apply_input: { operation_id: op.operation_id, expected_plan_sha256: op.plan_sha256 }, limitations: ['预览不修改文档；动态消费者须先由助手核对。执行后可按原 operation_id 查询或恢复。'] }
}
function write(root: string, path: string, file: File | null) { const full = dataPath(root, path); if (file) atomicWrite(full, file.text, file.mode); else rmSync(full) }
function recover(root: string, op: Operation) {
  for (const row of op.rows) {
    const current = fileAt(root, row.path)
    if (!same(current, row.before) && !same(current, row.after)) fail(`${row.path} 已被并行修改，保留现场；不能覆盖恢复`)
  }
  for (const row of [...op.rows].reverse()) if (!same(fileAt(root, row.path), row.before)) write(root, row.path, row.before)
  op.state = 'recovered'; save(root, op)
  return receipt(root, op)
}
export function documentOperation(root: string, action: string, input: Record<string, any>) {
  if (action === 'inspect') return inspect(root, input)
  if (action === 'prepare') return prepare(root, input)
  const op = read(root, input)
  if (action === 'status') return receipt(root, op)
  if (input.expected_plan_sha256 !== op.plan_sha256 || sha256(JSON.stringify(op.rows)) !== op.plan_sha256) fail('整理预览摘要不匹配')
  if (action === 'recover') {
    if (op.state === 'prepared') fail('预览尚未执行，无需恢复')
    return recover(root, op)
  }
  if (action !== 'apply') fail('未知文档操作')
  if (op.state === 'applied') return receipt(root, op)
  if (op.state !== 'prepared') fail('请先查询原操作状态，不重放整理')
  const scanned = scan(root)
  if (!scanned.complete || snapshot(scanned) !== op.snapshot_sha256) fail('文档或引用已变化，请重新准备预览')
  for (const row of op.rows) if (!same(fileAt(root, row.path), row.before)) fail(`${row.path} 已变化，请重新准备预览`)
  op.state = 'applying'; save(root, op)
  try {
    for (const row of op.rows) {
      if (!same(fileAt(root, row.path), row.before)) fail(`${row.path} 已变化`)
      write(root, row.path, row.after)
    }
    op.state = 'applied'; save(root, op)
    return receipt(root, op)
  } catch (error) {
    op.error = (error as Error).message
    try { recover(root, op) } catch { op.state = 'interrupted'; save(root, op) }
    throw error
  }
}
