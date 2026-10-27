export async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch { /* HTTP 页面或浏览器权限不支持时使用页面复制。 */ }
  const active = document.activeElement as HTMLElement | null
  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(input)
  try {
    input.select()
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制')
  } finally {
    input.remove()
    active?.focus({ preventScroll: true })
  }
}
