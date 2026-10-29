import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkBusinessGatewayEntry, type BusinessEntryCheck } from './plugin/src/business-control/entry.ts'

const execute = promisify(execFile)
export async function checkRunningBusinessEntries(programRoot: string, dataRoot: string): Promise<(BusinessEntryCheck & { name: string })[]> {
  const access = join(dataRoot, 'config/business-access.json')
  if (!existsSync(access) || !JSON.parse(readFileSync(access, 'utf8')).gateway?.instances?.length) return []
  const { stdout } = await execute(join(programRoot, 'runtime/adapters/dsh-container/dsh-dev'), ['ps', '--all'], {
    env: { ...process.env, HARNESS_ASSET_ROOT: dataRoot, HARNESS_PROGRAM_ROOT: programRoot }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })
  const observed = JSON.parse(stdout) as { instances: { name: string; agent_id: string; state: string; business_gateway: boolean }[] }
  return Promise.all(observed.instances.filter(instance => instance.state === 'unknown' || instance.business_gateway && instance.state === 'running').map(async instance => {
    if (instance.state === 'unknown') return { name: instance.name, url: '', ready: false, detail: '容器状态读取失败，无法确认业务入口' }
    try { return { name: instance.name, ...await checkBusinessGatewayEntry(dataRoot, instance.agent_id, instance.name) } }
    catch { return { name: instance.name, url: '', ready: false, detail: '业务入口配置或实例登记无效，请核对当前工作区' } }
  }))
}

export async function reportBusinessReadiness(programRoot: string, dataRoot: string): Promise<void> {
  try {
    const entries = await checkRunningBusinessEntries(programRoot, dataRoot)
    const failed = entries.filter(entry => !entry.ready)
    if (failed.length) console.error(`平台已启动，以下业务实例入口仍不可用：\n${failed.map(entry => `${entry.name}：${entry.detail}`).join('\n')}`)
    else if (entries.length) console.log(`已核对 ${entries.length} 个运行中业务实例的网页入口与接入版本`)
  } catch { console.error('平台已启动，但业务实例入口检查未完成；请执行部署在线核验并检查 Docker 状态') }
}
