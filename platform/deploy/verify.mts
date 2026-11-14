import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectDataRoot } from './data.mts'
import { managedState, ownsPort } from '../lifecycle.mts'
import { managerWorkspaceRoot, workspaceIdentity } from '../plugin/src/workspace.ts'
import { sha256File, type Manifest } from './manifest.mts'
import { validateBusinessGateway } from '../plugin/src/business-control/configuration.ts'
import { resolveBusinessSecretFile } from '../plugin/src/business-control/secret-file.ts'
import { checkRunningBusinessEntries } from '../business-readiness.mts'
import { managerHome } from '../manager-home.mts'
import { assertImageSource } from './image.mts'

export interface DeploymentCheck {
  id: string
  status: 'ok' | 'missing' | 'mismatch'
  detail: string
}

export interface VerifyOptions {
  prefix: string
  dataRoot: string
  url?: string
}

/** 安装器尚未进入目标运行环境，在线核验必须通过目标的正式入口。 */
export async function verifyInstalledDeployment(options: VerifyOptions): Promise<{ checks: DeploymentCheck[]; onlineVerified: boolean; ok: boolean }> {
  const launcher = join(resolve(options.prefix), 'platform/dsh-deploy')
  try {
    const { stdout } = await promisify(execFile)(launcher, ['verify', '--prefix', resolve(options.prefix),
      '--data-root', resolve(options.dataRoot), ...(options.url ? ['--url', options.url] : []), '--json'], {
      env: { ...process.env, HARNESS_ASSET_ROOT: resolve(options.dataRoot) }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string }
    // verify 的非零退出码也可能带有完整的逐项核验结果。
    if (result.stdout) {
      try {
        const report = JSON.parse(result.stdout)
        if (report.ok === false && Array.isArray(report.checks)) return report
      } catch {}
    }
    throw new Error(`部署核验入口 ${launcher} 执行失败：${result.stderr?.trim() || result.message}`)
  }
}

export async function verifyDeployment(options: VerifyOptions): Promise<{ checks: DeploymentCheck[]; onlineVerified: boolean; ok: boolean }> {
  const prefix = resolve(options.prefix)
  const dataRoot = resolve(options.dataRoot)
  const checks: DeploymentCheck[] = []
  try {
    const manifest = JSON.parse(readFileSync(join(prefix, '.local/installation.json'), 'utf8')) as Manifest
    for (const entry of manifest.files.filter(entry => entry.path.startsWith('program/'))) {
      const path = join(prefix, entry.path.slice(8)), stat = lstatSync(path)
      if (entry.type === 'symlink') {
        if (!stat.isSymbolicLink() || readlinkSync(path) !== entry.target) throw new Error(`程序链接不符：${entry.path}`)
      } else if (!stat.isFile() || sha256File(path) !== entry.sha256 || (entry.mode !== undefined && (stat.mode & 0o777) !== entry.mode)) throw new Error(`程序文件摘要或权限不符：${entry.path}`)
    }
    checks.push({ id: 'program-integrity', status: 'ok', detail: `安装来源 ${manifest.package.commit}` })
    if (manifest.image) {
      try {
        assertImageSource(prefix, manifest.package.arch, manifest.image)
        checks.push({ id: 'standard-runtime-source', status: 'ok', detail: `${manifest.image.tag}，安装后的构建输入与标准镜像一致` })
      } catch (error) { checks.push({ id: 'standard-runtime-source', status: 'mismatch', detail: error instanceof Error ? error.message : String(error) }) }
    }
  } catch (error) { checks.push({ id: 'program-integrity', status: 'mismatch', detail: error instanceof Error ? error.message : '缺少安装清单' }) }
  const data = inspectDataRoot(dataRoot)
  try {
    const access = JSON.parse(readFileSync(join(dataRoot, 'config/business-access.json'), 'utf8'))
    if (access.schemaVersion !== 1 || access.enabled !== true) throw new Error('业务网关未启用；业务实例不能创建为直连实例')
    validateBusinessGateway(access.gateway)
    const published = access.gateway.instances.some((item: { identityMode?: string }) => item.identityMode !== 'development')
    if (published && (!access.gateway.sharedSecretFile || readFileSync(resolveBusinessSecretFile(dataRoot, access.gateway.sharedSecretFile)).length < 32)) throw new Error('已发布实例的业务网关本地共享密钥无效')
    checks.push({ id: 'business-gateway', status: 'ok', detail: `网关配置完整${published ? '，已核对发布签名密钥' : '，开发模式无需签名密钥'}，入口 ${access.gateway.publicOrigin}；监听状态需启动后核对` })
  } catch (error) {
    checks.push({ id: 'business-gateway', status: 'mismatch', detail: error instanceof Error ? error.message : '业务网关配置无效' })
  }
  checks.push({
    id: 'workspace-assets',
    status: data.kind === 'workspace' ? 'ok' : 'missing',
    detail: data.kind === 'workspace' ? `${data.skills} skills, ${data.workspaceId}` : `缺少 ${data.missing.join('、')}`,
  })
  const home = managerHome(dataRoot)
  const profile = join(home, 'profiles', 'harness-platform', 'harness-platform.patch.yml')
  if (!existsSync(profile)) {
    checks.push({ id: 'profile', status: 'missing', detail: profile })
  } else {
    const patch = readFileSync(profile, 'utf8')
    const expected = join(home, '.agents', 'skills')
    checks.push({
      id: 'profile-skills',
      status: patch.includes(expected) ? 'ok' : 'mismatch',
      detail: patch.includes(expected) ? expected : `Profile 未包含 ${expected}`,
    })
  }
  const storage = join(home, 'storages', 'workspace.json')
  if (!existsSync(storage)) {
    checks.push({ id: 'default-workspace', status: 'missing', detail: storage })
  } else {
    const value = JSON.parse(readFileSync(storage, 'utf8')) as any
    // defaultWorkspaceId 仅标记原生首次使用；原生会话绑定管理工作区。
    const expected = managerWorkspaceRoot(dataRoot)
    const ids = value?.global?.workspaceIds
    const path = Array.isArray(ids) && ids.length === 1 ? value?.tables?.workspaces?.[ids[0]]?.path : undefined
    checks.push({
      id: 'default-workspace',
      status: typeof path === 'string' && resolve(path) === expected ? 'ok' : 'mismatch',
      detail: typeof path === 'string' ? path : `原生工作区登记未唯一绑定到 ${expected}`,
    })
  }
  const launcher = join(prefix, 'platform', 'dsh-platform')
  try {
    accessSync(launcher, constants.X_OK)
    const result = spawnSync(launcher, ['start', '--dry-run'], { env: { ...process.env, HARNESS_ASSET_ROOT: dataRoot }, encoding: 'utf8', timeout: 30_000 })
    if (result.status !== 0) throw new Error('启动预检失败；请单独执行 start --dry-run 查看原因')
    const preview = JSON.parse(result.stdout)
    if (preview.mode === 'initialization' || preview.asset_root !== dataRoot || preview.repository !== prefix) throw new Error('启动预检的程序或工作区身份不符')
    checks.push({ id: 'runtime', status: 'ok', detail: `DSH ${preview.dsh_version}，只读启动预检通过` })
  } catch (error) {
    checks.push({ id: 'runtime', status: 'missing', detail: error instanceof Error ? error.message : '启动入口不可执行' })
  }
  if (options.url) {
    try {
      const state = managedState(dataRoot, prefix)
      if (!state || ![state.url, state.publicUrl].includes(new URL(options.url).href) || !ownsPort(state.pid, state.host, state.port)) throw new Error('地址未对应当前程序和数据根的受管监听进程')
      const account = JSON.parse(readFileSync(join(dataRoot, '.local/credentials/admin.json'), 'utf8'))
      const request = { redirect: 'manual' as const, signal: AbortSignal.timeout(10_000) }
      const login = await fetch(new URL('login', options.url), { ...request, method: 'POST', headers: { origin: new URL(options.url).origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: account.username, password: account.password }) })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      if (login.status !== 303 || !cookie) throw new Error('平台密码登录未成功')
      const response = await fetch(new URL('harness-platform/inventory', options.url), { ...request, method: 'POST', headers: { origin: new URL(options.url).origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'deployment-verify', method: 'inventory', payload: {} }) })
      if (response.status !== 200) throw new Error(`清单 RPC 返回 ${response.status}`)
      const inventory = (await response.json() as any)?.result?.value
      const identity = workspaceIdentity(dataRoot)
      if (inventory?.root !== dataRoot || inventory?.workspace?.id !== identity.id || inventory?.workspace?.root !== dataRoot) throw new Error('清单 RPC 的工作区身份不符')
      checks.push({ id: 'online-workspace', status: 'ok', detail: `${identity.id}，PID ${state.pid}，密码登录及 inventory RPC 通过` })
    } catch (error) {
      checks.push({ id: 'online-workspace', status: 'mismatch', detail: error instanceof Error ? error.message : '在线核验失败' })
    }
    try {
      const state = managedState(dataRoot, prefix)
      const access = JSON.parse(readFileSync(join(dataRoot, 'config/business-access.json'), 'utf8'))
      if (!state || checks.find(check => check.id === 'business-gateway')?.status !== 'ok'
        || !ownsPort(state.pid, access.gateway.host, access.gateway.port)) throw new Error('业务网关未由当前平台进程监听，请核对网关配置和启动日志')
      checks.push({ id: 'online-business-gateway', status: 'ok', detail: `PID ${state.pid} 已监听业务网关 ${access.gateway.host}:${access.gateway.port}` })
    } catch (error) {
      checks.push({ id: 'online-business-gateway', status: 'mismatch', detail: error instanceof Error ? error.message : '业务网关监听核验失败' })
    }
    try {
      if (!['online-workspace', 'online-business-gateway'].every(id => checks.find(check => check.id === id)?.status === 'ok')) throw new Error('平台与业务网关归属尚未通过核对，未执行实例入口检查')
      const entries = await checkRunningBusinessEntries(prefix, dataRoot)
      const failed = entries.filter(entry => !entry.ready)
      checks.push({ id: 'online-business-instances', status: failed.length ? 'mismatch' : 'ok',
        detail: failed.length ? failed.map(entry => `${entry.name}：${entry.detail}`).join('；') : `已核对 ${entries.length} 个运行中业务实例的网页入口与接入版本` })
    } catch (error) { checks.push({ id: 'online-business-instances', status: 'mismatch', detail: `运行中业务实例入口检查失败：${error instanceof Error ? error.message : error}` }) }
  }
  return { checks, onlineVerified: Boolean(options.url && ['online-workspace', 'online-business-gateway', 'online-business-instances'].every(id => checks.find(check => check.id === id)?.status === 'ok')), ok: checks.every(check => check.status === 'ok') }
}
