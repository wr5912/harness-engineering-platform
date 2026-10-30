import { VERSION_ID } from '../version-id.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const EXPERIMENT = VERSION_ID
const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 整体结论只属于已完成的 Run；中断 Run 的 summary 可作为部分证据保留。 */
export async function readRunVerdict(root: string, experimentId: string, runId: string, status: string | null | undefined): Promise<string | null> {
  if (status !== 'completed' || !EXPERIMENT.test(experimentId) || !RUN.test(runId)) return null
  try {
    const summary = JSON.parse(await readFile(join(root, 'evolution/experiments', experimentId, 'runs', runId, 'summary.json'), 'utf8'))
    const verdict = summary.effective_verdict ?? summary.machine_overall_verdict ?? summary.overall_verdict
    return ['passed', 'failed', 'inconclusive'].includes(verdict) ? verdict : null
  } catch { return null }
}
