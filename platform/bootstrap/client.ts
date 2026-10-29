import { readFileSync } from 'node:fs'
import { defaultAccount } from './workspace.ts'

const harnessIcon = `data:image/svg+xml;base64,${readFileSync(new URL('../plugin/assets/harness-logo.svg', import.meta.url)).toString('base64')}`

/** 首次启动页面独立于平台构建依赖；后端负责工作区与写入检查。 */
function bootstrapClient() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const form = get<HTMLFormElement>('setup'), root = get<HTMLInputElement>('root')
  const repository = get<HTMLInputElement>('repository'), username = get<HTMLInputElement>('username')
  const password = get<HTMLInputElement>('password'), confirmation = get<HTMLInputElement>('password-confirm')
  const previewButton = get<HTMLButtonElement>('preview'), applyButton = get<HTMLButtonElement>('apply')
  const statusText = get<HTMLElement>('status'), errorBox = get<HTMLElement>('error')
  let plan: any = null, planRequest = '', checking = false, applying = false, entering = false, needsAccount = true
  let normalUrl = '/hep/'
  let poll: ReturnType<typeof setInterval> | undefined
  const action = () => (form.querySelector('input[name=action]:checked') as HTMLInputElement).value
  const message = (text = '') => { errorBox.textContent = text; errorBox.hidden = !text }
  const values = () => ({ action: action(), root: root.value.trim(), ...(action() === 'clone' ? { repositoryUrl: repository.value.trim() } : {}) })
  function controls() {
    for (const field of Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button'))) field.disabled = applying || entering
    previewButton.disabled = checking || applying || entering
    applyButton.disabled = checking || applying || entering || !plan?.canApply
    get<HTMLButtonElement>('refresh').disabled = checking || applying || entering
    get<HTMLElement>('repository-field').hidden = action() !== 'clone'
    repository.required = action() === 'clone'
    get<HTMLElement>('account').hidden = !needsAccount
    password.required = confirmation.required = username.required = needsAccount
    password.setCustomValidity(confirmation.value && password.value !== confirmation.value ? '两次填写的密码不一致' : '')
  }
  function invalidate() {
    plan = null
    planRequest = ''
    get<HTMLElement>('plan').hidden = true
    message()
    controls()
  }
  function checks(items: any[], target: string) {
    const list = get<HTMLElement>(target)
    list.replaceChildren()
    for (const item of items ?? []) {
      const line = document.createElement('li'), label = document.createElement('strong'), detail = document.createElement('span')
      line.dataset.status = item.status
      label.textContent = `${item.status === 'ok' ? '已就绪' : item.status === 'missing' ? '缺少' : '需处理'} · ${item.label}`
      detail.textContent = item.detail || ''
      line.append(label, detail); list.append(line)
    }
  }
  function list(items: string[], target: string) {
    get<HTMLElement>(target).replaceChildren(...items.map(value => { const item = document.createElement('li'); item.textContent = value; return item }))
  }
  async function request(endpoint: string, body?: any) {
    const response = await fetch(`bootstrap/${endpoint}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    let result: any
    try { result = await response.json() } catch { throw new Error('服务未返回有效响应，请核对启动终端。') }
    if (!response.ok || result.error && endpoint !== 'status') throw new Error(result.error || `请求失败（${response.status}）`)
    if (endpoint === 'status' && !['idle', 'applying', 'ready'].includes(result.phase)) throw new Error('初始化状态不可用，请核对启动终端。')
    return result
  }
  function acceptNormalUrl(value: unknown) {
    if (!entering && typeof value === 'string' && /^\/[a-z][a-z0-9-]*\/$/.test(value)) normalUrl = value
  }
  async function loginReady(target = normalUrl) {
    const response = await fetch(`${target}login`, { credentials: 'same-origin', cache: 'no-store' })
    return response.ok && response.headers.get('x-harness-bootstrap') !== '1' && !(await response.text()).includes('data-harness-bootstrap')
  }
  async function enterPlatform() {
    if (entering) return
    entering = true; applying = false
    const target = normalUrl
    if (poll) clearInterval(poll)
    controls(); message()
    statusText.textContent = '工作区已准备，正在等待平台登录入口…'
    get<HTMLElement>('progress').hidden = false
    const started = Date.now()
    const probe = async () => {
      try {
        if (await loginReady(target)) { window.location.assign(target); return }
      } catch { /* 启动器切换服务期间短暂断开，继续等待实际登录入口。 */ }
      if (Date.now() - started > 120_000) statusText.textContent = '工作区已初始化，平台仍在启动。可查看启动终端；本页继续等待登录入口。'
      setTimeout(probe, 1500)
    }
    void probe()
  }
  async function refresh(initial = false) {
    try {
      const state = await request('status')
      acceptNormalUrl(state.normalUrl)
      if (initial) {
        invalidate()
        root.value = state.root || ''
        repository.value = state.repositoryUrl || ''
        get<HTMLElement>('default-root').textContent = state.root || ''
      }
      needsAccount = state.needsAccount !== false
      checks(state.checks, 'initial-checks')
      if (state.phase === 'ready') { void enterPlatform(); return }
      const wasApplying = applying
      applying = state.phase === 'applying'
      if (wasApplying && !applying && state.error && state.checks?.some((item: any) => item.id === 'workspace.json' && item.status === 'ok')) {
        root.value = state.root
        ;(form.querySelector('input[value=existing]') as HTMLInputElement).checked = true
        invalidate()
      }
      if (applying && !poll) poll = setInterval(() => { void refresh() }, 1200)
      if (!applying && poll) { clearInterval(poll); poll = undefined }
      get<HTMLElement>('progress').hidden = !applying
      statusText.textContent = applying ? '正在初始化工作区并准备平台，请保留此页面…' : '先检查工作区，再确认初始化。'
      if (state.error) message(state.error)
      controls()
      if (initial && action() === 'existing' && !applying && !state.error && state.checks?.some((item: any) => item.id === 'workspace.json' && item.status === 'ok')) form.requestSubmit()
    } catch (error) {
      try { if (await loginReady()) { window.location.assign(normalUrl); return } } catch { /* 平台接续前登录入口可能尚未监听。 */ }
      if (applying) {
        statusText.textContent = '暂未收到完整初始化状态，正在继续核对，请勿重复提交。'
      } else if (!entering) message(error instanceof Error ? error.message : String(error))
    }
  }
  form.addEventListener('change', event => {
    const id = (event.target as HTMLInputElement).id
    if (!['username', 'password', 'password-confirm'].includes(id)) invalidate()
    else controls()
  })
  root.addEventListener('input', invalidate)
  repository.addEventListener('input', invalidate)
  for (const field of [username, password, confirmation]) field.addEventListener('input', controls)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (checking || applying || entering) return
    if (!root.value.trim() || action() === 'clone' && !repository.value.trim()) { message('请填写数据目录；克隆时还需填写 Git 地址。'); return }
    const requested = JSON.stringify(values())
    checking = true; plan = null; controls(); message()
    get<HTMLElement>('plan').hidden = true
    statusText.textContent = '正在检查目录与初始化条件…'
    try {
      const result = await request('preview', values())
      if (requested !== JSON.stringify(values())) { message('填写内容已变化，请重新检查。'); return }
      plan = result; planRequest = requested; needsAccount = result.needsAccount !== false
      acceptNormalUrl(result.normalUrl)
      checks(result.checks, 'plan-checks')
      list(result.plannedChanges ?? [], 'changes')
      list((result.extensions ?? []).map((item: any) => `${item.id} · ${item.path}`), 'extensions')
      get<HTMLElement>('extensions-section').hidden = !result.extensions?.length
      get<HTMLElement>('planned-root').textContent = result.root
      get<HTMLElement>('plan').hidden = false
      if (!result.canApply) message('当前检查未通过，请按上方提示调整后重试。')
      statusText.textContent = result.canApply ? '检查完成。请核对写入内容和首次登录账号。' : '当前条件尚不满足初始化。'
    } catch (error) { message(error instanceof Error ? error.message : String(error)); statusText.textContent = '检查失败，可以调整后重新检查。' }
    finally { checking = false; controls() }
  })
  applyButton.addEventListener('click', async () => {
    if (!plan?.canApply || applying || entering || checking) return
    if (JSON.stringify(values()) !== planRequest) { invalidate(); message('填写内容已变化，请重新检查。'); return }
    if (needsAccount && (!username.value.trim() || !password.value || password.value !== confirmation.value)) {
      message(!username.value.trim() || !password.value ? '请填写首次平台登录账号和密码。' : '两次填写的密码不一致。'); return
    }
    const payload = { ...values(), previewRevision: plan.revision, ...(needsAccount ? { account: { username: username.value.trim(), password: password.value } } : {}) }
    applying = true; controls(); message(); get<HTMLElement>('progress').hidden = false
    statusText.textContent = '正在初始化工作区并准备平台，请保留此页面…'
    poll = setInterval(() => { void refresh() }, 1200)
    try {
      const result = await request('apply', payload)
      acceptNormalUrl(result.normalUrl)
      password.value = confirmation.value = ''
      if (result.requiresReview) {
        applying = false
        if (poll) { clearInterval(poll); poll = undefined }
        root.value = result.root
        ;(form.querySelector('input[value=existing]') as HTMLInputElement).checked = true
        invalidate()
        await refresh()
        message('仓库已克隆到所选目录。检测到工作区扩展，请重新检查并预览实际扩展，确认后再准备平台。')
        return
      }
      void enterPlatform()
    } catch (error) {
      password.value = confirmation.value = ''
      message(error instanceof Error ? error.message : String(error))
      plan = null; get<HTMLElement>('plan').hidden = true
      await refresh(); controls()
    }
  })
  get<HTMLButtonElement>('refresh').addEventListener('click', () => { void refresh(true) })
  controls(); void refresh(true)
}

export function bootstrapHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/svg+xml" href="${harnessIcon}"><title>初始化工作区 · Harness工程平台</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#17233c;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}[hidden]{display:none!important}main{max-width:1000px;padding:40px 28px 64px;margin:auto}.brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;color:#364762}.logo{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:#0075ca;color:white;font-weight:800;font-size:19px}.intro{margin:28px 0 24px}h1{font-size:29px;letter-spacing:-.5px;margin:0 0 8px}h2{font-size:18px;margin:0 0 14px}p{margin:6px 0}.muted,.hint{color:#65738c}.hint{font-size:13px}.card{background:white;border:1px solid #dfe5ee;border-radius:14px;padding:24px;margin-top:18px;box-shadow:0 3px 16px #15395804}.options{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.option{display:flex;align-items:flex-start;gap:10px;border:1px solid #d9e0ea;padding:16px;border-radius:10px;cursor:pointer}.option:has(input:checked){border-color:#0075ca;background:#f1f8ff;box-shadow:0 0 0 1px #0075ca}.option input{margin:5px 0 0;accent-color:#0075ca}.option strong{display:block;font-size:15px}.option span span{display:block;font-size:13px;color:#65738c;margin-top:5px}.field{display:block;margin-top:18px}.field>span{display:block;font-weight:600;margin-bottom:7px}input[type=text],input[type=password],input[type=url]{display:block;width:100%;padding:10px 12px;border:1px solid #cbd5e3;border-radius:8px;color:#17233c;background:white}input:focus{outline:2px solid #79b8e8;outline-offset:1px}.path,code{overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}.checks{list-style:none;padding:0;margin:10px 0}.checks li{display:flex;gap:10px;padding:5px 0;font-size:13px}.checks strong{color:#8e601d;min-width:130px}.checks [data-status=ok] strong{color:#22734d}.checks span{color:#65738c;overflow-wrap:anywhere}.actions{display:flex;align-items:center;gap:14px;margin-top:20px}.primary,.secondary{border-radius:8px;padding:10px 18px;font-weight:600}.primary{background:#0075ca;color:white;border:1px solid #0075ca}.primary:hover:not(:disabled){background:#0063ad}.secondary{background:white;color:#245c85;border:1px solid #bdcfdf}.account-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.error{padding:14px 18px;border:1px solid #efc3bd;background:#fff5f3;color:#9b352d;border-radius:10px;margin-top:18px;white-space:pre-wrap}.progress{color:#0066af;background:#eef7ff;border:1px solid #bbd9ef;padding:12px 16px;border-radius:10px;margin-top:18px}.progress:before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:#0075ca;margin-right:9px;animation:pulse 1.4s infinite}@keyframes pulse{50%{opacity:.25}}.footer{font-size:13px;color:#65738c;margin-top:20px}.subsection{border-top:1px solid #e7ecf2;padding-top:16px;margin-top:18px}.subsection h3{font-size:14px;margin:0 0 8px}ul{padding-left:20px}.notice{padding:12px 16px;background:#f5f8fc;border-radius:8px;margin-top:16px;font-size:13px;color:#52647d}@media(max-width:700px){main{padding:24px 16px}.card{padding:18px}.options,.account-grid{grid-template-columns:1fr}.checks li{display:block}.checks span{display:block}.actions{align-items:stretch;flex-direction:column}h1{font-size:25px}}@media(prefers-reduced-motion:reduce){.progress:before{animation:none}}
</style></head><body data-harness-bootstrap><main>
<div class="brand"><span class="logo" aria-hidden="true">H</span><span>Harness Engineering Platform</span></div>
<header class="intro"><h1>连接你的数据工作区</h1><p class="muted">平台程序已启动。准备独立的智能体资产与研究数据后，即可进入个人工作台。</p></header>
<section class="card" aria-label="当前工作区检查"><h2>当前还需要准备</h2><p class="hint">默认数据目录：<code id="default-root">正在读取…</code></p><ul id="initial-checks" class="checks"></ul><button id="refresh" class="secondary" type="button">重新读取状态</button></section>
<form id="setup" novalidate><section class="card"><h2>1. 选择准备方式</h2><div class="options">
<label class="option"><input type="radio" name="action" value="existing" checked><span><strong>选择已有目录</strong><span>连接已存在的有效数据工作区。</span></span></label>
<label class="option"><input type="radio" name="action" value="clone"><span><strong>从 Git 克隆</strong><span>将数据仓库克隆到新目录。</span></span></label>
<label class="option"><input type="radio" name="action" value="new"><span><strong>创建空白工作区</strong><span>初始化目录，随后创建自己的智能体。</span></span></label></div>
<label class="field"><span>数据目录</span><input id="root" type="text" spellcheck="false" autocomplete="off" required><p class="hint">填写服务器上的目录路径。检查失败可以重试，已有非空目录不会被覆盖。</p></label>
<label id="repository-field" class="field" hidden><span>Git 仓库地址</span><input id="repository" type="text" spellcheck="false" autocomplete="off"><p class="hint">私有 SSH 仓库需要服务器已具备 Git 访问权限。此处不收集 PAT 或其他访问凭据。</p></label>
<div class="actions"><button id="preview" type="submit" class="secondary">检查并预览</button><span class="hint">先核对路径与将发生的写入。</span></div></section>
<section id="plan" class="card" hidden><h2>2. 确认初始化内容</h2><p class="path" id="planned-root"></p><ul id="plan-checks" class="checks"></ul><h3 class="hint">将执行</h3><ul id="changes"></ul><div id="extensions-section" class="subsection" hidden><h3>工作区扩展声明</h3><ul id="extensions"></ul></div><p class="notice">不会自动拉取外部插件或接入第三方服务。扩展缺失时按检查结果另行准备。</p></section>
<section id="account" class="card"><h2>首次平台登录账号</h2><p class="hint">仅用于这个平台的登录。密码只在确认初始化时发送。</p><div class="account-grid">
<label class="field"><span>账号</span><input id="username" type="text" autocomplete="username" value="${defaultAccount.username}" required></label><label class="field"><span>密码</span><input id="password" type="password" autocomplete="new-password" value="${defaultAccount.password}" required></label><label class="field"><span>再次填写密码</span><input id="password-confirm" type="password" autocomplete="new-password" value="${defaultAccount.password}" required></label></div></section>
<div id="error" class="error" role="alert" hidden></div><div id="progress" class="progress" hidden>正在准备，请勿重复提交。</div>
<div class="actions"><button id="apply" type="button" class="primary" disabled>确认初始化并进入平台</button><span id="status" class="hint" role="status" aria-live="polite">正在读取状态…</span></div></form>
<p class="footer">数据工作区独立保存，平台程序可单独更新。初始化完成后自动进入平台登录页面。</p>
</main><script>(${bootstrapClient.toString()})();</script></body></html>`
}
