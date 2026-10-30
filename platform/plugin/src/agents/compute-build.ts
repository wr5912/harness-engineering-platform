import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { load, dump } from 'js-yaml'
import { candidateDigest, dataPath, sourceInfo } from '../tasks/files.ts'
import { programRoot } from '../workspace.ts'
import { AssetCompileError, compileManagedAsset } from './asset-build-core.ts'

type Body = Record<string, any>
type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const ENTRY = 'dsh/managed/compute-workflow/index.ts'
const RUNTIME_RESOLVER = 'runtime/adapters/dsh-web/src/resolve-runtime.ts'
class BuildError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function atomic(file: string, value: string | Uint8Array) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temp, value); renameSync(temp, file) } finally { rmSync(temp, { force: true }) }
}
function runtimeDigests() {
  const program = programRoot()
  function tree(folder: string): string[] { return readdirSync(folder, { withFileTypes: true }).flatMap(item => item.isDirectory() ? tree(join(folder, item.name)) : [join(folder, item.name)]).sort() }
  const runnerFiles = [...tree(join(program, 'platform/plugin/src/workflows')), join(program, 'platform/plugin/src/evaluation/model-attempts.ts'), join(program, RUNTIME_RESOLVER)]
  return { runner_sha256: hash(JSON.stringify(runnerFiles.map(file => [relative(program, file), hash(readFileSync(file))]))),
    deps_sha256: hash(readFileSync(join(program, 'platform/plugin/pnpm-lock.yaml'))) }
}

/** 只核对已保存构建摘要，不编译、不装载业务代码。 */
export function inspectComputeBuild(assetRoot: string, experimentId: string) {
  try {
    const source = sourceInfo(assetRoot, experimentId)
    const change = load(readFileSync(dataPath(assetRoot, `evolution/experiments/${source.id}/change.yaml`), 'utf8')) as Body
    const receipt = change.compute_variant_build
    if (!receipt) return { verified: false, reasons: ['尚未构建工作流'], receipt: null }
    const reasons: string[] = [], current = runtimeDigests()
    if (receipt.schema_version !== 1 || !/^[0-9a-f]{64}$/.test(receipt.build_digest ?? '')) reasons.push('构建回执格式不完整')
    if (receipt.source_sha256 !== hash(JSON.stringify(receipt.source_files))) reasons.push('源码清单摘要不匹配')
    for (const key of ['runner_sha256', 'deps_sha256'] as const) if (receipt[key] !== current[key]) reasons.push(`${key} 已变化，需要重新构建`)
    if (receipt.candidate_sha256 !== candidateDigest(source.candidate)) reasons.push('Candidate 已变化，需要重新构建')
    if (!Array.isArray(receipt.source_files) || receipt.source_files.some((item: any) => hash(readFileSync(dataPath(source.candidate, item.path))) !== item.sha256)) reasons.push('工作流源码摘要不匹配')
    if (hash(readFileSync(dataPath(source.candidate, receipt.output_path))) !== receipt.esm_sha256) reasons.push('ESM 制品摘要不匹配')
    return { verified: !reasons.length, reasons, receipt }
  } catch { return { verified: false, reasons: ['构建来源、制品或回执无法完整读取'], receipt: null } }
}

/** 固定编译器只读取源码，不导入或执行 Candidate，也不运行它的构建脚本。 */
export function createComputeBuildHandler(assetRoot: string) {
  const root = resolve(assetRoot)
  let busy = false
  async function prepare(body: Body, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const source = sourceInfo(root, body.experiment_id)
    const before = candidateDigest(source.candidate)
    if (body.expected_candidate_sha256 && body.expected_candidate_sha256 !== before) throw new BuildError('conflict', 'Candidate 已变化，请重新预览构建')
    const entryPath = body.entry_path ?? ENTRY
    if (typeof entryPath !== 'string' || !entryPath.startsWith('dsh/managed/') || !entryPath.endsWith('.ts')) throw new BuildError('invalid_request', '入口必须是 Candidate Managed 中的 TypeScript 文件')
    const entry = dataPath(source.candidate, entryPath)
    const outputPath = entryPath.replace(/\.ts$/, '.mjs'), output = dataPath(source.candidate, outputPath)
    const changeFile = dataPath(root, `evolution/experiments/${source.id}/change.yaml`)
    const changeText = readFileSync(changeFile, 'utf8'), change = load(changeText) as Body
    if (change?.experiment_id !== source.id || change.agent_id !== source.agent_id || !change.compute_variant) throw new BuildError('invalid_request', '仅能构建已建立算力比较计划的目标版本')
    let baseReceipt!: { schema_version: number; entry_path: string; output_path: string; source_sha256: string;
      source_files: { path: string; sha256: string }[]; runner_sha256: string; deps_sha256: string; compiler: { typescript: string; esbuild: string } }
    let buildDigest!: string
    const built = await compileManagedAsset({ candidate: source.candidate, entry, output, legacyWorkflow: true,
      beforeBundle(sources, compiler) {
        baseReceipt = { schema_version: 1, entry_path: entryPath, output_path: outputPath,
          source_sha256: hash(JSON.stringify(sources)), source_files: sources, ...runtimeDigests(), compiler }
        buildDigest = hash(JSON.stringify(baseReceipt))
        return { __WORKFLOW_BUILD_DIGEST__: JSON.stringify(buildDigest), __WORKFLOW_SOURCE_DIGEST__: JSON.stringify(baseReceipt.source_sha256) }
      } }, signal)
    const sources = built.sources
    const currentRuntime = runtimeDigests()
    if (currentRuntime.runner_sha256 !== baseReceipt.runner_sha256 || currentRuntime.deps_sha256 !== baseReceipt.deps_sha256
      || sources.some(item => hash(readFileSync(dataPath(source.candidate, item.path))) !== item.sha256)) throw new BuildError('conflict', '编译期间工作流、共享运行器或依赖发生变化，请重新预览')
    const receipt = { ...baseReceipt, build_digest: buildDigest, esm_sha256: hash(built.artifact) }
    const value = { experiment_id: source.id, candidate_sha256: before, ...receipt,
      notes: ['仅执行 TypeScript 检查和固定编译；尚未执行 Candidate、启动 DSH 或证明业务效果。'] }
    return { source, before, changeFile, changeText, change, output, artifact: built.artifact, receipt,
      value: { ...value, preview_sha256: hash(JSON.stringify(value)) } }
  }
  return async (method: string, body: Body, signal?: AbortSignal): Promise<Result> => {
    if (!['preview', 'build'].includes(method)) return { ok: false, error: { code: 'method_not_found', message: '未知工作流构建操作' } }
    if (method === 'build' && busy) return { ok: false, error: { code: 'conflict', message: '工作流正在构建' } }
    if (method === 'build') busy = true
    try {
      const prepared = await prepare(body, signal)
      if (method === 'preview') return { ok: true, value: prepared.value }
      if (!body.expected_candidate_sha256 || body.expected_preview_sha256 !== prepared.value.preview_sha256) throw new BuildError('conflict', '请先预览并确认同一份工作流构建')
      if (candidateDigest(prepared.source.candidate) !== prepared.before || readFileSync(prepared.changeFile, 'utf8') !== prepared.changeText) throw new BuildError('conflict', '构建期间目标资产或计划已变化')
      const previous = existsSync(prepared.output) ? readFileSync(prepared.output) : null
      atomic(prepared.output, prepared.artifact)
      try {
        if (readFileSync(prepared.changeFile, 'utf8') !== prepared.changeText) throw new BuildError('conflict', '保存构建回执前计划已变化')
        const receipt = { ...prepared.receipt, candidate_sha256: candidateDigest(prepared.source.candidate) }
        atomic(prepared.changeFile, dump({ ...prepared.change, compute_variant_build: receipt }, { lineWidth: -1, noRefs: true }))
        return { ok: true, value: { experiment_id: prepared.source.id, ...receipt } }
      } catch (error) {
        if (existsSync(prepared.output) && hash(readFileSync(prepared.output)) === prepared.receipt.esm_sha256) {
          if (previous) atomic(prepared.output, previous); else rmSync(prepared.output)
        }
        throw error
      }
    } catch (error) {
      return { ok: false, error: { code: signal?.aborted ? 'aborted' : (error instanceof BuildError || error instanceof AssetCompileError) ? error.code : 'build_failed',
        message: signal?.aborted ? '构建已取消' : (error instanceof BuildError || error instanceof AssetCompileError) ? error.message : '工作流构建失败，请检查入口、依赖与类型' } }
    } finally { if (method === 'build') busy = false }
  }
}
