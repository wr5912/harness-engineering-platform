import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { dataPath } from '../tasks/files.ts'
import { parseEvaluationDocument } from '../evaluation/cases.ts'
import { canonical, type MigrationMap } from './migrations-source.ts'

function read(root: string, relative: string, json = true): MigrationMap {
  const file = dataPath(root, relative), stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('证据文件不可读取')
  return json ? JSON.parse(readFileSync(file, 'utf8')) : load(readFileSync(file, 'utf8')) as MigrationMap
}
/** 完成状态只消费既有真实 API Run；固定 Case、装载观察和有效判定分别核对。 */
export async function migrationRunEvidence(root: string, id: string, agent: string, candidate: string, receipt: MigrationMap, build: MigrationMap, evaluationContent?: string | null) {
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
      current = (await parseEvaluationDocument(root, content)).cases
    }
    catch { reasons.push('当前关键用例合同无法读取') }
  }
  const runs: MigrationMap[] = [], directory = join(root, 'evolution/experiments', id, 'runs')
  if (existsSync(directory)) for (const run of readdirSync(directory).sort()) {
    if (!/^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run)) continue
    const failures: string[] = [], path = `evolution/experiments/${id}/runs/${run}`
    try {
      const manifest = read(root, `${path}/run.yaml`, false), inputs = read(root, `${path}/inputs.lock.json`), summary = read(root, `${path}/summary.json`)
      const actual = manifest.run_id === run && manifest.experiment_id === id && manifest.agent_id === agent && manifest.source_id === `experiment:${id}` && inputs.source_id === `experiment:${id}`
      const matches = inputs.candidate_sha256 === candidate
      if (!actual) failures.push('Run 来源身份不一致')
      if (!matches) failures.push('Run 对应其他 Candidate 摘要')
      if (manifest.status !== 'completed') failures.push('Run 的最终状态尚未完成')
      if (inputs.executor !== 'api') failures.push('Run 未使用真实 API 执行器')
      if (summary.run_id !== run || summary.source_verification?.status !== 'matched') failures.push('Run 缺少封存来源核对')
      const verdict = summary.effective_verdict ?? summary.machine_overall_verdict ?? summary.overall_verdict
      if (verdict !== 'passed') failures.push('Run 的有效结论尚未通过')
      const frozen = new Map<string, MigrationMap>((inputs.evaluation_cases ?? []).map((item: MigrationMap) => [item.case_id, item]))
      const results = dataPath(root, `${path}/results.jsonl`), rows = readFileSync(results, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      let reviews = new Map<string, MigrationMap>()
      if (inputs.review_mode === 'ai') {
        const analysis = read(root, `${path}/analysis.json`)
        if (summary.review_status !== 'completed' || analysis.review_status !== 'completed') failures.push('业务复核尚未完成')
        reviews = new Map((analysis.scenes ?? []).flatMap((scene: MigrationMap) => (scene.case_reviews ?? []).map((item: MigrationMap) => [item.case_id, item])))
      }
      let loaded = 0, passed = 0
      for (const caseId of required) {
        if (!/^U-[A-Z0-9-]+$/.test(caseId)) { failures.push('关键用例 ID 无效'); continue }
        const contract = frozen.get(caseId)
        if (!contract || !current?.[caseId] || canonical(contract) !== canonical(current[caseId])) { failures.push(`${caseId} 缺少当前合同的冻结定义`); continue }
        const selected = rows.filter(row => row.input_id === caseId)
        if (!selected.length || selected.some(row => row.run_id !== run || row.execution_status !== 'completed')) { failures.push(`${caseId} 没有完整执行结果`); continue }
        const checks = read(root, `${path}/evidence/${caseId}/checks.json`), response = read(root, `${path}/evidence/${caseId}/response.json`)
        if (checks.preset_matches === true && checks.workspace_matches === true && typeof checks.session_id === 'string' && checks.session_id && Array.isArray(response.assistant_texts) && response.assistant_texts.some((item: unknown) => typeof item === 'string' && item.trim())) loaded++
        else { failures.push(`${caseId} 缺少真实装载和响应观察`); continue }
        const caseVerdict = inputs.review_mode === 'ai' ? reviews.get(caseId)?.reviewed_verdict : selected.every(row => row.verdict === 'passed') ? 'passed' : 'inconclusive'
        if (caseVerdict === 'passed') passed++
        else failures.push(`${caseId} 有效判定未通过或未知`)
      }
      const runtime = Boolean(required.length && actual && matches && inputs.executor === 'api' && summary.source_verification?.status === 'matched' && loaded === required.length)
      const business = runtime && verdict === 'passed' && passed === required.length && !failures.length
      runs.push({ run_id: run, status: manifest.status, executor: inputs.executor, candidate_sha256: inputs.candidate_sha256, candidate_matches: matches, effective_verdict: verdict ?? null, runtime_verified: runtime, business_verified: business, covered_case_ids: required.filter(caseId => frozen.has(caseId)), reasons: failures, path })
    } catch { runs.push({ run_id: run, status: 'incomplete-evidence', runtime_verified: false, business_verified: false, reasons: ['Run 缺少完整冻结输入、摘要、结果或原始执行证据'], path }) }
  }
  const runtime = runs.some(run => run.runtime_verified), business = runs.some(run => run.business_verified) && !blocked && (!needsBuild || build.verified)
  if (!runtime) reasons.push('尚无覆盖当前 Candidate 和全部关键用例的真实 DSH API 装载证据')
  if (!business) reasons.push('当前迁移关键行为尚未完成有效业务验证')
  return { runs, runtime_verified: runtime, business_verified: Boolean(business), completed: Boolean(business), verification_reasons: reasons }
}
