import type { InstanceBinding } from './contracts.ts'
export interface BusinessRuntimeConfig {
  assetRoot: string; stateRoot: string; sharedSecretFile: string; coordinatorOrigin: string
  basePath?: string; workspacePath?: string; presetId?: string; localTools?: string[]; binding: InstanceBinding
}
/** 独立业务Profile保留历史HOME，停用后台投递、owner认证及未纳管执行入口。 */
export function createBusinessRuntimePatch(config: BusinessRuntimeConfig, runtimePlugin: string, mcpManagerPlugin?: string, mcpManagerConfig: Record<string, unknown> = {}): unknown[] {
  const disabled = ['connection', 'schedule', 'ui-schedule', 'tool-schedule', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-web', 'tool-cordis', 'tool-plugin-manager', 'tool-plugin-market', 'session-log-download', 'open-in-app', 'ui-open-in-app', 'ui-agent-preset', 'directory-picker']
  if (mcpManagerPlugin) disabled.push('mcp-manager')
  return [...disabled.map(id => ({ id, disabled: true })),
    // 装载原生Node客户端面以保留真实浏览器模块；独立realm只容纳惰性ClientHandle，不创建默认owner Host。
    { insert: [{ id: 'business-client-connection', name: '/opt/dsh/packages/client/connection/lib/client.node.js', isolate: { connection: true } }] },
    { insert: [{ id: 'business-runtime', name: runtimePlugin, inject: ['webServer', 'remoteAccess', 'tools', 'approval', 'workspaceRegistry'], config }] },
    ...(mcpManagerPlugin ? [{ insert: [{ id: 'business-mcp-manager', name: mcpManagerPlugin, inject: ['businessRuntime'], config: { ...mcpManagerConfig, assetRoot: config.assetRoot } }] }] : [])]
}
