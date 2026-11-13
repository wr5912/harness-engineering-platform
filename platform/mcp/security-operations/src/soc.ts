import { createHash } from 'node:crypto'
import { dependencyError } from './error.ts'
import { fromJSONSchema } from 'zod'
type Dispatch = (request: Record<string, any>, signal?: AbortSignal) => Promise<{ status: number; value: any }>

/** 参数与认证仍由平台原生连接处理，只缓存同一接口规格的发现结果。 */
export function createSoc(dispatch: Dispatch, servers: () => any[]) {
  const catalogs = new Map<string, { identity: string; promise: Promise<any> }>()
  const fingerprint = (connection: string) => {
    const server = servers().find(item => item.id === connection && item.enabled !== false)
    if (!server?.specUrl) throw new Error(`所需 OpenAPI 连接未登记：${connection}`)
    return createHash('sha256').update(JSON.stringify(server)).digest('hex')
  }
  const invoke = async (connection: string, operation: string, args: Record<string, any>, signal: AbortSignal, expected?: string) => {
    signal.throwIfAborted()
    const identity = fingerprint(connection)
    if (expected && identity !== expected) throw new Error('连接配置已变化，请重新提交；本次不会切换目标')
    const server = servers().find(item => item.id === connection && item.enabled !== false)
    if (!server?.specUrl) throw new Error(`所需 OpenAPI 连接未登记：${connection}`)
    let catalog = catalogs.get(connection)
    if (!catalog || catalog.identity !== identity) {
      const promise = dispatch({ action: 'test', serverId: connection }, signal).then(reply => {
        if (reply.status >= 400 || !Array.isArray(reply.value?.tools)) {
          throw dependencyError('discovery', {
            connection,
            operation,
            status: reply.status,
            detail: reply.value?.error ?? reply.value?.message ?? '发现回执缺少 tools 数组',
            receipt: reply.value,
          })
        }
        return reply.value
      }, error => {
        signal.throwIfAborted()
        throw dependencyError('discovery', { connection, operation, detail: error?.message ?? '发现请求失败，未提供错误消息', cause: error })
      })
      catalog = { identity, promise }; catalogs.set(connection, catalog)
      promise.catch(() => { if (catalogs.get(connection) === catalog) catalogs.delete(connection) })
    }
    const discovered = await catalog.promise
    const tool = discovered.tools.find((item: any) => item.name === operation)
    const resource = discovered.resources?.resources?.find((item: any) => item.name === operation)
    const template = discovered.resourceTemplates?.resourceTemplates?.find((item: any) => item.name === operation)
    if (!tool && !resource && !template) throw dependencyError('discovery', {
      connection,
      operation,
      detail: `连接已返回目录，但未暴露所需操作：${operation}`,
    })
    if (fingerprint(connection) !== identity) throw new Error('连接目标已变化，请重新提交')
    const properties = tool?.inputSchema?.properties ?? {}, body = properties.body
    let arguments_ = args
    if (body && !Object.hasOwn(args, 'body')) {
      const parameters = Object.keys(properties).filter(key => key !== 'body')
      // 兼容既有仅 body 的扁平调用；路径、查询与 body 混合时只接受规格中的完整参数。
      if (!parameters.length) arguments_ = { body: body.properties?.arguments ? { arguments: args } : args }
      else if (Object.keys(args).some(key => !parameters.includes(key))) throw new Error(`操作 ${operation} 需要显式 body，并保留路径与查询参数`)
    }
    const request = tool ? { action: 'callTool', toolName: operation,
      arguments: arguments_ }
      : template ? { action: 'readResource', uriTemplate: template.uriTemplate, arguments: args }
        : { action: 'readResource', uri: resource.uri }
    const reply = await dispatch({ ...request, serverId: connection, timeoutMs: 30_000 }, signal)
    if (reply.status >= 400) throw dependencyError('invocation', {
      connection,
      operation,
      status: reply.status,
      detail: reply.value?.error ?? reply.value?.message ?? `上游返回 HTTP ${reply.status}，未提供可展示的错误详情`,
      receipt: reply.value,
    })
    return reply.value
  }
  const describe = async (connection: string, operation: string, signal: AbortSignal) => {
    const reply = await dispatch({ action: 'test', serverId: connection }, signal)
    if (reply.status >= 400) throw new Error('当前只读能力目录不可取得')
    const tool = reply.value?.tools?.find((entry: any) => entry.name === operation)
    const resource = reply.value?.resourceTemplates?.resourceTemplates?.find((entry: any) => entry.name === operation) ?? reply.value?.resources?.resources?.find((entry: any) => entry.name === operation)
    const selected = tool ?? resource
    if (!selected?.inputSchema || selected.httpOperation?.method !== 'GET') throw new Error('当前目录未核实该操作为GET只读能力；分组标签不授权')
    return { inputSchema: selected.inputSchema, readonly: true, operation, connection, fingerprint:fingerprint(connection) }
  }
  return Object.assign(invoke, { fingerprint, describe, validateSchema: (schema: any, args: any) => fromJSONSchema(schema).safeParse(args).success })
}
