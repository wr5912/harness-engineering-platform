import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { programRoot } from '../workspace.ts'
import type { CompositionWorkflow, WorkflowContext } from './extension.ts'
import { freezeLfxBundle, lfxCanvas, lfxDigest, loadLfxBundle, type LfxBundle } from './lfx-assets.ts'

type Invoke = (connection: string, operation: string, args: Record<string, any>, signal: AbortSignal, fingerprint?: string) => Promise<any>
let processState: { process: ChildProcess; url: string; key: string } | undefined
let starting: Promise<NonNullable<typeof processState>> | undefined

async function runtime() {
  if (processState && processState.process.exitCode === null) return processState
  if (starting) return starting
  starting = new Promise<NonNullable<typeof processState>>((resolve, reject) => {
    const root = programRoot(), lock = readFileSync(join(root, 'platform/mcp/lfx/requirements.txt'))
    const python = join(root, '.local/lfx', createHash('sha256').update(lock).digest('hex'), 'bin/python')
    if (!existsSync(python)) return reject(new Error('LFX 运行环境未安装，请通过平台更新工具安装锁定依赖'))
    const key = randomUUID(), child = spawn(python, [join(root, 'platform/mcp/lfx/server.py')], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANGFLOW_API_KEY: key, DO_NOT_TRACK: '1', LANGFLOW_DO_NOT_TRACK: 'true' } })
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
        processState = { process: child, url, key }; resolve(processState)
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
  const cache = new Map<string, Promise<any>>()
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
    try {
      let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 16 * 1024 * 1024) throw new Error('LFX 回调过大') }
      const value = JSON.parse(text)
      let result: any
      if (value.action === 'invoke') {
        if (!Object.values(config.connections ?? {}).includes(value.connection)) throw new Error('LFX 使用了未绑定的连接')
        const key = JSON.stringify([value.connection, value.operation, value.arguments])
        if (!cache.has(key)) cache.set(key, context.call(async () => {
          const call = () => invoke(value.connection, value.operation, value.arguments, context.signal, context.shared?.connection_fingerprints?.[value.connection])
          try { return await call() } catch (error: any) {
            if (!context.signal.aborted && /ECONNRESET|ETIMEDOUT|fetch failed/.test(error.message)) return call()
            throw error
          }
        }))
        result = await cache.get(key)
      } else if (value.action === 'progress') {
        const { node_id, action: _action, ...progress } = value
        context.progress.call({ ...context, nodeId: node_id }, progress)
      } else throw new Error('未知 LFX 回调')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: result ?? null }))
    } catch (error) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'LFX 回调失败' })) }
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
    const response = await fetch(host.url + '/api/v2/workflows', { method: 'POST', headers: { ...headers, 'x-hep-run': runKey },
      body: JSON.stringify({ flow_id: flowId, mode: 'stream', stream_protocol: 'langflow', expose_graph_state: true }), signal: context.signal })
    if (!response.ok) throw new Error(`LFX 流程执行失败（${response.status}）`)
    const outputIds = new Set(bundle.flow.data.nodes.filter((node: any) => node.data.node.is_output).map((node: any) => node.id))
    let pending = '', result: any, ended = false
    for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
      pending += chunk
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        const raw = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)
        if (!raw) continue
        const event = JSON.parse(raw)
        if (event.event === 'error') throw new Error('LFX 流程执行失败，请查看节点进度')
        if (event.event === 'end_vertex') {
          const built = event.data?.build_data
          if (built?.valid === false) throw new Error('LFX 节点执行失败，请查看节点进度')
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
  } finally {
    await Promise.allSettled([api(`/hep/runs/${runKey}`, undefined, 'DELETE', AbortSignal.timeout(3000)), api(`/flows/${flowId}`, undefined, 'DELETE', AbortSignal.timeout(3000))])
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export function lfxWorkflow(root: string, id: string, previous: CompositionWorkflow, invoke: Invoke): CompositionWorkflow {
  return { ...previous,
    native: { digest: config => lfxDigest(loadLfxBundle(root, id, config)), freeze: config => freezeLfxBundle(root, id, config) },
    structure: config => config.engine === 'lfx' ? Promise.resolve(lfxCanvas(loadLfxBundle(root, id, config).flow)) : previous.structure?.(config) ?? Promise.resolve({ nodes: [], edges: [] }),
    prepare: async (input, config, signal) => {
      const bundle = config.engine === 'lfx' ? loadLfxBundle(root, id, config) : undefined
      const snapshot = await previous.prepare?.(input, config, signal)
      return bundle ? { ...snapshot, lfxBundle: bundle } : snapshot
    },
    execute: (input, config, context) => config.engine === 'lfx' ? execute(context.shared.lfxBundle, input, config, context, invoke) : previous.execute!(input, config, context),
  }
}
