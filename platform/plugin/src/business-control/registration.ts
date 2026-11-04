import { randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { instanceStateRoot, programRoot, workspaceConfigPath } from '../workspace.ts'
import { prepareBusinessRuntimeFile } from './secret-file.ts'
import { validateBusinessGateway } from './configuration.ts'
import { isUnrestrictedBusinessAccess } from './contracts.ts'

export function businessAccessPath(assetRoot: string): string { return workspaceConfigPath(assetRoot, 'business-access.json') }

export async function businessAccess(assetRoot: string, validate = true): Promise<Record<string, unknown> & { gateway: Record<string, unknown> }> {
  const access = JSON.parse(await readFile(businessAccessPath(assetRoot), 'utf8')) as Record<string, unknown>
  const gateway = access.gateway
  if (access.schemaVersion !== 1 || typeof access.enabled !== 'boolean' || !gateway || typeof gateway !== 'object'
    || Array.isArray(gateway) || !Array.isArray((gateway as Record<string, unknown>).instances)) {
    throw new Error(validate ? '业务网关尚未配置，无法创建受控实例' : '业务网关登记配置无效，拒绝删除受控实例')
  }
  if (validate) validateBusinessGateway(gateway)
  return access as Record<string, unknown> & { gateway: Record<string, unknown> }
}

function assertMatchingRegistration(instances: Record<string, unknown>[], input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }, previousSourceDigest?: string): void {
  const existing = instances.find(row => row.instanceId === input.instanceId)
  if (existing && (existing.agentId !== input.agentId || existing.sourceId && existing.sourceId !== input.sourceId
    || existing.sourceDigest && existing.sourceDigest !== input.sourceDigest
      && !(isUnrestrictedBusinessAccess(existing) && previousSourceDigest && existing.sourceDigest === previousSourceDigest)
    || input.accessMode && (existing.accessMode ?? 'authenticated') !== input.accessMode
    || input.identityMode && (existing.identityMode ?? 'published') !== input.identityMode)) throw new Error('业务网关中同名实例的来源、访问方式或实例阶段不一致，拒绝覆盖')
}

export async function preflightGatewayRegistration(assetRoot: string, input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }, remove = false, previousSourceDigest?: string): Promise<void> {
  const access = await businessAccess(assetRoot, !remove)
  assertMatchingRegistration(access.gateway.instances as Record<string, unknown>[], input, previousSourceDigest)
  if (!remove && access.enabled !== true && input.accessMode !== 'anonymous') throw new Error('需要登录的实例尚未启用业务访问')
}

async function acquireGatewayLock(lock: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { return await open(lock, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 600) throw new Error('业务网关配置持续被占用或保存锁未释放；请稍后重试并核对配置锁')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

export async function updateGatewayRegistration(assetRoot: string, input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }, remove = false, previousSourceDigest?: string, beforeCommit?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const path = businessAccessPath(assetRoot), lock = `${path}.lock`, temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await acquireGatewayLock(lock, signal)
  try {
    const access = await businessAccess(assetRoot, !remove)
    const instances = access.gateway.instances as Record<string, unknown>[]
    assertMatchingRegistration(instances, input, previousSourceDigest)
    if (!remove && access.enabled !== true && input.accessMode !== 'anonymous') throw new Error('需要登录的实例尚未启用业务访问')
    const existing = instances.find(row => row.instanceId === input.instanceId)
    const next = remove ? instances.filter(row => row.instanceId !== input.instanceId)
      : [...instances.filter(row => row.instanceId !== input.instanceId), { ...input,
        ...(input.accessMode ? {} : existing?.accessMode ? { accessMode: existing.accessMode } : {}),
        ...(input.identityMode ? {} : existing?.identityMode ? { identityMode: existing.identityMode } : {}) }]
    const changed = JSON.stringify(instances) !== JSON.stringify(next)
    if (changed) {
      access.gateway.instances = next
      await writeFile(temporary, JSON.stringify(access, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      prepareBusinessRuntimeFile(temporary)
    }
    // 删除前持有共享配置锁并准备好新配置，避免并发删除在 DSH 已删除后才发现锁冲突。
    await beforeCommit?.()
    if (changed) await rename(temporary, path)
  } finally { await handle.close(); await rm(lock, { force: true }); await rm(temporary, { force: true }) }
}

export async function deleteBusinessInstance(assetRoot: string, name: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('实例名必须是小写 kebab-case')
  const directory = join(instanceStateRoot(assetRoot), name), path = join(directory, 'instance.json')
  const before = JSON.parse(await readFile(path, 'utf8'))
  const digest = before.business_control?.source_digest
  if (typeof before.agent_id !== 'string' || typeof before.source_id !== 'string' || typeof digest !== 'string') {
    throw new Error('受控实例来源登记不完整，拒绝删除；请先核对实例与网关配置')
  }
  let result: { stdout: string; stderr: string } | undefined
  try {
    await updateGatewayRegistration(assetRoot, { agentId: before.agent_id, instanceId: name,
      sourceId: before.source_id, sourceDigest: digest }, true, undefined, async () => {
      signal?.throwIfAborted()
      // 与 CLI 共用底层容器删除；调用后不再取消，避免中止已开始的 Docker 操作。
      try {
        result = await promisify(execFileCallback)(process.env.HARNESS_PYTHON || 'python3', ['-c',
          'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); _,manifest=m["load_instance"](sys.argv[2]); print(json.dumps(m["delete_instance"](sys.argv[2],manifest),ensure_ascii=False))',
          join(programRoot(), 'runtime/adapters/dsh-container/dsh-dev'), name], {
          cwd: assetRoot, env: { ...process.env, HARNESS_ASSET_ROOT: assetRoot, HARNESS_PROGRAM_ROOT: programRoot() },
          encoding: 'utf8', maxBuffer: 1024 * 1024,
        })
      } catch (error) {
        const failed = error as Error & { stderr?: string; stdout?: string }
        throw new Error(failed.stderr || failed.stdout || failed.message)
      }
    }, signal)
  } catch (error) {
    if (!result) throw error
    // 容器已删除时恢复登记，保留 HOME 并允许同名重试网关清理。
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(path, JSON.stringify(before, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    } catch (recoveryError) {
      throw new Error(`DSH 容器已删除，但网关清理与实例登记恢复未完成；请核对两处登记。${(error as Error).message}；${(recoveryError as Error).message}`)
    }
    throw new Error(`DSH 容器已删除，HOME 与实例登记已保留，可修复网关配置后重试删除。${(error as Error).message}`)
  }
  return result!
}

