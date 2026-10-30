// 此函数编译后作为登录页的内联脚本执行，必须自包含，不捕获服务端模块变量。
export function initializeLoginCarousel() {
  const root = document.querySelector<HTMLElement>('[data-login-carousel]')
  if (!root) return
  const slides = Array.from(root.querySelectorAll<HTMLElement>('[data-carousel-slide]'))
  const previous = root.querySelector<HTMLButtonElement>('[data-carousel-previous]')
  const next = root.querySelector<HTMLButtonElement>('[data-carousel-next]')
  const content = root.querySelector<HTMLElement>('[data-carousel-content]')
  if (slides.length < 2 || !previous || !next || !content) return

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let current = 0
  let hovered = false
  let keyboard = false
  let focused = false
  let touched = false
  let handledTouch = false
  let touch: { id: number; x: number; y: number; button?: HTMLButtonElement } | undefined
  let timer: number | undefined
  const clear = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined }
  const show = (index: number) => {
    current = (index + slides.length) % slides.length
    slides.forEach((slide, at) => {
      slide.dataset.active = String(at === current)
      slide.setAttribute('aria-hidden', String(at !== current))
    })
  }
  const schedule = () => {
    clear()
    const engaged = hovered || focused || touched
    const playing = !engaged && !motion.matches && !document.hidden
    root.dataset.engaged = String(engaged)
    root.dataset.playing = String(playing)
    content.setAttribute('aria-live', engaged ? 'polite' : 'off')
    if (document.hidden || hovered || focused || touch) return
    // 触屏没有 hover 离开事件，闲置后收起按钮，再按普通节奏继续轮播。
    if (touched) timer = window.setTimeout(() => { touched = false; schedule() }, 7000)
    else if (playing) timer = window.setTimeout(() => { show(current + 1); schedule() }, 7000)
  }
  const select = (index: number) => { show(index); schedule() }

  previous.addEventListener('click', event => { if (!handledTouch || event.detail === 0) select(current - 1); handledTouch = false })
  next.addEventListener('click', event => { if (!handledTouch || event.detail === 0) select(current + 1); handledTouch = false })
  root.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return
    hovered = true; touched = false; schedule()
  })
  root.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return
    hovered = false; schedule()
  })
  // 鼠标点击留下的焦点不锁住轮播；只有键盘进入时暂停至焦点离开。
  document.addEventListener('keydown', event => { if (event.key === 'Tab') keyboard = true })
  document.addEventListener('pointerdown', event => {
    keyboard = false; focused = false
    if (!root.contains(event.target as Node)) touched = false
    schedule()
  })
  root.addEventListener('focusin', () => { focused = keyboard; schedule() })
  root.addEventListener('focusout', event => {
    if (root.contains(event.relatedTarget as Node | null)) return
    focused = false; schedule()
  })
  root.addEventListener('keydown', event => {
    keyboard = true; focused = true; handledTouch = false
    schedule()
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    select(event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1))
  })
  root.addEventListener('pointerdown', event => {
    handledTouch = false
    if (event.pointerType !== 'touch' || !event.isPrimary) return
    const target = event.target as Node
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY,
      button: previous.contains(target) ? previous : next.contains(target) ? next : undefined }
    touched = true; schedule()
  })
  root.addEventListener('pointerup', event => {
    if (!touch || touch.id !== event.pointerId) return
    const dx = event.clientX - touch.x, dy = event.clientY - touch.y, button = touch.button
    touch = undefined
    handledTouch = Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5
    if (handledTouch) show(current + (dx < 0 ? 1 : -1))
    else if (button && Math.hypot(dx, dy) < 10) {
      const bounds = button.getBoundingClientRect()
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        // 横划后的首个 tap 可能没有兼容 click，按完整触屏手势激活并去重。
        show(current + (button === next ? 1 : -1))
        handledTouch = true
      }
    }
    schedule()
  })
  root.addEventListener('pointercancel', () => {
    touch = undefined; touched = false; handledTouch = false; schedule()
  })
  document.addEventListener('visibilitychange', schedule)
  motion.addEventListener('change', schedule)
  window.addEventListener('pagehide', () => { clear(); root.dataset.playing = 'false' })
  window.addEventListener('pageshow', schedule)
  previous.hidden = false
  next.hidden = false
  show(0)
  schedule()
}
