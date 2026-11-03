// 合成合同夹具；这些材料不代表真实 KEV 训练或效果验收。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const trainingDigest = value => createHash('sha256').update(value).digest('hex')
export const trainingArtifacts = { checkpoint: 'synthetic trained adapter', state_constructor: 'synthetic state builder', calibration: 'synthetic fitted temperature' }
export function trainingFixture(root, sourceRunIds) {
  const file = (name, content) => {
    const path = `evaluation/training-fixture/${name}`
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content)
    return { path, sha256: trainingDigest(content) }
  }
  const rows = Object.fromEntries(['train', 'development', 'calibration', 'test'].map(split => [split, {
    _meta: { id: `record-${split}`, split, group_id: `group-${split}` }, state: `visible state ${split}`,
    questions: { route: { type: 'choice', instructions: 'Select a valid route', criteria: { A: 'one', B: 'two' }, answer: 'A' } },
  }]))
  const receipt = {
    schema_version: 1, source_run_ids: sourceRunIds,
    datasets: Object.fromEntries(Object.entries(rows).map(([split, row]) => [split, file(`${split}.jsonl`, JSON.stringify(row) + '\n')])),
    training: { status: 'completed', exit_code: 0, job_id: 'synthetic-job', optimizer_steps: 3, log: file('train.log', 'synthetic optimizer steps: 3\n') },
    calibration: { status: 'completed', exit_code: 0, report: file('calibration-report.json', '{"synthetic":true}') },
    test: { status: 'completed', exit_code: 0, report: file('test-report.json', '{"synthetic":true}') },
    artifacts: Object.fromEntries(Object.entries(trainingArtifacts).map(([name, content]) => [name, file(`${name}.bin`, content)])),
  }
  const save = () => file('receipt.json', JSON.stringify(receipt))
  const plan = { execution_mode: 'hybrid', generation: { source_run_ids: sourceRunIds },
    model_roles: { language: { provider: 'local', model: 'small-llm' }, decision: { checkpoint_sha256: receipt.artifacts.checkpoint.sha256, state_constructor_sha256: receipt.artifacts.state_constructor.sha256, calibration_sha256: receipt.artifacts.calibration.sha256 } }, decision_training: save() }
  return { plan, receipt, rows, file, save: () => { plan.decision_training = save() } }
}
