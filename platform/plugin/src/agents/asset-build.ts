import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import { candidateDigest, dataPath, sourceInfo } from '../tasks/files.ts'
import { programRoot } from '../workspace.ts'
import { resolvePreparedAssetDependencies } from './asset-dependencies.ts'
import { assetCompiler, AssetCompileError, compileManagedAsset, protectedBuildSource } from './asset-build-core.ts'

type Body = Record<string, any>
type Result = { ok: true; value: Body } | { ok: false; error: { code: string; message: string } }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const buildInputKeys = ['schema_version', 'entry_path', 'output_path', 'compiler', 'dependencies_sha256', 'source_files', 'source_sha256', 'platform_sources', 'platform_sources_sha256'] as const
const trustedBuildSource = (path: unknown): path is string => typeof path === 'string' && (path.startsWith('platform/plugin/src/workflows/')
  || path === 'platform/plugin/src/evaluation/model-attempts.ts' || path === 'runtime/adapters/dsh-web/src/resolve-runtime.ts')
class BuildError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function atomic(file: string, value: string | Uint8Array) { mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { writeFileSync(temp, value); renameSync(temp, file) } finally { rmSync(temp, { force: true }) } }
/** 仅检查当前入口的构建证据；不执行 Candidate 或触发构建。 */
export function inspectAssetBuild(assetRoot: string, experimentId: string, entryPath?: string) {
  try {
    const source = sourceInfo(assetRoot, experimentId)
    const change = load(readFileSync(dataPath(assetRoot, `evolution/experiments/${source.id}/change.yaml`), 'utf8')) as Body
    const receipts = Object.values(change.asset_builds ?? {}) as Body[]
    const selected = entryPath ? receipts.filter(item => item.entry_path === entryPath) : receipts
    if (!selected.length) return { verified: false, reasons: ['尚未构建该 Managed TypeScript 入口'], receipts: [] }
    const reasons: string[] = [], compiler = assetCompiler().receipt
    for (const receipt of selected) {
      const identityKeys = [...buildInputKeys, 'source_inputs_version']
      if (receipt.source_inputs_version !== 1) reasons.push('构建回执未完整记录实际输入，需要重新受控构建')
      if (typeof receipt.entry_path !== 'string' || !receipt.entry_path.startsWith('dsh/managed/') || !receipt.entry_path.endsWith('.ts')
        || receipt.output_path !== receipt.entry_path.replace(/\.ts$/, '.mjs')
        || !Array.isArray(receipt.source_files) || !receipt.source_files.length || !receipt.source_files.some((item: Body) => item.path === receipt.entry_path)
        || receipt.source_inputs_version !== undefined && receipt.source_inputs_version !== 1
        || hash(JSON.stringify(Object.fromEntries(identityKeys.map(key => [key, receipt[key]])))) !== receipt.build_digest) reasons.push('受控构建输入身份不匹配')
      if (receipt.schema_version !== 1 || hash(JSON.stringify(receipt.source_files)) !== receipt.source_sha256) reasons.push('构建回执格式或源码清单摘要不匹配')
      if (JSON.stringify(receipt.compiler) !== JSON.stringify(compiler)) reasons.push('编译器或平台依赖锁已变化')
      if (!Array.isArray(receipt.source_files) || receipt.source_files.some((item: Body) => hash(readFileSync(dataPath(source.candidate, item.path))) !== item.sha256)) reasons.push('Managed 源码已变化')
      if (!Array.isArray(receipt.platform_sources) || !receipt.platform_sources.length || receipt.platform_sources.some((item: Body) => !trustedBuildSource(item.path))
        || hash(JSON.stringify(receipt.platform_sources)) !== receipt.platform_sources_sha256
        || receipt.platform_sources.some((item: Body) => hash(readFileSync(dataPath(programRoot(), item.path))) !== item.sha256)) reasons.push('共享运行器已变化')
      if (hash(readFileSync(dataPath(source.candidate, receipt.output_path))) !== receipt.esm_sha256) reasons.push('ESM 制品已变化')
      const deps = resolvePreparedAssetDependencies(assetRoot, source.id)
      if (deps.status !== 'ready' || (deps.receipt?.declarations_sha256 ?? null) !== receipt.dependencies_sha256) reasons.push('业务依赖尚未准备或声明已变化')
    }
    return { verified: !reasons.length, reasons: [...new Set(reasons)], receipts: selected }
  } catch { return { verified: false, reasons: ['构建来源、回执或制品无法完整读取'], receipts: [] } }
}

/** 固定到新 Run 的审读合同：已核验制品保留身份，业务源码与共享 SDK 源码完整进入材料。 */
export function assetBuildReviewEvidence(assetRoot: string, experimentId: string) {
  const empty = { schema_version: 1, generated: [] as Body[], sources: [] as Body[] }
  try {
    const source = sourceInfo(assetRoot, experimentId), before = candidateDigest(source.candidate)
    const changePath = dataPath(assetRoot, `evolution/experiments/${source.id}/change.yaml`), changeText = readFileSync(changePath, 'utf8')
    const change = load(changeText) as Body, generated: Body[] = [], sources = new Map<string, Body>()
    for (const candidate of Object.values(change.asset_builds ?? {}) as Body[]) {
      if (typeof candidate?.entry_path !== 'string') continue
      const checked = inspectAssetBuild(assetRoot, experimentId, candidate.entry_path)
      if (!checked.verified || checked.receipts.length !== 1) continue
      const receipt = checked.receipts[0]
      if (receipt.source_inputs_version !== 1) continue
      const dependencies = resolvePreparedAssetDependencies(assetRoot, experimentId)
      if (dependencies.status !== 'ready') continue
      const material: Body[] = []
      for (const [origin, root, files] of [['candidate', source.candidate, receipt.source_files], ['platform', programRoot(), receipt.platform_sources]] as const) {
        for (const file of files) {
          if (protectedBuildSource(file.path)) throw new Error('凭据文件不进入审读材料')
          const bytes = readFileSync(dataPath(root, file.path))
          if (hash(bytes) !== file.sha256) throw new Error('审读来源已变化')
          material.push({ origin, path: file.path, sha256: file.sha256, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) })
        }
      }
      generated.push({ path: receipt.output_path, sha256: receipt.esm_sha256,
        build: { ...Object.fromEntries([...buildInputKeys, 'source_inputs_version', 'build_digest', 'runtime_imports', 'esm_sha256'].map(key => [key, receipt[key]])),
          prepared_dependencies_sha256: hash(JSON.stringify(dependencies.receipt ?? null)) } })
      for (const item of material) sources.set(`${item.origin}:${item.path}`, item)
    }
    if (candidateDigest(source.candidate) !== before || readFileSync(changePath, 'utf8') !== changeText) throw new Error('审读来源已变化')
    const evidence = { schema_version: 1, generated, sources: [...sources.values()] }
    return { ...evidence, candidate_sha256: before }
  } catch { return empty }
}
/** 普通 EXP 的受控 TS→ESM 构建；不读取来源构建配置，不运行脚本或导入模块。 */
export function createAssetBuildHandler(assetRoot: string) {
  const root = resolve(assetRoot), busy = new Set<string>()
  async function prepare(body: Body, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const source = sourceInfo(root, body.experiment_id)
    if (!source.id.startsWith('EXP-')) throw new BuildError('invalid_request', '变体继续使用其算力工作流构建操作')
    const before = candidateDigest(source.candidate)
    if (body.expected_candidate_sha256 && before !== body.expected_candidate_sha256) throw new BuildError('conflict', 'Candidate 已变化，请重新预览构建')
    const entryPath = body.entry_path
    if (typeof entryPath !== 'string' || !entryPath.startsWith('dsh/managed/') || !entryPath.endsWith('.ts') || entryPath.endsWith('.d.ts')) throw new BuildError('invalid_request', '入口必须是 Candidate Managed 中的 TypeScript 文件')
    const entry = dataPath(source.candidate, entryPath), outputPath = entryPath.replace(/\.ts$/, '.mjs'), output = dataPath(source.candidate, outputPath)
    const changeFile = dataPath(root, `evolution/experiments/${source.id}/change.yaml`), changeText = readFileSync(changeFile, 'utf8'), change = load(changeText) as Body
    if (change.compute_variant) throw new BuildError('invalid_request', '该来源已建立算力变体计划，请使用原有工作流构建操作')
    const dependencies = resolvePreparedAssetDependencies(root, source.id)
    if (dependencies.status !== 'ready') throw new BuildError('dependency_pending', dependencies.reasons.join('；'))
    const compilerReceipt = assetCompiler().receipt
    let receipts!: Body, buildDigest!: string
    const runtimeDirectory = dirname('/opt/dsh-managed/' + entryPath.slice('dsh/managed/'.length))
    const dependencyRoots = dependencies.mounts.filter(item => item.target.endsWith('/node_modules')
      && (runtimeDirectory === dirname(item.target) || runtimeDirectory.startsWith(dirname(item.target) + '/'))).map(item => dirname(item.source))
    const built = await compileManagedAsset({ candidate: source.candidate, entry, output,
      dependencyRoots,
      beforeBundle(sources, _compiler, platformSources) {
        receipts = { schema_version: 1, entry_path: entryPath, output_path: outputPath, compiler: compilerReceipt,
          dependencies_sha256: dependencies.receipt?.declarations_sha256 ?? null, source_files: sources, source_sha256: hash(JSON.stringify(sources)),
          platform_sources: platformSources, platform_sources_sha256: hash(JSON.stringify(platformSources)), source_inputs_version: 1 }
        buildDigest = hash(JSON.stringify(receipts))
        return { __WORKFLOW_BUILD_DIGEST__: JSON.stringify(buildDigest), __WORKFLOW_SOURCE_DIGEST__: JSON.stringify(receipts.source_sha256) }
      } }, signal)
    const receipt: Body = { ...receipts, runtime_imports: built.runtime_imports, build_digest: buildDigest, esm_sha256: hash(built.artifact) }
    if (candidateDigest(source.candidate) !== before || readFileSync(changeFile, 'utf8') !== changeText) throw new BuildError('conflict', '编译期间 Candidate 或版本说明已变化，请重新预览')
    const value = { experiment_id: source.id, candidate_sha256: before, ...receipt, notes: ['仅完成固定编译和类型检查；未装载插件、启动实例或验证业务行为。'] }
    return { source, before, change, changeFile, changeText, output, artifact: built.artifact, receipt, value: { ...value, preview_sha256: hash(JSON.stringify(value)) } }
  }
  return async (method: string, body: Body, signal?: AbortSignal): Promise<Result> => {
    if (!['preview', 'build'].includes(method)) return { ok: false, error: { code: 'method_not_found', message: '未知资产构建操作' } }
    const key = String(body.experiment_id), lock = method === 'build'
    if (lock && busy.has(key)) return { ok: false, error: { code: 'conflict', message: '该版本正在构建资产' } }
    if (lock) busy.add(key)
    try {
      const prepared = await prepare(body, signal)
      if (!lock) return { ok: true, value: prepared.value }
      if (!body.expected_candidate_sha256 || body.expected_preview_sha256 !== prepared.value.preview_sha256) throw new BuildError('conflict', '请先预览并构建同一份资产')
      if (candidateDigest(prepared.source.candidate) !== prepared.before || readFileSync(prepared.changeFile, 'utf8') !== prepared.changeText) throw new BuildError('conflict', '保存前 Candidate 或版本说明已变化')
      const previous = existsSync(prepared.output) ? readFileSync(prepared.output) : null
      atomic(prepared.output, prepared.artifact)
      try {
        if (readFileSync(prepared.changeFile, 'utf8') !== prepared.changeText) throw new BuildError('conflict', '保存构建回执前版本说明已变化')
        const receipt = { ...prepared.receipt, candidate_sha256: candidateDigest(prepared.source.candidate) }
        atomic(prepared.changeFile, dump({ ...prepared.change, asset_builds: { ...prepared.change.asset_builds, [prepared.receipt.entry_path]: receipt } }, { lineWidth: -1, noRefs: true }))
        return { ok: true, value: { experiment_id: prepared.source.id, ...receipt } }
      } catch (error) {
        if (existsSync(prepared.output) && hash(readFileSync(prepared.output)) === prepared.receipt.esm_sha256) { if (previous) atomic(prepared.output, previous); else rmSync(prepared.output) }
        throw error
      }
    } catch (error) { return { ok: false, error: { code: signal?.aborted ? 'aborted' : (error instanceof BuildError || error instanceof AssetCompileError) ? error.code : 'build_failed', message: signal?.aborted ? '构建已取消' : (error instanceof BuildError || error instanceof AssetCompileError) ? error.message : '资产构建失败，请核对 Managed 入口和已准备依赖' } } }
    finally { if (lock) busy.delete(key) }
  }
}
