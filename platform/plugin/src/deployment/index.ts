import { VERSION_ID } from '../version-id.ts'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { programRoot, workspaceLocalPath } from '../workspace.ts'

type State = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
type Job = { id: string, agent_id: string, experiment_id: string, arch: string, mode: string, state: State, created_at: string, updated_at: string, progress?: unknown, error?: string, size?: number, sha256?: string, archive?: string, request_sha256?: string }
const selection = z.object({ agent_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), experiment_id: z.string().regex(VERSION_ID), arch: z.enum(['amd64', 'arm64']).default(process.arch === 'arm64' ? 'arm64' : 'amd64'), mode: z.enum(['online', 'offline']).default('online'), expected_candidate_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), request_id: z.string().uuid().optional(), knowledge_sources: z.array(z.object({ url: z.url(), path: z.string().min(1) }).strict()).max(100).optional() }).strict()
const identity = z.object({ job_id: z.string().uuid() }).strict()
export interface DeploymentServices {
  seed(input: { agent_id: string; experiment_id: string }, signal: AbortSignal): Promise<{ seed: Record<string, any>; notices?: string[] }>
  notify?(): void
}

/** 耗时扫描、复制与归档在独立进程执行；IPC传递凭据，状态回执只保留公开信息。 */
export function createDeployments(assetRoot: string, services: DeploymentServices) {
  const root = workspaceLocalPath(assetRoot, 'artifacts', 'agent-deployments')
  const active = new Map<string, AbortController>()
  const pending = new Set<Promise<void>>()
  const accepting = new Map<string, { hash: string; promise: Promise<any> }>()
  const statePath = (id: string) => join(root, id, 'state.json')
  const safe = (message: unknown, seed: Record<string, any>) => {
    let text = typeof message === 'string' ? message : '导出未能完成'
    const secrets = Object.values(seed.environment ?? {}).filter((v): v is string => typeof v === 'string' && v.length > 3)
    const visit = (value: any) => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) {
      if (key === 'headers' && item && typeof item === 'object') for (const header of Object.values(item)) { const secret = typeof header === 'string' ? header : (header as any)?.value; if (typeof secret === 'string' && secret.length > 3) secrets.push(secret) }
      if (typeof item === 'string' && /key|password|token|authorization|secret/i.test(key) && item.length > 3) secrets.push(item); else visit(item)
    } }
    visit(seed.mcp)
    for (const secret of secrets.sort((a,b) => b.length-a.length)) text = text.split(secret).join('[已隐藏]')
    return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]').slice(0, 2000)
  }
  const save = async (job: Job) => { await mkdir(join(root, job.id), { recursive: true }); const tmp = `${statePath(job.id)}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(job), { mode: 0o600 }); await rename(tmp, statePath(job.id)); services.notify?.() }
  async function load(id: string): Promise<Job> {
    let job: Job
    try { job = JSON.parse(await readFile(statePath(id), 'utf8')) }
    catch { throw new Error('导出任务不存在') }
    if (job.state === 'running' && !active.has(id)) { job = { ...job, state: 'interrupted', updated_at: new Date().toISOString(), error: '原导出进程已中断；未生成可下载的完整安装包，请重新导出。' }; await save(job) }
    return job
  }
  function execute(command: 'preview' | 'pack', input: Record<string, any>, signal: AbortSignal, progress?: (value: unknown) => void): Promise<any> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const source = import.meta.url.endsWith('.ts') ? './worker.ts' : './agent-deployment-worker.js'
      const child = fork(fileURLToPath(new URL(source, import.meta.url)), [], { execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      let settled = false
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch {} } }
      const abort = () => { stop(); cleanupTimer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 3000); cleanupTimer.unref() }
      const finish = (error?: unknown, value?: any) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); if (cleanupTimer) clearTimeout(cleanupTimer); error ? reject(error) : resolve(value) }
      signal.addEventListener('abort', abort, { once: true })
      child.on('message', (message: any) => { if (message?.type === 'progress') progress?.(message.progress); else if (message?.type === 'result') finish(undefined, message.result); else if (message?.type === 'error') finish(new Error(safe(message.message, input.seed ?? {}))) })
      child.once('error', () => finish(new Error('无法启动导出进程，请检查当前 Node 运行环境')))
      child.once('exit', code => finish(new Error(signal.aborted ? '导出已取消' : `导出进程未完成（${code ?? '信号中断'}），请检查运行资源并重试`)))
      child.send({ type: 'run', command, input })
      if (signal.aborted) abort()
    })
  }
  function inputOf(value: z.infer<typeof selection>, seed: Record<string, any>, out: string) {
    const program = programRoot()
    return { programRoot: program, assetRoot, agentId: value.agent_id, experimentId: value.experiment_id, arch: value.arch, mode: value.mode, expectedCandidateSha256: value.expected_candidate_sha256, knowledgeSources: value.knowledge_sources, out, seed }
  }
  const publicJob = (job: Job) => ({ ...job, archive: undefined, ...(job.state === 'completed' ? { download: `api/harness-platform/agent-deployments/download?job_id=${job.id}` } : {}) })
  const requestDigest = (selected: z.infer<typeof selection>) => createHash('sha256').update(JSON.stringify({ ...selected, request_id: undefined })).digest('hex')
  async function acceptExport(selected: z.infer<typeof selection>, id: string, signal: AbortSignal) {
    const requestHash = requestDigest(selected)
    if (existsSync(statePath(id))) {
      const previous = await load(id)
      if (previous.request_sha256 !== requestHash) throw new Error('本次导出身份已用于另一组选项，请重新检查后发起新导出')
      return publicJob(previous)
    }
    const { seed } = await services.seed(selected, signal)
    const controller = new AbortController(), now = new Date().toISOString()
    const job: Job = { id, request_sha256: requestHash, agent_id: selected.agent_id, experiment_id: selected.experiment_id, arch: selected.arch, mode: selected.mode, state: 'running', created_at: now, updated_at: now }
    active.set(id, controller)
    try { await save(job) } catch (error) { active.delete(id); throw error }
    // 请求结束不取消已接受的导出；用户通过明确的取消操作终止。
    let progressWrite = Promise.resolve()
    const task = execute('pack', inputOf(selected, seed, join(root, id)), controller.signal, progress => {
      job.progress = typeof progress === 'string' ? safe(progress, seed) : { ...(progress && typeof progress === 'object' ? progress : {}), message: safe((progress as any)?.message, seed) }; job.updated_at = new Date().toISOString()
      progressWrite = progressWrite.then(() => save({ ...job })).catch(() => {})
    }).then(async result => {
      await progressWrite
      if (controller.signal.aborted) throw new Error('导出已取消')
      job.state = 'completed'; job.archive = result.archive; job.size = result.size; job.sha256 = result.sha256
    }).catch(async error => { await progressWrite; job.state = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = safe(error instanceof Error ? error.message : error, seed) })
      .finally(async () => { job.updated_at = new Date().toISOString(); try { await save(job) } finally { active.delete(id) } })
      .finally(() => { pending.delete(task) }).catch(() => {})
    pending.add(task)
    return publicJob(job)
  }
  const handler: ConnectionRpcHandler = async (action, payload, signal) => {
    try {
      if (action === 'status' || action === 'cancel') {
        const { job_id } = identity.parse(payload)
        if (action === 'cancel') active.get(job_id)?.abort()
        const job = await load(job_id)
        return { ok: true, value: publicJob(job) }
      }
      if (action !== 'preview' && action !== 'export') throw new Error('未知的安装包操作')
      const selected = selection.parse(payload)
      if (action === 'preview') {
        const { seed, notices = [] } = await services.seed(selected, signal)
        const preview = await execute('preview', inputOf(selected, seed, root), signal)
        const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64'
        return { ok: true, value: { ...preview, notices, hostArch, canPrepareResources: selected.arch === hostArch && preview.issues.every((issue: any) => issue.code === 'resources_missing') } }
      }
      if (!selected.expected_candidate_sha256) throw new Error('请先检查当前版本，再生成安装包')
      const id = selected.request_id ?? randomUUID()
      const hash = requestDigest(selected)
      let request = accepting.get(id)
      if (request && request.hash !== hash) throw new Error('本次导出身份已用于另一组选项，请重新检查后发起新导出')
      if (!request) {
        const promise = acceptExport(selected, id, signal)
        request = { hash, promise }
        accepting.set(id, request)
        void promise.finally(() => { if (accepting.get(id)?.promise === promise) accepting.delete(id) }).catch(() => {})
      }
      return { ok: true, value: await request.promise }
    } catch (error) { return { ok: false, error: { code: 'deployment_failed', message: error instanceof z.ZodError ? '安装包参数无效，请重新检查所选智能体、版本和架构。' : error instanceof Error ? error.message : '安装包操作失败', details: {} } } }
  }
  async function download(request: Request): Promise<Response> {
    try {
      const { job_id } = identity.parse({ job_id: new URL(request.url).searchParams.get('job_id') })
      const job = await load(job_id)
      if (job.state !== 'completed' || !job.archive) throw new Error('安装包尚未完整生成，请核对导出状态')
      if (!job.archive.startsWith(join(root, job_id) + '/') || !existsSync(job.archive)) throw new Error('安装包文件不可用，请重新导出')
      const info = await stat(job.archive)
      return new Response(Readable.toWeb(createReadStream(job.archive)) as ReadableStream, { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${basename(job.archive).replace(/[^a-zA-Z0-9._-]/g, '_')}"`, 'content-length': String(info.size), 'cache-control': 'no-store' } })
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '安装包下载失败' }, { status: 409, headers: { 'cache-control': 'no-store' } }) }
  }
  return { handler, download, async dispose() { for (const controller of active.values()) controller.abort(); await Promise.allSettled([...pending]); } }
}
