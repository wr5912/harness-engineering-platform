import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_SCHEMA, Type, dump, load } from 'js-yaml'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { createAgent } from './create-agent.ts'
import { assetText } from './asset-text.ts'
import { businessCasesSchema } from './business-cases.ts'
import { inheritedLoadableAssets, versionIdentity, versionSource } from './version-source.ts'
import { VERSION_ID, assertInheritableVersion } from '../version-id.ts'
import { candidateDigest, candidateFiles, dataPath, sha256 } from '../tasks/files.ts'
import { instanceStateRoot, workspaceOwnsInstance } from '../workspace.ts'
import { inspectAssetBuild } from './asset-build.ts'
import { migrationRunEvidence } from './migrations-evidence.ts'
import { parseEvaluationDocument } from '../evaluation/cases.ts'
import { computeGenerationContract } from './compute-generation-contract.ts'
import { MigrationError, canonical, excludedMigrationPath, inspectMigrationSource, loadMigrationSource, migrationFail as fail, migrationSourceBytes, migrationWrite, readMigrationSource, safeSourcePath, type MigrationMap, type MigrationSource } from './migrations-source.ts'

export type MigrationMethod = 'inspect' | 'read' | 'preview' | 'apply' | 'resolve' | 'status'
export type MigrationTarget = { kind: 'new-agent'; agent_id: string; name: string; description: string; role: string } | { kind: 'new-version'; agent_id: string; parent_experiment_id: string; parent_ref: string; research_question: string }
export type MigrationFile = { path: string; content?: string; source_path?: string; source_sha256?: string; executable?: boolean }
export type MigrationPreviewInput = { source_id: string; fingerprint: string; target: MigrationTarget; files: MigrationFile[]; mapping: MigrationMap[]; uncovered?: string[]; scope_limitations?: string[]; case_ids?: string[]; evaluation_cases?: unknown; model_bindings?: MigrationMap; project_workspace?: { path: string }; role_instructions?: Record<string, string> }
type Operation = { schema_version: 1; operation_id: string; created_at: string; updated_at: string; state: 'preparing' | 'prepared' | 'publishing' | 'published' | 'failed'; agent_id: string; experiment_id: string; target_kind: string; source_id: string; source_fingerprint: string; preview_sha256?: string; asset_list_sha256?: string; candidate_sha256?: string; experiment_tree_sha256?: string; agent_tree_sha256?: string; manifest_sha256?: string; evaluation_before_sha256?: string | null; evaluation_after_sha256?: string; error?: { code: string; message: string }; summary?: MigrationMap; validation?: MigrationMap }
const EVIDENCE = 'evaluation/evidence/migration.json'
const RESOLUTION_ROOT = 'evaluation/evidence/migration-resolutions'
// 原生 Loader 的 !!js 只作为标量清点，迁移静态校验不执行表达式。
const READ_ONLY_DSH_SCHEMA = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
const EXP_PATH = (id: string) => `evolution/experiments/${id}`
const isMap = (value: unknown): value is MigrationMap => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function text(value: unknown, name: string, maximum = 24000): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) fail(`${name} 必须非空，且不超过 ${maximum} 字节`)
  if (assetText(name, value).redacted) fail(`${name} 包含凭据常量，请移除后重试`, 'secret_rejected')
  return value.trim()
}
function jsonSafe(value: unknown, name: string, maximum = 128 * 1024): void {
  const content = canonical(value)
  if (!content || Buffer.byteLength(content) > maximum) fail(`${name} 内容超过允许范围`)
  if (assetText(`${name}.json`, content).redacted) fail(`${name} 包含凭据常量`, 'secret_rejected')
}
function treeDigest(root: string): string {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('迁移目录不存在或不是实体目录', 'conflict')
  const entries: unknown[] = []
  function walk(relative: string) {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name, file = dataPath(root, path), stat = lstatSync(file)
      if (stat.isDirectory()) { entries.push([path, 'directory']); walk(path) }
      else if (stat.isFile()) entries.push([path, stat.mode & 0o111 ? 0o755 : 0o644, sha256(readFileSync(file))])
      else fail('迁移目录不能包含特殊文件', 'conflict')
    }
  }
  walk(''); return sha256(canonical(entries))
}
function yaml(file: string): MigrationMap {
  const value = load(readFileSync(file, 'utf8')); if (!isMap(value)) fail('资产 YAML 必须是对象'); return value
}
function writeYaml(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, dump(value, { noRefs: true, lineWidth: -1 }), { flag: 'wx' }); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}
function operationDirectory(root: string, id: unknown) {
  if (typeof id !== 'string' || !/^migration-[0-9a-f-]{36}$/.test(id)) fail('operation_id 无效')
  return dataPath(root, `.local/migrations/operations/${id}`)
}
function loadOperation(root: string, id: unknown): Operation {
  const file = join(operationDirectory(root, id), 'operation.json')
  if (!existsSync(file)) fail('迁移操作不存在', 'not_found')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function saveOperation(root: string, operation: Operation) { operation.updated_at = new Date().toISOString(); migrationWrite(join(operationDirectory(root, operation.operation_id), 'operation.json'), operation) }
function fixedGit(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'buffer', maxBuffer })
  if (result.status !== 0 || result.error) fail('无法读取固定 Git 父版，请确认提交和资产已入仓', 'invalid_parent')
  return result.stdout
}
function parentTarget(root: string, target: MigrationMap) {
  const agent = text(target.agent_id, 'target.agent_id', 80), id = text(target.parent_experiment_id, 'target.parent_experiment_id', 160), ref = text(target.parent_ref, 'target.parent_ref', 80)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent) || !VERSION_ID.test(id) || !/^git:[0-9a-f]{40}$/.test(ref)) fail('已有智能体必须提供所属 Agent、父版 EXP 和固定 git:<40位提交>')
  const change = versionIdentity(root, id, ref.slice(4)); assertInheritableVersion(id, change)
  // 当前登记也不能把历史同名 EXP 变体伪装为可继承业务版本。
  if (existsSync(dataPath(root, `${EXP_PATH(id)}/change.yaml`))) assertInheritableVersion(id, versionIdentity(root, id))
  if (change.agent_id !== agent) fail('父版与目标 Agent 不一致')
  const source = versionSource(root, id, ref.slice(4))
  const manifest = dataPath(root, `agents/${agent}/manifest.yaml`)
  if (!existsSync(manifest)) fail('目标 Agent 不存在', 'not_found')
  return { agent, id, ref, source, manifest, manifest_sha256: sha256(readFileSync(manifest)), question: text(target.research_question, 'target.research_question') }
}
function freshId(root: string, agent: string, first = false) {
  const directory = dataPath(root, 'evolution/experiments')
  const versions = existsSync(directory) ? readdirSync(directory) : []
  const number = first ? 1 : Math.max(0, ...versions.filter(id => id.startsWith('EXP-') && VERSION_ID.exec(id)?.[1] === agent).map(id => Number(VERSION_ID.exec(id)![2]))) + 1
  if (number > 999) fail('该 Agent 的版本序号已用完')
  let id: string; do { id = `EXP-${agent}-${String(number).padStart(3, '0')}-r${randomBytes(6).toString('hex')}` } while (existsSync(join(directory, id)))
  return id
}
function targetAssetPath(path: unknown) {
  const value = safeSourcePath(path)
  if (value !== 'harness.yaml' && !/^dsh\/(?:workspace|presets|managed)\/.+/.test(value)) fail('目标资产必须位于 Candidate 的 harness.yaml 或三棵 DSH 资产目录')
  const reason = excludedMigrationPath(value)
  if (reason) fail(`目标路径不适合作为 Harness 资产：${reason}`)
  return value
}
function copyFixedParent(root: string, parent: ReturnType<typeof parentTarget>, candidate: string) {
  const prefix = `${EXP_PATH(parent.id)}/candidate/`, rows = fixedGit(root, ['ls-tree', '-r', '-z', parent.ref.slice(4), '--', prefix]).toString().split('\0').filter(Boolean)
  rmSync(candidate, { recursive: true, force: true }); mkdirSync(candidate, { recursive: true })
  let total = 0
  for (const row of rows) {
    const match = /^(\d+) (\S+) [0-9a-f]+\t([\s\S]+)$/.exec(row)
    if (!match || match[2] !== 'blob' || match[1] === '120000') fail('固定父版不能包含链接或子模块')
    const path = match[3].slice(prefix.length)
    if (excludedMigrationPath(path)) continue
    // 历史附加资产可以继续继承，但不把运行目录和凭据带入新版本。
    safeSourcePath(path)
    const bytes = fixedGit(root, ['show', `${parent.ref.slice(4)}:${match[3]}`], 64 * 1024 * 1024)
    total += bytes.length; if (total > 64 * 1024 * 1024) fail('固定父版资产超过 64 MiB，请先整理来源')
    if (assetText(path, bytes.toString()).redacted) fail('固定父版含凭据常量，请先清理父版', 'secret_rejected')
    const file = dataPath(candidate, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { mode: parseInt(match[1], 8) & 0o111 ? 0o755 : 0o644 })
  }
  // 与普通版本创建保持同一装载格式，旧固定提交中的来源声明只读解析。
  const file = join(candidate, 'harness.yaml'), harness = existsSync(file) ? yaml(file) : {}
  delete harness.experiment; delete harness.runtime_contract
  harness.loadable_assets = inheritedLoadableAssets(parent.source, parent.id)
  harness.credential_environment_keys = [...new Set([...(parent.source.required_env_names ?? []), ...(parent.source.optional_env_names ?? [])])]
  writeYaml(file, harness)
}
function caseMarkdown(cases: MigrationMap[]) {
  return cases.map(item => `\n#### ${item.id} ${item.title}\n\n${item.fast ? '**评估档位：** \`fast\`\n\n' : ''}**用户输入**\n\n${item.inputs.split(/\r?\n/).map((line: string) => `> ${line}`).join('\n')}\n\n**预期**\n\n${item.expected_behavior}\n`).join('\n')
}
function assertLoadable(stage: string, id: string) {
  const source = versionSource(stage, id)
  for (const path of [`${source.candidate_root}/presets/${source.preset}`, `${source.candidate_root}/managed/${source.patch}`, ...(source.guard ? [`${source.candidate_root}/managed/${source.guard}`] : [])]) {
    const file = dataPath(stage, path)
    if (!existsSync(file) || !lstatSync(file).isFile()) fail('迁移后的 DSH 装载入口不存在')
    const content = readFileSync(file, 'utf8'); load(content, { schema: READ_ONLY_DSH_SCHEMA })
    if (assetText(path, content).redacted) fail('DSH 装载入口包含凭据常量', 'secret_rejected')
  }
  const harness = yaml(join(stage, EXP_PATH(id), 'candidate/harness.yaml'))
  for (const path of Object.values(harness.role_instructions ?? {})) if (!existsSync(dataPath(join(stage, EXP_PATH(id), 'candidate'), targetAssetPath(path)))) fail('角色指令引用的文件不存在')
  if (harness.project_workspace) {
    const path = targetAssetPath(harness.project_workspace.path), file = dataPath(join(stage, EXP_PATH(id), 'candidate'), path)
    if (!existsSync(file) || !lstatSync(file).isDirectory()) fail('项目工作区必须引用已选入 Candidate 的目录')
  }
  return { valid: true, scope: 'static-loadable-assets', runtime_verified: false, business_verified: false }
}
function generatedConfiguration(stage: string, id: string) {
  const source = versionSource(stage, id), candidateRoot = `${EXP_PATH(id)}/candidate`
  let remaining = 128 * 1024
  const files = ['harness.yaml', `dsh/presets/${source.preset}`, `dsh/managed/${source.patch}`].map(relative => {
    const path = `${candidateRoot}/${relative}`, bytes = readFileSync(dataPath(stage, path)), content = bytes.toString('utf8')
    const readable = bytes.length <= Math.min(64 * 1024, remaining)
    if (readable) remaining -= bytes.length
    return { path, candidate_path: relative, bytes: bytes.length, sha256: sha256(bytes), content: readable ? content : null,
      ...(readable ? {} : { note: '正文超过本次预览的返回限额；发布后按 read_input 读取完整资产，不使用省略正文覆盖文件。' }),
      read_input: { experiment_id: id, path } }
  })
  return { target_source: { source_id: `experiment:${id}`, ...source }, generated_configuration: files,
    build_contract: { entry_path: 'Candidate 内 dsh/managed/ 下的 .ts 文件', output_path: '与入口同目录、同文件名的 .mjs 文件', preview_action: 'assets/build-preview', build_action: 'assets/build', sdk: computeGenerationContract().sdk, note: 'DSH 插件配置引用构建得到的 .mjs；使用实际构建回执的 output_path，不直接装载 .ts。普通 EXP 可直接复用 sdk 的 defineWorkflow/registerWorkflowTool、StateGraph 和 context.infer，不需要创建算力变体。' } }
}
function safeFailure(error: unknown, signal?: AbortSignal) {
  return { code: signal?.aborted ? 'aborted' : error instanceof MigrationError ? error.code : 'migration_failed', message: signal?.aborted ? '迁移操作已取消；可查询操作回执继续处理' : assetText('error.txt', (error as Error)?.message ?? '迁移操作失败').content }
}

/** 来源读取与生成分离；语义转换由管理助手提供文件和映射，平台只验证、固定、发布。 */
export function createMigrationsHandler(rootPath: string) {
  const root = resolve(rootPath), busy = new Set<string>()
  async function preview(body: MigrationMap, signal?: AbortSignal) {
    if (typeof body.fingerprint !== 'string') fail('预览必须携带来源 fingerprint')
    const source = loadMigrationSource(root, body.source_id, body.fingerprint), target = body.target
    if (!isMap(target) || !['new-agent', 'new-version'].includes(target.kind)) fail('target.kind 必须为 new-agent 或 new-version')
    const agent = text(target.agent_id, 'target.agent_id', 80)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent)) fail('Agent ID 必须是小写 kebab-case')
    const parent = target.kind === 'new-version' ? parentTarget(root, target) : null
    if (!parent && existsSync(dataPath(root, `agents/${agent}`))) fail('Agent ID 已存在，请创建已有 Agent 的新版本', 'conflict')
    if (!Array.isArray(body.files) || !body.files.length || body.files.length > 500) fail('files 必须包含 1–500 个明确选择的目标文件')
    if (!Array.isArray(body.mapping) || !body.mapping.length || body.mapping.length > 500) fail('请提供来源行为到目标资产的 mapping')
    jsonSafe(body.mapping, 'mapping'); if (body.uncovered !== undefined) { if (!Array.isArray(body.uncovered) || body.uncovered.some((item: unknown) => typeof item !== 'string')) fail('uncovered 必须为字符串列表'); jsonSafe(body.uncovered, 'uncovered') }
    if (body.scope_limitations !== undefined) {
      if (!Array.isArray(body.scope_limitations) || body.scope_limitations.length > 500 || body.scope_limitations.some((item: unknown) => typeof item !== 'string' || !item.trim())) fail('scope_limitations 必须为非空字符串列表，最多 500 项')
      jsonSafe(body.scope_limitations, 'scope_limitations')
    }
    const scopeLimitations = body.scope_limitations ?? []
    for (const mapping of body.mapping) {
      if (!isMap(mapping) || typeof mapping.source !== 'string' || typeof mapping.target !== 'string' || !['converted', 'native', 'pending', 'omitted'].includes(mapping.status)) fail('mapping 每项须包含 source、target、status(converted/native/pending/omitted)')
    }
    const parsedCases = body.evaluation_cases === undefined ? undefined : businessCasesSchema.safeParse(body.evaluation_cases)
    if (parsedCases && !parsedCases.success) fail(parsedCases.error.issues.map(issue => `evaluation_cases${issue.path.length ? '.' + issue.path.join('.') : ''}: ${issue.message}`).join('；'))
    const cases = parsedCases?.data ?? []
    if (body.case_ids !== undefined && (!Array.isArray(body.case_ids) || body.case_ids.length > 500 || body.case_ids.some((id: unknown) => typeof id !== 'string' || !/^U-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)))) fail('case_ids 必须是实际 Case ID 数组，最多 500 项')
    const caseIds = [...new Set<string>([...(body.case_ids ?? []), ...cases.map(item => item.id)])]
    const uncovered = [...(body.uncovered ?? [])]
    if (!caseIds.length) uncovered.push('尚未绑定迁移关键行为的评测用例；请创建或选择实际 Case 后，通过 migrations/resolve 关联验证依据。')
    const edits: { path: string; bytes: Buffer; mode: number; source_path?: string; source_sha256?: string }[] = []
    const paths = new Set<string>(); let bytesTotal = 0
    for (const edit of body.files) {
      if (!isMap(edit)) fail('文件选择必须是对象')
      const path = targetAssetPath(edit.path)
      if (paths.has(path)) fail('目标文件路径不能重复'); paths.add(path)
      const fromSource = typeof edit.source_path === 'string'
      if (fromSource === (typeof edit.content === 'string')) fail('每个文件必须且只能选择 content 或 source_path')
      let bytes: Buffer
      if (fromSource) {
        if (typeof edit.source_sha256 !== 'string') fail('复制来源文件必须提供 source_sha256')
        bytes = migrationSourceBytes(root, source, edit.source_path, edit.source_sha256)
      } else { bytes = Buffer.from(edit.content); if (bytes.includes(0)) fail('文本内容不能包含 NUL；二进制资产请使用 source_path') }
      bytesTotal += bytes.length; if (bytes.length > 8 * 1024 * 1024 || bytesTotal > 32 * 1024 * 1024) fail('所选目标资产超过大小限制')
      if (assetText(path, bytes.toString('utf8')).redacted) fail('目标文本包含凭据常量', 'secret_rejected')
      if (edit.executable !== undefined && typeof edit.executable !== 'boolean') fail('executable 必须为布尔值')
      const sourceMode = fromSource ? source.entries.find(item => item.path === edit.source_path)?.mode : undefined
      edits.push({ path, bytes, mode: edit.executable === undefined ? sourceMode ?? 0o644 : edit.executable ? 0o755 : 0o644, ...(fromSource ? { source_path: edit.source_path, source_sha256: sha256(bytes) } : {}) })
    }
    const operation: Operation = { schema_version: 1, operation_id: `migration-${randomUUID()}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), state: 'preparing', agent_id: agent, experiment_id: freshId(root, agent, !parent), target_kind: target.kind, source_id: source.source_id, source_fingerprint: source.fingerprint }
    // 在生成任何版本之前先保存已分配身份，进程中断后仍可查询本次范围。
    saveOperation(root, operation)
    const directory = operationDirectory(root, operation.operation_id), stage = join(directory, 'stage'), experiment = join(stage, EXP_PATH(operation.experiment_id)), candidate = join(experiment, 'candidate')
    try {
      for (const path of ['agents', 'evolution/experiments']) mkdirSync(join(stage, path), { recursive: true })
      const currentManifest = parent ? yaml(parent.manifest) : undefined
      const rolePath = parent ? `${EXP_PATH(parent.id)}/candidate/dsh/workspace/AGENTS.md` : null
      const role = parent ? fixedGit(root, ['show', `${parent.ref.slice(4)}:${rolePath}`], 1024 * 1024).toString('utf8') : text(target.role, 'target.role', 60 * 1024)
      const created = await createAgent(stage, { agent_id: agent, name: parent ? String(currentManifest!.name ?? agent) : text(target.name, 'target.name', 240), description: parent ? String(currentManifest!.description ?? parent.question) : text(target.description, 'target.description', 4000), role, ...(cases.length && !parent ? { evaluation_cases: cases } : {}) }, signal)
      if (!created.ok) fail(created.error.message, created.error.code)
      renameSync(join(stage, EXP_PATH(created.value.experiment_id)), experiment)
      const agentManifest = join(stage, 'agents', agent, 'manifest.yaml'), generatedManifest = yaml(agentManifest)
      generatedManifest.active_experiment = operation.experiment_id; writeYaml(agentManifest, generatedManifest)
      const changeFile = join(experiment, 'change.yaml'), change = yaml(changeFile)
      change.experiment_id = operation.experiment_id
      let finalEvaluation = readFileSync(join(stage, 'agents', agent, 'evaluation.md'), 'utf8')
      if (parent) {
        copyFixedParent(root, parent, candidate)
        change.parent_experiment_id = parent.id; change.parent_ref = change.baseline_ref = parent.ref; change.research_question = parent.question
        operation.manifest_sha256 = parent.manifest_sha256
        writeFileSync(join(experiment, 'hypothesis.md'), `# ${operation.experiment_id}\n\n研究问题：${parent.question}\n\n固定继承来源见 [change.yaml](change.yaml)，外部来源与转换范围见 [迁移回执](${EVIDENCE})。\n`)
        const evaluation = dataPath(root, `agents/${agent}/evaluation.md`), before = existsSync(evaluation) ? readFileSync(evaluation, 'utf8') : ''
        finalEvaluation = before
        if (caseIds.length) operation.evaluation_before_sha256 = existsSync(evaluation) ? sha256(before) : null
        if (cases.length) {
          for (const item of cases) if (new RegExp(`^####\\s+${item.id}(?:\\s|$)`, 'm').test(before)) fail(`评测用例 ${item.id} 已存在，请沿用已有用例或明确另设 ID`)
          finalEvaluation = before + caseMarkdown(cases); operation.evaluation_after_sha256 = sha256(finalEvaluation)
          writeFileSync(join(directory, 'evaluation.after.md'), finalEvaluation)
        }
      }
      if (caseIds.length) {
        const actualCases = (await parseEvaluationDocument(root, finalEvaluation, signal)).cases
        for (const caseId of caseIds) if (!Object.hasOwn(actualCases, caseId)) fail(`迁移关键用例 ${caseId} 不存在于目标 Agent 的最终评测定义中`)
      }
      for (const edit of edits) { const file = dataPath(candidate, edit.path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, edit.bytes); chmodSync(file, edit.mode) }
      const harnessFile = join(candidate, 'harness.yaml'), harness = yaml(harnessFile)
      for (const key of ['model_bindings', 'project_workspace', 'role_instructions']) if (body[key] !== undefined) { if (!isMap(body[key])) fail(`${key} 必须是对象`); jsonSafe(body[key], key); harness[key] = body[key] }
      harness.role_instructions ??= { [harness.loadable_assets?.preset_id ?? agent]: 'dsh/workspace/AGENTS.md' }
      writeYaml(harnessFile, harness)
      change.migration = { operation_id: operation.operation_id, receipt: EVIDENCE }
      writeYaml(changeFile, change)
      const validation = assertLoadable(stage, operation.experiment_id)
      const selected = edits.map(edit => ({ path: edit.path, bytes: edit.bytes.length, sha256: sha256(edit.bytes), mode: edit.mode, ...(edit.source_path ? { source_path: edit.source_path, source_sha256: edit.source_sha256 } : {}) }))
      const assetList = candidateFiles(candidate).map(path => ({ path, sha256: sha256(readFileSync(join(candidate, path))), mode: lstatSync(join(candidate, path)).mode & 0o111 ? 0o755 : 0o644 }))
      operation.asset_list_sha256 = sha256(canonical(assetList)); operation.candidate_sha256 = candidateDigest(candidate)
      const receipt = { schema_version: 1, generated: true, operation_id: operation.operation_id, agent_id: agent, experiment_id: operation.experiment_id, created_at: operation.created_at, source: { source_id: source.source_id, fingerprint: source.fingerprint, provenance: source.provenance, frameworks: source.frameworks, versions: source.versions }, parent: parent ? { experiment_id: parent.id, ref: parent.ref } : null, selected, candidate_sha256: operation.candidate_sha256, asset_list_sha256: operation.asset_list_sha256, mapping: body.mapping, uncovered, scope_limitations: scopeLimitations, evaluation_case_ids: caseIds, validation, note: '来源和映射为此次生成的固定回执；业务等效性须由实际 DSH 行为与评测证据证明。' }
      migrationWrite(join(experiment, EVIDENCE), receipt)
      operation.experiment_tree_sha256 = treeDigest(experiment)
      if (!parent) operation.agent_tree_sha256 = treeDigest(join(stage, 'agents', agent))
      operation.summary = { agent_id: agent, experiment_id: operation.experiment_id, target_kind: target.kind, source_id: source.source_id, fingerprint: source.fingerprint, selected, mapping: body.mapping, uncovered, scope_limitations: scopeLimitations, evaluation_case_ids: caseIds, candidate_sha256: operation.candidate_sha256, asset_list_sha256: operation.asset_list_sha256, active_version_changed: !parent }
      operation.validation = validation
      operation.preview_sha256 = sha256(canonical({ ...operation.summary, experiment_tree_sha256: operation.experiment_tree_sha256, agent_tree_sha256: operation.agent_tree_sha256 ?? null, manifest_sha256: operation.manifest_sha256 ?? null, evaluation_before_sha256: operation.evaluation_before_sha256 ?? null, evaluation_after_sha256: operation.evaluation_after_sha256 ?? null }))
      operation.state = 'prepared'; saveOperation(root, operation)
      return { ...operation.summary, operation_id: operation.operation_id, preview_sha256: operation.preview_sha256, validation, ...generatedConfiguration(stage, operation.experiment_id), apply_input: { operation_id: operation.operation_id, expected_preview_sha256: operation.preview_sha256 }, note: '已准备独立暂存资产；尚未发布、运行来源脚本、启动实例或验证业务行为。' }
    } catch (error) { operation.state = 'failed'; operation.error = safeFailure(error, signal); saveOperation(root, operation); throw new MigrationError(operation.error.code, `${operation.error.message}（操作 ${operation.operation_id} 可查询）`) }
  }
  async function apply(body: MigrationMap, signal?: AbortSignal) {
    const operation = loadOperation(root, body.operation_id), directory = operationDirectory(root, operation.operation_id)
    if (body.expected_preview_sha256 !== operation.preview_sha256 || !operation.preview_sha256) fail('请先预览并确认同一份迁移资产', 'conflict')
    if (busy.has(operation.operation_id)) fail('该迁移正在保存，请查询状态', 'conflict')
    busy.add(operation.operation_id)
    try {
      if (operation.state === 'published') return { ...(await status({ operation_id: operation.operation_id })), already_applied: true }
      if (!['prepared', 'publishing', 'failed'].includes(operation.state)) fail('本次迁移准备未完成，请重新预览', 'conflict')
      if (!operation.experiment_tree_sha256 || !operation.candidate_sha256) fail('本次迁移没有完整暂存资产，请重新预览', 'conflict')
      loadMigrationSource(root, operation.source_id, operation.source_fingerprint)
      const stage = join(directory, 'stage'), stagedExperiment = join(stage, EXP_PATH(operation.experiment_id)), targetExperiment = dataPath(root, EXP_PATH(operation.experiment_id))
      const targetAgent = dataPath(root, `agents/${operation.agent_id}`), stagedAgent = join(stage, 'agents', operation.agent_id)
      const evaluation = dataPath(root, `agents/${operation.agent_id}/evaluation.md`)
      if (operation.target_kind === 'new-agent') {
        if (existsSync(targetAgent)) { if (treeDigest(targetAgent) !== operation.agent_tree_sha256) fail('目标 Agent 已存在或已变化，未覆盖', 'conflict') }
        else if (!existsSync(stagedAgent) || treeDigest(stagedAgent) !== operation.agent_tree_sha256) fail('暂存 Agent 发生变化', 'conflict')
      } else {
        if (sha256(readFileSync(dataPath(root, `agents/${operation.agent_id}/manifest.yaml`))) !== operation.manifest_sha256) fail('目标 Agent 当前版本或登记已变化，请重新预览', 'conflict')
        if (operation.evaluation_before_sha256 !== undefined) {
          const digest = existsSync(evaluation) ? sha256(readFileSync(evaluation)) : null
          if (digest !== operation.evaluation_before_sha256 && (!operation.evaluation_after_sha256 || digest !== operation.evaluation_after_sha256)) fail('目标评测定义已变化，请重新预览', 'conflict')
          if (operation.evaluation_after_sha256 && (!existsSync(join(directory, 'evaluation.after.md')) || sha256(readFileSync(join(directory, 'evaluation.after.md'))) !== operation.evaluation_after_sha256)) fail('暂存评测定义已变化', 'conflict')
        }
      }
      if (existsSync(targetExperiment)) { if (treeDigest(targetExperiment) !== operation.experiment_tree_sha256) fail('目标 EXP 已存在或已变化，未覆盖', 'conflict') }
      else if (!existsSync(stagedExperiment) || treeDigest(stagedExperiment) !== operation.experiment_tree_sha256) fail('暂存 EXP 发生变化', 'conflict')
      if (signal?.aborted) fail('迁移已取消，可按操作回执重试', 'aborted')
      operation.state = 'publishing'; delete operation.error; saveOperation(root, operation)
      // 每棵完整目录通过 rename 发布；中断后按相同身份和摘要继续，绝不覆盖第三方改动。
      if (!existsSync(targetExperiment)) { mkdirSync(dirname(targetExperiment), { recursive: true }); renameSync(stagedExperiment, targetExperiment) }
      if (operation.target_kind === 'new-agent' && !existsSync(targetAgent)) { mkdirSync(dirname(targetAgent), { recursive: true }); renameSync(stagedAgent, targetAgent) }
      if (operation.target_kind === 'new-version' && operation.evaluation_after_sha256 && (existsSync(evaluation) ? sha256(readFileSync(evaluation)) : null) !== operation.evaluation_after_sha256) {
        const temporary = `${evaluation}.${operation.operation_id}.tmp`
        try {
          mkdirSync(dirname(evaluation), { recursive: true }); writeFileSync(temporary, readFileSync(join(directory, 'evaluation.after.md')), { flag: 'wx' })
          if ((existsSync(evaluation) ? sha256(readFileSync(evaluation)) : null) !== operation.evaluation_before_sha256) fail('发布期间评测定义变化，保留已发布 EXP 等待处理', 'conflict')
          renameSync(temporary, evaluation)
        } finally { rmSync(temporary, { force: true }) }
      }
      operation.state = 'published'; saveOperation(root, operation)
      return { ...(await status({ operation_id: operation.operation_id })), already_applied: false }
    } catch (error) { operation.state = 'failed'; operation.error = safeFailure(error, signal); saveOperation(root, operation); throw error }
    finally { busy.delete(operation.operation_id) }
  }
  function migrationTarget(body: MigrationMap) {
    if ((body.operation_id !== undefined) === (body.experiment_id !== undefined)) fail('必须且只能提供 operation_id 或 experiment_id')
    let operation: Operation | undefined, id: string
    if (body.operation_id !== undefined) { operation = loadOperation(root, body.operation_id); id = operation.experiment_id }
    else {
      id = text(body.experiment_id, 'experiment_id', 160)
      if (!VERSION_ID.test(id) || !id.startsWith('EXP-')) fail('迁移目标必须是普通 EXP')
    }
    return { operation, id, experiment: dataPath(root, EXP_PATH(id)) }
  }
  function migrationReceipt(experiment: string, id: string, change: MigrationMap, operation?: Operation) {
    const receiptPath = change.migration?.receipt
    if (receiptPath !== EVIDENCE) fail('该 EXP 没有迁移来源回执', 'not_found')
    const content = readFileSync(dataPath(experiment, receiptPath), 'utf8'), receipt = JSON.parse(content)
    if (receipt.experiment_id !== id || receipt.operation_id !== change.migration.operation_id || operation && operation.operation_id !== receipt.operation_id) fail('迁移来源身份不一致', 'conflict')
    return { receipt, sha256: sha256(content) }
  }
  function resolutionState(experiment: string, change: MigrationMap, receipt: MigrationMap, receiptSha: string, digest: string) {
    const declaredScope = (receipt.scope_limitations ?? []).map((description: string) => ({ description, origin: 'declared-scope', implemented: false }))
    const initial: MigrationMap = { ...receipt, scope_limitations: declaredScope }
    const pointer = change.migration?.resolution_receipt
    if (!pointer) return { effective: initial, resolution: { status: 'none', resolutions: [] as MigrationMap[] } }
    try {
      if (typeof pointer !== 'string' || !/^evaluation\/evidence\/migration-resolutions\/[a-f0-9]{64}\.json$/.test(pointer)) throw new Error('解决记录引用格式无效')
      const record = JSON.parse(readFileSync(dataPath(experiment, pointer), 'utf8'))
      const { created_at: _created, ...identity } = record
      if (record.schema_version !== 1 || record.operation_id !== receipt.operation_id || record.experiment_id !== receipt.experiment_id || record.migration_sha256 !== receiptSha || sha256(canonical(identity)) !== pointer.slice(RESOLUTION_ROOT.length + 1, -5) || !Array.isArray(record.resolutions) || record.resolutions.some((item: MigrationMap) => item.disposition !== undefined && !['converted', 'native', 'outside-scope'].includes(item.disposition))) throw new Error('解决记录与原始迁移不一致')
      if (record.candidate_sha256 !== digest) return { effective: initial, resolution: { status: 'expired', path: pointer, candidate_sha256: record.candidate_sha256, resolutions: record.resolutions, note: 'Candidate 已变化，需要重新核对解决项与对应 Case。' } }
      const mapping = receipt.mapping.map((item: MigrationMap, index: number) => {
        const resolved = record.resolutions.find((item: MigrationMap) => item.mapping_index === index)
        if (!resolved) return item
        const disposition = resolved.disposition ?? 'converted'
        return { ...item, ...(disposition === 'outside-scope' ? { required: false } : { status: disposition, ...(resolved.target ? { target: resolved.target } : {}) }),
          resolution_disposition: disposition, resolution: resolved.notes, resolution_case_ids: resolved.case_ids }
      })
      const uncovered = (receipt.uncovered ?? []).filter((_item: unknown, index: number) => !record.resolutions.some((item: MigrationMap) => item.uncovered_index === index))
      const required = [...new Set<string>([...(receipt.evaluation_case_ids ?? []), ...record.resolutions.flatMap((item: MigrationMap) => item.case_ids)])]
      const scopeLimitations = [...declaredScope, ...record.resolutions.filter((item: MigrationMap) => item.disposition === 'outside-scope').map((item: MigrationMap) => {
        const mapped = item.mapping_index !== undefined ? receipt.mapping[item.mapping_index] : null
        return { ...(mapped ? { mapping_index: item.mapping_index, description: mapped.source, target: mapped.target, original_status: mapped.status } : { uncovered_index: item.uncovered_index, description: receipt.uncovered[item.uncovered_index] }),
          disposition: 'outside-scope', implemented: false, notes: item.notes, case_ids: item.case_ids }
      })]
      return { effective: { ...receipt, mapping, uncovered, scope_limitations: scopeLimitations, evaluation_case_ids: required }, resolution: { status: 'current', path: pointer, candidate_sha256: digest, resolutions: record.resolutions } }
    } catch { return { effective: initial, resolution: { status: 'unreadable', path: pointer, resolutions: [] as MigrationMap[], note: '解决记录不能与原始迁移核对，原待补齐项继续生效。' } } }
  }
  async function resolvePending(body: MigrationMap, signal?: AbortSignal) {
    const { operation, id, experiment } = migrationTarget(body), key = `resolve:${id}`
    if (busy.has(key)) fail('该迁移正在核对解决项，请查询状态', 'conflict')
    busy.add(key)
    try {
      const changeFile = dataPath(experiment, 'change.yaml'), beforeChange = readFileSync(changeFile, 'utf8'), change = versionIdentity(root, id)
      const initial = migrationReceipt(experiment, id, change, operation), candidate = join(experiment, 'candidate'), digest = candidateDigest(candidate)
      if (body.expected_candidate_sha256 !== digest) fail('Candidate 已变化，请重新读取后核对解决项', 'conflict')
      if (!Array.isArray(body.resolutions) || !body.resolutions.length || body.resolutions.length > 500) fail('resolutions 必须包含 1–500 项明确的解决说明')
      jsonSafe(body.resolutions, 'resolutions')
      const evaluation = dataPath(root, `agents/${change.agent_id}/evaluation.md`), beforeEvaluation = readFileSync(evaluation, 'utf8')
      const cases = (await parseEvaluationDocument(root, beforeEvaluation, signal)).cases
      const previous = resolutionState(experiment, change, initial.receipt, initial.sha256, digest)
      const combined = new Map<string, MigrationMap>((previous.resolution.status === 'current' ? previous.resolution.resolutions : []).map((item: MigrationMap) => [item.mapping_index === undefined ? `uncovered:${item.uncovered_index}` : `mapping:${item.mapping_index}`, item]))
      const supplied = new Set<string>()
      for (const item of body.resolutions) {
        if (!isMap(item) || (item.mapping_index === undefined) === (item.uncovered_index === undefined) || Object.keys(item).some(key => !['mapping_index', 'uncovered_index', 'target', 'notes', 'case_ids', 'disposition'].includes(key))) fail('解决项必须且只能指定 mapping_index 或 uncovered_index，以及 notes、case_ids 和可选 disposition、target')
        const disposition = item.disposition ?? 'converted'
        if (!['converted', 'native', 'outside-scope'].includes(disposition)) fail('disposition 必须为 converted、native 或 outside-scope')
        if (disposition === 'outside-scope' && item.target !== undefined) fail('outside-scope 只记录范围边界，不能修改原 target')
        const mapping = item.mapping_index !== undefined, index = mapping ? item.mapping_index : item.uncovered_index, values = mapping ? initial.receipt.mapping : initial.receipt.uncovered ?? []
        if (!Number.isInteger(index) || index < 0 || index >= values.length || mapping && !['pending', 'omitted'].includes(values[index].status)) fail('解决项必须引用原始待补齐映射或 uncovered 索引')
        if (!Array.isArray(item.case_ids) || !item.case_ids.length || item.case_ids.length > 30 || item.case_ids.some((value: unknown) => typeof value !== 'string' || !Object.hasOwn(cases, value))) fail('每项解决说明必须引用当前 Agent 中存在的真实 Case')
        const identity = `${mapping ? 'mapping' : 'uncovered'}:${index}`
        if (supplied.has(identity)) fail('同一请求不能重复解决相同项'); supplied.add(identity)
        const priorCases = combined.get(identity)?.case_ids ?? []
        combined.set(identity, { [mapping ? 'mapping_index' : 'uncovered_index']: index, ...(disposition === 'converted' ? {} : { disposition }), ...(item.target === undefined ? {} : { target: text(item.target, 'target') }), notes: text(item.notes, 'notes'), case_ids: [...new Set<string>([...priorCases, ...item.case_ids])].sort() })
      }
      const record = { schema_version: 1, operation_id: initial.receipt.operation_id, experiment_id: id, migration_sha256: initial.sha256, candidate_sha256: digest, resolutions: [...combined.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value) }
      const path = `${RESOLUTION_ROOT}/${sha256(canonical(record))}.json`
      if (signal?.aborted) fail('核对解决项已取消', 'aborted')
      if (candidateDigest(candidate) !== digest || readFileSync(changeFile, 'utf8') !== beforeChange || readFileSync(evaluation, 'utf8') !== beforeEvaluation || sha256(readFileSync(dataPath(experiment, EVIDENCE))) !== initial.sha256) fail('核对期间 Candidate、迁移来源或评测合同变化，请重新读取', 'conflict')
      const file = dataPath(experiment, path), already = change.migration.resolution_receipt === path
      if (!existsSync(file)) migrationWrite(file, { ...record, created_at: new Date().toISOString() })
      else {
        const { created_at: _created, ...saved } = JSON.parse(readFileSync(file, 'utf8'))
        if (canonical(saved) !== canonical(record)) fail('既有解决记录与当前内容冲突，未覆盖', 'conflict')
      }
      if (!already) writeYaml(changeFile, { ...change, migration: { ...change.migration, resolution_receipt: path } })
      return { ...(await status({ experiment_id: id })), already_resolved: already }
    } finally { busy.delete(key) }
  }
  async function status(body: MigrationMap, signal?: AbortSignal) {
    const { operation, id, experiment } = migrationTarget(body)
    const exists = existsSync(join(experiment, 'change.yaml'))
    if (!exists) return { operation_id: operation?.operation_id, state: operation?.state ?? 'not-found', agent_id: operation?.agent_id, experiment_id: id, published: false, error: operation?.error ?? null, resumable: Boolean(operation?.preview_sha256), runtime_verified: false, business_verified: false, note: '目标 EXP 尚未发布；操作回执保留已分配身份和准备结果。' }
    const changeFile = dataPath(experiment, 'change.yaml'), changeSnapshot = readFileSync(changeFile, 'utf8')
    const change = versionIdentity(root, id), initial = migrationReceipt(experiment, id, change, operation), receipt = initial.receipt
    const candidate = join(experiment, 'candidate'), currentDigest = candidateDigest(candidate)
    const evaluationFile = dataPath(root, `agents/${change.agent_id}/evaluation.md`)
    const evaluationSnapshot = existsSync(evaluationFile) ? readFileSync(evaluationFile, 'utf8') : null
    const resolutionPointer = change.migration?.resolution_receipt
    const resolutionFile = typeof resolutionPointer === 'string' && /^evaluation\/evidence\/migration-resolutions\/[a-f0-9]{64}\.json$/.test(resolutionPointer)
      ? dataPath(experiment, resolutionPointer) : undefined
    const resolutionSnapshot = resolutionFile && existsSync(resolutionFile) ? readFileSync(resolutionFile, 'utf8') : null
    const builds = inspectAssetBuild(root, id)
    const resolved = resolutionState(experiment, change, receipt, initial.sha256, currentDigest)
    const currentResolutions = resolved.resolution.status === 'current' ? resolved.resolution.resolutions : []
    const unresolvedItems = [
      ...receipt.mapping.flatMap((item: MigrationMap, index: number) => ['pending', 'omitted'].includes(item.status) && !currentResolutions.some((resolution: MigrationMap) => resolution.mapping_index === index)
        ? [{ mapping_index: index, description: item.source, target: item.target, status: item.status, required: item.required !== false }] : []),
      ...(receipt.uncovered ?? []).flatMap((description: string, index: number) => !currentResolutions.some((resolution: MigrationMap) => resolution.uncovered_index === index)
        ? [{ uncovered_index: index, description, required: true }] : []),
    ]
    const verification = await migrationRunEvidence(root, id, change.agent_id, currentDigest, resolved.effective, builds, evaluationSnapshot, signal)
    const instances: MigrationMap[] = [], instanceRoot = instanceStateRoot(root)
    if (existsSync(instanceRoot)) for (const name of readdirSync(instanceRoot).sort()) {
      try {
        const file = dataPath(instanceRoot, `${name}/instance.json`)
        if (!existsSync(file)) continue
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        if (manifest.source_id !== `experiment:${id}` || !workspaceOwnsInstance(root, manifest)) continue
        instances.push({ name, source_id: manifest.source_id, recorded_status: manifest.status ?? null, live_verified: false, note: '实例登记可读；实时运行状态由实例管理查询。' })
      } catch { /* 无法确认归属的实例不作为验证依据。 */ }
    }
    // Case 解析会等待子进程；返回前重新核对用于判定的同一份资产与引用。
    let unchanged = false
    try {
      unchanged = candidateDigest(candidate) === currentDigest && readFileSync(changeFile, 'utf8') === changeSnapshot
        && sha256(readFileSync(dataPath(experiment, EVIDENCE))) === initial.sha256
        && (existsSync(evaluationFile) ? readFileSync(evaluationFile, 'utf8') : null) === evaluationSnapshot
        && (!resolutionFile || (existsSync(resolutionFile) ? readFileSync(resolutionFile, 'utf8') : null) === resolutionSnapshot)
        && canonical(inspectAssetBuild(root, id)) === canonical(builds)
    } catch { /* 读取期间删除或替换的资产同样不能沿用旧完成状态。 */ }
    if (!unchanged) fail('迁移状态读取期间资产、构建来源、迁移记录或评测定义已变化，请重新查询', 'conflict')
    return { operation_id: receipt.operation_id, state: operation?.state ?? 'published', agent_id: change.agent_id, experiment_id: id, published: true, candidate_sha256: currentDigest, candidate_changed_since_migration: currentDigest !== (operation?.candidate_sha256 ?? receipt.candidate_sha256), source: receipt.source, receipt_path: `${EXP_PATH(id)}/${EVIDENCE}`, mapping: resolved.effective.mapping, uncovered: resolved.effective.uncovered, scope_limitations: resolved.effective.scope_limitations, unresolved_items: unresolvedItems, required_case_ids: resolved.effective.evaluation_case_ids, resolution: resolved.resolution, build: builds, instances, ...verification, error: operation?.error ?? null, resumable: operation ? operation.state !== 'published' : false, note: (verification.completed ? '当前 Candidate 的关键行为已由真实 DSH API Run 验证；完成范围以固定迁移回执和用例为准。' : '资产、构建回执、实例登记和 Run 分别展示；静态通过与历史 Run 不表示当前业务等效，待实际 DSH 验证转换范围。') + (resolved.effective.scope_limitations.length ? '范围限制单列为 scope_limitations，不表示这些能力已经实现或完成原框架等效比较。' : '') }
  }
  return async (method: MigrationMethod | string, body: MigrationMap, signal?: AbortSignal): Promise<ConnectionRpcResult<any>> => {
    try {
      if (signal?.aborted) fail('迁移操作已取消', 'aborted')
      const value = method === 'inspect' ? await inspectMigrationSource(root, body, signal) : method === 'read' ? readMigrationSource(root, body) : method === 'preview' ? await preview(body, signal) : method === 'apply' ? await apply(body, signal) : method === 'resolve' ? await resolvePending(body, signal) : method === 'status' ? await status(body, signal) : fail('未知迁移操作', 'method_not_found')
      return { ok: true, value }
    } catch (error) { return { ok: false, error: { ...safeFailure(error, signal), details: {} } } }
  }
}
