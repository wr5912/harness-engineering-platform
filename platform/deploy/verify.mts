import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { inspectDataRoot } from './data.mts'
import { managedState, ownsPort } from '../lifecycle.mts'
import { workspaceIdentity } from '../plugin/src/workspace.ts'
import { sha256File, type Manifest } from './manifest.mts'
import { validateBusinessGateway } from '../plugin/src/business-control/configuration.ts'
import { resolveBusinessSecretFile } from '../plugin/src/business-control/secret-file.ts'

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
  const profile = join(dataRoot, '.local', 'platform-home', 'profiles', 'harness-platform', 'harness-platform.patch.yml')
  if (!existsSync(profile)) {
    checks.push({ id: 'profile', status: 'missing', detail: profile })
  } else {
    const patch = readFileSync(profile, 'utf8')
    const expected = join(dataRoot, '.agents', 'skills')
    checks.push({
      id: 'profile-skills',
      status: patch.includes(expected) ? 'ok' : 'mismatch',
      detail: patch.includes(expected) ? expected : `Profile 未包含 ${expected}`,
    })
  }
  const storage = join(dataRoot, '.local', 'platform-home', 'storages', 'workspace.json')
  if (!existsSync(storage)) {
    checks.push({ id: 'default-workspace', status: 'missing', detail: storage })
  } else {
    const value = JSON.parse(readFileSync(storage, 'utf8')) as any
    // defaultWorkspaceId 仅标记原生首次使用；平台通过 registry.create 绑定唯一数据工作区。
    const ids = value?.global?.workspaceIds
    const path = Array.isArray(ids) && ids.length === 1 ? value?.tables?.workspaces?.[ids[0]]?.path : undefined
    checks.push({
      id: 'default-workspace',
      status: typeof path === 'string' && resolve(path) === dataRoot ? 'ok' : 'mismatch',
      detail: typeof path === 'string' ? path : `原生工作区登记未唯一绑定到 ${dataRoot}`,
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
      if (!state || new URL(options.url).href !== state.url || !ownsPort(state.pid, state.host, state.port)) throw new Error('地址未对应当前程序和数据根的受管监听进程')
      const account = JSON.parse(readFileSync(join(dataRoot, '.local/credentials/admin.json'), 'utf8'))
      const request = { redirect: 'manual' as const, signal: AbortSignal.timeout(10_000) }
      const login = await fetch(new URL('login', state.url), { ...request, method: 'POST', headers: { origin: new URL(state.url).origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: account.username, password: account.password }) })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      if (login.status !== 303 || !cookie) throw new Error('平台密码登录未成功')
      const response = await fetch(new URL('harness-platform/inventory', state.url), { ...request, method: 'POST', headers: { origin: new URL(state.url).origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'deployment-verify', method: 'inventory', payload: {} }) })
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
  }
  return { checks, onlineVerified: Boolean(options.url && ['online-workspace', 'online-business-gateway'].every(id => checks.find(check => check.id === id)?.status === 'ok')), ok: checks.every(check => check.status === 'ok') }
}
