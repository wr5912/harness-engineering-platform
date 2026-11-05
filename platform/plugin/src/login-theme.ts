// 编译后内嵌到登录页，在正文绘制前应用主题；不捕获服务端模块变量。
export function initializeLoginTheme(storageKey: string) {
  const body = document.body
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let draft: string | null = null
  try { draft = sessionStorage.getItem(storageKey) } catch {}
  if (draft !== 'light' && draft !== 'dark') draft = null
  const render = () => {
    const preference = draft ?? body.dataset.themePreference
    const dark = preference === 'dark' || preference === 'system' && media.matches
    body.toggleAttribute('data-ds-dark-theme', dark)
    body.style.colorScheme = dark ? 'dark' : 'light'
    const button = document.querySelector<HTMLButtonElement>('[data-login-theme]')
    if (button) {
      button.hidden = false
      button.title = dark ? '切换到浅色主题' : '切换到深色主题'
      button.setAttribute('aria-label', button.title)
    }
    const field = document.querySelector<HTMLInputElement>('input[name="theme"]')
    if (field) field.value = draft ?? ''
  }
  render()
  media.addEventListener('change', render)
  document.addEventListener('DOMContentLoaded', () => {
    render()
    document.querySelector('[data-login-theme]')?.addEventListener('click', () => {
      draft = body.hasAttribute('data-ds-dark-theme') ? 'light' : 'dark'
      try { sessionStorage.setItem(storageKey, draft) } catch {}
      render()
    })
  }, { once: true })
}
