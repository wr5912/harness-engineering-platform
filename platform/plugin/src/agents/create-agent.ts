import { versionSource, versionSources } from './version-source.ts'
import { programRoot } from '../workspace.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { redactRunText } from './run-files.ts'
import { businessCasesSchema, businessCasesMarkdown } from './business-cases.ts'

const execute = promisify(execFile)
const CLI = 'runtime/adapters/dsh-container/dsh-dev'
type JsonMap = Record<string, unknown>
export type NewAgentReceipt = { agent_id: string; experiment_id: string; source_id: string; name: string; profile: 'web' | 'sdk'; status: 'created'; started: false; note: string }
class CreationError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function checkedText(payload: JsonMap, key: string, limit: number) {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit) throw new CreationError('invalid_request', `${key} 必须非空，且不超过 ${limit} 字节`)
  if (/\bsk-[A-Za-z0-9_-]{12,}\b|(?:api[_-]?key|password|secret|authorization|cookie|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i.test(value)) throw new CreationError('secret_rejected', '输入包含凭据样式，请移除凭据后再创建')
  return value.trim()
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new CreationError('aborted', '新建智能体已取消') }
function writeYaml(file: string, value: unknown) { writeFileSync(file, dumpYaml(value, { noRefs: true, lineWidth: -1 })) }
function yamlMap(file: string) { return loadYaml(readFileSync(file, 'utf8')) as JsonMap }

function pathExists(path: string) { try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }

/** 复用 dsh-dev init 生成标准来源；完整角色准备并校验后再一次落入仓库。 */
export async function createAgent(rootPath: string, payload: JsonMap, signal?: AbortSignal): Promise<ConnectionRpcResult<NewAgentReceipt>> {
  let temporary = ''
  let phase = 'input'
  const moved: string[] = []
  const createdDirectories: string[] = []
  try {
    const root = resolve(rootPath), agentId = checkedText(payload, 'agent_id', 80)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) throw new CreationError('invalid_request', 'Agent ID 必须是小写 kebab-case')
    const name = checkedText(payload, 'name', 240), description = checkedText(payload, 'description', 4000), role = checkedText(payload, 'role', 60 * 1024)
    const profile = payload.profile ?? 'web'
    if (profile !== 'web' && profile !== 'sdk') throw new CreationError('invalid_request', '使用方式只支持 Web 交互或 TypeScript SDK')
    const parsedCases = payload.evaluation_cases === undefined ? undefined : businessCasesSchema.safeParse(payload.evaluation_cases)
    if (parsedCases && !parsedCases.success) throw new CreationError('invalid_request', parsedCases.error.issues.map(issue => issue.message).join('；'))
    const businessCases = parsedCases?.data ?? []
    for (const path of ['agents', 'evolution', 'evolution/experiments']) {
      if (!pathExists(join(root, path))) continue
      const stat = lstatSync(join(root, path))
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CreationError('path_rejected', '资产目录必须是仓库内的实体目录')
    }
    if (/[\r\n]/.test(name)) throw new CreationError('invalid_request', '名称必须为单行')
    if (pathExists(join(root, 'agents', agentId)) || Object.values(versionSources(root).sources).some(item => item.agent_id === agentId)) throw new CreationError('conflict', 'Agent ID 已存在，未覆盖已有资产')
    cancelled(signal)
    temporary = mkdtempSync(join(root, '.platform-agent-create-'))
    for (const path of ['agents', 'evolution/experiments']) mkdirSync(join(temporary, path), { recursive: true })
    phase = 'dsh-dev-init'
    // 只运行本仓库的创建函数，在隔离根中准备新角色。
    const code = [
      'import json,runpy,sys', 'from pathlib import Path',
      'module=runpy.run_path(sys.argv[1])',
      'stage=Path(sys.argv[2])',
      'print(json.dumps(module["create_harness"](sys.argv[3],repo=stage,lock_path=Path(sys.argv[4]),profile=sys.argv[5])))',
    ].join('\n')
    const result = await execute(process.env.HARNESS_PYTHON || 'python3', ['-c', code, join(programRoot(), CLI), temporary, agentId, join(programRoot(), 'runtime/adapters/dsh-container/source.lock.json'), profile], { cwd: root, env: { ...process.env, HARNESS_ASSET_ROOT: temporary, HARNESS_PROGRAM_ROOT: programRoot() }, signal, timeout: 30_000, maxBuffer: 1024 * 1024 })
    const created = JSON.parse(result.stdout) as { experiment_id: string; source_id: string }
    if (!new RegExp(`^EXP-${agentId}-001-r[0-9a-f]{12}$`).test(created.experiment_id) || created.source_id !== `experiment:${created.experiment_id}`) throw new CreationError('creation_failed', '创建工具返回的研究版本身份无效')
    const experiment = join(temporary, 'evolution/experiments', created.experiment_id), agent = join(temporary, 'agents', agentId)
    phase = 'role-assets'
    const identity = `你是${name}（Agent ID: ${agentId}）。`
    const instructions = `${identity}\n\n${role}\n\n使用中文回答。仅声明实际提供的工具、权限与执行结果；缺少必要信息时明确说明并补充询问。`
    writeFileSync(join(experiment, 'candidate/dsh/workspace/AGENTS.md'), `# ${name}\n\n${instructions}\n`)
    const presetPath = join(experiment, `candidate/dsh/presets/${agentId}/agent.cordis.yml`)
    const plugins = loadYaml(readFileSync(presetPath, 'utf8')) as { id: string; config?: JsonMap }[]
    const persona = plugins.find(item => item.id === 'persona')
    if (!persona?.config) throw new CreationError('creation_failed', '创建工具没有提供标准 persona 配置')
    // 角色正文只在工作区 AGENTS.md 维护；Preset 仅声明身份并装载工作区指令。
    persona.config.prefix = `${identity} 使用工作区 AGENTS.md 中的职责和工作指令。使用中文回答，不声称未提供的工具、权限或执行结果。`
    writeYaml(presetPath, plugins)
    writeYaml(join(experiment, `candidate/dsh/presets/${agentId}/preset.yml`), { name, description, order: 10 })
    const harnessPath = join(experiment, 'candidate/harness.yaml'), harness = yamlMap(harnessPath)
    harness.agent = { ...(harness.agent as JsonMap), name }
    writeYaml(harnessPath, harness)
    const manifestPath = join(agent, 'manifest.yaml')
    writeYaml(manifestPath, { ...yamlMap(manifestPath), name, description })
    const question = `${name}能否由标准 DSH Runtime 装载，并按提供的职责响应用户请求`
    const changePath = join(experiment, 'change.yaml')
    writeYaml(changePath, { ...yamlMap(changePath), research_question: question })
    writeFileSync(join(experiment, 'hypothesis.md'), `# 研究假设\n\nBaseline 为 \`none:first-experiment\`。${question}。\n\n## 职责与比较方法\n\n${description}\n\n角色正文只在 Candidate 的工作区 AGENTS.md 维护，Preset 声明身份并引用该指令。使用全新 Session 核对身份、职责、必要信息补问及真实工具边界。\n\n## 限制\n\n本次只创建来源和角色资产，尚未启动实例或执行模型评测；不将静态校验视为业务效果通过。\n`)
    writeFileSync(join(agent, 'evaluation.md'), `# ${name}评测\n\n#### U-IDENTITY-001 身份与职责\n\n**评估档位：** \`fast\`\n\n**用户输入**\n\n> 你是谁？请简要说明身份和主要职责。\n\n**预期**\n\n回复明确包含 Agent ID \`${agentId}\`，身份为${name}，职责符合 Candidate 指令；不使用创建工具的流程验证身份。\n\n#### U-ROLE-001 业务范围与信息不足\n\n**用户输入**\n\n> 请说明你能如何帮助我开始工作；如果信息不足，你需要先了解什么？\n\n**预期**\n\n根据 Candidate 中用户提供的角色正文，说明与“${description.replace(/\r?\n/g, ' ')}”一致的工作方式。缺少必要信息时提出具体问题，不声称已经执行未提供的工具或产生业务结果。\n`)
    if (businessCases.length) {
      const evaluationPath = join(agent, 'evaluation.md')
      const body = businessCasesMarkdown(businessCases)
      writeFileSync(evaluationPath, readFileSync(evaluationPath, 'utf8') + body)
    }
    cancelled(signal)
    phase = 'validation'
    // 使用既有验证入口检查新角色后的完整来源；不执行 Candidate、模型或业务工具。
    const validate = [
      'import json,runpy,sys', 'from pathlib import Path',
      `sys.path.insert(0,${JSON.stringify(join(programRoot(), 'runtime/adapters/dsh-container'))})`,
      'from source_contract import resolve',
      'stage=Path(sys.argv[1])',
      'resolve("experiment:"+sys.argv[2],repo=stage,lock_path=Path(sys.argv[3]))',
      'module=runpy.run_path(sys.argv[4])',
      'result,status=module["validate"](stage/"evolution/experiments"/sys.argv[2])',
      'if status: raise ValueError("Experiment 校验失败: "+json.dumps(result,ensure_ascii=False))',
      'print(json.dumps({"validated":True}))',
    ].join('\n')
    await execute(process.env.HARNESS_PYTHON || 'python3', ['-c', validate, temporary, created.experiment_id, join(programRoot(), 'runtime/adapters/dsh-container/source.lock.json'), join(programRoot(), 'runtime/research/validate_experiment.py')], { cwd: root, env: { ...process.env, HARNESS_ASSET_ROOT: temporary, HARNESS_PROGRAM_ROOT: programRoot() }, signal, timeout: 30_000, maxBuffer: 1024 * 1024 })
    cancelled(signal)
    phase = 'publish'
    const source = versionSource(temporary, created.experiment_id)
    if (source?.agent_id !== agentId) throw new CreationError('creation_failed', '创建工具没有返回一致的版本身份')
    const targetAgent = join(root, 'agents', agentId), targetExperiment = join(root, 'evolution/experiments', created.experiment_id)
    if (pathExists(targetAgent) || pathExists(targetExperiment) || Object.values(versionSources(root).sources).some(item => item.agent_id === agentId)) throw new CreationError('conflict', '创建期间 Agent ID 被占用，未覆盖已有资产')
    // 新工作区在真实资产准备完成后才建立父目录；并行创建也重新核对实体目录。
    for (const path of ['agents', 'evolution', 'evolution/experiments']) {
      const directory = join(root, path)
      if (!pathExists(directory)) {
        try { mkdirSync(directory); createdDirectories.push(directory) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CreationError('path_rejected', '资产目录必须是仓库内的实体目录')
    }
    // 同步发布已校验的两棵目录；不改写其他版本。
    renameSync(agent, targetAgent); moved.push(targetAgent)
    renameSync(experiment, targetExperiment); moved.push(targetExperiment)
    moved.length = 0
    return { ok: true, value: { agent_id: agentId, experiment_id: created.experiment_id, source_id: created.source_id, name, profile, status: 'created', started: false, note: `角色和首次研究版本已创建，使用方式为${profile === 'sdk' ? '官方 TypeScript SDK' : 'Web 交互'}；尚未启动实例或完成业务评测。` } }
  } catch (error) {
    for (const path of moved.reverse()) rmSync(path, { recursive: true, force: true })
    for (const path of createdDirectories.reverse()) { try { rmdirSync(path) } catch {} }
    if (error instanceof CreationError) return { ok: false, error: { code: error.code, message: error.message, details: {} } }
    if (signal?.aborted) return { ok: false, error: { code: 'aborted', message: '新建智能体已取消，未保存资产', details: {} } }
    const failure = error as Error & { stderr?: string }
    const message = phase === 'validation' ? '智能体资产合同校验失败，本次新增资产已回滚；请根据具体用例或来源错误修正后重试' : '智能体创建失败，本次新增资产已回滚；请根据失败阶段和具体原因排查'
    return { ok: false, error: { code: 'creation_failed', message, details: { phase, reason: redactRunText(failure.stderr || failure.message || 'unknown').slice(0, 4000) } } }
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }) }
}
