import { VERSION_ID } from '../version-id.ts'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { versionIdentity } from '../agents/version-source.ts'

export const EXPERIMENT = VERSION_ID
export const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EXCLUDED = new Set(['runs', 'history', 'RuntimeHOME', 'sessions', 'cache', '.git', 'node_modules', '__pycache__'])
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

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
