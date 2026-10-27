import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

export async function bindConversationWorkspace(ctx: Context, assetRoot: string) {
  const root = realpathSync(assetRoot)
  const registry = ctx.get('workspaceRegistry') as {
    create(path: string, title?: string): Promise<{ id: WorkspaceId; sessionIds: readonly string[] }>
    list(): readonly { id: WorkspaceId }[]
    delete(id: WorkspaceId): Promise<boolean>
  }
  const controller = ctx.get('workspaceController') as { delete(request: unknown): Promise<unknown> }
  const sessions = ctx.get('sessionController') as { create(request: SessionCreateRequest): Promise<SessionCreateValue> }
  const workspace = await registry.create(root)
  // 撤销其他目录的登记，原生接口保留目录、会话及其历史 cwd。
  for (const item of registry.list()) {
    if (item.id !== workspace.id) await registry.delete(item.id)
  }
  const createWorkspace = registry.create.bind(registry)
  const createSession = sessions.create.bind(sessions)
  ctx.effect(() => {
    const original = {
      createWorkspace: Object.getOwnPropertyDescriptor(registry, 'create'),
      createSession: Object.getOwnPropertyDescriptor(sessions, 'create'),
      deleteWorkspace: Object.getOwnPropertyDescriptor(controller, 'delete'),
    }
    Object.defineProperty(registry, 'create', { configurable: true, value: async (path: string, title?: string) => {
      if (!isAbsolute(path) || realpathSync(path) !== root) throw new RemoteError('gateway/bad-request', '管理对话仅使用平台绑定的数据仓库，不能添加其他工作区。', {})
      return createWorkspace(root, title)
    } })
    Object.defineProperty(controller, 'delete', { configurable: true, value: async () => {
      throw new RemoteError('gateway/bad-request', '平台绑定的数据工作区不能移除。', {})
    } })
    Object.defineProperty(sessions, 'create', { configurable: true, value: (request: SessionCreateRequest) => {
      if (request.cwd !== undefined && request.workspaceId !== undefined) {
        throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
      }
      // 只复用当前工作区的空白会话；历史目录的空白会话重新创建到当前数据根。
      const sessionId = request.sessionId && workspace.sessionIds.includes(request.sessionId) ? request.sessionId : undefined
      return createSession({ ...request, sessionId, cwd: undefined, workspaceId: workspace.id })
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
