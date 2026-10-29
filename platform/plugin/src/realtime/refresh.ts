import { useEffect, useRef } from 'react'

/** 隐藏时只记脏；读取期间的通知合并为下一批，避免仅丢弃回执却重复发起读取。 */
export function useQueuedRefresh(active: boolean, read: () => Promise<unknown>, scope = '') {
  const current = useRef({ active, read })
  current.current = { active, read }
  const queue = useRef({ pending: false, running: false, mounted: true, scope })
  if (queue.current.scope !== scope) {
    queue.current.mounted = false
    queue.current = { pending: false, running: false, mounted: true, scope }
  }
  async function refresh() {
    const state = queue.current
    state.pending = true
    if (state.running || !current.current.active || !state.mounted) return
    state.running = true
    try {
      while (state.pending && current.current.active && state.mounted) {
        state.pending = false
        await current.current.read()
      }
    } finally { state.running = false }
  }
  useEffect(() => {
    const state = queue.current
    state.mounted = true
    return () => { state.mounted = false }
  }, [scope])
  useEffect(() => { if (active && queue.current.pending) void refresh() }, [active])
  return refresh
}
