import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { candidateDigest, candidateFiles, dataPath, sourceInfo as experimentSource } from '../tasks/files.ts'
import { businessSource, businessSourceSelector } from './business-source.ts'
import { programRoot } from '../workspace.ts'
import { assertRuntimeCandidateOrigin } from '../models/harness-runtime.ts'
import { standardDependencies } from '../../../../runtime/adapters/dsh-container/standard-dependencies.mts'

type Body = Record<string, any>
export type DependencyTarget = { image: string; image_id: string; python_version: string; python_abi: string; os: string; libc: string; architecture: string }
export type DependencyMount = { source: string; target: string; read_only: true }
export type PreparedAssetDependencies = { status: 'ready' | 'pending'; reasons: string[]; mounts: DependencyMount[]; environment: Record<string, string>; target?: DependencyTarget; receipt?: Body }
export type AssetCommand = (command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }) => Promise<string>
type Declaration = { kind: 'node' | 'python'; path: string; directory: string; files: { path: string; sha256: string }[] }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const omitted = ['.venv', 'venv', '.local', '.env']
function sourceInfo(root: string, id: string) {
  if (!id?.startsWith('business:')) return experimentSource(root, id)
  const source = businessSource(root, id)
  return { id: source.source_id as string, source: source.source_id as string, agent_id: source.agent_id as string,
    candidate: resolve(source.repository_root, source.candidate_root, '..') }
}
class DependencyError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
export const assetCommand: AssetCommand = (command, args, options) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } })
  let output = '', size = 0, stopped: string | undefined
  const collect = (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) { stopped ??= '输出超过 4 MiB 上限'; child.kill('SIGKILL') } else output += chunk.toString() }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const timeout = options.timeout ?? 180_000
  const timer = setTimeout(() => { stopped ??= `超时（${timeout / 1000} 秒）`; child.kill('SIGKILL') }, timeout)
  child.on('error', error => { clearTimeout(timer); fail(error) })
  // 不返回安装器的原始输出，包索引凭据和来源 URL 不进入普通回执。
  child.on('close', (code, signal) => { clearTimeout(timer); code === 0 && !stopped ? done(output.trim()) : fail(new DependencyError('dependency_pending', `${command} 依赖准备未完成（${stopped ?? (signal ? `进程被 ${signal} 终止` : `退出码 ${code}`)}），请核对目标环境、包版本和网络后重试`)) })
})
function readNodeManifest(path: string) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`无法读取依赖声明 ${path}：${error instanceof Error ? error.message : String(error)}`) }
}
function declarations(candidate: string): Declaration[] {
  const files = candidateFiles(candidate, omitted).filter(path => /^dsh\/(?:managed|workspace)\//.test(path))
  const folders = new Map<string, string[]>()
  for (const path of files) if (/\/(?:package\.json|requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt|pyproject\.toml)$/.test(path)) {
    const directory = dirname(path), names = folders.get(directory) ?? []; names.push(path); folders.set(directory, names)
  }
  const result: Declaration[] = []
  for (const [directory, names] of folders) {
    const node = names.find(path => path.endsWith('/package.json'))
    if (node) {
      const manifest = readNodeManifest(dataPath(candidate, node))
      if (Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length) {
        const lock = `${directory}/package-lock.json`
        result.push({ kind: 'node', path: node, directory, files: [node, ...(existsSync(dataPath(candidate, lock)) ? [lock] : [])].map(path => ({ path, sha256: hash(readFileSync(dataPath(candidate, path))) })) })
      }
    }
    const pythonNames = names.filter(path => !path.endsWith('/package.json'))
    const python = pythonNames.find(path => path.endsWith('/pyproject.toml')) ?? pythonNames.find(path => path.endsWith('/requirements.txt')) ?? pythonNames.filter(path => !path.endsWith('/requirements.lock.txt')).sort()[0] ?? pythonNames.find(path => path.endsWith('/requirements.lock.txt'))
    if (python && !python.endsWith('/package.json')) {
      const lock = `${directory}/requirements.lock.txt`
      result.push({ kind: 'python', path: python, directory, files: [python, ...(python !== lock && existsSync(dataPath(candidate, lock)) ? [lock] : [])].map(path => ({ path, sha256: hash(readFileSync(dataPath(candidate, path))) })) })
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
export function assetDependencyDeclarations(candidate: string) { return declarations(candidate) }
function declarationHash(items: Declaration[]) { return hash(JSON.stringify(items)) }
/** 只读验证，不探测 Docker，也不执行已准备模块。供实例和评测共用。 */
export function resolvePreparedAssetDependencies(assetRoot: string, experimentId: string, _expected: { image?: string; image_id?: string } = {}, candidatePath?: string): PreparedAssetDependencies {
  try {
    const sourceId = candidatePath && experimentId.startsWith('business:') ? businessSourceSelector(assetRoot, experimentId, candidatePath) : experimentId
    const source = candidatePath ? { id: sourceId, candidate: assertRuntimeCandidateOrigin(assetRoot, candidatePath) } : sourceInfo(assetRoot, sourceId)
    if (candidatePath && resolve(sourceInfo(assetRoot, sourceId).candidate) !== resolve(source.candidate)) throw new Error('依赖来源版本不一致')
    const items = declarations(source.candidate)
    if (!items.length) return { status: 'ready', reasons: [], mounts: [], environment: {} }
    const standard = standardDependencies(programRoot())
    const missing = items.flatMap(item => (item.kind === 'node'
      ? standard.node(readNodeManifest(dataPath(source.candidate, item.path)))
      : standard.python(pythonRequirements(source.candidate, item).trim().split('\n').filter(Boolean)))
      .map(name => `${item.path}: ${name}`))
    return { status: missing.length ? 'pending' : 'ready',
      reasons: missing.length ? [`标准 Runtime 镜像尚未包含兼容依赖：${missing.join('、')}；请更新平台 Runtime 依赖锁并重建共享标准镜像`] : [],
      mounts: [], environment: {}, receipt: { declarations_sha256: declarationHash(items) } }
  } catch (error) { return { status: 'pending', reasons: [`无法核对业务来源 ${experimentId} 与标准 Runtime 依赖锁：${error instanceof Error ? error.message : String(error)}`], mounts: [], environment: {} } }
}

function pythonRequirements(candidate: string, item: Declaration) {
  const text = readFileSync(dataPath(candidate, item.path), 'utf8')
  let lines: string[]
  if (item.path.endsWith('.toml')) {
    const project = /(?:^|\n)\s*\[project\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/.exec(text)?.[1] ?? ''
    const opening = /(?:^|\n)\s*dependencies\s*=\s*\[/.exec(project)
    let list: string | undefined
    if (opening) {
      const start = opening.index + opening[0].length
      let quote = ''
      for (let index = start; index < project.length; index++) {
        const char = project[index]
        if (quote) { if (char === '\\' && quote === '"') index++; else if (char === quote) quote = '' }
        else if (char === '"' || char === "'") quote = char
        else if (char === ']') { list = project.slice(start, index); break }
      }
    }
    if (list === undefined) throw new DependencyError('dependency_pending', 'Python 项目没有静态 dependencies，需先声明明确的业务依赖')
    lines = [...list.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'/g)].map(match => match[1] ?? match[2])
  } else lines = text.split(/\r?\n/).map(line => line.replace(/\s+--hash=sha256:[a-f0-9]{64}/g, '').trim()).filter(line => line && !line.startsWith('#'))
  // 只解析包索引声明，不允许本地目录、VCS、可编辑包、索引重定向和源构建。
  if (lines.some(line => !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*[<>=!~].*)?$/.test(line) || /(?:https?:|git\+|file:|\s@\s|--)/.test(line))) throw new DependencyError('dependency_pending', 'Python 依赖含本地、VCS、URL 或安装选项；请先提供包索引版本声明')
  return lines.join('\n') + '\n'
}
/** 保留依赖操作入口，但只核对标准 Runtime，不安装宿主依赖或生成挂载回执。 */
export function createAssetDependenciesHandler(assetRoot: string, _options: { command?: AssetCommand } = {}) {
  return async (body: Body, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted()
      const source = sourceInfo(assetRoot, body.experiment_id)
      if (body.expected_candidate_sha256 && body.expected_candidate_sha256 !== candidateDigest(source.candidate)) {
        return { ok: false as const, error: { code: 'conflict', message: 'Harness 已变化，请重新读取依赖声明' } }
      }
      const dependencies = resolvePreparedAssetDependencies(assetRoot, source.id)
      return dependencies.status === 'ready'
        ? { ok: true as const, value: { experiment_id: source.id, ...dependencies } }
        : { ok: false as const, error: { code: 'dependency_pending', message: dependencies.reasons.join('；') } }
    } catch (error) { return { ok: false as const, error: { code: signal?.aborted ? 'aborted' : 'dependency_pending', message: signal?.aborted ? '依赖核对已取消' : error instanceof Error ? error.message : '无法读取业务依赖声明' } } }
  }
}
