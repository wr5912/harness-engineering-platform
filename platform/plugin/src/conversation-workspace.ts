import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { listRepositories } from './assistant/repositories.ts'

export async function bindConversationWorkspace(ctx: Context, assetRoot: string) {
  const root = realpathSync(assetRoot)
  const registry = ctx.get('workspaceRegistry') as {
    create(path: string, title?: string): Promise<{ id: WorkspaceId; sessionIds: readonly string[] }>
    list(): readonly { id: WorkspaceId }[]
    delete(id: WorkspaceId): Promise<boolean>
  }
  const controller = ctx.get('workspaceController') as { delete(request: unknown): Promise<unknown> }
  const sessions = ctx.get('sessionController') as { create(request: SessionCreateRequest): Promise<SessionCreateValue> }
  const createWorkspace = registry.create.bind(registry)
  const createSession = sessions.create.bind(sessions)
  const workspaces = new Map<string, Awaited<ReturnType<typeof createWorkspace>>>()
  const allowed = () => new Set(listRepositories(root).repositories.filter(item => item.available).map(item => item.workspace!))
  const register = async (path: string, title?: string) => {
    let resolved: string | undefined
    try { if (isAbsolute(path)) resolved = realpathSync(path) } catch { /* 显式拒绝失效路径。 */ }
    if (!resolved || !allowed().has(resolved)) throw new RemoteError('gateway/bad-request', '管理对话只能使用数据根或已登记目标仓库，不能添加其他工作区。', {})
    const workspace = await createWorkspace(resolved, title)
    workspaces.set(resolved, workspace)
    return workspace
  }
  await register(root)
  for (const path of allowed()) if (path !== root) await register(path)
  const retained = new Set([...workspaces.values()].map(item => item.id))
  // 仅撤销未登记目录，保留会话及其历史 cwd。
  for (const item of registry.list()) if (!retained.has(item.id)) await registry.delete(item.id)
  ctx.effect(() => {
    const original = {
      createWorkspace: Object.getOwnPropertyDescriptor(registry, 'create'),
      createSession: Object.getOwnPropertyDescriptor(sessions, 'create'),
      deleteWorkspace: Object.getOwnPropertyDescriptor(controller, 'delete'),
    }
    Object.defineProperty(registry, 'create', { configurable: true, value: register })
    Object.defineProperty(controller, 'delete', { configurable: true, value: async () => {
      throw new RemoteError('gateway/bad-request', '平台绑定的数据工作区和目标仓库不能移除。', {})
    } })
    Object.defineProperty(sessions, 'create', { configurable: true, value: (request: SessionCreateRequest) => {
      if (request.cwd !== undefined && request.workspaceId !== undefined) throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
      return (async () => {
        let path = root
        if (request.cwd !== undefined) path = request.cwd
        else if (request.workspaceId !== undefined) {
          const found = [...workspaces].find(([, item]) => item.id === request.workspaceId)
          if (!found) throw new RemoteError('gateway/bad-request', '目标工作区未登记，请选择目标仓库。', {})
          path = found[0]
        }
        const workspace = await register(path)
        const sessionId = request.sessionId && workspace.sessionIds.includes(request.sessionId) ? request.sessionId : undefined
        return createSession({ ...request, sessionId, cwd: undefined, workspaceId: workspace.id })
      })()
    } })
    return () => {
      for (const [target, key, descriptor] of [
        [registry, 'create', original.createWorkspace],
        [sessions, 'create', original.createSession],
        [controller, 'delete', original.deleteWorkspace],
      ] as const) {
        if (descriptor) Object.defineProperty(target, key, descriptor)
        else Reflect.deleteProperty(target, key)
      }
    }
  })
}
