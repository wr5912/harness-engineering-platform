import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { WorkspaceDeleteRequest, WorkspaceDeleteValue } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { resolveRepository } from './assistant/repositories.ts'
import { businessAgentsRoot, workspaceIdentity } from './workspace.ts'

/** 通过原生有效目录变更恢复移动前的会话，保留不可变的历史 header。 */
export async function relocateManagementSession(assetRoot: string, workingDirectory: {
  get(session: any): string
  set(agent: any, path: string, signal?: AbortSignal): Promise<string>
}, agent: any, signal?: AbortSignal): Promise<void> {
  const workspace = workspaceIdentity(assetRoot)
  const current = workingDirectory.get(agent.session)
  if (existsSync(current)) return
  const migrations = workspace.legacyRoots.flatMap(previous => [
    { previous, target: workspace.root },
    { previous: join(dirname(previous), 'business-agents'), target: businessAgentsRoot(assetRoot) },
  ])
  for (const { previous, target } of migrations) {
    const suffix = relative(previous, current)
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) continue
    await workingDirectory.set(agent, resolve(target, suffix), signal)
    return
  }
}

export async function bindConversationWorkspace(ctx: Context, assetRoot: string) {
  const root = realpathSync(assetRoot)
  const defaultRoot = resolveRepository(root).workspace
  const registry = ctx.get('workspaceRegistry') as {
    create(path: string, title?: string): Promise<{ id: WorkspaceId; sessionIds: readonly string[] }>
    list(): readonly { id: WorkspaceId }[]
    delete(id: WorkspaceId): Promise<boolean>
  }
  const controller = ctx.get('workspaceController') as { delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> }
  const sessions = ctx.get('sessionController') as { create(request: SessionCreateRequest): Promise<SessionCreateValue> }
  const createWorkspace = registry.create.bind(registry)
  const deleteWorkspace = controller.delete.bind(controller)
  const createSession = sessions.create.bind(sessions)
  const register = async (path: string, title?: string) => {
    let resolved: string | undefined
    try { if (isAbsolute(path)) resolved = realpathSync(path) } catch { /* 显式拒绝失效路径。 */ }
    if (resolved !== defaultRoot) throw new RemoteError('gateway/bad-request', '平台只能绑定 manager-workspace，不能添加其他工作区。', {})
    return createWorkspace(resolved, title)
  }
  const bound = await register(defaultRoot)
  // 仅撤销工作区登记，保留目录、会话及其历史 cwd。
  for (const item of [...registry.list()]) if (item.id !== bound.id) await registry.delete(item.id)
  ctx.effect(() => {
    const original = {
      createWorkspace: Object.getOwnPropertyDescriptor(registry, 'create'),
      createSession: Object.getOwnPropertyDescriptor(sessions, 'create'),
      deleteWorkspace: Object.getOwnPropertyDescriptor(controller, 'delete'),
    }
    Object.defineProperty(registry, 'create', { configurable: true, value: register })
    Object.defineProperty(controller, 'delete', { configurable: true, value: (request: WorkspaceDeleteRequest) => {
      if (request.workspaceId === bound.id) return Promise.reject(new RemoteError('gateway/bad-request', '平台绑定的 manager-workspace 不能移除。', {}))
      return deleteWorkspace(request)
    } })
    Object.defineProperty(sessions, 'create', { configurable: true, value: (request: SessionCreateRequest) => {
      if (request.cwd !== undefined && request.workspaceId !== undefined) throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
      return (async () => {
        let path = defaultRoot
        if (request.cwd !== undefined) path = request.cwd
        else if (request.workspaceId !== undefined) {
          if (request.workspaceId !== bound.id) throw new RemoteError('gateway/bad-request', '目标工作区未登记，请使用 manager-workspace。', {})
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
