import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BUSINESS_TRANSPORT_HEADER, BUSINESS_TRANSPORT_VERSION } from './contracts.ts'
import { resolveBusinessInstance } from './instance.ts'

/** CLI 与实例管理共用同一业务公开入口合同。 */
export function businessGatewayEntry(assetRoot: string, agentId: string, instanceId: string): string {
  const access = JSON.parse(readFileSync(join(assetRoot, 'config/business-access.json'), 'utf8'))
  const gateway = access.gateway
  const selected = gateway?.instances?.find((value: { agentId: string; instanceId: string }) => value.agentId === agentId && value.instanceId === instanceId)
  if (access.enabled !== true || !selected) throw new Error('实例未向业务网关开放')
  resolveBusinessInstance(assetRoot, selected)
  const origin = new URL(gateway.publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('业务网关公开来源无效')
  return `${origin.origin}/agents/${agentId}/instances/${instanceId}/`
}

export interface BusinessEntryCheck {
  url: string; ready: boolean; detail: string; httpStatus?: number; runtimeVersion?: string
}

/** 不使用系统代理、不跟随重定向；只核验 HTTP 入口，浏览器交互另行验收。 */
function entryResponse(url: string): Promise<{ status: number; type: string; version?: string }> {
  return new Promise((resolve, reject) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5000),
    }, response => {
      const header = response.headers[BUSINESS_TRANSPORT_HEADER]
      resolve({ status: response.statusCode!, type: String(response.headers['content-type'] || ''),
        version: Array.isArray(header) ? header[0] : header })
      response.destroy()
    })
    request.on('error', reject)
    request.end()
  })
}

export async function checkBusinessGatewayEntry(assetRoot: string, agentId: string, instanceId: string): Promise<BusinessEntryCheck> {
  const url = businessGatewayEntry(assetRoot, agentId, instanceId)
  const access = JSON.parse(readFileSync(join(assetRoot, 'config/business-access.json'), 'utf8'))
  const selected = access.gateway.instances.find((item: { agentId: string; instanceId: string }) => item.agentId === agentId && item.instanceId === instanceId)
  let stage = '业务网关'
  try {
    const entry = await entryResponse(url)
    const anonymous = selected.accessMode === 'anonymous'
    if (entry.status !== (anonymous ? 200 : 401)) {
      // 网关自身也可能拒绝请求；缺少响应头时核对 Runtime，避免误报为未重载。
      let version = entry.version
      if (entry.status === 403 && !version) {
        try { version = (await entryResponse(`${resolveBusinessInstance(assetRoot, selected).origin}${new URL(url).pathname}`)).version }
        catch { /* 保留已经收到的网关 HTTP 错误。 */ }
      }
      const reload = entry.status === 403 && version !== BUSINESS_TRANSPORT_VERSION
        ? `；Runtime 接入版本${version ? `为 ${version}` : '未报告'}，当前需要 ${BUSINESS_TRANSPORT_VERSION}，请重载该实例后重试` : ''
      return { url, ready: false, httpStatus: entry.status, runtimeVersion: version,
        detail: `业务网关入口返回 HTTP ${entry.status}，预期${anonymous ? '无需认证的网页 HTTP 200' : '登录前 HTTP 401'}${reload}` }
    }
    if (anonymous && !/^text\/html(?:;|$)/i.test(entry.type)) return { url, ready: false, httpStatus: entry.status, detail: '业务网关入口未返回 HTML 网页，请检查实例 Web 配置' }
    // 登录前的 401 由网关生成，另查受控内部地址才能确认 Runtime 实际装载版本。
    stage = '业务 Runtime'
    const runtime = anonymous ? entry : await entryResponse(`${resolveBusinessInstance(assetRoot, selected).origin}${new URL(url).pathname}`)
    if (runtime.version !== BUSINESS_TRANSPORT_VERSION) return { url, ready: false, httpStatus: runtime.status, runtimeVersion: runtime.version,
      detail: `Runtime 接入版本${runtime.version ? `为 ${runtime.version}` : '未报告'}，当前需要 ${BUSINESS_TRANSPORT_VERSION}；请重载该实例后重试` }
    return { url, ready: true, httpStatus: entry.status, runtimeVersion: runtime.version, detail: anonymous ? '无需认证的网页入口可用' : '登录入口及 Runtime 接入版本已核对' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { url, ready: false, detail: `${stage}${code === 'ABORT_ERR' ? '检查超时' : code === 'ECONNREFUSED' ? '连接被拒绝' : '连接失败'}；请检查监听状态和启动日志` }
  }
}
