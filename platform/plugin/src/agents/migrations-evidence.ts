import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { programRoot } from '../workspace.ts'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataPath } from '../tasks/files.ts'
import { parseEvaluationDocument } from '../evaluation/cases.ts'
import { caseObservation } from '../evaluation/case-observation.ts'
import { canonical, type MigrationMap } from './migrations-source.ts'

const execute = promisify(execFile)
async function sealedRun(root: string, run: string, agent: string, signal?: AbortSignal): Promise<MigrationMap> {
  const code = [
    'import json,sys', 'from pathlib import Path', 'sys.path.insert(0,sys.argv[1])',
    'from run_record import comparison_run_view',
    'try:', '    print(json.dumps({"ok":True,"value":comparison_run_view(Path(sys.argv[2]),sys.argv[3],sys.argv[4])}))',
    'except (OSError,ValueError,KeyError,TypeError) as error:', '    print(json.dumps({"ok":False,"reason":str(error)[:512]}))',
  ].join('\n')
  const { stdout } = await execute(process.env.HARNESS_PYTHON || 'python3', ['-c', code, join(programRoot(), 'runtime/adapters/dsh-container'), root, run, agent], { cwd: root, signal, timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
  const result = JSON.parse(stdout)
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

/** 完成状态只消费既有真实 API Run；固定 Case、装载观察和有效判定分别核对。 */
export async function migrationRunEvidence(root: string, id: string, agent: string, candidate: string, receipt: MigrationMap, build: MigrationMap, evaluationContent?: string | null, signal?: AbortSignal) {
  const required: string[] = Array.isArray(receipt.evaluation_case_ids) ? receipt.evaluation_case_ids : []
  const blocked = (receipt.uncovered?.length ?? 0) > 0 || receipt.mapping?.some((item: MigrationMap) => item.required !== false && ['pending', 'omitted'].includes(item.status))
  const reasons: string[] = []
  if (!required.length) reasons.push('尚未声明迁移关键行为的评测用例')
  if (blocked) reasons.push('仍有未覆盖的关键行为或待转换项')
  // 只有迁移选择了 TS 入口才要求构建；纯配置/Prompt 资产无需虚构构建回执。
  const candidateRoot = join(root, 'evolution/experiments', id, 'candidate')
  function hasTypeScript(directory: string): boolean {
    return existsSync(directory) && readdirSync(directory, { withFileTypes: true }).some(entry => entry.isDirectory() ? hasTypeScript(join(directory, entry.name)) : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name))
  }
  const needsBuild = hasTypeScript(join(candidateRoot, 'dsh/managed'))
  if (needsBuild && !build.verified) reasons.push('Managed TypeScript 资产尚未通过当前构建核对')
  let current: MigrationMap | undefined
  if (required.length) {
    try {
      const content = evaluationContent === undefined ? readFileSync(dataPath(root, `agents/${agent}/evaluation.md`), 'utf8') : evaluationContent
      if (content === null) throw new Error('当前评测合同不存在')
      current = (await parseEvaluationDocument(root, content, signal)).cases
    }
    catch { reasons.push('当前关键用例合同无法读取') }
  }
  const runs: MigrationMap[] = [], directory = join(root, 'evolution/experiments', id, 'runs')
  if (existsSync(directory)) for (const run of readdirSync(directory).sort()) {
    if (!/^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run)) continue
    const failures: string[] = [], path = `evolution/experiments/${id}/runs/${run}`
    try {
      const view = await sealedRun(root, run, agent, signal), manifest = view.manifest, inputs = view.source, summary = view.summary
      const actual = manifest.run_id === run && manifest.experiment_id === id && manifest.agent_id === agent && manifest.source_id === `experiment:${id}` && inputs.source_id === `experiment:${id}`
      const matches = inputs.candidate_sha256 === candidate
      if (!actual) failures.push('Run 来源身份不一致')
      if (!matches) failures.push('Run 对应其他 Candidate 摘要')
      if (manifest.status !== 'completed') failures.push('Run 的最终状态尚未完成')
      if (inputs.executor !== 'api') failures.push('Run 未使用真实 API 执行器')
      if (summary.run_id !== run || summary.source_verification?.status !== 'matched') failures.push('Run 缺少封存来源核对')
      const verdict = summary.effective_verdict ?? summary.machine_overall_verdict ?? summary.overall_verdict
      if (verdict !== 'passed') failures.push('Run 的有效结论尚未通过')
      const cases = new Map<string, MigrationMap>((view.cases ?? []).map((item: MigrationMap) => [item.case_id, item]))
      const frozen = new Map<string, MigrationMap>((view.cases ?? []).filter((item: MigrationMap) => item.frozen).map((item: MigrationMap) => [item.case_id, item.frozen]))
      if (inputs.review_mode === 'ai' && summary.review_status !== 'completed') failures.push('业务复核尚未完成')
      let loaded = 0, passed = 0
      for (const caseId of required) {
        if (!/^U-[A-Z0-9-]+$/.test(caseId)) { failures.push('关键用例 ID 无效'); continue }
        const contract = frozen.get(caseId)
        if (!contract || !current?.[caseId] || canonical(contract) !== canonical(current[caseId])) { failures.push(`${caseId} 缺少当前合同的冻结定义`); continue }
        const selected: MigrationMap[] = cases.get(caseId)?.trials ?? []
        if (!selected.length || selected.some(row => row.run_id !== run || row.execution_status !== 'completed')) { failures.push(`${caseId} 没有完整执行结果`); continue }
        const evidence = cases.get(caseId)!, checks = evidence.load_observation, output = evidence.output
        for (const name of ['checks.json', 'response.json', 'trace.jsonl', 'tools.jsonl']) {
          const file = dataPath(root, `${path}/evidence/${caseId}/${name}`)
          if (!existsSync(file) || !lstatSync(file).isFile() || name === 'trace.jsonl' && !lstatSync(file).size) failures.push(`${caseId} 缺少原始执行证据 ${name}`)
        }
        if (!failures.some(reason => reason.startsWith(`${caseId} 缺少原始执行证据`)) && checks?.preset_matches === true && checks.workspace_matches === true && typeof checks.session_id === 'string' && checks.session_id && Array.isArray(output) && output.some((item: unknown) => typeof item === 'string' && item.trim())) loaded++
        else { failures.push(`${caseId} 缺少真实装载和响应观察`); continue }
        const caseVerdict = caseObservation(evidence, inputs.review_mode === 'ai').value
        if (caseVerdict === 'passed') passed++
        else failures.push(`${caseId} 有效判定未通过或未知`)
      }
      const runtime = Boolean(required.length && actual && matches && inputs.executor === 'api' && summary.source_verification?.status === 'matched' && loaded === required.length)
      const business = runtime && verdict === 'passed' && passed === required.length && !failures.length
      runs.push({ run_id: run, status: manifest.status, executor: inputs.executor, candidate_sha256: inputs.candidate_sha256, candidate_matches: matches, effective_verdict: verdict ?? null, runtime_verified: runtime, business_verified: business, covered_case_ids: required.filter(caseId => frozen.has(caseId)), reasons: failures, path })
    } catch (error) {
      signal?.throwIfAborted()
      runs.push({ run_id: run, status: 'incomplete-evidence', runtime_verified: false, business_verified: false, reasons: [`Run 封存或原始证据不可验证：${error instanceof Error ? error.message : '证据读取失败'}`], path })
    }
  }
  const runtime = runs.some(run => run.runtime_verified), business = runs.some(run => run.business_verified) && !blocked && (!needsBuild || build.verified)
  if (!runtime) reasons.push('尚无覆盖当前 Candidate 和全部关键用例的真实 DSH API 装载证据')
  if (!business) reasons.push('当前迁移关键行为尚未完成有效业务验证')
  return { runs, runtime_verified: runtime, business_verified: Boolean(business), completed: Boolean(business), verification_reasons: reasons }
}
