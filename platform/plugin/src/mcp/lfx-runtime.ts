import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { programRoot } from '../workspace.ts'
import type { CompositionWorkflow, WorkflowContext } from './extension.ts'
import { freezeLfxBundle, lfxCanvas, lfxDigest, loadLfxBundle, type LfxBundle } from './lfx-assets.ts'

type Invoke = (connection: string, operation: string, args: Record<string, any>, signal: AbortSignal, fingerprint?: string) => Promise<any>
const moduleDigest = (source: string) => createHash('sha256').update(source).digest('hex')
async function typedWorkflow(bundle: LfxBundle, invoke: Invoke): Promise<CompositionWorkflow | undefined> {
  if (!bundle.typescript) return undefined
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundle.typescript).toString('base64'))
  return module.create(invoke)
}

/** 每个节点独立派发；缓存与重试必须由了解业务语义的组件决定。 */
export function lfxCallbacks(config: any, context: WorkflowContext, invoke: Invoke, components: Record<string, CompositionWorkflow['components']> = {}) {
  return async (value: any) => {
    if (value.action === 'invoke') {
      if (!Object.values(config.connections ?? {}).includes(value.connection)) throw new Error('LFX 使用了未绑定的连接')
      return context.call(() => invoke(value.connection, value.operation, value.arguments, context.signal, context.shared?.connection_fingerprints?.[value.connection]))
    }
    if (value.action === 'component') {
      const module = Object.hasOwn(components, value.module_digest ?? '') && components[value.module_digest]
      const component = module && Object.hasOwn(module, value.name ?? '') && module[value.name]
      if (typeof component !== 'function' || typeof value.node_id !== 'string') throw new Error('LFX TypeScript 组件未登记在当前冻结包中')
      return component(value.input, config, { ...context, nodeId: value.node_id })
    }
    if (value.action === 'progress') {
      const { node_id, action: _action, ...progress } = value
      context.progress.call({ ...context, nodeId: node_id }, progress)
      return
    }
    throw new Error('未知 LFX 回调')
  }
}
let processState: { process: ChildProcess; url: string; key: string } | undefined
let starting: Promise<NonNullable<typeof processState>> | undefined

async function runtime() {
  if (processState && processState.process.exitCode === null) return processState
  if (starting) return starting
  starting = new Promise<NonNullable<typeof processState>>((resolve, reject) => {
    const standalone = process.env.STANDALONE_ROOT
    const directory = standalone ? join(standalone, 'runtime/lfx') : join(programRoot(), 'platform/mcp/lfx')
    const lock = readFileSync(join(directory, 'requirements.txt'))
    const python = standalone ? join(directory, 'python3') : join(programRoot(), '.local/lfx', createHash('sha256').update(lock).digest('hex'), 'bin/python')
    if (!standalone && !existsSync(python)) return reject(new Error('LFX 运行环境未安装，请通过平台更新工具安装锁定依赖'))
    const key = randomUUID(), child = spawn(python, [join(directory, 'server.py')], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(standalone ? { PYTHONPATH: [join(directory, 'site-packages'), process.env.PYTHONPATH].filter(Boolean).join(':') } : {}), LANGFLOW_API_KEY: key, DO_NOT_TRACK: '1', LANGFLOW_DO_NOT_TRACK: 'true' } })
    const timer = setTimeout(() => { child.kill(); reject(new Error('LFX 启动超时')) }, 60_000)
    child.stderr?.resume() // 第三方错误正文可能包含参数，不进入普通日志。
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', async line => {
      try {
        const ready = JSON.parse(line)
        if (!Number.isInteger(ready.port)) return
        const url = `http://127.0.0.1:${ready.port}`
        for (let attempt = 0; attempt < 100; attempt++) {
          try { if ((await fetch(url + '/health')).ok) break } catch {}
          await new Promise(resolve => setTimeout(resolve, 50))
          if (attempt === 99) throw new Error('LFX 尚未就绪')
        }
        clearTimeout(timer)
        processState = { process: child, url, key }
        child.unref(); (child.stdout as any)?.unref?.(); (child.stderr as any)?.unref?.()
        resolve(processState)
      } catch { /* 仅识别启动回执。 */ }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); if (processState?.process === child) processState = undefined; reject(new Error('LFX 进程已退出')) })
    process.once('exit', () => child.kill())
  }).finally(() => { starting = undefined })
  return starting
}

async function execute(bundle: LfxBundle, input: any, config: any, context: WorkflowContext, invoke: Invoke) {
  const host = await runtime(), token = randomUUID(), runKey = randomUUID(), flowId = randomUUID()
  const components: Record<string, CompositionWorkflow['components']> = {}
  async function register(current: LfxBundle) {
    if (current.typescript) components[moduleDigest(current.typescript)] = (await typedWorkflow(current, invoke))?.components
    for (const child of Object.values(current.children)) await register(child)
  }
  await register(bundle)
  const callback = lfxCallbacks(config, context, invoke, components)
  let callbackError: string | undefined
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
    try {
      let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 16 * 1024 * 1024) throw new Error('LFX 回调过大') }
      const value = JSON.parse(text)
      const result = await callback(value)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: result ?? null }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LFX 回调失败'
      callbackError ??= message
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const headers = { 'content-type': 'application/json', 'x-api-key': host.key }
  const api = async (path: string, body?: any, method = 'POST', signal = context.signal) => {
    const response = await fetch(host.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
    if (!response.ok) throw new Error(`LFX 请求失败（${response.status}）`)
    return response.status === 204 ? null : response.json()
  }
  try {
    await api(`/hep/runs/${runKey}`, { bundle, input, shared: { ...context.shared, lfxBundle: undefined }, config, callback: `http://127.0.0.1:${port}`, token })
    await api('/flows/upload/', { name: config.title, id: flowId, data: bundle.flow.data })
    // 长节点可能数分钟没有 SSE 帧；由工作流 signal 控制时限，避免 fetch 的响应体空闲超时。
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const call = request(host.url + '/api/v2/workflows', { method: 'POST', headers: { ...headers, 'x-hep-run': runKey }, signal: context.signal }, resolve)
      call.once('error', reject)
      call.end(JSON.stringify({ flow_id: flowId, mode: 'stream', stream_protocol: 'langflow', expose_graph_state: true }))
    })
    if (response.statusCode !== 200) { response.resume(); throw new Error(`LFX 流程执行失败（${response.statusCode}）`) }
    response.setEncoding('utf8')
    const outputIds = new Set(bundle.flow.data.nodes.filter((node: any) => node.data.node.is_output).map((node: any) => node.id))
    let pending = '', result: any, ended = false
    for await (const chunk of response) {
      pending += chunk
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        const raw = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)
        if (!raw) continue
        const event = JSON.parse(raw)
        if (event.event === 'error') throw new Error(callbackError ?? 'LFX 流程执行失败，请查看节点进度')
        if (event.event === 'end_vertex') {
          const built = event.data?.build_data
          if (built?.valid === false) throw new Error(callbackError ?? 'LFX 节点执行失败，请查看节点进度')
          if (outputIds.has(built?.id)) {
            const values = Object.values(built.data?.artifacts ?? {}) as any[]
            result = values.find(value => value && Object.hasOwn(value, 'raw'))?.raw
          }
        }
        if (event.event === 'end') ended = true
      }
    }
    if (ended && result && typeof result === 'object') return result
    throw new Error('LFX 未返回结构化输出')
  } catch (error) {
    context.signal.throwIfAborted()
    throw error
  } finally {
    await Promise.allSettled([api(`/hep/runs/${runKey}`, undefined, 'DELETE', AbortSignal.timeout(3000)), api(`/flows/${flowId}`, undefined, 'DELETE', AbortSignal.timeout(3000))])
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export function lfxWorkflow(root: string, id: string, previous: CompositionWorkflow, invoke: Invoke): CompositionWorkflow {
  return { ...previous,
    native: { digest: config => lfxDigest(loadLfxBundle(root, id, config)), freeze: config => freezeLfxBundle(root, id, config) },
    structure: config => config.engine === 'lfx' ? Promise.resolve(lfxCanvas(loadLfxBundle(root, id, config).flow)) : previous.structure?.(config) ?? Promise.resolve({ nodes: [], edges: [] }),
    prepare: async (input, config, signal, context) => {
      const bundle = config.engine === 'lfx' ? loadLfxBundle(root, id, config) : undefined
      const workflow = bundle && await typedWorkflow(bundle, invoke) || previous
      const snapshot = await workflow.prepare?.(input, config, signal, context)
      return bundle ? { ...snapshot, asset_root: root, lfxBundle: bundle } : snapshot
    },
    execute: (input, config, context) => config.engine === 'lfx' ? execute(context.shared.lfxBundle, input, config, context, invoke) : previous.execute!(input, config, context),
  }
}

/** 独立运行只导入已发布字节，不重新编译或读取工作区草稿。 */
export async function frozenLfxWorkflow(root: string, config: any, invoke: Invoke): Promise<CompositionWorkflow> {
  if (config.engine !== 'lfx' || !config.flowDigest) throw new Error('独立运行需要已冻结的 LFX 发布版本')
  const bundle = loadLfxBundle(root, config.workflow, config), workflow = await typedWorkflow(bundle, invoke)
  if (!workflow) throw new Error('冻结 LFX 编排缺少独立运行合同')
  return lfxWorkflow(root, config.workflow, { ...workflow, sourceDigest: lfxDigest(bundle) }, invoke)
}
