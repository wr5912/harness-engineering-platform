import { reuseParentDependencies } from './plugin-dependency-reuse.ts'
import { assetText } from './asset-text.ts'
import { createRequire } from 'node:module'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { DEFAULT_SCHEMA, Type, load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { RunFileError, readRunReport, listRunFiles, previewRunFile, redactRunText } from './run-files.ts'
import { readRunTrace } from '../evaluation/trace.ts'
import { createDecisionDatasetHandler } from '../evaluation/datasets.ts'
import { createEvaluationJobs, EvaluationJobError, redactKnownValues } from '../evaluation/jobs.ts'
import { caseSourceReferences, createCaseManagementHandler, type RunCaseSource } from '../evaluation/cases.ts'
import { readAssetDiff, readFixedAsset } from './asset-diff.ts'
import { createAgent } from './create-agent.ts'
import { createSdkHandler } from '../sdk/operations.ts'
import { VERSION_ID, isVariantIdentity, assertInheritableVersion } from '../version-id.ts'
import { createComputeVariantsHandler, type ComputeVariantCreation } from './compute-variants.ts'
import { createTrainingServersHandler } from './training-servers.ts'
import { createComputeBuildHandler } from './compute-build.ts'
import { createAssetBuildHandler } from './asset-build.ts'
import { createAssetDependenciesHandler } from './asset-dependencies.ts'
import { createMigrationsHandler } from './migrations.ts'
import { createComputeFreezeHandler } from './compute-freeze.ts'
import { programRoot, workspaceConfigPath, workspaceLocalPath } from '../workspace.ts'
import { discoverTaskCapabilities, type CapabilityOptions } from '../tasks/capabilities.ts'
import { candidateFiles, dataPath, sourceInfo } from '../tasks/files.ts'
import { previewTaskAssembly, applyTaskAssembly, type TaskAssemblyInput } from '../tasks/assembly.ts'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'
import { materializeEvaluationSource, validateMcpFixture } from '../../../../runtime/adapters/dsh-container/evaluation-source.mts'
import { createInstancesHandler } from '../instances/index.ts'
import { inheritedLoadableAssets, assertVersionIdentity, versionIdentity, versionSource, versionSources } from './version-source.ts'
import { inspectLegacy, readResearchReference, validateResearch } from './research.ts'
import { createVariantIdentityMigrationHandler, currentVariantProjection } from './variant-identity.ts'

type JsonMap = Record<string, unknown>
type SourceCatalog = { schema_version?: string; sources?: Record<string, JsonMap> }
type RpcValue = JsonMap | JsonMap[] | string | number | boolean | null
type EvalModelPolicyProvider = (agentId: string, selection?: { provider: string; model: string; reasoningEffort?: string }, candidatePath?: string) => Promise<{ policy: unknown; environment: Record<string, string> }>

const EXP_ID = VERSION_ID
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/
const DSH_EVAL = 'runtime/adapters/dsh-container/dsh-eval'
const RUN_RECORD = 'runtime/adapters/dsh-container/run_record.py'
const VALIDATE_EXPERIMENT = 'runtime/research/validate_experiment.py'
const SOURCE_CONTRACT = 'runtime/adapters/dsh-container/source_contract.py'
const EVALUATION_CONTRACT = 'runtime/research/evaluation_contract.py'
const EXCLUDED_ASSETS = new Set(['runs', 'history', 'RuntimeHOME', 'sessions', 'cache', '.git', 'node_modules', '__pycache__'])
// DSH 的 !!js 只作为 YAML 标量解析，dry 校验不求值。
const DRAFT_YAML_SCHEMA = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))

class RpcError extends Error {
  constructor(readonly code: string, message: string, readonly details: JsonMap = {}) {
    super(message)
  }
}

function ok<T extends RpcValue>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

function failure(error: unknown): ConnectionRpcResult<never> {
  if (error instanceof EvaluationJobError) return { ok: false, error: { code: error.code, message: error.message, details: {} } }
  if (error instanceof RpcError || error instanceof RunFileError) return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
  return { ok: false, error: { code: 'asset_operation_failed', message: '智能体资产操作失败', details: { filesystem_code: code } } }
}

function requireObject(payload: unknown): JsonMap {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RpcError('invalid_request', '请求参数必须是对象')
  return payload as JsonMap
}

function stringField(payload: JsonMap, name: string): string {
  const value = payload[name]
  if (typeof value !== 'string' || !value.trim()) throw new RpcError('invalid_request', `缺少 ${name}`)
  return value.trim()
}

function agentIdField(payload: JsonMap, name = 'agent_id'): string {
  const value = stringField(payload, name)
  if (!AGENT_ID.test(value)) throw new RpcError('invalid_request', `${name} 格式无效`, { [name]: value })
  return value
}

function experimentIdValue(value: string, name = 'experiment_id'): string {
  if (!EXP_ID.test(value)) throw new RpcError('invalid_request', `${name} 格式无效`, { [name]: value })
  return value
}

function experimentIdField(payload: JsonMap, name = 'experiment_id'): string {
  return experimentIdValue(stringField(payload, name), name)
}

function optionalString(payload: JsonMap, name: string): string | undefined {
  const value = payload[name]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new RpcError('invalid_request', `${name} 必须是字符串`)
  return value
}

function textField(payload: JsonMap, name: string): string {
  const value = payload[name]
  if (typeof value !== 'string') throw new RpcError('invalid_request', `${name} 必须是字符串`)
  return value
}

function rootOf(assetRoot: string): string {
  return realpathSync(resolve(assetRoot))
}

function repoPath(root: string, rel: string): string {
  if (rel.startsWith('/') || rel.split('/').includes('..')) throw new RpcError('path_rejected', '拒绝仓库外路径', { path: rel })
  return join(root, rel)
}

function repoRelative(root: string, file: string): string {
  const rel = relative(root, file)
  if (rel.startsWith('..') || rel === '' || rel.split(sep).includes('..')) throw new RpcError('path_rejected', '拒绝仓库外路径')
  return rel.split(sep).join('/')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readText(file: string, fallback = ''): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readText(file))
}

function programArgs(args: string[]) {
  return args[0]?.startsWith('runtime/') || args[0]?.startsWith('.agents/') ? [join(programRoot(), args[0]), ...args.slice(1)] : args
}
function programEnvironment(root: string) {
  return { ...process.env, HARNESS_ASSET_ROOT: root, HARNESS_PROGRAM_ROOT: programRoot() }
}

function parseJsonCommand(root: string, args: string[], message = '命令执行失败') {
  const run = spawnSync(process.env.HARNESS_PYTHON || 'python3', programArgs(args), { cwd: root, env: programEnvironment(root), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (run.status !== 0) throw new RpcError('command_failed', message, { status: run.status, stderr: redact(run.stderr), stdout: redact(run.stdout) })
  try {
    return JSON.parse(run.stdout) as JsonMap
  } catch {
    throw new RpcError('command_failed', '命令没有返回合法 JSON', { stdout: redact(run.stdout), stderr: redact(run.stderr) })
  }
}

async function parseJsonCommandAsync(root: string, args: string[], message = '命令执行失败', signal?: AbortSignal, input?: string,
  extraEnvironment: NodeJS.ProcessEnv = {}) {
  let stdout: string
  const secrets = Object.values(extraEnvironment).filter((value): value is string => typeof value === 'string' && !!value)
  const redactEnvironment = (value: string) => redact(redactKnownValues(value, secrets))
  try {
    const pending = promisify(execFile)(process.env.HARNESS_PYTHON || 'python3', programArgs(args), {
      cwd: root, env: { ...programEnvironment(root), ...extraEnvironment }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20_000, signal,
    })
    if (input !== undefined) pending.child.stdin?.end(input)
    stdout = (await pending).stdout
  } catch (error) {
    const failed = error as Error & { stderr?: string }
    throw new RpcError('command_failed', message, { reason: redactEnvironment(failed.stderr || failed.message) })
  }
  try { return JSON.parse(stdout) as JsonMap }
  catch { throw new RpcError('command_failed', '命令没有返回合法 JSON', { stdout: redactEnvironment(stdout) }) }
}

function readYamlMap(root: string, file: string, content?: string): JsonMap {
  try {
    const value = loadYaml(content ?? readFileSync(file, 'utf8')) ?? {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML 顶层必须是 object')
    return value as JsonMap
  } catch {
    throw new RpcError('asset_read_failed', 'YAML 解析失败', { path: repoRelative(root, file) })
  }
}

function writeYamlMap(file: string, values: JsonMap) {
  atomicWrite(file, dumpYaml(values, { forceQuotes: true, quotingType: '"', lineWidth: -1, noRefs: true }))
}

function redact(text: string, limit = 4000): string {
  return text
    .replace(/Bearer\s+[^\s"'&]+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]*("|$)/gi, '$1[REDACTED]$2')
    .replace(/((?:api[_-]?key|token|password|secret)=)[^\s"'&]+/gi, '$1[REDACTED]')
    .slice(0, limit)
}

function catalog(root: string) {
  const { sources, errors } = versionSources(root)
  return { parsed: { schema_version: '2.0', sources } as SourceCatalog, errors }
}

function atomicWrite(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString('hex')}.tmp`
  const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : undefined
  try {
    writeFileSync(tmp, body, { flag: 'wx', mode })
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, file)
  } finally { rmSync(tmp, { force: true }) }
}


function listDirs(file: string): string[] {
  try {
    return readdirSync(file, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function agentDisplayName(root: string, experimentId?: string): string | undefined {
  if (!experimentId) return undefined
  const file = join(root, 'evolution/experiments', experimentId, 'candidate/harness.yaml')
  if (!existsSync(file)) return undefined
  assertNoSymlinkPath(root, file)
  const agent = readYamlMap(root, file).agent as JsonMap | undefined
  return typeof agent?.name === 'string' && agent.name.trim() ? agent.name.trim() : undefined
}

function listAgents(root: string, experiments = listExperiments(root)) {
  return listDirs(join(root, 'agents')).filter(id => AGENT_ID.test(id)).map(id => {
    const manifest = readYamlMap(root, join(root, 'agents', id, 'manifest.yaml'))
    const versions = experiments.filter(item => item.agent_id === id).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))
    const active = typeof manifest.active_experiment === 'string' && versions.some(value => value.id === manifest.active_experiment) ? manifest.active_experiment : undefined
    return { id, name: agentDisplayName(root, active ?? versions[0]?.id) ?? id, version_count: versions.length, latest_experiment_status: versions[0]?.status ?? null,
      path: `agents/${id}`, manifest, active_experiment: manifest.active_experiment ?? null }
  })
}

/** 只投影已启用版本的资产描述；发现 Skill 不表示运行实例已装载或可执行。 */
function agentDescription(root: string, payload: JsonMap) {
  const agentId = agentIdField(payload)
  const manifest = readYamlMap(root, dataPath(root, `agents/${agentId}/manifest.yaml`))
  const experimentId = typeof manifest.active_experiment === 'string' ? manifest.active_experiment : ''
  if (!experimentId) return ok({ agentId, source: null, name: null, description: null, skills: [] })
  const source = sourceInfo(root, experimentId)
  if (source.agent_id !== agentId) throw new RpcError('invalid_source', '已启用版本不属于该 Agent')
  const base = `evolution/experiments/${experimentId}/candidate`
  const harness = readYamlMap(root, dataPath(root, `${base}/harness.yaml`))
  const asset = harness.agent && typeof harness.agent === 'object' && !Array.isArray(harness.agent) ? harness.agent as JsonMap : {}
  const loadable = harness.loadable_assets && typeof harness.loadable_assets === 'object' && !Array.isArray(harness.loadable_assets) ? harness.loadable_assets as JsonMap : {}
  const presetRoot = typeof loadable.preset_root === 'string' ? loadable.preset_root : 'dsh/presets'
  const presetId = typeof loadable.preset_id === 'string' ? loadable.preset_id : agentId
  const presetFile = dataPath(root, `${base}/${presetRoot}/${presetId}/preset.yml`)
  const preset = existsSync(presetFile) ? readYamlMap(root, presetFile) : {}
  const workspace = typeof loadable.workspace === 'string' ? loadable.workspace : 'dsh/workspace'
  const prefix = `${workspace}/.agents/skills/`
  const skills = candidateFiles(source.candidate).filter(path => path.startsWith(prefix) && path.endsWith('/SKILL.md')).map(path => {
    const skillId = path.slice(prefix.length, -'/SKILL.md'.length)
    const content = readFileSync(dataPath(root, `${base}/${path}`), 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
    let fields: JsonMap = {}
    if (frontmatter) {
      try { const value = loadYaml(frontmatter[1]); if (value && typeof value === 'object' && !Array.isArray(value)) fields = value as JsonMap }
      catch { /* 无效元数据不冒充完整技能描述。 */ }
    }
    return { skillId, skillName: typeof fields.name === 'string' ? fields.name : null,
      skillDescription: typeof fields.description === 'string' ? fields.description : null, verification: 'discovered' as const }
  })
  return ok({ agentId, source: { experimentId, basis: 'active_experiment' },
    name: typeof asset.name === 'string' ? asset.name : null,
    description: typeof preset.description === 'string' ? preset.description : null, skills })
}

function experimentInfo(root: string, id: string) {
  experimentIdValue(id)
  const base = join(root, 'evolution/experiments', id)
  const file = join(base, 'change.yaml')
  let content: string
  try { content = readFileSync(file, 'utf8') }
  catch (error) {
    const filesystemCode = (error as NodeJS.ErrnoException).code ?? 'unknown'
    throw new RpcError('asset_read_failed', filesystemCode === 'ENOENT' ? '版本清单不存在' : '版本清单读取失败',
      { path: repoRelative(root, file), filesystem_code: filesystemCode })
  }
  const change = readYamlMap(root, file, content)
  try { assertVersionIdentity(id, change) }
  catch { throw new RpcError('invalid_request', 'change.yaml 与版本身份不一致', { experiment_id: id }) }
  const agentId = change.agent_id as string
  return {
    id,
    path: `evolution/experiments/${id}`,
    agent_id: agentId,
    baseline_ref: change.baseline_ref ?? null,
    status: change.status ?? null,
    change,
    change_sha256: sha256(content),
    ...currentVariantProjection(root, id, change),
  }
}

function listExperiments(root: string, agentId?: string) {
  return listDirs(join(root, 'evolution/experiments'))
    .filter(id => EXP_ID.test(id))
    .filter(id => {
      const base = `evolution/experiments/${id}`
      if (existsSync(join(root, base, 'change.yaml'))) return true
      const visible = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', base], { cwd: root, encoding: 'utf8' })
      return visible.status !== 0 || Boolean(visible.stdout)
    })
    .map(id => {
      try { return { ...experimentInfo(root, id), error: null as string | null } }
      catch (error) { return { id, path: `evolution/experiments/${id}`, agent_id: EXP_ID.exec(id)![1], status: 'unavailable', baseline_ref: null, change: {} as JsonMap, change_sha256: null, current_variant_id: null, is_current: true, error: (error as Error).message } }
    })
    .filter(item => !agentId || item.agent_id === agentId)
}

function listRuns(root: string, experimentId: string) {
  const base = join(root, 'evolution/experiments', experimentId, 'runs')
  return listDirs(base).filter(id => RUN_ID.test(id)).map(id => ({ id, path: `evolution/experiments/${experimentId}/runs/${id}` }))
}

function casesFromEvaluation(parsed: unknown) {
  const raw = parsed as { catalog?: JsonMap[]; cases?: Record<string, JsonMap>; case_ids?: string[] }
  const caseMap = raw.cases ?? {}
  return (raw.catalog ?? []).map(item => {
    const id = typeof item.case_id === 'string' ? item.case_id : ''
    const value = caseMap[id] ?? {}
    const inputs = Array.isArray(value.inputs) ? value.inputs.filter(input => typeof input === 'string') as string[] : []
    return {
      id,
      title: typeof value.title === 'string' ? value.title : '',
      scene: typeof item.scene === 'string' ? item.scene : '未分组',
      tier: item.fast === true ? 'fast' : 'full',
      has_input: inputs.length > 0,
      input_preview: inputs.join('\n').slice(0, 180),
    }
  })
}

async function loadEvaluation(root: string, agentId: string, signal?: AbortSignal) {
  const path = repoPath(root, `agents/${agentId}/evaluation.md`)
  assertNoSymlinkPath(root, path)
  const content = readText(path)
  // 原文、摘要及解析共享同一个快照，避免读取期间保存造成口径错配。
  const parsed = await parseJsonCommandAsync(root, ['-c', evaluationPreviewCode(root)], 'evaluation.md 合同解析失败', signal, content)
  return { path: `agents/${agentId}/evaluation.md`, content, sha256: sha256(content), parsed, cases: casesFromEvaluation(parsed) }
}

function declaredFusion(change: JsonMap) {
  const values = [change.fusion_sources, change.inherited_experiments, change.fused_experiments]
    .find(value => Array.isArray(value)) as unknown[] | undefined
  const experiments = (values ?? []).map(value => typeof value === 'string' ? value : value && typeof value === 'object' ? (value as JsonMap).experiment_id : undefined)
    .filter((value): value is string => typeof value === 'string' && EXP_ID.test(value))
  return experiments.length ? { status: 'declared', experiments: [...new Set(experiments)].sort() } : { status: 'unknown', experiments: [] }
}

function relatedRefs(root: string, experimentId: string) {
  const files = ['hypothesis.md', 'decision.md', 'evaluation/observations.md']
  const refs = new Set<string>()
  for (const rel of files) {
    for (const match of readText(join(root, 'evolution/experiments', experimentId, rel)).matchAll(/(?:EXP|VAR)-[a-z0-9-]+-\d{3}(?:-[a-z0-9-]+)?/g)) {
      if (match[0] !== experimentId) refs.add(match[0])
    }
  }
  return [...refs].sort()
}

async function sourceContract(root: string, experimentId: string, signal?: AbortSignal) {
  try {
    return await parseJsonCommandAsync(root, [SOURCE_CONTRACT, '--source', `experiment:${experimentId}`], '来源合同解析失败', signal)
  } catch (error) {
    return { status: 'unavailable', error: error instanceof RpcError ? error.code : 'asset_operation_failed' }
  }
}

function assertUniqueResolved(edits: { rel: string }[]) {
  const seen = new Set<string>()
  for (const edit of edits) {
    if (seen.has(edit.rel)) throw new RpcError('invalid_request', '同一次写入不能包含重复路径', { path: edit.rel })
    seen.add(edit.rel)
  }
}

function list(root: string) {
  const source = catalog(root)
  const allExperiments = listExperiments(root)
  const experiments = allExperiments.filter(item => item.is_current)
  return ok({
    schema_version: '1.0',
    root,
    observed_at: new Date().toISOString(),
    agents: listAgents(root, experiments),
    experiments,
    historical_experiments: allExperiments.filter(item => !item.is_current),
    releases: listDirs(join(root, 'releases')).map(id => ({ id, path: `releases/${id}` })),
    source_catalog: { path: 'evolution/experiments/*/candidate/harness.yaml', schema_version: '2.0', count: Object.keys(source.parsed.sources ?? {}).length, errors: source.errors },
  })
}

export interface AgentFeature {
  id: string
  title: string
  description: string
  source_refs: string[]
  evidence_refs: string[]
  change?: string
}

export interface FusionPlan {
  sources: { experiment_id: string; ref: string; decision: 'inherit' | 'omit'; reason: string }[]
  features: AgentFeature[]
  conflicts: { description: string; resolution: string }[]
  checks: { id: string; kind: 'build' | 'load' | 'capability'; command?: string[]; cwd?: string; case_ids?: string[] }[]
  evaluation_case_ids: string[]
  evaluation_sha256: string
}

type VersionPreview = { kind: 'features' | 'fusion'; snapshot: string; payload: JsonMap; value: JsonMap }

function gitHead(root: string) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function relocateSourcePath(value: unknown, parent: string, target: string) {
  return typeof value === 'string' ? value.replace(`evolution/experiments/${parent}/candidate`, `evolution/experiments/${target}/candidate`) : undefined
}

function changePath(root: string, id: string) { return repoPath(root, `evolution/experiments/${id}/change.yaml`) }

function featureList(value: unknown): AgentFeature[] {
  if (!Array.isArray(value)) throw new RpcError('invalid_request', 'features 必须是数组')
  const ids = new Set<string>()
  return value.map(item => {
    const row = requireObject(item)
    const id = stringField(row, 'id')
    if (ids.has(id)) throw new RpcError('invalid_request', '特性 id 不能重复')
    ids.add(id)
    const refs = (name: string) => {
      if (row[name] === undefined) return []
      if (!Array.isArray(row[name]) || row[name].some(ref => typeof ref !== 'string' || !ref.trim())) throw new RpcError('invalid_request', `${name} 必须是非空字符串数组`)
      return [...new Set(row[name] as string[])]
    }
    return { id, title: stringField(row, 'title'), description: stringField(row, 'description'), source_refs: refs('source_refs'), evidence_refs: refs('evidence_refs'), ...(optionalString(row, 'change') ? { change: optionalString(row, 'change') } : {}) }
  })
}

// 历史 change.yaml 使用 Experiment 相对引用；新保存统一为数据根相对引用。
function featureReference(experimentId: string, ref: string) {
  if (!ref || ref.includes('://') || ref.includes('\\') || ref.startsWith('/') || ref.split(/[\/#]/).includes('..')) return null
  if (/^(candidate\/|evaluation\/|runs\/|hypothesis\.md(?:#|$)|decision\.md(?:#|$)|change\.yaml(?:#|$))/.test(ref)) return `evolution/experiments/${experimentId}/${ref}`
  return /^(evolution\/experiments\/|agents\/)/.test(ref) ? ref : null
}

function featureView(root: string, experimentId: string, change: JsonMap) {
  const values = Array.isArray(change.features) ? featureList(change.features) : []
  return values.map(feature => ({ ...feature, evidence: feature.evidence_refs.map(ref => {
    const path = featureReference(experimentId, ref)?.split('#')[0] ?? null
    let present = false
    if (path) try { const file = repoPath(root, path); assertNoSymlinkPath(root, file); present = existsSync(file) && lstatSync(file).isFile() } catch { /* 无效历史引用显示缺失，不猜测其他目录。 */ }
    return { ref, path, present }
  }), verification: feature.evidence_refs.length ? '有证据引用，需按范围复核' : '尚未验证' }))
}

function featureSourceOwner(root: string, agentId: string, path: string) {
  const match = /^evolution\/experiments\/([^/]+)\/(.+)$/.exec(path)
  if (!match || !(match[2]!.startsWith('evaluation/') || ['hypothesis.md', 'decision.md'].includes(match[2]!)) ||
      path.split('/').some(part => EXCLUDED_ASSETS.has(part) || part.startsWith('.') || ['credentials', 'secrets'].includes(part.toLowerCase()) || part.endsWith('.llm-api-key'))) return null
  try { return experimentInfo(root, match[1]!).agent_id === agentId ? match[1]! : null } catch { return null }
}

function readFeatureSource(root: string, body: JsonMap) {
  const id = experimentIdField(body)
  const exp = experimentInfo(root, id)
  const reference = optionalString(body, 'ref')
  if (!reference) return ok({ experiment_id: id, files: [...new Set([
    `evolution/experiments/${id}/hypothesis.md`, `evolution/experiments/${id}/evaluation/observations.md`, `evolution/experiments/${id}/decision.md`,
    ...featureView(root, id, exp.change).flatMap(feature => feature.evidence.filter(item => item.present && item.path).map(item => item.path!)),
  ])].filter(path => featureSourceOwner(root, exp.agent_id, path) && existsSync(repoPath(root, path))) })
  const ref = featureReference(id, reference)
  const path = ref?.split('#')[0]
  if (!path) throw new RpcError('path_rejected', '特性证据必须使用 Experiment 或数据根相对路径')
  const owner = featureSourceOwner(root, exp.agent_id, path)
  if (!owner) throw new RpcError('path_rejected', '仅可读取同一 Agent 的研究说明、观察和 Decision；Candidate 和 Run 使用各自专用读取工具')
  const file = repoPath(root, path)
  assertNoSymlinkPath(root, file)
  if (!existsSync(file)) throw new RpcError('asset_read_failed', '特性来源文件不存在', { path })
  const stat = lstatSync(file)
  if (!stat.isFile()) throw new RpcError('path_rejected', '特性来源必须是文件')
  const content = readAssetText(file)
  return ok({ experiment_id: id, source_experiment_id: owner, ref, path, size: stat.size, kind: content === null ? 'unpreviewable' : 'text',
    ...(content === null ? {} : assetText(path, content)) })
}

function candidateDigest(root: string, experimentId: string) {
  const base = repoPath(root, `evolution/experiments/${experimentId}/candidate`)
  const hash = createHash('sha256')
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (EXCLUDED_ASSETS.has(name) || name.endsWith('.llm-api-key')) continue
      const file = join(folder, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new RpcError('path_rejected', 'Candidate 中的符号链接不能作为融合验证来源')
      if (stat.isDirectory()) walk(file)
      // Git 只保存可执行位；与固定提交比较时不把工作树 umask 当作资产变化。
      else if (stat.isFile()) hash.update(JSON.stringify([relative(base, file), stat.mode & 0o111 ? 0o755 : 0o644, sha256(readFileSync(file))]))
    }
  }
  walk(base)
  return hash.digest('hex')
}

function runEvidenceDigest(root: string, experimentId: string, runId: string) {
  if (!RUN_ID.test(runId)) throw new RpcError('invalid_request', 'Run ID 无效')
  const base = repoPath(root, `evolution/experiments/${experimentId}/runs/${runId}`)
  const hash = createHash('sha256')
  const walk = (folder: string) => {
    assertNoSymlinkPath(root, folder)
    for (const entry of readdirSync(folder).sort()) {
      const file = join(folder, entry)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new RpcError('path_rejected', 'Run 证据不得包含符号链接')
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) hash.update(JSON.stringify([relative(base, file), sha256(readFileSync(file))]))
    }
  }
  walk(base)
  return hash.digest('hex')
}

function featureSnapshot(root: string, id: string) { return sha256(`${readText(changePath(root, id))}\n${candidateDigest(root, id)}`) }

function evaluationDigest(root: string, agentId: string, caseIds: string[]): string {
  const python = ['import json,sys', 'from pathlib import Path', `sys.path.insert(0, ${JSON.stringify(join(programRoot(), dirname(EVALUATION_CONTRACT)))})`, 'from evaluation_contract import evaluation_digest', 'print(json.dumps({"digest":evaluation_digest(Path(sys.argv[1]),json.loads(sys.argv[2]))}))'].join('\n')
  return String(parseJsonCommand(root, ['-c', python, `agents/${agentId}/evaluation.md`, JSON.stringify(caseIds)], '无法锁定约定评测口径').digest)
}

function creationView(root: string, id: string, change: JsonMap) {
  const creation = change.creation as JsonMap | undefined
  if (!creation || creation.status !== 'completed') return creation ?? null
  const plan = creation.plan as unknown as FusionPlan
  let evaluationChanged = true
  try { evaluationChanged = !plan?.evaluation_case_ids?.length || evaluationDigest(root, String(change.agent_id), plan.evaluation_case_ids) !== plan.evaluation_sha256 } catch { /* 删除或破坏已选口径时同样需要重新确认。 */ }
  const changed = creation.candidate_sha256 !== candidateDigest(root, id) || creation.source_sha256 !== sha256(JSON.stringify(catalog(root).parsed.sources?.[id] ?? null)) || evaluationChanged
  return changed ? { ...creation, status: 'integrating', stale: true, note: '资产或来源在完成验证后发生变化，需重新验证。' } : creation
}

function featurePreview(root: string, body: JsonMap, previews: Map<string, VersionPreview>) {
  const id = experimentIdField(body)
  experimentInfo(root, id)
  const features = featureList(body.features).map(feature => ({ ...feature, evidence_refs: feature.evidence_refs.map(ref => featureReference(id, ref) ?? ref) }))
  const previewId = randomUUID()
  const value = { preview_id: previewId, experiment_id: id, features, before: featureView(root, id, experimentInfo(root, id).change), requires_confirmation: true, assistant_session_id: optionalString(body, 'assistant_session_id') ?? null }
  previews.set(previewId, { kind: 'features', snapshot: featureSnapshot(root, id), payload: { experiment_id: id }, value })
  return ok(value)
}

function confirmedPreview(body: JsonMap, previews: Map<string, VersionPreview>, kind: VersionPreview['kind']) {
  const id = stringField(body, 'preview_id')
  const preview = previews.get(id)
  if (body.confirmed !== true) throw new RpcError('confirmation_required', '请先确认展示的方案')
  if (!preview || preview.kind !== kind) throw new RpcError('preview_expired', '预览已失效，请重新生成')
  return { id, preview }
}

function latestProposal(body: JsonMap, previews: Map<string, VersionPreview>, kind: VersionPreview['kind']) {
  const values = [...previews.values()].filter(preview => preview.kind === kind)
  const value = values.reverse().find(preview => kind === 'features'
    ? preview.value.experiment_id === stringField(body, 'experiment_id')
    : preview.value.agent_id === agentIdField(body) && (!body.parent_experiment_id || preview.value.parent_experiment_id === body.parent_experiment_id))
  return ok({ proposal: value?.value ?? null })
}

function featureApply(root: string, body: JsonMap, previews: Map<string, VersionPreview>) {
  const { id, preview } = confirmedPreview(body, previews, 'features')
  const experimentId = String(preview.payload.experiment_id)
  if (featureSnapshot(root, experimentId) !== preview.snapshot) throw new RpcError('conflict', '资产或特性已变化，请重新整理和确认')
  const change = readYamlMap(root, changePath(root, experimentId))
  writeYamlMap(changePath(root, experimentId), { ...change, features: preview.value.features })
  previews.delete(id)
  return ok({ experiment_id: experimentId, features: featureView(root, experimentId, { ...change, features: preview.value.features }) })
}

function gitCandidateDigest(root: string, id: string, ref: string): string | null {
  const base = `evolution/experiments/${id}/candidate/`
  const listed = spawnSync('git', ['ls-tree', '-rz', '--full-tree', ref.slice(4), '--', base.slice(0, -1)], { cwd: root, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })
  if (listed.status !== 0) return null
  const records = listed.stdout.toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(row)
    return match ? { mode: Number.parseInt(match[1]!, 8) & 0o777, object: match[2]!, path: match[3]!.slice(base.length), symlink: match[1] === '120000' } : null
  }).filter((row): row is NonNullable<typeof row> => row !== null)
    .filter(row => !row.path.split('/').some(part => EXCLUDED_ASSETS.has(part) || part.endsWith('.llm-api-key')))
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

function fusionInventory(root: string, agentId: string, parentId: string, parentRef: string) {
  const versions = listExperiments(root, agentId).filter(version => !isVariantIdentity(version.id, version.change))
  type FixedVersion = { id: string; ref: string; change: JsonMap; digest: string; sourceHash: string }
  const fixed = new Map<string, FixedVersion | null>()
  const snapshot = (id: string, ref: string): FixedVersion | null => {
    const key = `${ref}:${id}`
    if (fixed.has(key)) return fixed.get(key)!
    fixed.set(key, null)
    if (!/^git:[0-9a-f]{40}$/i.test(ref) || !EXP_ID.test(id)) return null
    const show = (path: string) => spawnSync('git', ['show', `${ref.slice(4)}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    try {
      const shown = show(`evolution/experiments/${id}/change.yaml`)
      if (shown.status !== 0) return null
      const change = requireObject(loadYaml(shown.stdout))
      const source = versionSource(root, id, ref.slice(4))
      const digest = gitCandidateDigest(root, id, ref)
      if (change.agent_id !== agentId || change.experiment_id !== id || source?.agent_id !== agentId || !digest || isVariantIdentity(id, change)) return null
      const value = { id, ref, change, digest, sourceHash: sha256(JSON.stringify(source)) }
      fixed.set(key, value)
      return value
    } catch { return null }
  }
  const usable = (version: FixedVersion) => {
    const creation = version.change.creation as JsonMap | undefined
    return !creation || creation.status === 'completed' && creation.candidate_sha256 === version.digest && creation.source_sha256 === version.sourceHash
  }
  const closure = (version: FixedVersion | null, seen = new Map<string, FixedVersion>()): Map<string, FixedVersion> => {
    if (!version) return seen
    const key = `${version.ref}:${version.id}`
    if (seen.has(key)) return seen
    seen.set(key, version)
    if (!usable(version)) return seen
    const change = version.change
    const sources = Array.isArray(change.fusion_sources) ? change.fusion_sources : []
    const edges: { id: string; ref: string }[] = []
    if (typeof change.parent_experiment_id === 'string' && typeof change.baseline_ref === 'string') edges.push({ id: change.parent_experiment_id, ref: change.baseline_ref })
    for (const source of sources) if (source && typeof source === 'object' && typeof (source as JsonMap).experiment_id === 'string' && typeof (source as JsonMap).ref === 'string') edges.push({ id: String((source as JsonMap).experiment_id), ref: String((source as JsonMap).ref) })
    for (const edge of edges) closure(snapshot(edge.id, edge.ref), seen)
    return seen
  }
  const currentDigests = new Map(versions.map(version => [version.id, existsSync(join(root, version.path, 'candidate')) ? candidateDigest(root, version.id) : null]))
  const matchesCurrent = (version: FixedVersion) => usable(version) && currentDigests.get(version.id) === version.digest
  const parent = snapshot(parentId, parentRef)
  const covered = new Set([...closure(parent).values()].filter(matchesCurrent).map(version => version.id))
  const head = gitHead(root)
  const currentFixed = new Map<string, boolean>()
  const currentClosures = new Map(versions.map(version => {
    const committed = head ? snapshot(version.id, `git:${head}`) : null
    const creation = version.change.creation as JsonMap | undefined
    const currentReady = !creation || creationView(root, version.id, version.change)?.status === 'completed'
    const ready = Boolean(committed && matchesCurrent(committed) && currentReady)
    currentFixed.set(version.id, ready)
    const inherited = ready ? [...closure(committed).values()].filter(matchesCurrent).map(item => item.id) : []
    return [version.id, new Set(inherited)] as const
  }))
  const rows = versions.filter(version => !covered.has(version.id)).map(version => {
    const change = version.change
    const decision = change.outcome ?? change.decision
    const excluded = decision === 'reject'
    const uncertain = !excluded && (decision !== 'adopt' || !currentFixed.get(version.id))
    return { experiment_id: version.id, baseline_ref: version.baseline_ref, status: excluded ? 'excluded' : uncertain ? 'needs_review' : 'recommended', reason: decision === 'reject' ? '研究 Decision 已否决' : version.id === parentId ? '当前版本与所选固定父版不同或尚未完成验证，需确认其变化' : uncertain ? '仍在探索、工作树已变化或继承关系未确认，需判断' : '主父版未覆盖的并行能力', features: featureView(root, version.id, change) }
  })
  const candidates = rows.filter(row => row.status !== 'excluded')
  const frontier = candidates.filter(row => !candidates.some(other => other.experiment_id !== row.experiment_id && currentClosures.get(other.experiment_id)?.has(row.experiment_id) && !currentClosures.get(row.experiment_id)?.has(other.experiment_id)))
  return { covered: [...covered].sort(), sources: [...frontier, ...rows.filter(row => row.status === 'excluded')], superseded: candidates.filter(row => !frontier.includes(row)).map(row => row.experiment_id) }
}

function normalizePlan(root: string, body: JsonMap, inventory: ReturnType<typeof fusionInventory>, agentId: string): FusionPlan {
  const value = requireObject(body)
  if (!Array.isArray(value.sources) || !Array.isArray(value.conflicts) || !Array.isArray(value.checks)) throw new RpcError('invalid_request', '融合方案需要 sources、features、conflicts 和 checks')
  const sources = value.sources.map(item => {
    const row = requireObject(item)
    const experimentId = experimentIdField(row)
    if (row.decision !== 'inherit' && row.decision !== 'omit') throw new RpcError('invalid_request', '来源必须明确 inherit 或 omit')
    const ref = optionalString(row, 'ref') ?? ''
    if (row.decision === 'inherit') validateGitParent(root, agentId, ref, experimentId)
    return { experiment_id: experimentId, ref, decision: row.decision as 'inherit' | 'omit', reason: stringField(row, 'reason') }
  })
  if (new Set(sources.map(source => source.experiment_id)).size !== sources.length) throw new RpcError('invalid_request', '融合来源不能重复')
  for (const row of inventory.sources.filter(item => item.status !== 'excluded')) {
    if (!sources.some(source => source.experiment_id === row.experiment_id)) throw new RpcError('invalid_request', '方案必须确认所有未覆盖来源的取舍', { experiment_id: row.experiment_id })
  }
  const checks = value.checks.map(item => {
    const row = requireObject(item)
    const id = stringField(row, 'id')
    if (!['build', 'load', 'capability'].includes(String(row.kind))) throw new RpcError('invalid_request', '验证 kind 无效')
    const kind = row.kind as 'build' | 'load' | 'capability'
    if (kind === 'build' && (!Array.isArray(row.command) || !row.command.length || row.command.some(arg => typeof arg !== 'string' || !arg))) throw new RpcError('invalid_request', 'build 需要经用户确认的命令数组')
    if (kind === 'capability' && (!Array.isArray(row.case_ids) || !row.case_ids.length || row.case_ids.some(id => typeof id !== 'string' || !id))) throw new RpcError('invalid_request', '能力验证需要实际评测 Case ID')
    const cwd = optionalString(row, 'cwd') ?? '.'
    if (cwd.startsWith('/') || cwd.split('/').includes('..')) throw new RpcError('path_rejected', '构建目录必须位于新 Candidate 内')
    return { id, kind, ...(kind === 'build' ? { command: row.command as string[], cwd } : {}), ...(kind === 'capability' ? { case_ids: row.case_ids as string[] } : {}) }
  })
  if (new Set(checks.map(check => check.id)).size !== checks.length || !checks.some(check => check.kind === 'load') || !checks.some(check => check.kind === 'capability')) throw new RpcError('invalid_request', '融合方案需要不重复的验证 ID、实际装载及能力验证')
  const caseIds = [...new Set(checks.flatMap(check => check.case_ids ?? []))]
  return { sources, features: featureList(value.features), conflicts: value.conflicts.map(item => { const row = requireObject(item); return { description: stringField(row, 'description'), resolution: stringField(row, 'resolution') } }), checks, evaluation_case_ids: caseIds, evaluation_sha256: evaluationDigest(root, agentId, caseIds) }
}

function fusionSnapshot(root: string, agentId: string) {
  const versions = listExperiments(root, agentId).map(version => ({ ...version,
    candidate_sha256: existsSync(join(root, version.path, 'candidate')) ? candidateDigest(root, version.id) : null,
  }))
  return sha256(JSON.stringify({ head: gitHead(root), versions }))
}

function fusionPreview(root: string, body: JsonMap, previews: Map<string, VersionPreview>) {
  const agentId = agentIdField(body)
  const parentId = experimentIdField(body, 'parent_experiment_id')
  const parentRef = stringField(body, 'parent_ref')
  validateGitParent(root, agentId, parentRef, parentId)
  const question = stringField(body, 'research_question')
  const inventory = fusionInventory(root, agentId, parentId, parentRef)
  const plan = body.plan ? normalizePlan(root, requireObject(body.plan), inventory, agentId) : null
  const value = { preview_id: plan ? randomUUID() : null, agent_id: agentId, parent_experiment_id: parentId, parent_ref: parentRef, research_question: question, inventory, plan, plan_ready: Boolean(plan), requires_confirmation: true, assistant_session_id: optionalString(body, 'assistant_session_id') ?? null }
  if (plan) previews.set(value.preview_id!, { kind: 'fusion', payload: body, snapshot: fusionSnapshot(root, agentId), value })
  return ok(value)
}

async function fusionConfirm(root: string, body: JsonMap, previews: Map<string, VersionPreview>) {
  const { id, preview } = confirmedPreview(body, previews, 'fusion')
  const agentId = agentIdField(preview.payload)
  if (fusionSnapshot(root, agentId) !== preview.snapshot) throw new RpcError('conflict', '版本或来源已经变化，请重新预览')
  const plan = preview.value.plan as unknown as FusionPlan
  if (evaluationDigest(root, agentId, plan.evaluation_case_ids) !== plan.evaluation_sha256) throw new RpcError('conflict', '约定评测口径已变化，请重新确认方案')
  // 在 await 创建之前消费预览，重复点击不会生成两个版本。
  previews.delete(id)
  const created = await createExperiment(root, preview.payload)
  if (!created.ok) return created
  const experimentId = String(created.value.experiment_id)
  const change = readYamlMap(root, changePath(root, experimentId))
  writeYamlMap(changePath(root, experimentId), { ...change, features: plan.features, fusion_sources: plan.sources.filter(source => source.decision === 'inherit').map(source => ({ experiment_id: source.experiment_id, ref: source.ref })), creation: { status: 'integrating', confirmed_at: new Date().toISOString(), research_question: preview.value.research_question, assistant_session_id: preview.value.assistant_session_id, plan, receipts: [] } })
  return ok({ ...created.value, creation_status: 'integrating', note: '已建立待融合工作树；来源声明不表示能力已经完成集成。' })
}

function fusionStatus(root: string, body: JsonMap) {
  const id = experimentIdField(body)
  const exp = experimentInfo(root, id)
  return ok({ experiment_id: id, candidate_sha256: candidateDigest(root, id), creation: creationView(root, id, exp.change), features: featureView(root, exp.id, exp.change) })
}

async function fusionVerify(root: string, body: JsonMap, signal?: AbortSignal) {
  const id = experimentIdField(body)
  const exp = experimentInfo(root, id)
  const creation = requireObject(exp.change.creation)
  const plan = creation.plan as unknown as FusionPlan
  if (evaluationDigest(root, exp.agent_id, plan.evaluation_case_ids) !== plan.evaluation_sha256) throw new RpcError('evaluation_conflict', '约定评测口径已变化，请重新确认方案并运行受影响比较')
  const check = plan.checks.find(check => check.id === stringField(body, 'check_id'))
  if (!check) throw new RpcError('invalid_request', '验证项不在已确认方案中')
  const before = candidateDigest(root, id)
  const sourceBefore = sha256(JSON.stringify(catalog(root).parsed.sources?.[id] ?? null))
  if (before !== stringField(body, 'expected_candidate_sha256')) throw new RpcError('conflict', 'Candidate 已变化，请重新读取')
  let evidence: JsonMap
  if (check.kind === 'build') {
    const candidate = repoPath(root, `evolution/experiments/${id}/candidate`)
    const cwd = resolve(candidate, check.cwd ?? '.')
    if (cwd !== candidate && !cwd.startsWith(`${candidate}${sep}`)) throw new RpcError('path_rejected', '构建目录必须在 Candidate 内')
    assertNoSymlinkPath(root, cwd)
    const args = check.command!.map(arg => arg.replaceAll('{experiment_id}', id).replaceAll('{source_id}', `experiment:${id}`).replaceAll('{candidate_root}', candidate))
    try {
      const result = await promisify(execFile)(args[0]!, args.slice(1), { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, signal })
      evidence = { command: args, stdout: redact(result.stdout), stderr: redact(result.stderr) }
    } catch (error) { throw new RpcError('verification_failed', '构建验证失败，版本保持未完成', { reason: redact((error as Error).message) }) }
  } else {
    const runId = stringField(body, 'run_id')
    if (!RUN_ID.test(runId)) throw new RpcError('invalid_request', 'Run ID 无效')
    const viewed = await runRecord(root, 'show', { run_id: runId }, signal)
    if (!viewed.ok) return viewed
    const run = viewed.value as JsonMap
    const manifest = requireObject(run.manifest)
    const source = requireObject(run.source)
    const cases = run.cases as JsonMap[]
    if (manifest.experiment_id !== id || manifest.status !== 'completed' || source.source_id !== `experiment:${id}`) throw new RpcError('verification_failed', '必须使用当前目标的已封存 Run')
    if (source.candidate_sha256 !== before) throw new RpcError('verification_failed', 'Run 未锁定当前完整 Candidate，需重新运行验证')
    if (source.evaluation_sha256 !== evaluationDigest(root, exp.agent_id, cases.map(row => String(row.case_id)))) throw new RpcError('verification_failed', 'Run 的已选评测口径与当前定义不同，需重新运行受影响比较')
    for (const name of ['results', 'summary', 'analysis', 'report']) {
      const file = repoPath(root, `${String(run.run_path)}/${name}.${name === 'results' ? 'jsonl' : name === 'report' ? 'md' : 'json'}`)
      if (typeof manifest[`${name}_sha256`] !== 'string' || !existsSync(file) || sha256(readFileSync(file)) !== manifest[`${name}_sha256`]) throw new RpcError('verification_failed', 'Run 封存摘要缺失或记录已变化', { artifact: name })
    }
    const python = ['import json,sys', 'from pathlib import Path', `sys.path.insert(0, ${JSON.stringify(join(programRoot(), 'runtime/adapters/dsh-container'))})`, 'from run_record import tree_digest', 'from source_contract import resolve', 'r=Path.cwd()', 'c=resolve(sys.argv[1],repo=r)', 'print(json.dumps({k:tree_digest(r,Path(c[k]))["tree_sha256"] for k in ("workspace","presets","managed")}))'].join('\n')
    const currentTrees = await parseJsonCommandAsync(root, ['-c', python, `experiment:${id}`], '无法核对 Run 来源', signal)
    const lockedTrees = requireObject(source.candidate_trees)
    if (Object.entries(currentTrees).some(([name, digest]) => requireObject(lockedTrees[name]).tree_sha256 !== digest)) throw new RpcError('verification_failed', 'Run 未指向当前 Candidate 三棵资产树')
    if (check.kind === 'load') {
      const image = requireObject(run.image)
      if (image.source_id !== `experiment:${id}` || !image.local_image_id || !cases.some(row => { const observed = row.load_observation as JsonMap | null; const raw = row.raw_evidence as JsonMap | undefined; return observed?.session_id && observed.preset_matches === true && observed.workspace_matches === true && (raw?.['trace.jsonl'] as JsonMap)?.present === true })) throw new RpcError('verification_failed', 'Run 缺少实际镜像、Session 和装载匹配证据')
    } else {
      const summary = requireObject(run.summary)
      if ((summary.effective_verdict ?? summary.overall_verdict) !== 'passed' || check.case_ids!.some(caseId => !cases.some(row => row.case_id === caseId && Array.isArray(row.trials) && row.trials.length > 0 && row.trials.every(trial => (trial as JsonMap).verdict === 'passed') && (row.evidence as JsonMap[]).every(ref => ref.present === true)))) throw new RpcError('verification_failed', '约定能力没有已通过且证据完整的 Run')
    }
    evidence = { run_id: runId, run_path: run.run_path, run_sha256: runEvidenceDigest(root, id, runId), case_ids: check.case_ids ?? [] }
  }
  const after = candidateDigest(root, id)
  if (check.kind !== 'build' && after !== before) throw new RpcError('conflict', '验证期间 Candidate 已变化')
  const fresh = experimentInfo(root, id).change
  const latest = requireObject(fresh.creation)
  if (JSON.stringify(latest.plan) !== JSON.stringify(creation.plan) || sha256(JSON.stringify(catalog(root).parsed.sources?.[id] ?? null)) !== sourceBefore || evaluationDigest(root, exp.agent_id, plan.evaluation_case_ids) !== plan.evaluation_sha256) throw new RpcError('conflict', '验证期间确认方案、来源配置或已选评测口径已变化')
  const receipt = { check_id: check.id, kind: check.kind, candidate_sha256: after, source_sha256: sha256(JSON.stringify(catalog(root).parsed.sources?.[id] ?? null)), evaluation_sha256: plan.evaluation_sha256, verified_at: new Date().toISOString(), evidence }
  const receipts = (Array.isArray(latest.receipts) ? latest.receipts as JsonMap[] : []).filter(item => item.check_id !== check.id)
  writeYamlMap(changePath(root, id), { ...fresh, creation: { ...latest, receipts: [...receipts, receipt] } })
  return ok({ experiment_id: id, receipt, candidate_sha256: after })
}

function fusionFinalize(root: string, body: JsonMap) {
  const id = experimentIdField(body)
  const exp = experimentInfo(root, id)
  const creation = requireObject(exp.change.creation)
  const plan = creation.plan as unknown as FusionPlan
  if (evaluationDigest(root, exp.agent_id, plan.evaluation_case_ids) !== plan.evaluation_sha256) throw new RpcError('evaluation_conflict', '约定评测口径已变化，旧 Run 不能证明新口径通过')
  const digest = candidateDigest(root, id)
  if (digest !== stringField(body, 'expected_candidate_sha256')) throw new RpcError('conflict', 'Candidate 已变化')
  const receipts = Array.isArray(creation.receipts) ? creation.receipts as JsonMap[] : []
  const sourceHash = sha256(JSON.stringify(catalog(root).parsed.sources?.[id] ?? null))
  const missing = plan.checks.filter(check => !receipts.some(receipt => {
    if (receipt.check_id !== check.id || receipt.candidate_sha256 !== digest || receipt.source_sha256 !== sourceHash || receipt.evaluation_sha256 !== plan.evaluation_sha256) return false
    const evidence = receipt.evidence as JsonMap | undefined
    return !evidence?.run_id || evidence.run_sha256 === runEvidenceDigest(root, id, String(evidence.run_id))
  }))
  if (missing.length) throw new RpcError('verification_incomplete', '构建、实际装载或约定能力尚未完成验证', { missing_checks: missing.map(check => check.id) })
  commandJson(root, [VALIDATE_EXPERIMENT, `evolution/experiments/${id}`])
  commandJson(root, [SOURCE_CONTRACT, '--source', `experiment:${id}`])
  writeYamlMap(changePath(root, id), { ...exp.change, creation: { ...creation, status: 'completed', completed_at: new Date().toISOString(), candidate_sha256: digest, source_sha256: sourceHash } })
  return ok({ experiment_id: id, creation_status: 'completed', candidate_sha256: digest })
}

async function detail(root: string, payload: JsonMap, signal?: AbortSignal) {
  const agentId = agentIdField(payload)
  const manifest = readYamlMap(root, repoPath(root, `agents/${agentId}/manifest.yaml`))
  const allVersions = listExperiments(root, agentId).sort((left, right) => right.id.localeCompare(left.id, 'en', { numeric: true }))
  const versions = allVersions.filter(item => item.is_current)
  const explicitExperiment = optionalString(payload, 'experiment_id')
  const activeExperiment = typeof manifest.active_experiment === 'string' ? manifest.active_experiment : undefined
  const rawExperimentId = explicitExperiment ?? activeExperiment ?? versions[0]?.id
  const experimentId = rawExperimentId ? experimentIdValue(rawExperimentId) : undefined
  if (!experimentId) throw new RpcError('invalid_request', '未指定 experiment_id，manifest 也没有 active_experiment')
  const exp = experimentInfo(root, experimentId)
  if (exp.agent_id !== agentId) throw new RpcError('invalid_request', 'Experiment 不属于该 Agent', { agent_id: agentId, experiment_id: experimentId })
  const source = catalog(root)
  const [evaluation, contract] = await Promise.all([
    loadEvaluation(root, agentId, signal).catch(error => ({ path: `agents/${agentId}/evaluation.md`, sha256: null, cases: [], error: redact((error as Error).message) })),
    sourceContract(root, experimentId, signal),
  ])
  const decisionPath = repoPath(root, `evolution/experiments/${experimentId}/decision.md`)
  const decisionExists = existsSync(decisionPath), decision = readText(decisionPath)
  const assets = assetTree(root, experimentId)
  const commit = gitHead(root)
  const variant = isVariantIdentity(experimentId, exp.change)
  let derivation: JsonMap = variant
    ? { parent_experiment_id: experimentId, parent_ref: null, is_variant: true, derivable: false, reason: 'variant', note: '变体不能作为新版本的继承来源。' }
    : { parent_experiment_id: experimentId, parent_ref: null, is_variant: false, derivable: true, note: '业务版本可作为继承来源，但当前提交尚不能恢复所选版本，请先固定完整来源；baseline_ref 是该版本的祖先，不能代替所选版本。' }
  if (commit && !variant) try {
    validateGitParent(root, agentId, `git:${commit}`, experimentId)
    const fixedDigest = gitCandidateDigest(root, experimentId, `git:${commit}`)
    if (fixedDigest && fixedDigest === candidateDigest(root, experimentId)) derivation = { parent_experiment_id: experimentId, parent_ref: `git:${commit}`, is_variant: false, derivable: true, note: '所选 Candidate 与固定提交一致，派生前用 assets/read-fixed 核对；baseline_ref/experiment.change.parent_ref 指向该版本的祖先。' }
    else if (fixedDigest) derivation.note = '所选 Candidate 有未提交改动，请先固定当前 Candidate；不能用 HEAD 的旧资产或祖先提交冒充当前版本。'
  } catch { /* 新建但尚未提交的版本不能冒用其祖先提交派生。 */ }
  let readableCandidateDigest: string | null = null
  try { if (existsSync(repoPath(root, `evolution/experiments/${experimentId}/candidate`))) readableCandidateDigest = candidateDigest(root, experimentId) }
  catch (error) { if (!(error instanceof RpcError && error.code === 'path_rejected')) throw error }
  return ok({
    agent: { id: agentId, name: agentDisplayName(root, experimentId) ?? agentId, manifest, path: `agents/${agentId}` },
    experiment: exp,
    current_variant_id: exp.current_variant_id,
    is_current: exp.is_current,
    historical_versions: allVersions.filter(item => !item.is_current).map(item => ({ id: item.id, current_variant_id: item.current_variant_id, is_current: false, is_variant: true, derivable: false })),
    change_sha256: exp.change_sha256,
    candidate_sha256: readableCandidateDigest,
    selection: { basis: explicitExperiment ? 'explicit' : activeExperiment ? 'active_experiment' : 'latest_experiment', experiment_id: experimentId },
    versions: versions.map(item => ({ id: item.id, is_current: item.is_current, current_variant_id: item.current_variant_id, is_variant: isVariantIdentity(item.id, item.change), derivable: !isVariantIdentity(item.id, item.change), status: item.status, baseline_ref: item.baseline_ref, ...(item.error ? { error: item.error } : {}) })),
    baseline: { ref: exp.baseline_ref, parent_experiment_id: exp.change.parent_experiment_id ?? null, source: exp.baseline_ref ? 'change.yaml' : 'unknown' },
    fusion: declaredFusion(exp.change),
    related_references: relatedRefs(root, experimentId),
    declared: { loadable_source: source.parsed.sources?.[experimentId] ?? null, source_contract: contract },
    loaded_instance: { status: 'not_queried', note: '实际实例由平台实例模块统一观察。' },
    verification: { runs: listRuns(root, experimentId), note: 'Run 证据通过 runs/index 或 runs/show 查询原始记录' },
    assets,
    editable_files: editableFiles(assets),
    evaluation: { path: evaluation.path, sha256: evaluation.sha256, cases: evaluation.cases, ...('error' in evaluation ? { error: evaluation.error } : {}) },
    decision: { path: `evolution/experiments/${experimentId}/decision.md`, exists: decisionExists, sha256: decisionExists ? sha256(decision) : null, content: decision },
    features: featureView(root, exp.id, exp.change),
    creation: creationView(root, experimentId, exp.change),
    repo_commit: commit,
    derivation,
  })
}


function validateGitParent(root: string, agentId: string, parentRef: string, parentExperiment: string) {
  if (!/^git:[0-9a-f]{40}$/i.test(parentRef)) throw new RpcError('invalid_request', '父版本必须是 git:<40位提交>')
  const commit = parentRef.slice('git:'.length)
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new RpcError('invalid_request', 'git 父版本必须是固定 40 位提交')
  const check = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, encoding: 'utf8' })
  if (check.status !== 0) throw new RpcError('invalid_request', '父提交不存在', { parent_ref: parentRef })
  let source: JsonMap
  try {
    assertInheritableVersion(parentExperiment, versionIdentity(root, parentExperiment))
    assertInheritableVersion(parentExperiment, versionIdentity(root, parentExperiment, commit))
    source = versionSource(root, parentExperiment, commit)
  }
  catch (error) { throw new RpcError('invalid_request', (error as Error).message, { parent_experiment_id: parentExperiment, parent_ref: parentRef }) }
  if (source.agent_id !== agentId) throw new RpcError('invalid_request', '父 Experiment 与 Agent 不匹配', { agent_id: agentId, parent_experiment_id: parentExperiment })
  return { commit, source }
}

async function copyGitCandidate(root: string, commit: string, parentExperiment: string, targetExperimentRoot: string) {
  mkdirSync(targetExperimentRoot, { recursive: true })
  const archive = spawnSync('git', ['archive', '--format=tar', commit, `evolution/experiments/${parentExperiment}/candidate`], {
    cwd: root, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024,
  })
  if (archive.status !== 0) throw new RpcError('invalid_request', '父提交缺少 Candidate', { parent_experiment_id: parentExperiment, stderr: redact(String(archive.stderr)) })
  const untar = spawnSync('tar', ['-x', '-C', targetExperimentRoot, '--strip-components=3'], { input: archive.stdout, encoding: 'utf8' })
  if (untar.status !== 0) throw new RpcError('asset_write_failed', '无法复制父 Candidate', { stderr: redact(untar.stderr) })
  if (!existsSync(join(targetExperimentRoot, 'candidate'))) throw new RpcError('asset_write_failed', '父 Candidate 复制结果缺失')
  for (const name of ['runs', 'history', 'RuntimeHOME', 'sessions', 'cache', '.git']) rmSync(join(targetExperimentRoot, 'candidate', name), { recursive: true, force: true })
  return reuseParentDependencies(root, parentExperiment, join(targetExperimentRoot, 'candidate'))
}


async function createExperiment(root: string, payload: JsonMap, variant?: ComputeVariantCreation) {
  if (!variant && isVariantIdentity('', payload)) throw new RpcError('invalid_request', '变体只能通过 compute-variants/create 创建')
  const agentId = agentIdField(payload)
  const parentRef = stringField(payload, 'parent_ref')
  const manifest = readYamlMap(root, repoPath(root, `agents/${agentId}/manifest.yaml`))
  const defaultParent = typeof manifest.active_experiment === 'string' ? manifest.active_experiment : undefined
  const rawParentExperiment = optionalString(payload, 'parent_experiment_id') ?? defaultParent
  const parentExperiment = rawParentExperiment ? experimentIdValue(rawParentExperiment, 'parent_experiment_id') : undefined
  if (!parentExperiment) throw new RpcError('invalid_request', '缺少 parent_experiment_id')
  const prefix = variant ? 'VAR' : 'EXP'
  const nextNumber = Math.max(0, ...listExperiments(root, agentId).filter(item => item.id.startsWith(`${prefix}-`)).map(item => Number(EXP_ID.exec(item.id)?.[2] ?? 0))) + 1
  let experimentId = ''
  do {
    experimentId = `${prefix}-${agentId}-${String(nextNumber).padStart(3, '0')}-r${randomBytes(6).toString('hex')}`
  } while (existsSync(join(root, 'evolution/experiments', experimentId)))

  const experimentRoot = repoPath(root, `evolution/experiments/${experimentId}`)
  let parentSource: JsonMap
  let dependencyReuse: { reused: JsonMap[]; skipped: JsonMap[] } = { reused: [], skipped: [] }
  let created = false
  try {
    mkdirSync(dirname(experimentRoot), { recursive: true })
    mkdirSync(experimentRoot)
    created = true
    if (parentRef.startsWith('git:')) {
      const parent = validateGitParent(root, agentId, parentRef, parentExperiment)
      parentSource = parent.source
      dependencyReuse = await copyGitCandidate(root, parent.commit, parentExperiment, experimentRoot)
    } else if (parentRef.startsWith('release:')) {
      throw new RpcError('unsupported_parent', 'Release 来源尚未接入现有不可变 Release 装载格式')
    } else {
      throw new RpcError('invalid_request', 'parent_ref 只支持 git:<commit> 或 release:<id>')
    }
    const researchQuestion = optionalString(payload, 'research_question')
    if (!researchQuestion) throw new RpcError('invalid_request', '缺少真实用户研究问题')
    writeYamlMap(join(experimentRoot, 'change.yaml'), {
      schema_version: '1.0',
      experiment_id: experimentId,
      agent_id: agentId,
      baseline_ref: parentRef,
      parent_experiment_id: parentExperiment,
      parent_ref: parentRef,
      status: 'active',
      ...(variant ? { compute_variant: variant.plan, variant_kind: 'exploratory', variant_name: variant.name } : {}),
    })
    writeFileSync(join(experimentRoot, 'hypothesis.md'), `# ${experimentId}\n\n固定父版与继承来源见 [change.yaml](change.yaml)。\n\n研究问题：${researchQuestion}\n`)
    mkdirSync(join(experimentRoot, 'evaluation'), { recursive: true })
    writeFileSync(join(experimentRoot, 'evaluation/observations.md'), `# Evaluation Observations\n\n尚未执行评测。\n`)
    writeFileSync(join(experimentRoot, 'decision.md'), `# Decision\n\n状态：inconclusive\n\n尚未完成评测，不声明采纳。\n`)
    const harnessFile = join(experimentRoot, 'candidate/harness.yaml')
    const harness = existsSync(harnessFile) ? readYamlMap(root, harnessFile) : {}
    delete harness.experiment
    delete harness.runtime_contract
    harness.loadable_assets = inheritedLoadableAssets(parentSource, parentExperiment)
    harness.credential_environment_keys = [...new Set([...(parentSource.required_env_names as string[] ?? []), ...(parentSource.optional_env_names as string[] ?? [])])]
    writeYamlMap(harnessFile, harness)
    const source = versionSource(root, experimentId)
    for (const rel of [`${source.candidate_root}/managed/${source.patch}`, `${source.candidate_root}/presets/${source.preset}`, ...(source.guard ? [`${source.candidate_root}/managed/${source.guard}`] : [])]) {
      const file = repoPath(root, rel)
      assertNoSymlinkPath(root, file)
      if (!existsSync(file) || !lstatSync(file).isFile()) throw new RpcError('invalid_request', '父版缺少装载入口', { path: rel })
    }
    const validation = { valid: true, scope: 'selected-version', source }
    return ok({ experiment_id: experimentId, path: `evolution/experiments/${experimentId}`, validation, dependency_reuse: dependencyReuse })
  } catch (error) {
    if (created) rmSync(experimentRoot, { recursive: true, force: true })
    throw error
  }
}

function editableFiles(nodes: AssetNode[]) {
  const flatten = (nodes: AssetNode[]): string[] => nodes.flatMap(node => node.children ? flatten(node.children) : [node.path])
  return flatten(nodes)
}

type AssetNode = { name: string; path: string; kind: 'directory' | 'file'; children?: AssetNode[] }

function assetTree(root: string, experimentId: string): AssetNode[] {
  const exp = experimentInfo(root, experimentId)
  function node(rel: string): AssetNode | null {
    const file = repoPath(root, rel)
    assertNoSymlinkPath(root, dirname(file))
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return null
    const name = rel.split('/').at(-1)!
    if (EXCLUDED_ASSETS.has(name) || name.endsWith('.llm-api-key')) return null
    if (lstatSync(file).isDirectory()) {
      const children = readdirSync(file).sort().map(child => node(`${rel}/${child}`)).filter((child): child is AssetNode => child !== null)
      return { name, path: rel, kind: 'directory', children }
    }
    return lstatSync(file).isFile() ? { name, path: rel, kind: 'file' } : null
  }
  return [`evolution/experiments/${experimentId}/candidate`, `agents/${exp.agent_id}/evaluation.md`,
    ...['hypothesis.md', 'evaluation/observations.md', 'decision.md'].map(path => `evolution/experiments/${experimentId}/${path}`)]
    .map(node).filter((item): item is AssetNode => item !== null)
}

function assertNoSymlinkPath(root: string, target: string) {
  const rel = relative(root, target)
  let cursor = root
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) break
    if (lstatSync(cursor).isSymbolicLink()) throw new RpcError('path_rejected', '拒绝访问符号链接路径', { path: repoRelative(root, cursor) })
  }
}

function editablePath(root: string, payload: JsonMap, relPath: string) {
  const experimentId = experimentIdField(payload)
  const exp = experimentInfo(root, experimentId)
  const agentId = exp.agent_id
  let rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === 'evaluation.md') rel = `agents/${agentId}/evaluation.md`
  if (['decision.md', 'hypothesis.md', 'evaluation/observations.md'].includes(rel)) rel = `evolution/experiments/${experimentId}/${rel}`
  if (rel.startsWith('candidate/')) rel = `evolution/experiments/${experimentId}/${rel}`
  if (!rel.startsWith('evolution/') && !rel.startsWith('agents/')) rel = `evolution/experiments/${experimentId}/candidate/${rel}`
  const parts = rel.split('/')
  if (parts.some(part => EXCLUDED_ASSETS.has(part)) || parts.some(part => part.endsWith('.llm-api-key'))) {
    throw new RpcError('path_rejected', 'Run、历史、缓存、Session、RuntimeHOME、Git 和 LLM API Key 不可编辑', { path: rel })
  }
  const allowed = rel === `evolution/experiments/${experimentId}/candidate` || rel.startsWith(`evolution/experiments/${experimentId}/candidate/`) ||
    ['decision.md', 'hypothesis.md', 'evaluation/observations.md'].some(path => rel === `evolution/experiments/${experimentId}/${path}`) ||
    rel === `agents/${agentId}/evaluation.md`
  if (!allowed) throw new RpcError('path_rejected', '路径不在可编辑范围内', { path: rel })
  const file = repoPath(root, rel)
  assertNoSymlinkPath(root, dirname(file))
  if (existsSync(file)) assertNoSymlinkPath(root, file)
  return { file, rel, agentId }
}

function simpleDiff(pathName: string, before: string, after: string) {
  if (before === after) return ''
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  return [`--- ${pathName}`, `+++ ${pathName}`, '@@',
    ...a.slice(prefix, a.length - suffix).map(line => `-${line}`),
    ...b.slice(prefix, b.length - suffix).map(line => `+${line}`),
  ].join('\n')
}

function edits(payload: JsonMap) {
  const raw = payload.edits
  if (!Array.isArray(raw) || raw.length === 0) throw new RpcError('invalid_request', '缺少 edits')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RpcError('invalid_request', `edits[${index}] 必须是对象`)
    const row = item as JsonMap
    const path = stringField(row, 'path')
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (seen.has(normalized)) throw new RpcError('invalid_request', '同一次写入不能包含重复路径', { path })
    seen.add(normalized)
    if (row.expected_sha256 !== undefined && row.expected_sha256 !== null && typeof row.expected_sha256 !== 'string') {
      throw new RpcError('invalid_request', 'expected_sha256 必须是文件摘要或新文件的 null')
    }
    return { path, content: textField(row, 'content'), expected: row.expected_sha256 as string | null | undefined }
  })
}

function rejectsLlmApiKey(pathName: string, content: string) {
  return containsLiteralLlmKey(pathName, content)
}

function readEditable(root: string, payload: JsonMap) {
  const path = optionalString(payload, 'path')
  if (!path) return ok({ files: editableFiles(assetTree(root, experimentIdField(payload))) })
  const target = editablePath(root, payload, path)
  if (!existsSync(target.file)) return ok({ path: target.rel, exists: false, kind: 'missing', editable: true, content: '', sha256: null })
  const stat = lstatSync(target.file)
  if (stat.isDirectory()) return ok({ path: target.rel, kind: 'directory', editable: false })
  const value = readAssetText(target.file)
  return ok({ path: target.rel, exists: true, kind: value === null ? 'binary' : 'text', editable: value !== null, size: stat.size,
    ...(value === null ? {} : assetText(target.rel, value)) })
}

function readAssetText(file: string): string | null {
  if (!existsSync(file)) return ''
  if (!lstatSync(file).isFile()) return null
  // shortcut: 超过 1 MiB 的文件只展示元信息；需要编辑大资产时再提供专用编辑器。
  if (lstatSync(file).size > 1024 * 1024) return null
  const buffer = readFileSync(file)
  if (buffer.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) } catch { return null }
}

function editableText(file: string) {
  const value = readAssetText(file)
  if (value === null) throw new RpcError('path_rejected', '二进制、目录或超过 1 MiB 的文件只读')
  return value
}

async function validateDraft(root: string, payload: JsonMap, drafts: { rel: string; content: string }[], signal?: AbortSignal) {
  for (const draft of drafts) {
    try {
      if (['.ts', '.tsx', '.mts', '.cts'].includes(extname(draft.rel))) {
        const ts = createRequire(join(programRoot(), 'platform/plugin/package.json'))('typescript') as typeof import('typescript')
        const result = ts.transpileModule(draft.content, { fileName: draft.rel, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
        if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('TypeScript 语法无效')
      }
      if (extname(draft.rel) === '.json') JSON.parse(draft.content)
      if (['.yaml', '.yml'].includes(extname(draft.rel))) loadYaml(draft.content, { schema: DRAFT_YAML_SCHEMA })
    } catch { throw new RpcError('invalid_request', '草稿格式无效', { path: draft.rel }) }
  }
  const experimentId = experimentIdField(payload)
  const temp = mkdtempSync(join(tmpdir(), 'harness-edit-dry-'))
  try {
    for (const draft of drafts) atomicWrite(join(temp, draft.rel), draft.content)
    if (drafts.some(draft => draft.rel.endsWith('/candidate/harness.yaml'))) {
      const changePath = `evolution/experiments/${experimentId}/change.yaml`
      atomicWrite(join(temp, changePath), readFileSync(dataPath(root, changePath), 'utf8'))
      try { versionSource(temp, experimentId) }
      catch (error) { throw new RpcError('invalid_request', '装载声明无效', { reason: (error as Error).message }) }
    }
    const javascriptDrafts = drafts.filter(draft => ['.js', '.mjs', '.cjs'].includes(extname(draft.rel)))
    for (const draft of javascriptDrafts) {
      try {
        // 只解析本次草稿，不导入模块；关闭环境预加载，避免 --check 执行额外代码。
        await promisify(execFile)(process.execPath, ['--check', join(temp, draft.rel)], {
          cwd: temp, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20_000, signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new RpcError('aborted', '草稿校验已取消')
        const failed = error as Error & { stderr?: string }
        const reason = failed.stderr?.match(/^(?:SyntaxError|Error)(?: \[[^\]]+\])?:[^\r\n]*/m)?.[0]
        throw new RpcError('invalid_request', 'JavaScript 草稿语法校验失败', { path: draft.rel, checker: 'node --check', reason: redact(reason || 'Node 语法检查未通过') })
      }
    }
    return { mode: 'dry', preflight_scope: 'changed-files',
      checks: ['草稿格式', ...(javascriptDrafts.length ? ['JavaScript 语法（仅本次草稿）'] : [])],
      note: '仅检查本次文件；未执行源码、评测、模型或业务工具，未启动实例或创建 Run。' }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

async function previewEdit(root: string, payload: JsonMap, signal?: AbortSignal) {
  const raw = edits(payload)
  const targets = raw.map(edit => ({ edit, target: editablePath(root, payload, edit.path) }))
  assertUniqueResolved(targets.map(item => item.target))
  const result = targets.map(({ edit, target }) => {
    const before = editableText(target.file)
    if (assetText(target.rel, before).redacted) throw new RpcError('path_rejected', '含凭据常量的资产仅提供只读预览，请在本地维护后重新读取')
    const beforeHash = existsSync(target.file) ? sha256(before) : null
    if (edit.expected !== undefined && beforeHash !== edit.expected) throw new RpcError('conflict', '文件或存在状态已被修改', { path: target.rel, expected_sha256: edit.expected, actual_sha256: beforeHash })
    if (rejectsLlmApiKey(target.rel, edit.content)) throw new RpcError('secret_rejected', '拒绝写入 LLM API Key')
    if (target.rel.endsWith('/evaluation.md')) loadEvaluationPreview(root, edit.content)
    return { path: target.rel, exists: beforeHash !== null, before_sha256: beforeHash, after_sha256: sha256(edit.content), changed: beforeHash === null || before !== edit.content, diff: simpleDiff(target.rel, assetText(target.rel, before).content, assetText(target.rel, edit.content).content), redacted: assetText(target.rel, before).redacted || assetText(target.rel, edit.content).redacted }
  })
  const dryRun = await validateDraft(root, payload, targets.map(({ edit, target }) => ({ rel: target.rel, content: edit.content })), signal)
  return ok({ edits: result, dry_run: dryRun })
}

function evaluationPreviewCode(root: string) {
  return [
    'import json, sys, tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(join(programRoot(), dirname(EVALUATION_CONTRACT)))})`,
    'from evaluation_contract import load_evaluation',
    'with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as handle:',
    '    handle.write(sys.stdin.read())',
    '    name = handle.name',
    'try:',
    '    print(json.dumps(load_evaluation(Path(name)), ensure_ascii=False))',
    'finally:',
    '    Path(name).unlink(missing_ok=True)',
  ].join('\n')
}

function loadEvaluationPreview(root: string, content: string) {
  const run = spawnSync(process.env.HARNESS_PYTHON || 'python3', ['-c', evaluationPreviewCode(root)], { cwd: root, env: programEnvironment(root), input: content, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  if (run.status !== 0) throw new RpcError('invalid_request', 'evaluation.md 合同无效', { stderr: redact(run.stderr) })
  return JSON.parse(run.stdout) as JsonMap
}

async function applyEdit(root: string, payload: JsonMap, signal?: AbortSignal) {
  const resolved = edits(payload).map(edit => {
    const target = editablePath(root, payload, edit.path)
    const before = editableText(target.file)
    if (assetText(target.rel, before).redacted) throw new RpcError('path_rejected', '含凭据常量的资产仅提供只读预览，请在本地维护后重新读取')
    if (edit.expected === undefined) throw new RpcError('invalid_request', '写入必须提供 expected_sha256，新文件使用 null', { path: target.rel })
    const beforeHash = existsSync(target.file) ? sha256(before) : null
    if (beforeHash !== edit.expected) throw new RpcError('conflict', '文件或存在状态已被修改', { path: target.rel, expected_sha256: edit.expected, actual_sha256: beforeHash })
    if (rejectsLlmApiKey(target.rel, edit.content)) throw new RpcError('secret_rejected', '拒绝写入 LLM API Key')
    if (target.rel.endsWith('/evaluation.md')) loadEvaluationPreview(root, edit.content)
    return { ...target, content: edit.content, expected: edit.expected, before: beforeHash === null ? null : before }
  })
  assertUniqueResolved(resolved)
  const dryRun = await validateDraft(root, payload, resolved, signal)
  if (signal?.aborted) throw new RpcError('aborted', '草稿保存已取消')
  // dry 期间原文件可能变化；校验全部哈希后同步写入，避免异步交错。
  for (const item of resolved) {
    assertNoSymlinkPath(root, item.file)
    if ((existsSync(item.file) ? sha256(editableText(item.file)) : null) !== item.expected) throw new RpcError('conflict', '文件或存在状态已被修改', { path: item.rel })
  }
  const written: typeof resolved = []
  try {
    for (const item of resolved) { atomicWrite(item.file, item.content); written.push(item) }
  } catch (error) {
    for (const item of written.reverse()) {
      // 仅恢复本次实际写入且未被并行修改的内容。
      if (!existsSync(item.file) || sha256(editableText(item.file)) !== sha256(item.content)) continue
      if (item.before === null) rmSync(item.file)
      else atomicWrite(item.file, item.before)
    }
    throw error
  }
  return ok({ written: resolved.map(item => ({ path: item.rel, sha256: sha256(item.content) })), dry_run: dryRun })
}

async function cases(root: string, payload: JsonMap, signal?: AbortSignal) {
  const agentId = agentIdField(payload)
  const evaluation = await loadEvaluation(root, agentId, signal)
  return ok({ path: evaluation.path, sha256: evaluation.sha256, cases: evaluation.cases })
}

function caseFromEvaluation(evaluation: Awaited<ReturnType<typeof loadEvaluation>>, caseId: string) {
  const summary = evaluation.cases.find(item => item.id === caseId)
  const values = (evaluation.parsed.cases as Record<string, JsonMap> | undefined)?.[caseId]
  if (!summary || !values) throw new RpcError('not_found', '未找到测试用例', { case_id: caseId })
  return { id: summary.id, title: String(values.title), inputs: values.inputs as string[],
    expected_behavior: String(values.expected_behavior), scene: summary.scene, tier: summary.tier }
}

async function readCase(root: string, payload: JsonMap, signal?: AbortSignal) {
  const exp = experimentInfo(root, experimentIdField(payload))
  const evaluation = await loadEvaluation(root, exp.agent_id, signal)
  return ok({ case: caseFromEvaluation(evaluation, stringField(payload, 'case_id')), sha256: evaluation.sha256, path: evaluation.path })
}

async function updateCase(root: string, payload: JsonMap, signal?: AbortSignal) {
  const experimentId = experimentIdField(payload)
  const exp = experimentInfo(root, experimentId)
  const caseId = stringField(payload, 'case_id')
  const evaluation = await loadEvaluation(root, exp.agent_id, signal)
  const previous = caseFromEvaluation(evaluation, caseId)
  const expected = stringField(payload, 'expected_sha256')
  if (expected !== evaluation.sha256) throw new RpcError('conflict', '评测用例已被修改，请重新读取后保存', { expected_sha256: expected, actual_sha256: evaluation.sha256 })
  const title = stringField(payload, 'title')
  if (/[\r\n]/.test(title)) throw new RpcError('invalid_request', '用例名称必须为单行')
  if (!Array.isArray(payload.inputs) || !payload.inputs.length || payload.inputs.some(value => typeof value !== 'string' || !value.trim())) {
    throw new RpcError('invalid_request', '至少需要一条非空用户输入')
  }
  const inputs = (payload.inputs as string[]).map(value => value.replace(/\r\n?/g, '\n').trim())
  const expectedBehavior = stringField(payload, 'expected_behavior').replace(/\r\n?/g, '\n')
  if (typeof payload.fast !== 'boolean') throw new RpcError('invalid_request', 'fast 必须是布尔值')
  // 与 evaluation_contract 一致：普通四级标题属于预期正文，只有下一业务 Case 或一至三级章节结束该区块。
  const headings = [...evaluation.content.matchAll(/^#### (U-[A-Z0-9-]+)\s+([^\r\n]+)\r?$/gm)]
  const index = headings.findIndex(match => match[1] === caseId)
  if (index < 0) throw new RpcError('invalid_request', '无法定位用例正文')
  const start = headings[index].index!
  let end = headings[index + 1]?.index ?? evaluation.content.length
  const bodyStart = start + headings[index][0].length
  const nextSection = /^#{1,3} /m.exec(evaluation.content.slice(bodyStart, end))
  if (nextSection) end = bodyStart + nextSection.index
  const oldBlock = evaluation.content.slice(start, end)
  const newline = oldBlock.includes('\r\n') ? '\r\n' : '\n'
  const tail = oldBlock.match(/(?:\r?\n)*$/)?.[0] || newline
  const body = [`#### ${caseId} ${title}`, '', ...(payload.fast ? ['**评估档位：** `fast`', ''] : []),
    ...caseSourceReferences(oldBlock).flatMap(reference => [reference, '']),
    ...inputs.flatMap((input, turn) => [`**用户输入${inputs.length > 1 ? ` ${turn + 1}` : ''}**`, '',
      ...input.split('\n').map(line => `> ${line}`), '']), '**预期**', '', ...expectedBehavior.split('\n')].join(newline)
  const content = evaluation.content.slice(0, start) + body + tail + evaluation.content.slice(end)
  const parsed = loadEvaluationPreview(root, content)
  const selected = (parsed.cases as Record<string, JsonMap>)[caseId]
  const row = (parsed.catalog as JsonMap[]).find(item => item.case_id === caseId)
  if (!selected || selected.title !== title || JSON.stringify(selected.inputs) !== JSON.stringify(inputs) || selected.expected_behavior !== expectedBehavior ||
    row?.scene !== previous.scene || row?.fast !== payload.fast || JSON.stringify(parsed.case_ids) !== JSON.stringify(evaluation.parsed.case_ids)) {
    throw new RpcError('invalid_request', '用例内容无法按评测合同完整保存，请检查输入和预期中的 Markdown 标题')
  }
  await applyEdit(root, { experiment_id: experimentId, edits: [{ path: evaluation.path, content, expected_sha256: expected }] }, signal)
  const saved = await loadEvaluation(root, exp.agent_id, signal)
  if (saved.sha256 !== sha256(content)) throw new RpcError('conflict', '保存后评测文件再次变化，请重新读取')
  return ok({ case: caseFromEvaluation(saved, caseId), sha256: saved.sha256, path: saved.path })
}

function evalArgs(payload: JsonMap, dryRun: boolean, modelPolicyPath?: string, mcpFixturePath?: string) {
  const source = stringField(payload, 'source')
  if (source.startsWith('experiment:')) experimentIdValue(source.slice('experiment:'.length), 'source')
  const args = [DSH_EVAL, '--source', source, '--mode', optionalString(payload, 'mode') ?? 'fast', '--executor', optionalString(payload, 'executor') ?? 'api', '--review', optionalString(payload, 'review') ?? 'none']
  const cases = payload.cases
  if (Array.isArray(cases)) for (const item of cases) if (typeof item === 'string' && item) args.push('--case', item)
  const model = optionalString(payload, 'model')
  const compareTo = optionalString(payload, 'compare_to')
  if (model) args.push('--model', model)
  if (modelPolicyPath) args.push('--model-policy', modelPolicyPath)
  if (payload.source_ref !== undefined) {
    if (typeof payload.source_ref !== 'string' || !/^git:[a-f0-9]{40}$/.test(payload.source_ref)) throw new RpcError('invalid_request', 'source_ref 必须是 git:<40位提交>')
    args.push('--source-ref', payload.source_ref)
  }
  if (mcpFixturePath) args.push('--mcp-fixture', mcpFixturePath)
  if (compareTo) args.push('--compare-to', compareTo)
  if (payload.artifact_export !== undefined) {
    const artifact = requireObject(payload.artifact_export)
    if (artifact.format !== 'markdown' || typeof artifact.filename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/.test(artifact.filename)) {
      throw new RpcError('invalid_request', '回答导出需要 markdown 格式和不含目录的 .md 文件名')
    }
    args.push('--export-response-markdown', artifact.filename)
  }
  if (dryRun) args.push('--dry-run')
  return args
}

function commandJson(root: string, args: string[]) {
  return parseJsonCommand(root, args)
}

function cleanupEvalPolicies(root: string, jobId: string) {
  const directory = workspaceLocalPath(root, 'evaluation-jobs', 'model-policies')
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) if (name.startsWith(`${jobId}-`)) rmSync(join(directory, name), { recursive: true, force: true })
}

async function evalCommand(root: string, payload: JsonMap, dryRun: boolean, modelPolicy?: EvalModelPolicyProvider,
  jobId = 'preview'): Promise<{ executable: string; args: string[]; environment?: NodeJS.ProcessEnv; dispose?: () => void }> {
  const selectedId = typeof payload.source === 'string' ? payload.source.replace(/^experiment:/, '') : ''
  if (!modelPolicy && payload.source_ref === undefined && payload.mcp_fixture === undefined) {
    if (payload.model_selection !== undefined) throw new RpcError('model_policy_unavailable', '当前执行入口没有原生模型投影，无法应用 model_selection')
    if (EXP_ID.test(selectedId) && existsSync(join(root, 'evolution/experiments', selectedId, 'candidate/harness.yaml'))
      && versionSource(root, selectedId).profile === 'sdk') throw new RpcError('sdk_evaluation_unavailable', 'SDK 型版本请使用 SDK 调试入口；当前评测执行器使用 Web 会话协议')
    return { executable: process.env.HARNESS_PYTHON || 'python3', args: programArgs(evalArgs(payload, dryRun)) }
  }
  const ref = payload.source_ref
  if (ref !== undefined && (typeof ref !== 'string' || !/^git:[a-f0-9]{40}$/.test(ref))) throw new RpcError('invalid_request', 'source_ref 必须是 git:<40位提交>')
  const fixed = ref ? materializeEvaluationSource(root, selectedId, ref) : undefined
  const source = fixed ? { id: selectedId, agent_id: fixed.agent_id, candidate: join(fixed.root, 'evolution/experiments', selectedId, 'candidate') }
    : sourceInfo(root, stringField(payload, 'source'))
  if (versionSource(fixed?.root ?? root, selectedId).profile === 'sdk') throw new RpcError('sdk_evaluation_unavailable', 'SDK 型版本请使用 SDK 调试入口；当前评测执行器使用 Web 会话协议')
  const fixture = payload.mcp_fixture === undefined ? undefined : validateMcpFixture(payload.mcp_fixture)
  if (!modelPolicy && payload.model_selection !== undefined) throw new RpcError('model_policy_unavailable', '当前执行入口没有原生模型投影，无法应用 model_selection')
  let projected: Awaited<ReturnType<EvalModelPolicyProvider>> | undefined
  try {
    let selection: Parameters<EvalModelPolicyProvider>[1]
    if (payload.model_selection !== undefined) {
      const value = requireObject(payload.model_selection)
      if (typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model || value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') throw new Error('model_selection 需要原生 provider/model/reasoningEffort')
      selection = { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort as string }) }
    }
    projected = await modelPolicy?.(source.agent_id, selection, source.candidate)
  }
  catch (error) { throw new RpcError('model_policy_unavailable', redact((error as Error).message)) }
  if (!projected && !fixture) return { executable: process.env.HARNESS_PYTHON || 'python3', args: programArgs(evalArgs(payload, dryRun)) }
  const directory = workspaceLocalPath(root, 'evaluation-jobs', 'model-policies')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(directory, `${jobId}-`))
  try {
    const file = join(temporary, 'policy.json')
    if (projected) writeFileSync(file, JSON.stringify(projected.policy), { mode: 0o600, flag: 'wx' })
    const fixtureFile = fixture ? join(temporary, 'mcp-fixture.json') : undefined
    if (fixtureFile) writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return { executable: process.env.HARNESS_PYTHON || 'python3', args: programArgs(evalArgs(payload, dryRun, projected ? file : undefined, fixtureFile)),
      environment: projected?.environment, dispose: () => rmSync(temporary, { recursive: true, force: true }) }
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
}

async function evalPreview(root: string, payload: JsonMap, signal?: AbortSignal, modelPolicy?: EvalModelPolicyProvider) {
  const prepared = await evalCommand(root, payload, true, modelPolicy)
  try {
    const command = modelPolicy
      ? [prepared.executable, ...programArgs(evalArgs(payload, true, '<平台模型投影>', payload.mcp_fixture ? '<本次Mock连接映射>' : undefined))]
      : [prepared.executable, ...prepared.args]
    return ok({ command, result: await parseJsonCommandAsync(root, prepared.args, '评测预览失败', signal, undefined, prepared.environment) })
  } finally { prepared.dispose?.() }
}

async function runRecord(root: string, op: 'index' | 'overview' | 'show' | 'compare', payload: JsonMap, signal?: AbortSignal) {
  const args = [RUN_RECORD, '--repo', root, op]
  if (op === 'index') args.push('--agent', agentIdField(payload))
  if (op === 'show') {
    assertRunFiles(root, stringField(payload, 'run_id'))
    args.push('--run', stringField(payload, 'run_id'))
    const caseId = optionalString(payload, 'case_id')
    if (caseId) args.push('--case', caseId)
  }
  if (op === 'compare') {
    assertRunFiles(root, stringField(payload, 'left'))
    assertRunFiles(root, stringField(payload, 'right'))
    args.push('--left', stringField(payload, 'left'), '--right', stringField(payload, 'right'))
    const caseId = optionalString(payload, 'case_id')
    if (caseId) args.push('--case', caseId)
  }
  let stdout: string
  try {
    ({ stdout } = await promisify(execFile)(process.env.HARNESS_PYTHON || 'python3', programArgs(args), {
      cwd: root, env: programEnvironment(root), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20_000, signal,
    }))
  } catch (error) {
    const failed = error as Error & { stderr?: string; stdout?: string }
    throw new RpcError('run_read_failed', 'Run 查询失败', {
      reason: redact(failed.stderr || failed.stdout || failed.message),
    })
  }
  return ok(JSON.parse(redact(stdout, Infinity)) as JsonMap)
}

function assertRunFiles(root: string, runId: string) {
  if (!RUN_ID.test(runId)) throw new RpcError('invalid_request', 'run_id 必须是 run-<UUIDv4>')
  const experiments = join(root, 'evolution/experiments')
  function visit(path: string) {
    if (lstatSync(path).isSymbolicLink()) throw new RpcError('path_rejected', 'Run 不得通过符号链接读取外部文件')
    if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  for (const id of listDirs(experiments)) {
    const path = join(experiments, id, 'runs', runId)
    if (existsSync(path)) { assertNoSymlinkPath(root, path); visit(path) }
  }
}

async function readRunEvidence(root: string, payload: JsonMap, signal?: AbortSignal) {
  const filename = stringField(payload, 'filename')
  const caseId = stringField(payload, 'case_id')
  const view = await runRecord(root, 'show', payload, signal)
  if (!view.ok) return view
  const cases = view.value.cases as JsonMap[]
  const selected = cases.find(item => item.case_id === caseId)
  const entry = (selected?.raw_evidence as Record<string, { path: string; present: boolean }> | undefined)?.[filename]
  if (!entry?.present) throw new RpcError('not_found', '该 Run/Case 没有此轨迹或证据文件')
  const file = repoPath(root, entry.path)
  assertNoSymlinkPath(root, file)
  const limit = 64 * 1024
  const buffer = Buffer.alloc(limit + 1)
  const fd = openSync(file, 'r')
  let size: number
  try { size = readSync(fd, buffer, 0, buffer.length, 0) } finally { closeSync(fd) }
  // shortcut: 轨迹只展示前 64 KiB；日常使用需要完整浏览时再增加分页读取。
  return ok({ path: entry.path, content: redact(buffer.subarray(0, Math.min(size, limit)).toString('utf8'), Infinity), truncated: size > limit })
}

function decisionChange(root: string, payload: JsonMap) {
  const id = experimentIdField(payload)
  if (payload.status !== undefined && (typeof payload.status !== 'string' || !['active', 'completed'].includes(payload.status))) throw new RpcError('invalid_request', 'status 必须是 active 或 completed')
  if (payload.outcome !== undefined && (typeof payload.outcome !== 'string' || !['adopt', 'continue', 'reject', 'inconclusive'].includes(payload.outcome))) throw new RpcError('invalid_request', 'outcome 必须是 adopt、continue、reject 或 inconclusive')
  const expectedChange = stringField(payload, 'expected_change_sha256')
  const file = changePath(root, id)
  assertNoSymlinkPath(root, file)
  const before = readFileSync(file, 'utf8')
  if (sha256(before) !== expectedChange) throw new RpcError('conflict', '研究版本状态已变化，请重新读取后确认')
  const current = readYamlMap(root, file, before)
  const updated = { ...current, ...(payload.status === undefined ? {} : { status: payload.status }), ...(payload.outcome === undefined ? {} : { outcome: payload.outcome }) }
  if (updated.status === 'completed' && !['adopt', 'continue', 'reject', 'inconclusive'].includes(String(updated.outcome))) throw new RpcError('invalid_request', '完成研究时必须同时选择有效 outcome')
  const after = dumpYaml(updated, { forceQuotes: true, quotingType: '"', lineWidth: -1, noRefs: true })
  return { file, before, after, current, updated, expectedChange }
}

function decisionExpected(payload: JsonMap): string | null {
  if (payload.expected_sha256 === null) return null
  return stringField(payload, 'expected_sha256')
}

async function decisionPreview(root: string, payload: JsonMap, signal?: AbortSignal) {
  const id = experimentIdField(payload)
  const change = payload.status === undefined && payload.outcome === undefined ? undefined : decisionChange(root, payload)
  const result = await previewEdit(root, { experiment_id: id, edits: [{ path: 'decision.md', content: textField(payload, 'content'), expected_sha256: decisionExpected(payload) }] }, signal)
  if (!result.ok || !change) return result
  return ok({ ...result.value, change: { path: repoRelative(root, change.file), before: { status: change.current.status, outcome: change.current.outcome ?? null },
    after: { status: change.updated.status, outcome: change.updated.outcome ?? null }, before_sha256: sha256(change.before), after_sha256: sha256(change.after) } })
}

async function decisionUpdate(root: string, payload: JsonMap, signal?: AbortSignal) {
  const id = experimentIdField(payload)
  const content = textField(payload, 'content')
  const expected = decisionExpected(payload)
  // 原有编辑器仅维护说明；结构化结论通过两个摘要共同确认。
  if (payload.status === undefined && payload.outcome === undefined) {
    const result = await applyEdit(root, { experiment_id: id,
      edits: [{ path: 'decision.md', content, expected_sha256: expected }],
    }, signal)
    if (!result.ok) return result
    const written = result.value.written[0]
    return ok({ path: written.path, sha256: written.sha256 })
  }
  const decision = editablePath(root, { experiment_id: id }, 'decision.md')
  const { file: changeFile, before: beforeChange, after: afterChange, updated } = decisionChange(root, payload)
  const beforeDecision = existsSync(decision.file) ? editableText(decision.file) : null
  if ((beforeDecision === null ? null : sha256(beforeDecision)) !== expected) throw new RpcError('conflict', '研究结论已变化，请重新读取后确认')
  if (rejectsLlmApiKey(decision.rel, content)) throw new RpcError('secret_rejected', '拒绝写入 LLM API Key')
  if (signal?.aborted) throw new RpcError('aborted', '研究结论保存已取消')
  let wroteDecision = false, wroteChange = false
  try {
    atomicWrite(decision.file, content); wroteDecision = true
    atomicWrite(changeFile, afterChange); wroteChange = true
    const validation = await validateResearch(root, id, signal)
    if (validation.valid !== true) throw new RpcError('validation_failed', '研究结论未通过校验，已恢复原内容', { validation })
    if (sha256(readFileSync(decision.file)) !== sha256(content) || sha256(readFileSync(changeFile)) !== sha256(afterChange)) throw new RpcError('conflict', '保存校验期间文件再次变化')
    return ok({ path: decision.rel, sha256: sha256(content), change_sha256: sha256(afterChange), status: updated.status, outcome: updated.outcome ?? null, validation })
  } catch (error) {
    // 只恢复本操作写入的内容，保留其他进程的并发修改并明确报告待恢复状态。
    try {
      assertNoSymlinkPath(root, decision.file); assertNoSymlinkPath(root, changeFile)
      if ((wroteDecision && sha256(readFileSync(decision.file)) !== sha256(content)) || (wroteChange && sha256(readFileSync(changeFile)) !== sha256(afterChange))) {
        throw new Error('concurrent-change')
      }
      if (wroteDecision) { if (beforeDecision === null) rmSync(decision.file); else atomicWrite(decision.file, beforeDecision) }
      if (wroteChange) atomicWrite(changeFile, beforeChange)
    } catch { throw new RpcError('needs_recovery', '结论保存失败且文件又有变化，请核对 decision.md 与 change.yaml', { experiment_id: id }) }
    throw error
  }
}

export function createAgentsHandler(assetRoot: string, onChange?: () => void, capabilityOptions: CapabilityOptions = {},
  modelPolicy?: EvalModelPolicyProvider, deployment?: ConnectionRpcHandler): ConnectionRpcHandler {
  const root = rootOf(assetRoot)
  const sdk = createSdkHandler(root, { modelPolicy, onChange })
  const jobs = createEvaluationJobs(root, {
    command: (payload, jobId) => evalCommand(root, payload, false, modelPolicy, jobId),
    environment: () => programEnvironment(root), redact: text => redact(text, 16 * 1024), onChange,
    cleanup: jobId => cleanupEvalPolicies(root, jobId),
  })
  const previews = new Map<string, VersionPreview>()
  const datasets = createDecisionDatasetHandler(root)
  const computeBuild = createComputeBuildHandler(root)
  const assetBuild = createAssetBuildHandler(root)
  const assetDependencies = createAssetDependenciesHandler(root)
  const migrations = createMigrationsHandler(root)
  const computeFreeze = createComputeFreezeHandler(root)
  const variantIdentity = createVariantIdentityMigrationHandler(root)
  const computeVariants = createComputeVariantsHandler(root, {
    createExperiment: (payload, variant) => createExperiment(root, payload, variant),
    candidateDigest: id => candidateDigest(root, id),
    gitCandidateDigest: (id, ref) => gitCandidateDigest(root, id, ref),
    readRun: async (runId, signal) => {
      const result = await runRecord(root, 'show', { run_id: runId }, signal)
      if (!result.ok) throw new RpcError(result.error.code, result.error.message)
      return result.value
    },
  })
  const trainingServers = createTrainingServersHandler(root)
  const caseManagement = createCaseManagementHandler(root, {
    applyEvaluation: async (id, content, hash, signal) => {
      const result = await applyEdit(root, { experiment_id: id, edits: [{ path: 'evaluation.md', content, expected_sha256: hash }] }, signal)
      if (!result.ok) throw new RpcError(result.error.code, result.error.message)
      return result
    },
    readRun: async (runId, signal) => {
      const result = await runRecord(root, 'show', { run_id: runId }, signal)
      if (!result.ok) throw new RpcError(result.error.code, result.error.message)
      return result.value as unknown as RunCaseSource
    },
  })
  return async (endpoint, payload, signal, peer) => {
    if (signal.aborted) return failure(new RpcError('aborted', '智能体操作已取消'))
    if (endpoint.startsWith('deployment/') && deployment) return deployment(endpoint.slice('deployment/'.length), payload, signal, peer)
    try {
      const body = payload === undefined ? {} : requireObject(payload)
      if (endpoint.startsWith('migrations/')) return await migrations(endpoint.slice('migrations/'.length) as any, body, signal)
      if (endpoint === 'assets/build-preview' || endpoint === 'assets/build') {
        const result = await assetBuild(endpoint === 'assets/build-preview' ? 'preview' : 'build', body, signal)
        return result.ok ? ok(result.value) : failure(new RpcError(result.error.code, result.error.message))
      }
      if (endpoint === 'assets/dependencies/prepare') {
        const result = await assetDependencies(body, signal)
        return result.ok ? ok(result.value) : failure(new RpcError(result.error.code, result.error.message))
      }
      if (endpoint.startsWith('sdk/')) return await sdk(endpoint.slice(4), body, signal, peer)
      if (endpoint.startsWith('datasets/')) return ok(await datasets(endpoint, body, signal))
      if (endpoint.startsWith('training-servers/')) return trainingServers(endpoint.slice('training-servers/'.length), body, signal, peer)
      if (endpoint.startsWith('compute-variants/')) {
        const method = endpoint.slice('compute-variants/'.length)
        const result = ['identity-preview', 'identity-apply'].includes(method) ? await variantIdentity(method, body, signal)
          : ['build-preview', 'build'].includes(method) ? await computeBuild(method === 'build-preview' ? 'preview' : 'build', body, signal)
          : ['freeze-preview', 'freeze'].includes(method) ? await computeFreeze(method === 'freeze-preview' ? 'preview' : 'freeze', body, signal)
            : await computeVariants(method, body, signal)
        return result.ok ? ok(result.value) : failure(new RpcError(result.error.code, result.error.message))
      }
      switch (endpoint) {
        case 'research/read-reference': return ok(readResearchReference(root, body.topic))
        case 'research/validate': return ok(await validateResearch(root, experimentIdField(body), signal))
        case 'legacy/inspect': return ok(await inspectLegacy(root, body.path, signal))
        case 'tasks/capabilities': return ok(await discoverTaskCapabilities(root, { ...capabilityOptions, signal, agent_id: optionalString(body, 'agent_id'), source: optionalString(body, 'source'), server_id: optionalString(body, 'server_id') }))
        case 'tasks/assembly-preview': return ok(await previewTaskAssembly(root, body as unknown as TaskAssemblyInput))
        case 'tasks/assembly-apply': {
          if (body.confirmed !== true) throw new RpcError('confirmation_required', '请先确认资产装配方案')
          return ok(await applyTaskAssembly(root, body as unknown as TaskAssemblyInput))
        }
        case 'list': return list(root)
        case 'description': return agentDescription(root, body)
        case 'detail': return await detail(root, body, signal)
        case 'create': return await createExperiment(root, body)
        case 'new': return await createAgent(root, body, signal)
        case 'assets/diff': return await readAssetDiff(root, body, signal)
        case 'assets/read-fixed': return await readFixedAsset(root, body, signal)
        case 'features/read-source': return readFeatureSource(root, body)
        case 'features/preview': return featurePreview(root, body, previews)
        case 'features/proposal': return latestProposal(body, previews, 'features')
        case 'features/apply': return featureApply(root, body, previews)
        case 'fusion/preview': return fusionPreview(root, body, previews)
        case 'fusion/proposal': return latestProposal(body, previews, 'fusion')
        case 'fusion/confirm': return await fusionConfirm(root, body, previews)
        case 'fusion/status': return fusionStatus(root, body)
        case 'fusion/verify': return await fusionVerify(root, body, signal)
        case 'fusion/finalize': return fusionFinalize(root, body)
        case 'edit/read': return readEditable(root, body)
        case 'edit/preview': return await previewEdit(root, body, signal)
        case 'edit/apply': return await applyEdit(root, body, signal)
        case 'cases/list': return await cases(root, body, signal)
        case 'cases/read': return await readCase(root, body, signal)
        case 'cases/update': return await updateCase(root, body, signal)
        case 'cases/create-context':
        case 'cases/from-run':
        case 'cases/create-preview':
        case 'cases/create': return await caseManagement(endpoint, body, signal, peer)
        case 'eval/preview': return await evalPreview(root, body, signal, modelPolicy)
        case 'eval/start': return ok(await jobs.start(body))
        case 'eval/list': return ok({ jobs: jobs.list().map(job => {
          const experimentId = job.source.startsWith('experiment:') ? job.source.slice('experiment:'.length) : null
          let agentId: string | null = null
          if (experimentId && EXP_ID.test(experimentId)) {
            try { agentId = experimentInfo(root, experimentId).agent_id } catch { /* 来源可能已移除，原 Job 仍可查询。 */ }
          }
          return { ...job, experiment_id: experimentId, agent_id: agentId }
        }) })
        case 'eval/status': return ok(jobs.status(stringField(body, 'job_id')))
        case 'eval/cancel': return ok(jobs.cancel(stringField(body, 'job_id')))
        case 'runs/index': return await runRecord(root, 'index', body, signal)
        case 'runs/overview': return await runRecord(root, 'overview', body, signal)
        case 'runs/show': return await runRecord(root, 'show', body, signal)
        case 'runs/evidence': return await readRunEvidence(root, body, signal)
        case 'runs/report': return ok(await readRunReport(root, stringField(body, 'run_id'), signal))
        case 'runs/files': return ok(await listRunFiles(root, stringField(body, 'run_id'), signal))
        case 'runs/read-file': return ok(await previewRunFile(root, stringField(body, 'run_id'), stringField(body, 'path'), signal))
        case 'runs/compare': return await runRecord(root, 'compare', body, signal)
        case 'runs/trace': return ok(await readRunTrace(root, body as any, signal))
        case 'decision/preview': return await decisionPreview(root, body, signal)
        case 'decision/update': return await decisionUpdate(root, body, signal)
        default: return failure(new RpcError('not_found', '未知的智能体操作', { endpoint }))
      }
    } catch (error) {
      return failure(error)
    }
  }
}
