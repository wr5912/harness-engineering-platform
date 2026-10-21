import { programRoot } from './workspace.ts'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { load as loadYaml } from 'js-yaml'
import { readRunVerdict } from './evaluation/run-verdict.ts'

const execute = promisify(execFile)

export interface RecentRun {
  id: string
  agent_id: string
  experiment_id: string
  status: string | null
  created_at: string | null
  finished_at: string | null
  effective_verdict?: string | null
  agent_name?: string | null
}

export async function recentRuns(root: string, agentIds: string[], signal: AbortSignal): Promise<RecentRun[]> {
  const rows = await Promise.all(agentIds.map(async agentId => {
    const { stdout } = await execute(process.env.HARNESS_PYTHON || 'python3', [join(programRoot(), 'runtime/adapters/dsh-container/run_record.py'),
      '--repo', root, 'index', '--agent', agentId], { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    const index = JSON.parse(stdout) as { experiments: { experiment_id: string; runs: {
      run_id: string; status: string | null; created_at: string | null; finished_at: string | null
    }[] }[] }
    return index.experiments.flatMap(experiment => experiment.runs.map(run => ({
      id: run.run_id, agent_id: agentId, experiment_id: experiment.experiment_id,
      status: run.status, created_at: run.created_at, finished_at: run.finished_at,
    })))
  }))
  const recent = rows.flat().sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 8)
  const names = new Map<string, Promise<string | null>>()
  const nameFor = (experimentId: string) => {
    let pending = names.get(experimentId)
    if (!pending) {
      pending = readFile(join(root, 'evolution/experiments', experimentId, 'candidate/harness.yaml'), 'utf8')
        .then(content => {
          const name = (loadYaml(content) as { agent?: { name?: unknown } })?.agent?.name
          return typeof name === 'string' && name.trim() ? name.trim() : null
        }).catch(() => null)
      names.set(experimentId, pending)
    }
    return pending
  }
  return Promise.all(recent.map(async run => ({ ...run,
    effective_verdict: await readRunVerdict(root, run.experiment_id, run.id, run.status),
    agent_name: await nameFor(run.experiment_id),
  })))
}
