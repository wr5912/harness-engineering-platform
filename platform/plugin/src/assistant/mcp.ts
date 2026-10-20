import type { ManagerConfig } from '../mcp/manager.ts'

/** GUI 配置及调试与助手使用同一原生 Settings 和管理服务。 */
export function assistantMcp(settings: any, manager: ManagerConfig) {
  return async (action: string, input: Record<string, any>, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (action.startsWith('control/')) {
      if (!manager.control) throw new Error('业务运行权限服务尚未装载')
      return manager.control(action.slice('control/'.length), input, signal, undefined as never)
    }
    if (action === 'configuration') {
      const view = settings.describe().namespaces.find((item: any) => item.ns === 'mcp-session-manager')
      if (!view) throw new Error('MCP 配置尚未装载')
      return { ok: true, value: view }
    }
    if (action === 'saveConfiguration') {
      if (!Array.isArray(input.ops) || !Number.isInteger(input.revision)) throw new Error('配置保存需要原始 revision 和路径修改 ops')
      return { ok: true, value: await settings.mutate('mcp-session-manager', input.ops, input.revision) }
    }
    if (!manager.dispatch) throw new Error('MCP 调试服务尚未就绪')
    const nativeAction = action === 'sources/list' ? 'sources' : action.startsWith('sources/') ? action.slice(8) : action
    const response = await manager.dispatch({ ...input, action: nativeAction }, signal)
    return response.status < 400 ? { ok: true, value: response.value } : { ok: false, error: { code: 'mcp_operation_failed', message: response.value?.error ?? 'MCP 操作失败', details: {} } }
  }
}
