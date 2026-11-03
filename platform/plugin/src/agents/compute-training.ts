import { createHash } from 'node:crypto'
import { createReadStream, lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkflowModelRoles } from '../workflows/model-roles.ts'

export type TrainingFile = { path: string; sha256: string }

/** 核对回收的原始材料；不把模型身份、训练计划或命令卡当作执行回执。 */
export async function inspectDecisionTraining(root: string, plan: {
  execution_mode?: string; model_roles?: WorkflowModelRoles; decision_training?: TrainingFile
  generation?: { source_run_ids: string[] }
}) {
  if (plan.execution_mode !== 'hybrid') return { required: false, verified: false, reasons: [] as string[] }
  const counts: Record<string, number> = {}
  try {
    function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
    async function file(ref: TrainingFile, text = false) {
      require(ref && typeof ref.path === 'string' && !isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), '训练材料必须引用数据根内的文件及其 SHA-256')
      const path = resolve(root, ref.path), rel = relative(root, path)
      require(rel && !rel.split(sep).includes('..'), '训练材料不能越出数据工作区')
      let cursor = root
      for (const part of rel.split(sep)) { cursor = join(cursor, part); require(!lstatSync(cursor).isSymbolicLink(), '训练材料不能使用符号链接') }
      require(lstatSync(path).isFile(), '训练材料必须为文件')
      require(lstatSync(path).size > 0, `训练材料为空：${ref.path}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      require(hash.digest('hex') === ref.sha256, `训练材料摘要不匹配：${ref.path}`)
      return text ? readFile(path, 'utf8') : ''
    }
    require(plan.decision_training, '缺少本次 KEV 决策模型的真实训练回执')
    const receipt = JSON.parse(await file(plan.decision_training, true))
    require(receipt.schema_version === 1, '训练回执版本无效')
    const sources = plan.generation?.source_run_ids ?? []
    require(sources.length && Array.isArray(receipt.source_run_ids) && JSON.stringify([...new Set(receipt.source_run_ids)].sort()) === JSON.stringify([...sources].sort()), '训练回执与固定来源 Run 不一致')
    const groups = new Map<string, string>(), inputs = new Map<string, string>(), ids = new Set<string>()
    for (const partition of ['train', 'development', 'calibration', 'test']) {
      const rows = (await file(receipt.datasets?.[partition], true)).split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      require(rows.length, `${partition} 训练用途数据为空`)
      counts[partition] = rows.length
      for (const row of rows) {
        const meta = row._meta, group = meta?.bridge_group_id ?? meta?.group_id
        require(meta?.split === partition && typeof group === 'string' && group.trim() && typeof meta.id === 'string' && meta.id.trim() && !ids.has(meta.id), '训练数据缺少有效分区、来源组或唯一记录身份')
        ids.add(meta.id)
        require(!groups.has(group) || groups.get(group) === partition, '训练、开发、校准和测试存在跨用途来源组泄漏')
        groups.set(group, partition)
        const state = row.state
        require((typeof state === 'string' ? state.trim().length : state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length)
          && row.questions && typeof row.questions === 'object' && !Array.isArray(row.questions) && Object.keys(row.questions).length, '训练数据缺少原生 KEV state/questions')
        for (const question of Object.values(row.questions) as any[]) {
          const key = JSON.stringify([row.state, question.type, question.instructions, question.criteria])
          require(!inputs.has(key) || inputs.get(key) === partition, '训练、开发、校准和测试存在相同决策输入泄漏')
          inputs.set(key, partition)
        }
      }
    }
    const training = receipt.training
    require(training?.status === 'completed' && training.exit_code === 0 && typeof training.job_id === 'string' && training.job_id.trim()
      && Number.isInteger(training.optimizer_steps) && training.optimizer_steps > 0, 'KEV 训练未成功退出或缺少真实作业身份和优化步骤')
    await file(training.log)
    for (const stage of ['calibration', 'test']) {
      const result = receipt[stage]
      require(result?.status === 'completed' && result.exit_code === 0, `KEV ${stage} 尚未完成`)
      await file(result.report)
    }
    for (const [name, digest] of Object.entries({ checkpoint: 'checkpoint_sha256', state_constructor: 'state_constructor_sha256', calibration: 'calibration_sha256' })) {
      const artifact = receipt.artifacts?.[name]
      await file(artifact)
      require(artifact.sha256 === (plan.model_roles?.decision as any)?.[digest], `训练工件与决策模型绑定不一致：${name}`)
    }
    return { required: true, verified: true, reasons: [] as string[], receipt_sha256: plan.decision_training.sha256, dataset_counts: counts }
  } catch (error) {
    return { required: true, verified: false, reasons: [`决策模型训练尚未核验：${error instanceof Error ? error.message : '材料不可读'}`] }
  }
}
