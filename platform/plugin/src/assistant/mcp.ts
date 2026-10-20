import type { ManagerConfig } from '../mcp/manager.ts'

const credentialField = /password|token|api.?key|authorization|secret|credential|headers|loginUsername/i

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => credentialField.test(key) || containsCredentialField(item))
}

export function mcpCredentialEdit(input: Record<string, any>): boolean {
  return containsCredentialField(input) || Array.isArray(input.ops) && input.ops.some((op: any) =>
    Array.isArray(op?.path) && op.path.some((part: any) => credentialField.test(String(part))))
}

/** GUI 与管理助手共用数据仓库配置入口和管理服务。 */
export function assistantMcp(manager: ManagerConfig) {
  return async (action: string, input: Record<string, any>, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (action.startsWith('control/')) {
      if (!manager.control) throw new Error('业务运行权限服务尚未装载')
      return manager.control(action.slice('control/'.length), input, signal, undefined as never)
    }
    if (action === 'configuration') {
      if (!manager.configuration) throw new Error('MCP 数据配置尚未装载')
      const view = manager.configuration()
      return { ok: true, value: { revision: view.revision,
        value: { servers: view.value.servers.map(server => {
          const { apiKey, loginUsername, loginPassword, headers, ...publicServer } = server
          return { ...publicServer, ...(headers ? { headers: headers.map(({ name }: { name: string }) => ({ name })) } : {}) }
        }), groups: view.value.groups },
        group_access_configured: Boolean(view.value.sharedToken),
        server_access: view.value.servers.map(server => ({ id: server.id,
          credential_configured: Boolean(server.apiKey), login_configured: Boolean(server.loginUsername && server.loginPassword),
          headers: (server.headers ?? []).map((header: { name: string; value: string }) => ({ name: header.name, configured: Boolean(header.value) })) })),
      } }
    }
    if (action === 'saveConfiguration') {
      if (!manager.saveConfiguration) throw new Error('MCP 数据配置尚未装载')
      if (!Array.isArray(input.ops) || typeof input.revision !== 'string') throw new Error('配置保存需要原始 revision 和路径修改 ops')
      const current = manager.configuration?.()
      if (!current || current.revision !== input.revision) throw new Error('MCP 配置已变化；请刷新后重试')
      for (const op of input.ops) {
        const path = op?.path
        if (!Array.isArray(path) || path.length === 0 || path[0] === 'servers' && (path.length === 1
          || path.length === 2 && op.op === 'set' && Number(path[1]) !== current.value.servers.length)) {
          throw new Error('助手只能修改单个服务的公开字段；整体替换或凭据请使用 MCP 管理页面')
        }
      }
      if (mcpCredentialEdit(input)) throw new Error('MCP 凭据请使用管理页面维护')
      return { ok: true, value: manager.saveConfiguration(input.ops, input.revision) }
    }
    if (!manager.dispatch) throw new Error('MCP 调试服务尚未就绪')
    const nativeAction = action === 'sources/list' ? 'sources' : action.startsWith('sources/') ? action.slice(8) : action
    const response = await manager.dispatch({ ...input, action: nativeAction }, signal)
    return response.status < 400 ? { ok: true, value: response.value } : { ok: false, error: { code: 'mcp_operation_failed', message: response.value?.error ?? 'MCP 操作失败', details: {} } }
  }
}
