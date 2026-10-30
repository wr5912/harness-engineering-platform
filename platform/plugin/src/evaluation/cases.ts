import { VERSION_ID } from '../version-id.ts'
import { programRoot } from '../workspace.ts'
import { assertVersionIdentity } from '../agents/version-source.ts'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { load as loadYaml } from 'js-yaml'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'

type JsonMap = Record<string, unknown>
const execute = promisify(execFile)
const EXPERIMENT_ID = VERSION_ID
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CASE_ID = /^U-[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CONTRACT = 'runtime/research/evaluation_contract.py'

/** 运行来源属于当前用例的出处，普通字段编辑不能静默移除。 */
export function caseSourceReferences(block: string): string[] {
  return [...block.matchAll(/^<!-- source_run_id: (run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}); source_case_id: (U-[A-Z0-9]+(?:-[A-Z0-9]+)*) -->\r?$/gm)]
    .map(match => match[0].trim())
}

interface ParsedEvaluation {
  case_ids: string[]
  cases: Record<string, { case_id: string; title: string; inputs: string[]; expected_behavior: string }>
  catalog: { case_id: string; scene: string; fast: boolean }[]
}
export interface RunCaseSource {
  run_id?: string
  manifest: { agent_id?: string; experiment_id?: string; status?: string }
  cases: { case_id: string; frozen?: { title?: string; inputs?: string[] }; trials?: { verdict?: string; execution_status?: string }[]; review?: { reviewed_verdict?: string } | null }[]
}
export interface CaseManagementServices {
  /** 委托原有资产写入服务，保留 dry 校验和摘要乐观锁。 */
  applyEvaluation(experimentId: string, content: string, expectedSha256: string, signal?: AbortSignal): Promise<unknown>
  readRun(runId: string, signal?: AbortSignal): Promise<RunCaseSource>
}

class CaseError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function field(body: JsonMap, name: string) {
  if (typeof body[name] !== 'string' || !body[name].trim()) throw new CaseError('invalid_request', `${name} 不能为空`)
  return (body[name] as string).trim()
}
function singleLine(value: string, name: string) {
  if (/[\r\n]/.test(value)) throw new CaseError('invalid_request', `${name} 必须是单行`)
  return value
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new CaseError('aborted', '用例操作已取消') }
async function noLinks(root: string, path: string) {
  let cursor = root
  for (const part of path.slice(root.length + 1).split(sep)) {
    cursor = join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new CaseError('path_rejected', '用例来源不得包含符号链接')
  }
}

/** 原文和新增草稿均调用当前研究合同，不维护另一套 Case 解析规则。 */
export async function parseEvaluationDocument(root: string, content: string, signal?: AbortSignal): Promise<ParsedEvaluation> {
  cancelled(signal)
  const temp = await mkdtemp(join(tmpdir(), 'harness-case-contract-'))
  const file = join(temp, 'evaluation.md')
  try {
    await writeFile(file, content)
    const code = 'import json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom evaluation_contract import load_evaluation\nprint(json.dumps(load_evaluation(Path(sys.argv[2])),ensure_ascii=False))'
    const { stdout } = await execute(process.env.HARNESS_PYTHON || 'python3', ['-c', code, join(programRoot(), CONTRACT, '..'), file], { cwd: root, signal, timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
    return JSON.parse(stdout)
  } catch (error) {
    cancelled(signal)
    const reason = (error as { stderr?: string }).stderr?.trim().split('\n').at(-1)
    // 诊断只取合同错误末行；不把输入正文和 Python 参数写入错误回执。
    throw new CaseError('invalid_request', reason?.startsWith('ValueError:') ? reason.slice('ValueError:'.length).trim() : 'evaluation.md 合同解析失败')
  } finally { await rm(temp, { recursive: true, force: true }) }
}

async function documentFor(root: string, body: JsonMap, signal?: AbortSignal) {
  cancelled(signal)
  const experimentId = field(body, 'experiment_id')
  if (!EXPERIMENT_ID.test(experimentId)) throw new CaseError('invalid_request', 'Experiment ID 格式无效')
  const changePath = join(root, 'evolution/experiments', experimentId, 'change.yaml')
  await noLinks(root, changePath)
  const change = loadYaml(await readFile(changePath, 'utf8')) as JsonMap
  const agentId = change?.agent_id
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new CaseError('invalid_request', 'Experiment 身份不一致')
  try { assertVersionIdentity(experimentId, change) }
  catch { throw new CaseError('invalid_request', 'Experiment 身份不一致') }
  const path = `agents/${agentId}/evaluation.md`
  await noLinks(root, join(root, path))
  const content = await readFile(join(root, path), 'utf8')
  const parsed = await parseEvaluationDocument(root, content, signal)
  return { experimentId, agentId, path, content, parsed, sha256: digest(content) }
}

async function sourceCase(services: CaseManagementServices, agentId: string, runId: string, caseId: string, signal?: AbortSignal) {
  if (!RUN_ID.test(runId) || !CASE_ID.test(caseId)) throw new CaseError('invalid_request', '来源 Run 或 Case ID 格式无效')
  const run = await services.readRun(runId, signal)
  if (run.manifest.agent_id !== agentId || run.run_id && run.run_id !== runId) throw new CaseError('invalid_request', '来源 Run 不属于当前智能体')
  const selected = run.cases.find(item => item.case_id === caseId)
  if (!selected) throw new CaseError('not_found', '来源 Run 没有该 Case')
  if (!selected.frozen?.inputs?.length || selected.frozen.inputs.some(value => typeof value !== 'string' || !value.trim())) throw new CaseError('source_unavailable', '该历史 Run 未保存完整冻结输入，无法生成用例草稿')
  return selected
}

function nextCaseId(parsed: ParsedEvaluation) {
  let index = 1
  while (parsed.case_ids.includes(`U-NEW-${String(index).padStart(3, '0')}`)) index++
  return `U-NEW-${String(index).padStart(3, '0')}`
}
function context(document: Awaited<ReturnType<typeof documentFor>>) {
  return { agent_id: document.agentId, experiment_id: document.experimentId, path: document.path, sha256: document.sha256,
    scenes: [...new Set(document.parsed.catalog.map(item => item.scene))],
    draft: { case_id: nextCaseId(document.parsed), title: '', scene: document.parsed.catalog[0]?.scene ?? '新增测试用例', inputs: [''], expected_behavior: '', fast: false } }
}

async function prepare(root: string, body: JsonMap, services: CaseManagementServices, signal?: AbortSignal) {
  const document = await documentFor(root, body, signal)
  const expected = field(body, 'expected_sha256')
  if (expected !== document.sha256) throw new CaseError('conflict', '评测用例已被其他任务修改；当前草稿保留，请重新读取后核对')
  const caseId = field(body, 'case_id')
  if (!CASE_ID.test(caseId)) throw new CaseError('invalid_request', 'Case ID 必须为 U- 开头的大写字母、数字和连字符')
  if (document.parsed.case_ids.includes(caseId)) throw new CaseError('conflict', 'Case ID 已存在，新增不会覆盖已有用例')
  const title = singleLine(field(body, 'title'), '用例名称')
  const scene = singleLine(field(body, 'scene'), '场景')
  if (!Array.isArray(body.inputs) || !body.inputs.length || body.inputs.some(value => typeof value !== 'string' || !value.trim())) throw new CaseError('invalid_request', '至少需要一条非空用户输入')
  const inputs = (body.inputs as string[]).map(value => value.replace(/\r\n?/g, '\n').trim())
  const expectedBehavior = field(body, 'expected_behavior').replace(/\r\n?/g, '\n')
  if (typeof body.fast !== 'boolean') throw new CaseError('invalid_request', 'fast 必须为布尔值')
  const sourceRun = body.source_run_id === undefined ? undefined : field(body, 'source_run_id')
  const sourceCaseId = body.source_case_id === undefined ? undefined : field(body, 'source_case_id')
  if (Boolean(sourceRun) !== Boolean(sourceCaseId)) throw new CaseError('invalid_request', '来源 Run 与来源 Case 必须一起提供')
  if (sourceRun && sourceCaseId) await sourceCase(services, document.agentId, sourceRun, sourceCaseId, signal)
  const newline = document.content.includes('\r\n') ? '\r\n' : '\n'
  const block = [`#### ${caseId} ${title}`, '', ...(body.fast ? ['**评估档位：** `fast`', ''] : []),
    ...(sourceRun ? [`<!-- source_run_id: ${sourceRun}; source_case_id: ${sourceCaseId} -->`, ''] : []),
    ...inputs.flatMap((value, index) => [`**用户输入${inputs.length > 1 ? ` ${index + 1}` : ''}**`, '', ...value.split('\n').map(line => `> ${line}`), '']),
    '**预期**', '', ...expectedBehavior.split('\n'), '', ''].join(newline)
  const headings = [...document.content.matchAll(/^## ([^\r\n]+)\r?$/gm)]
  const section = headings.find(item => item[1] === scene)
  const index = section ? headings.indexOf(section) : -1
  const position = section ? headings[index + 1]?.index ?? document.content.length : document.content.length
  const addition = `${section ? '' : `## ${scene}${newline}${newline}`}${block}`
  const prefix = document.content.slice(0, position)
  const content = prefix + (prefix.endsWith(`${newline}${newline}`) ? '' : prefix.endsWith(newline) ? newline : `${newline}${newline}`) + addition + document.content.slice(position)
  const parsed = await parseEvaluationDocument(root, content, signal)
  const created = parsed.cases[caseId]
  const row = parsed.catalog.find(item => item.case_id === caseId)
  if (created?.title !== title || JSON.stringify(created.inputs) !== JSON.stringify(inputs) || created.expected_behavior !== expectedBehavior || row?.scene !== scene || row.fast !== body.fast || parsed.case_ids.length !== document.parsed.case_ids.length + 1) throw new CaseError('invalid_request', '新增内容无法按评测合同完整保存，请检查 Markdown 标题和字段')
  for (const id of document.parsed.case_ids) {
    if (JSON.stringify(document.parsed.cases[id]) !== JSON.stringify(parsed.cases[id]) || JSON.stringify(document.parsed.catalog.find(item => item.case_id === id)) !== JSON.stringify(parsed.catalog.find(item => item.case_id === id))) throw new CaseError('invalid_request', '新增内容改变了其他用例，已拒绝写入')
  }
  return { document, content, parsed, created, row, diff: [`--- ${document.path}`, `+++ ${document.path}`, '@@ 新增测试用例 @@', ...addition.trimEnd().split(/\r?\n/).map(line => `+${line}`)].join('\n') }
}

export function createCaseManagementHandler(assetRoot: string, services: CaseManagementServices): ConnectionRpcHandler {
  const root = resolve(assetRoot)
  return async (endpoint, payload, signal) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CaseError('invalid_request', '用例请求必须为对象')
      const body = payload as JsonMap
      if (endpoint === 'cases/create-context' || endpoint === 'cases/from-run') {
        const document = await documentFor(root, body, signal)
        const result = context(document)
        if (endpoint === 'cases/from-run') {
          const runId = field(body, 'run_id'), caseId = field(body, 'case_id')
          const source = await sourceCase(services, document.agentId, runId, caseId, signal)
          return { ok: true, value: { ...result, source_run_id: runId, source_case_id: caseId,
            note: '草稿仅复制运行时的冻结输入。请人工重写输入并填写预期行为；实际回答和失败结果不会作为参考答案。',
            draft: { ...result.draft, title: `复现：${source.frozen?.title ?? caseId}`, inputs: [...source.frozen!.inputs!], expected_behavior: '' } } }
        }
        return { ok: true, value: result }
      }
      if (endpoint !== 'cases/create-preview' && endpoint !== 'cases/create') throw new CaseError('not_found', '未知用例操作')
      const value = await prepare(root, body, services, signal)
      const result = { case: { id: value.created.case_id, title: value.created.title, inputs: value.created.inputs, expected_behavior: value.created.expected_behavior, scene: value.row!.scene, fast: value.row!.fast, tier: value.row!.fast ? 'fast' : 'full' }, path: value.document.path, sha256: digest(value.content), diff: value.diff,
        note: '新增用例在保存后立即供后续评测选择；已启动和历史 Run 保留冻结口径。' }
      if (endpoint === 'cases/create-preview') return { ok: true, value: { ...result, before_sha256: value.document.sha256, written: false } }
      cancelled(signal)
      await services.applyEvaluation(value.document.experimentId, value.content, value.document.sha256, signal)
      return { ok: true, value: { ...result, written: true } }
    } catch (error) {
      if (!(error instanceof CaseError)) throw error
      return { ok: false, error: { code: error.code, message: error.message, details: {} } }
    }
  }
}
