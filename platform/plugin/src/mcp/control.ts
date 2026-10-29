import { getBusinessControl, currentBusinessContext, withBusinessContext } from '../business-control/core.ts'
import type { BusinessOperation } from '../business-control/contracts.ts'
import { registerBusinessReport } from '../business-control/reports.ts'
import { limitedText } from './openapi.ts'

export type ManagedDispatch = {
  <T>(operation: BusinessOperation, dispatch: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  requestHeaders?(target: string): Record<string, string>
}

/** 所有出站分支共用同一授权服务；调用描述必须来自服务端解析后的实际目标。 */
export function managedDispatch(assetRoot: string): ManagedDispatch {
  const control = getBusinessControl(assetRoot)
  const execute: ManagedDispatch = async (operation, dispatch, signal) => {
    const actual = { ...operation, kind: control.operationKind(operation.serverId, operation.operationId, operation.kind) }
    return control.execute(actual, async executionSignal => {
      const result = await dispatch(executionSignal)
      const context = currentBusinessContext()
      if (actual.kind !== 'publish' || !context || control.isManagement(context) || !control.enabled()) return result
      const rewrite = (value: any): any => {
        if (Array.isArray(value)) return value.map(rewrite)
        if (!value || typeof value !== 'object') return value
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
          if (/^(download_?url|report_?url|report_?download_?url)$/i.test(key) && typeof item === 'string') {
            return [key, registerBusinessReport(assetRoot, context, new URL(item, actual.target).href,
              new URL(actual.target).origin, { serverId: actual.serverId, operation: actual })]
          }
          if (key === 'text' && typeof item === 'string') {
            let parsed: unknown
            try { parsed = JSON.parse(item) } catch { return [key, item] }
            return [key, JSON.stringify(rewrite(parsed))]
          }
          return [key, rewrite(item)]
        }))
      }
      if (result instanceof Response && result.ok && result.headers.get('content-type')?.includes('json')) {
        const text = await limitedText(result.clone(), 1024 * 1024)
        const headers = new Headers(result.headers); headers.delete('content-length')
        return new Response(JSON.stringify(rewrite(JSON.parse(text))), { status: result.status, headers }) as Awaited<typeof result>
      }
      return rewrite(result)
    }, signal)
  }
  execute.requestHeaders = (target): Record<string, string> => {
    const context = currentBusinessContext(), provider = control.config().riskAssessment
    // 明确配置的验收 fixture 只向同来源模拟服务附加观察标签；标签没有授权效力。
    if (!context || control.isManagement(context) || !provider?.testRunId
      || new URL(target).origin !== new URL(provider.endpoint).origin) return {}
    return { 'X-Test-Run-Id': provider.testRunId, 'X-Control-Subject-Id': context.subject.id }
  }
  return execute
}

/** 管理 HTTP/RPC 已经由平台认证；已有业务上下文不得被管理身份覆盖。 */
export function managementDispatch<T>(assetRoot: string, dispatch: () => Promise<T>): Promise<T> {
  const control = getBusinessControl(assetRoot)
  return currentBusinessContext() ? dispatch() : withBusinessContext(control.managementContext(), dispatch)
}

export function managedServer(assetRoot: string, server: any, current?: () => any): any {
  const execute = managedDispatch(assetRoot)
  const identity = (value: any) => JSON.stringify(value, (key, item) => key.startsWith('platform') ? undefined : item)
  const expected = identity(server)
  return { ...server, platformRequestHeaders: execute.requestHeaders,
    platformExecute: (operation: BusinessOperation, dispatch: (signal: AbortSignal) => Promise<any>, signal?: AbortSignal) =>
    execute(operation, controlledSignal => {
      if (current) {
        const latest = current()
        if (!latest || latest.enabled === false || identity(latest) !== expected) throw new Error('MCP 当前连接或工具范围已变化')
      }
      return dispatch(controlledSignal)
    }, signal) }
}
