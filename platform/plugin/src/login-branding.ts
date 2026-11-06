/** 登录页只读取公开名称，不刷新页面或改动登录草稿。 */
export function initializeLoginBranding() {
  let pending = false
  const sync = async () => {
    if (document.hidden || pending) return
    pending = true
    try {
      const response = await fetch(document.body.dataset.brandingUrl!, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) return
      const value = await response.json()
      if (typeof value.name !== 'string' || !value.name.trim() || typeof value.subtitle !== 'string') return
      const name = document.querySelector<HTMLElement>('[data-platform-name]')!
      const subtitle = document.querySelector<HTMLElement>('[data-platform-subtitle]')!
      name.textContent = name.title = value.name
      subtitle.textContent = subtitle.title = value.subtitle
      subtitle.hidden = !value.subtitle
      document.title = `登录 · ${value.name}`
      document.querySelector('[data-platform-story]')!.setAttribute('aria-label', `了解 ${value.name}`)
    } catch {} // 网络恢复后继续同步，保留最近一次名称和登录输入。
    finally { pending = false }
  }
  document.addEventListener('visibilitychange', sync)
  window.setInterval(sync, 3000)
  void sync()
}
