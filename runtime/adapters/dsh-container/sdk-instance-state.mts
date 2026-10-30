import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

export type SdkContainerObservation = { state: string; stopped: boolean | null }

/** 只认当前实例的 Compose 归属；查询失败不推断已经停止。 */
export async function observeSdkContainer(name: string, project: string, target: string, ownsGeneration: () => boolean): Promise<SdkContainerObservation> {
  const unknown = { state: 'unknown', stopped: null }
  if (!ownsGeneration()) return unknown
  try {
    const format = '{"name":{{json .Names}},"state":{{json .State}},"config":{{json (.Label "com.docker.compose.project.config_files")}},"working":{{json (.Label "com.docker.compose.project.working_dir")}}}'
    const listed = await promisify(execFile)('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=dsh', '--format', format], { timeout: 12000, maxBuffer: 1024 * 1024 })
    if (!ownsGeneration()) return unknown
    const containers = listed.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (!containers.length) return { state: 'absent', stopped: true }
    if (containers.length !== 1) return unknown
    const container = containers[0]
    if (container.name !== name || typeof container.config !== 'string' || resolve(container.config) !== resolve(join(target, 'compose.yaml'))
      || typeof container.working !== 'string' || resolve(container.working) !== resolve(target)) return unknown
    if (!['running', 'exited', 'dead', 'created', 'restarting', 'paused', 'removing'].includes(container.state)) return unknown
    return { state: container.state, stopped: ['exited', 'dead'].includes(container.state) ? true : false }
  } catch { return unknown }
}

/** 信号和 Compose 退出码均不能替代 SDK 结果与实际容器观察。 */
export function sdkExecutionStatus(stopping: boolean, code: number, result: any, container: SdkContainerObservation): string {
  if (stopping) return container.stopped === true ? 'stopped' : 'unknown'
  if (code === 0 && result?.status === 'completed') return 'completed'
  if (result?.status === 'failed') return 'failed'
  return 'unknown'
}
