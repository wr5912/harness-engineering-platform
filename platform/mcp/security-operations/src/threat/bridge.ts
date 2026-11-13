import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThreatBindings, ThreatServices } from './types.ts'
import { publicErrorText } from '../error.ts'

function decodedTool(value: any): any {
  if (Array.isArray(value?.content)) {
    const text = value.content.find((item: any) => item.type === 'text')?.text
    if (value?.isError || value?.error) return {
      code: 502, data: null,
      message: `MCP 工具返回错误：${publicErrorText(text ?? value.error ?? value.message, '未提供错误详情')}`,
    }
    if (typeof text !== 'string') return { code: 502, data: null, message: 'MCP 工具未返回可解析的文本回执' }
    try { return JSON.parse(text) } catch { return { code: 502, data: null, message: 'MCP 工具返回了文本，但无法解析为结构化回执' } }
  }
  if (value?.isError || value?.error) return {
    code: 502, data: null,
    message: `MCP 工具返回错误：${publicErrorText(value.error ?? value.message, '未提供错误详情')}`,
  }
  return value
}

function socEnvelope(value: any) {
  if (typeof value?.status === 'string' && value.result !== undefined) return value
  const body = decodedTool(value)
  if (typeof body?.status === 'string' && body.result !== undefined) return body
  if (body && typeof body === 'object' && 'code' in body) return {
    status: Number(body.code) === 200 ? 'success' : 'error', status_code: Number(body.code),
    result: { ...body, code: Number(body.code) },
  }
  return { status: 'success', status_code: 200, result: { code: 200, data: body } }
}

export async function createThreatBridge(catalogDir: string, bindings: ThreatBindings, services: ThreatServices, signal: AbortSignal) {
  const tools = new Set<string>()
  for (const file of await readdir(catalogDir)) if (/^\.current-ai_soc_.*-tools\.local\.json$/.test(file)) {
    const document = JSON.parse(await readFile(join(catalogDir, file), 'utf8'))
    const entries = document.items ?? Object.values(document)
    for (const tool of entries) tools.add(tool.name)
  }
  const capability = randomUUID(), key = randomUUID()
  const controller = new AbortController()
  const bridgeSignal = AbortSignal.any([signal, controller.signal])
  const prefix = `/${capability}`
  const server = createServer(async (request, response) => {
    const send = (code: number, value?: any) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(value === undefined ? undefined : JSON.stringify(value)) }
    try {
      if (request.method !== 'POST' || !request.url?.startsWith(prefix + '/')) { send(404, { error: 'not_found' }); return }
      const chunks: Buffer[] = []
      let size = 0
      for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('request_too_large'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const path = request.url.slice(prefix.length)
      if (path === '/runtime/invoke') {
        if (request.headers.authorization !== `Bearer ${key}` || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) { send(403, { error: 'invalid_runtime_request' }); return }
        const report = body.resource === 'report-write' && body.tool === 'save_persistence_result'
        if (!report && (!tools.has(body.tool) || body.tool.split('__')[0] !== body.resource)) { send(422, { error: 'unknown_runtime_tool' }); return }
        const timeout = report || /judgement|judge_pending/.test(body.tool) ? 30_000 : 120_000
        send(200, socEnvelope(await services.invoke(report ? bindings.reportConnectionId : bindings.socConnectionId, body.tool, body.args, AbortSignal.any([bridgeSignal, AbortSignal.timeout(timeout)])))); return
      }
      if (path === '/model/chat/completions') {
        if (request.headers.authorization !== `Bearer ${key}` || body.messages?.length !== 2 || body.messages[0]?.role !== 'system' || body.messages[1]?.role !== 'user') { send(403, { error: 'invalid_frozen_request' }); return }
        send(200, await services.inferFrozen(body, bindings.model, AbortSignal.any([bridgeSignal, AbortSignal.timeout(300_000)]))); return
      }
      send(404, { error: 'not_found' })
    } catch (error: any) {
      send(502, {
        status: 'error', status_code: 502, error: 'platform_upstream_failed',
        message: '平台依赖调用未完成', detail: publicErrorText(error?.message, '上游未提供错误详情'),
      })
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('threat_bridge_unavailable')
  const base = `http://127.0.0.1:${address.port}${prefix}`
  return { key, runtime: `${base}/runtime`, model: `${base}/model`,
    close: () => { controller.abort(); server.closeAllConnections(); server.close() } }
}
