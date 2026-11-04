import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { load, dump } from 'js-yaml'
import { dataPath, sourceInfo } from '../tasks/files.ts'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'
import type { WorkflowModelRoles } from '../workflows/model-roles.ts'

export type TrainingFile = { path: string; sha256: string }

/** 核对回收的原始材料；不把模型身份、训练计划或命令卡当作执行回执。 */
export async function inspectDecisionTraining(root: string, plan: {
  execution_mode?: string; model_roles?: WorkflowModelRoles; decision_training?: TrainingFile
  generation?: { source_run_ids: string[] }
}, experimentId?: string) {
  if (plan.execution_mode !== 'hybrid') return { required: false, verified: false, reasons: [] as string[] }
  const counts: Record<string, number> = {}
  const files = new Map<string, TrainingFile>()
  try {
    function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
    async function file(ref: TrainingFile, text = false) {
      require(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256), '训练材料必须引用数据根内的文件及其 SHA-256')
      require(!ref.path.startsWith('/') && !ref.path.split('/').includes('..'), '训练材料不能越出数据工作区')
      const path = dataPath(root, ref.path)
      if (experimentId) require(['evaluation', 'candidate'].some(part => ref.path.startsWith(`evolution/experiments/${experimentId}/${part}/`)), '训练材料必须归档到所属 Experiment 的 evaluation 或 Candidate，不能依赖 .local 或其他工作区')
      require(lstatSync(path).isFile(), '训练材料必须为文件')
      require(lstatSync(path).size > 0, `训练材料为空：${ref.path}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      require(hash.digest('hex') === ref.sha256, `训练材料摘要不匹配：${ref.path}`)
      require(!files.has(ref.path) || files.get(ref.path)!.sha256 === ref.sha256, '同一路径的训练材料摘要冲突')
      files.set(ref.path, ref)
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
    require(receipt.supporting_files === undefined || Array.isArray(receipt.supporting_files), '训练依赖文件清单必须为数组')
    for (const ref of receipt.supporting_files ?? []) await file(ref)
    return { required: true, verified: true, reasons: [] as string[], receipt_sha256: plan.decision_training.sha256, dataset_counts: counts, files: [...files.values()] }
  } catch (error) {
    return { required: true, verified: false, reasons: [`决策模型训练尚未核验：${error instanceof Error ? error.message : '材料不可读'}`] }
  }
}

/** prepare 的固定交接步骤：只归档核验过的引用闭包，原始执行回执保持原样。 */
export async function archiveDecisionTraining(root: string, experimentId: string, signal?: AbortSignal, trainingFiles: TrainingFile[] = []) {
  const source = sourceInfo(root, experimentId), base = `evolution/experiments/${source.id}`
  const changePath = dataPath(root, `${base}/change.yaml`), before = readFileSync(changePath, 'utf8'), change = load(before) as any
  const plan = change.compute_variant
  if (plan?.execution_mode !== 'hybrid' || !plan.decision_training) return null
  if (!Array.isArray(trainingFiles)) throw new Error('training_files 必须为文件及 SHA-256 引用数组')
  const owned = await inspectDecisionTraining(root, plan, source.id)
  const ownedMaterials = `${dirname(plan.decision_training.path)}/materials/`
  if (owned.verified && trainingFiles.every(ref => owned.files?.some(file => (file.path === ref?.path || file.path === ownedMaterials + ref?.path) && file.sha256 === ref.sha256))) return { stage: 'training-archive', reused: true, receipt: plan.decision_training, files: owned.files }
  const verified = await inspectDecisionTraining(root, plan)
  if (!verified.verified) throw new Error(verified.reasons.join('；'))
  signal?.throwIfAborted()
  const original = plan.decision_training as TrainingFile
  const destination = `${base}/evaluation/training/${original.sha256}`
  const originalContent = await readFile(dataPath(root, original.path))
  if (createHash('sha256').update(originalContent).digest('hex') !== original.sha256) throw new Error('归档期间训练回执变化，请重新核对')
  if (containsLiteralLlmKey(original.path, originalContent.toString('utf8'))) throw new Error('训练回执包含 LLM API Key，不能归档')
  const receipt = JSON.parse(originalContent.toString('utf8'))
  const pending = new Map<string, Buffer>()
  async function collect(ref: TrainingFile, name: string) {
    if (!ref || typeof ref.path !== 'string' || ref.path.startsWith('/') || ref.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('训练依赖必须引用数据根内文件及其 SHA-256')
    if (!lstatSync(dataPath(root, ref.path)).isFile()) throw new Error('训练依赖必须为文件')
    const content = await readFile(dataPath(root, ref.path))
    if (createHash('sha256').update(content).digest('hex') !== ref.sha256) throw new Error('归档期间训练材料变化，请重新核对')
    if (containsLiteralLlmKey(ref.path, content.toString('utf8'))) throw new Error('训练材料包含 LLM API Key，不能归档')
    const path = `${destination}/${name}/${basename(ref.path)}`
    pending.set(path.slice(destination.length + 1), content)
    return { path, sha256: ref.sha256 }
  }
  for (const split of ['train', 'development', 'calibration', 'test']) receipt.datasets[split] = await collect(receipt.datasets[split], `datasets/${split}`)
  receipt.training.log = await collect(receipt.training.log, 'execution')
  for (const stage of ['calibration', 'test']) receipt[stage].report = await collect(receipt[stage].report, `reports/${stage}`)
  // 工件与显式依赖保持原目录关系，状态构造器和模型配置的相对加载才能恢复。
  for (const name of ['checkpoint', 'state_constructor', 'calibration']) receipt.artifacts[name] = await collect(receipt.artifacts[name], `materials/${dirname(receipt.artifacts[name].path)}`)
  const supporting = new Map<string, TrainingFile>()
  for (const ref of [...receipt.supporting_files ?? [], ...trainingFiles]) {
    const previous = supporting.get(ref?.path)
    if (previous && previous.sha256 !== ref.sha256) throw new Error('训练依赖文件清单摘要冲突')
    supporting.set(ref?.path, ref)
  }
  if (supporting.size) receipt.supporting_files = await Promise.all([...supporting.values()].map(ref => collect(ref, `materials/${dirname(ref.path)}`)))
  pending.set('source-receipt.json', originalContent)
  const content = JSON.stringify(receipt, null, 2) + '\n'
  pending.set('receipt.json', Buffer.from(content))
  const next = { path: `${destination}/receipt.json`, sha256: createHash('sha256').update(content).digest('hex') }
  // 暂存仅在 .local；目录完整后一次改名，change.yaml 最后更新。
  const scratch = dataPath(root, '.local/training-archive'); await mkdir(scratch, { recursive: true })
  const temporary = await mkdtemp(join(scratch, 'archive-'))
  try {
    for (const [path, bytes] of pending) {
      const target = dataPath(temporary, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: 0o600 })
    }
    signal?.throwIfAborted()
    const target = dataPath(root, destination)
    await mkdir(dirname(target), { recursive: true })
    try { await rename(temporary, target) }
    catch (error) { if (!existsSync(target)) throw error }
    for (const [path, bytes] of pending) if (!readFileSync(dataPath(root, `${destination}/${path}`)).equals(bytes)) throw new Error('已有训练归档与当前材料冲突，未修改计划')
    const recovered = await inspectDecisionTraining(root, { ...plan, decision_training: next }, source.id)
    if (!recovered.verified) throw new Error(recovered.reasons.join('；'))
    signal?.throwIfAborted()
    const update = `${changePath}.${randomUUID()}.tmp`
    try {
      change.compute_variant.decision_training = next
      writeFileSync(update, dump(change, { lineWidth: -1, noRefs: true }), { flag: 'wx' })
      if (readFileSync(changePath, 'utf8') !== before) throw new Error('归档期间研究计划变化，材料已保留，请重新执行 prepare')
      renameSync(update, changePath)
    } finally { await rm(update, { force: true }) }
    return { stage: 'training-archive', reused: false, receipt: next, source_receipt: original, files: recovered.files }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
