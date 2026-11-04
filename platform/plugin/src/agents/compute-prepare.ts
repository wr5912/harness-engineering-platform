import { inspectComputeBuild } from './compute-build.ts'
import { archiveDecisionTraining } from './compute-training.ts'

type Body = Record<string, any>
type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string; details?: Body } }
type Handler = (method: string, body: Body, signal?: AbortSignal) => Promise<Result>

/** 固定本地步骤连续执行；业务判断、训练与外部写入不在此流程中。 */
export async function prepareComputeVariant(root: string, body: Body, build: Handler, freeze: Handler, signal?: AbortSignal): Promise<Result> {
  const steps: Body[] = []
  const started = performance.now()
  let stageStarted = started
  let stage = 'training-archive'
  const failed = (result: Extract<Result, { ok: false }>): Result => ({ ok: false,
    error: { ...result.error, details: { ...result.error.details, stage, completed_steps: steps,
      stage_elapsed_ms: Math.round(performance.now() - stageStarted), elapsed_ms: Math.round(performance.now() - started) } } })
  try {
    signal?.throwIfAborted()
    const archived = await archiveDecisionTraining(root, body.experiment_id, signal, body.training_files)
    if (archived) steps.push({ ...archived, elapsed_ms: Math.round(performance.now() - stageStarted) })
    stage = 'build'
    stageStarted = performance.now()
    const existing = inspectComputeBuild(root, body.experiment_id)
    if (existing.verified && (!body.entry_path || body.entry_path === existing.receipt.entry_path)) {
      steps.push({ stage, reused: true, build_digest: existing.receipt.build_digest })
    } else {
      const preview = await build('preview', body, signal)
      if (!preview.ok) return failed(preview)
      const saved = await build('build', { ...body, expected_candidate_sha256: preview.value.candidate_sha256,
        expected_preview_sha256: preview.value.preview_sha256 }, signal)
      if (!saved.ok) return failed(saved)
      steps.push({ stage, reused: false, build_digest: saved.value.build_digest })
    }
    steps[steps.length - 1].elapsed_ms = Math.round(performance.now() - stageStarted)
    stage = 'freeze'
    stageStarted = performance.now()
    signal?.throwIfAborted()
    const preview = await freeze('preview', body, signal)
    if (!preview.ok) return failed(preview)
    const frozen = await freeze('freeze', preview.value.freeze_input, signal)
    if (!frozen.ok) return failed(frozen)
    steps.push({ stage, reused: frozen.value.unchanged === true, commit: frozen.value.commit,
      elapsed_ms: Math.round(performance.now() - stageStarted) })
    return { ok: true, value: { experiment_id: body.experiment_id, source_ref: `git:${frozen.value.commit}`, steps,
      elapsed_ms: Math.round(performance.now() - started),
      notes: ['构建与本地冻结已完成；尚未启动评测或证明业务通过。'] } }
  } catch (error) {
    return failed({ ok: false, error: { code: signal?.aborted ? 'aborted' : 'prepare_failed',
      message: `${stage === 'training-archive' ? '训练归档' : stage === 'build' ? '构建' : '冻结'}未完成；已完成步骤保留，重试时按当前摘要核对。${signal?.aborted ? '操作已取消。' : error instanceof Error ? error.message : ''}` } })
  }
}
