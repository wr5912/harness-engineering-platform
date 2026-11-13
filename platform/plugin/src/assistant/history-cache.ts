import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { workspaceOwnsManagementCwd } from '../workspace.ts'

/** 只重建派生缓存；逐个读取稳定的原生日志，不发布 Session 或激活 Agent。 */
export async function compactAssistantHistory(root: string, services: any, restore: Function, signal: AbortSignal) {
  const summary = { written: 0, skipped: 0, failed: 0 }
  for (const before of await services.sessionPersistence.list({ signal })) {
    signal.throwIfAborted()
    const header = before.header, id = header.id
    if (typeof header.cwd !== 'string' || !workspaceOwnsManagementCwd(root, header.cwd) || before.formatStatus === 'migration-required'
      || services.sessions.get(id) || services.agents.get(id)
      || services.sessionProjectionCache.cachedSnapshot(header, ['harnessPlatformAssistant'])) { summary.skipped++; continue }
    let handle
    try {
      handle = await services.sessionPersistence.open(id, 'read', { signal })
      const { events, eventState } = await handle.read(undefined, undefined, { signal })
      const session = restore(id, events, handle.header, handle.inheritedEventCount, eventState, services.sessions.messageProjections)
      services.sessionProjectionCache.hydratePrepared(session, events)
      const after = await services.sessionPersistence.stat(id, { signal })
      signal.throwIfAborted()
      if (!after || after.revision !== before.revision || services.sessions.get(id) || services.agents.get(id)) { summary.skipped++; continue }
      // write 是原生持久化屏障；coldSnapshot 的异步写回不能作为迁移完成回执。
      await services.sessionProjectionCache.write(session)
      if (!services.sessionProjectionCache.cachedSnapshot(handle.header, ['harnessPlatformAssistant'])) throw new Error('缓存版本未更新')
      summary.written++
    } catch (error) {
      signal.throwIfAborted()
      summary.failed++
    } finally { await handle?.close() }
    await yieldToLoop(undefined, { signal })
  }
  return summary
}
