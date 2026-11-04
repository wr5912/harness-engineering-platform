import { VERSION_ID } from '../version-id.ts'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { versionIdentity } from '../agents/version-source.ts'

export const EXPERIMENT = VERSION_ID
export const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EXCLUDED = new Set(['runs', 'history', 'RuntimeHOME', 'sessions', 'cache', '.git', 'node_modules', '__pycache__'])
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function atomicWrite(file: string, body: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString('hex')}.tmp`
  const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : undefined
  try {
    writeFileSync(tmp, body, { flag: 'wx', mode })
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, file)
  } finally { rmSync(tmp, { force: true }) }
}

/** 业务路径必须保持相对身份；拒绝路径任意一层的符号链接。 */
export function dataPath(root: string, path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('路径必须是工作区内的 POSIX 相对路径')
  }
  let cursor = resolve(root)
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('不允许符号链接路径')
  }
  return cursor
}

export function sourceInfo(root: string, source: string) {
  const id = typeof source === 'string' ? source.replace(/^experiment:/, '') : ''
  const match = EXPERIMENT.exec(id)
  if (!match) throw new Error('来源必须是固定 Experiment 身份')
  const change = versionIdentity(root, id)
  const candidate = dataPath(root, `evolution/experiments/${id}/candidate`)
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) throw new Error('Candidate 不存在')
  return { id, source: `experiment:${id}`, agent_id: change.agent_id as string, candidate }
}

/** 与 run_record.candidate_digest 共用路径、执行位和内容摘要口径。 */
export function candidateDigest(candidate: string): string {
  const hash = createHash('sha256')
  for (const entry of candidateFiles(candidate)) {
    const mode = lstatSync(join(candidate, entry)).mode & 0o111 ? 0o755 : 0o644
    hash.update(JSON.stringify([entry, mode, sha256(readFileSync(join(candidate, entry)))]))
  }
  return hash.digest('hex')
}

export function gitCandidateDigest(root: string, id: string, ref: string): string | null {
  const base = `evolution/experiments/${id}/candidate/`
  const listed = spawnSync('git', ['ls-tree', '-rz', '--full-tree', ref.slice(4), '--', base.slice(0, -1)], { cwd: root, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })
  if (listed.status !== 0) return null
  const records = listed.stdout.toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(row)
    return match ? { mode: Number.parseInt(match[1]!, 8) & 0o777, object: match[2]!, path: match[3]!.slice(base.length), symlink: match[1] === '120000' } : null
  }).filter((row): row is NonNullable<typeof row> => row !== null)
    .filter(row => !row.path.split('/').some(part => EXCLUDED.has(part) || part.endsWith('.llm-api-key')))
  if (!records.length || records.some(row => row.symlink)) return null
  // 与工作树扫描一致：按目录项排序后深度遍历，而非整条路径的字符串顺序。
  records.sort((left, right) => {
    const a = left.path.split('/'), b = right.path.split('/')
    for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
    return a.length - b.length
  })
  const blobs = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: records.map(row => row.object).join('\n') + '\n', maxBuffer: 100 * 1024 * 1024 })
  if (blobs.status !== 0) return null
  const hash = createHash('sha256')
  let offset = 0
  for (const row of records) {
    const end = blobs.stdout.indexOf(10, offset)
    const header = blobs.stdout.subarray(offset, end).toString('ascii').split(' ')
    const size = Number(header[2])
    if (end < 0 || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) return null
    const data = blobs.stdout.subarray(end + 1, end + 1 + size)
    if (data.length !== size) return null
    hash.update(JSON.stringify([row.path, row.mode, sha256(data)]))
    offset = end + size + 2
  }
  return hash.digest('hex')
}

export function candidateFiles(candidate: string, extraExcluded: readonly string[] = []): string[] {
  const files: string[] = []
  const excluded = extraExcluded.length ? new Set([...EXCLUDED, ...extraExcluded]) : EXCLUDED
  function walk(path: string) {
    for (const name of readdirSync(join(candidate, path)).sort()) {
      if (excluded.has(name) || name.endsWith('.llm-api-key')) continue
      const rel = path ? `${path}/${name}` : name
      const stat = lstatSync(join(candidate, rel))
      if (stat.isSymbolicLink()) throw new Error('Candidate 不能包含符号链接')
      if (stat.isDirectory()) walk(rel)
      else if (stat.isFile()) files.push(rel)
    }
  }
  walk('')
  return files
}

export function assertAssetPath(path: string): void {
  if (path.split('/').some(name => EXCLUDED.has(name) || name === '.env' || name.endsWith('.llm-api-key'))) {
    throw new Error('运行状态、依赖、环境凭据和 LLM API Key 不能作为装配资产')
  }
}
