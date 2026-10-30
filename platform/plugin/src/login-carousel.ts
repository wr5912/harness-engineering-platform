// 此函数编译后作为登录页的内联脚本执行，必须自包含，不捕获服务端模块变量。
export function initializeLoginCarousel() {
  const root = document.querySelector<HTMLElement>('[data-login-carousel]')
  if (!root) return
  const slides = Array.from(root.querySelectorAll<HTMLElement>('[data-carousel-slide]'))
  const controls = root.querySelector<HTMLElement>('[data-carousel-controls]')
  const dots = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-carousel-to]'))
  const playback = root.querySelector<HTMLButtonElement>('[data-carousel-playback]')
  const position = root.querySelector<HTMLElement>('[data-carousel-position]')
  const content = root.querySelector<HTMLElement>('[data-carousel-content]')
  if (slides.length < 2 || !controls || !playback || !content) return

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let current = 0
  let paused = motion.matches
  let hovered = false
  let timer: number | undefined
  const clear = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined }
  const updatePlayback = () => {
    playback.textContent = paused ? '播放' : '暂停'
    playback.setAttribute('aria-label', paused ? '开始自动轮播' : '暂停自动轮播')
    playback.setAttribute('aria-pressed', String(paused))
    content.setAttribute('aria-live', paused ? 'polite' : 'off')
  }
  const show = (index: number) => {
    current = (index + slides.length) % slides.length
    slides.forEach((slide, at) => {
      slide.dataset.active = String(at === current)
      slide.setAttribute('aria-hidden', String(at !== current))
    })
    dots.forEach((dot, at) => {
      if (at === current) dot.setAttribute('aria-current', 'true')
      else dot.removeAttribute('aria-current')
    })
    if (position) position.textContent = `${String(current + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`
  }
  const schedule = () => {
    clear()
    const playing = !paused && !hovered && !document.hidden
    root.dataset.playing = String(playing)
    if (!playing) return
    timer = window.setTimeout(() => { show(current + 1); schedule() }, 7000)
  }
  const pause = () => { paused = true; updatePlayback(); schedule() }
  const select = (index: number) => { pause(); show(index) }

  dots.forEach((dot, index) => dot.addEventListener('click', () => select(index)))
  root.querySelector('[data-carousel-previous]')?.addEventListener('click', () => select(current - 1))
  root.querySelector('[data-carousel-next]')?.addEventListener('click', () => select(current + 1))
  playback.addEventListener('click', () => { paused = !paused; updatePlayback(); schedule() })
  root.addEventListener('mouseenter', () => { hovered = true; schedule() })
  root.addEventListener('mouseleave', () => { hovered = false; schedule() })
  root.addEventListener('focusin', event => { if (event.target !== playback) pause() })
  root.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    select(current + (event.key === 'ArrowRight' ? 1 : -1))
  })
  // 只观察输入事件，不读取或保存凭据；首次自动聚焦用户名不阻止展示轮播。
  document.querySelector('.harness-login form')?.addEventListener('input', pause)
  document.addEventListener('visibilitychange', schedule)
  motion.addEventListener('change', () => { if (motion.matches) pause() })
  window.addEventListener('pagehide', clear)
  window.addEventListener('pageshow', schedule)
  controls.hidden = false
  updatePlayback()
  show(0)
  schedule()
}
