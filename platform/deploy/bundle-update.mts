import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { managedState, ownsPort } from '../lifecycle.mts'
import { inspectBundle, install, type InstallOptions, type InstallReport } from './install.mts'
import { activationSnapshot } from './remote-update.mts'
import { readUpdateActivity } from './update.mts'
import { verifyDeployment } from './verify.mts'
import { prepareDeploymentFirewall } from './firewall.mts'

/** 完整快照替换业务资产；现场配置与原生运行状态从备份恢复。 */
export async function updateBundle(options: InstallOptions): Promise<InstallReport> {
  const { manifest, report } = inspectBundle(options, true)
  const { prefix, dataRoot } = report
  if (!manifest.data) throw new Error('全量更新需要同时包含程序和数据仓库')
  for (const path of [prefix, dataRoot]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) throw new Error(`更新目标必须是已有的独立真实目录：${path}`)
  }
  if (!existsSync(join(prefix, '.local/installation.json'))) throw new Error('目标缺少安装来源清单；请指定原安装目录')
  const workspace = JSON.parse(readFileSync(join(dataRoot, 'workspace.json'), 'utf8'))
  if (typeof workspace.id !== 'string' || !workspace.id) throw new Error('目标工作区身份无效，未更新')
  const state = managedState(dataRoot, prefix)
  if (state && !ownsPort(state.pid, state.host, state.port)) throw new Error('目标受管进程尚未就绪，未更新')
  if (state && !options.start) throw new Error('目标平台正在运行；请使用 --update --start，或先通过平台启动器停止')
  if (options.start && options.skipPrepare) throw new Error('--update --start 不能跳过离线 prepare')
  const before = state ? await activationSnapshot({ prefix, dataRoot }) : undefined
  if (state) {
    const busy = await readUpdateActivity({ programRoot: prefix, dataRoot }, state, workspace.id)
    if (busy.length) throw new Error(`目标存在在途任务，未更新：${JSON.stringify(busy)}`)
  }
  const suffix = `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  report.backups = { prefix: prefix + suffix, dataRoot: dataRoot + suffix }
  if (options.dryRun) return report
  const lock = prefix + '.update-lock'
  mkdirSync(lock, { mode: 0o700 })
  const moved: Array<{ path: string; backup: string; mode: number }> = []
  const command = (args: string[]) => {
    const result = spawnSync(join(prefix, 'platform/dsh-platform'), args, {
      cwd: prefix, stdio: 'inherit', env: { ...process.env, HARNESS_PROGRAM_ROOT: prefix, HARNESS_ASSET_ROOT: dataRoot },
    })
    if (result.error || result.status !== 0) throw new Error(`平台 ${args[0]} 失败（退出码 ${result.status}）`)
  }
  const address = options.host ? ['--host', options.host, '--port', String(options.port), ...(options.publicUrl ? ['--public-url', options.publicUrl] : [])]
    : state ? ['--host', state.host, '--port', String(state.port), '--public-url', state.publicUrl ?? state.url] : []
  let stopped = false
  let installing = false
  try {
    if (state) {
      const busy = await readUpdateActivity({ programRoot: prefix, dataRoot }, state, workspace.id)
      if (busy.length) throw new Error('目标刚启动了新任务，未更新')
      command(['stop']); stopped = true
    }
    for (const path of [prefix, dataRoot]) {
      const mode = lstatSync(path).mode & 0o777, backup = path + suffix
      renameSync(path, backup); moved.push({ path, backup, mode }); chmodSync(backup, 0o700)
    }
    installing = true
    const installed = install({ ...options, start: false, preserveFrom: report.backups })
    if (options.start) {
      if (options.host) {
        const accessPath = join(dataRoot, 'config/business-access.json')
        const access = existsSync(accessPath) ? JSON.parse(readFileSync(accessPath, 'utf8')) : undefined
        installed.warnings.push(prepareDeploymentFirewall(options.host, [options.port,
          ...(access?.enabled === true && access.gateway ? [access.gateway.port] : [])]))
      }
      command(['start', ...address])
      const current = managedState(dataRoot, prefix)
      if (!current) throw new Error('更新后平台没有受管进程')
      await readUpdateActivity({ programRoot: prefix, dataRoot }, current, workspace.id)
      const after = await activationSnapshot({ prefix, dataRoot })
      if (before?.sessions.some(id => !after.sessions.includes(id))) throw new Error('更新后管理会话清单不完整')
      const verified = await verifyDeployment({ prefix, dataRoot, url: after.state.url })
      if (!verified.ok) throw new Error(`更新后部署核对失败：${JSON.stringify(verified.checks.filter(item => item.status !== 'ok'))}`)
    }
    return { ...installed, status: 'updated', backups: report.backups }
  } catch (error) {
    try {
      if (installing) {
        if (managedState(dataRoot, prefix)) command(['stop'])
        for (const entry of moved) rmSync(entry.path, { recursive: true, force: true })
      }
      for (const entry of moved.reverse()) { renameSync(entry.backup, entry.path); chmodSync(entry.path, entry.mode) }
      if (stopped) {
        command(['start', '--host', state!.host, '--port', String(state!.port), '--public-url', state!.publicUrl ?? state!.url])
        const restored = await activationSnapshot({ prefix, dataRoot })
        if (before?.sessions.some(id => !restored.sessions.includes(id))) throw new Error('恢复后管理会话清单不完整')
      }
    } catch (recovery) {
      throw new Error(`更新失败：${error instanceof Error ? error.message : error}；自动恢复未完成：${recovery instanceof Error ? recovery.message : recovery}；备份位置：${JSON.stringify(report.backups)}`)
    }
    throw new Error(`更新失败，已恢复原安装：${error instanceof Error ? error.message : error}`)
  } finally { rmSync(lock, { recursive: true, force: true }) }
}
