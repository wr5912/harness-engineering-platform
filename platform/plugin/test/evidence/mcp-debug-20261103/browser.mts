import { chromium } from '/home/admin/work/cross-framework-sources/dsh/apps/web/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// 手动激活后运行：真实平台认证、配置及客户端；仅 MCP 调试 HTTP 响应替换为固定 UI 夹具。
const origin = 'http://10.0.160.32:18120'
const directory = '.local/mcp-debug-20261103/browser-' + new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const report: any = { at: new Date().toISOString(), scope: '实际18120认证/配置/客户端与原生主题；MCP发现/调用HTTP响应为浏览器UI夹具，无真实MCP工具或业务写入；最后单独进行真实只读发现', checks: [], phases: [], errors: [], requests: [], screenshots: [], blockedWrites: [], mockedCalls: [], realDiscovery: null }
const browser = await chromium.launch({ headless: true, executablePath: '/home/admin/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(10000)
let phase = 'setup', replyMode = 'success', useRealDiscovery = false, initialTheme: string | null = null, initialDark = false
const longDescription = '根据告警时间、严重程度以及资产范围检索告警。返回结果需要结合实际业务核对。\n'.repeat(18) + '描述末尾检索词：完整说明终点。'
const fixtures = {
  tools: [
    { name: 'query_alerts', title: '查询告警', description: longDescription, inputSchema: { type: 'object', required: ['severity', 'body'], additionalProperties: false, properties: {
      severity: { type: 'string', enum: ['high', 'low'], description: '必填严重程度，无服务默认值。' },
      body: { type: 'object', required: ['query'], description: '请求体筛选条件。', properties: {
        query: { type: 'string', minLength: 1, examples: ['示例检索'], description: '检索文本。' },
        count: { type: 'integer', default: 0, minimum: 0, maximum: 50 },
        includeClosed: { type: 'boolean', default: false },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
        advanced: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '复杂字段由 JSON 编辑。' },
      } },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      optionalId: { type: 'string', description: '无默认的可选业务ID，不应自动提交。' },
    } } },
    { name: 'lookup_asset', title: '查询资产', description: '根据业务资产标识查询资产，用户需要自行填写真实标识。', inputSchema: { type: 'object', required: ['assetId'], properties: { assetId: { type: 'string', minLength: 1 } } } },
    { name: 'complex_contract', title: '复杂参数工具', description: '顶层组合定义使用 JSON，保留服务最终核对。', inputSchema: { type: 'object', oneOf: [{ required: ['first'] }, { required: ['second'] }], properties: { first: { type: 'string' }, second: { type: 'string' } } } },
  ],
  resources: { resources: [{ name: '核验说明资源', uri: 'fixture://help', description: '资源说明：此内容用于界面读取合同验证。' }] },
  resourceTemplates: { resourceTemplates: [{ name: '资产资源模板', uriTemplate: 'fixture://assets/{assetId}{?detail}', description: '模板说明：按资产标识读取，查询变量由服务判断是否需要。' }] },
}
function check(name: string, ok: unknown, detail?: unknown) {
  report.checks.push({ phase, name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
  if (!ok) throw new Error(name)
}
const pathname = (url: string) => { try { return new URL(url).pathname } catch { return '' } }
const requestBody = (request: any) => { try { return request.postDataJSON() ?? {} } catch { return {} } }
const forbidden = (path: string, method: string) => /(?:^|\/)(?:session|workspace)\/(?:create|fork|prompt|cancel|delete|archive|unarchive|update|rename|set|send)(?:\/|$)/.test(path + '/' + method)
  || /assistant\/(?:context|session|confirm|reject)$/.test(method)
  || /(?:^|\/)(?:save|saveConfiguration|apply|invoke|send|start|stop|restart|remove|delete|enable|disable|confirm|run|batch|publish|create|import|rotateCredential|issueCredential)(?:\/|$)/.test(method)
await context.route('**/*', async route => {
  const request = route.request(), path = pathname(request.url()), body = requestBody(request), method = body.method ?? ''
  if (path === '/hep/api/mcp-manager' && request.method() === 'POST') {
    const action = body.action
    if (action === 'test') {
      if (useRealDiscovery) {
        const response = await route.fetch({ timeout: 30000 })
        let data: any = {}; try { data = await response.json() } catch {}
        report.realDiscovery = { status: response.status(), tools: data.tools?.length ?? null, toolsUnavailable: !!data.toolsUnavailable,
          resourceUnavailable: !!data.resources?.unavailable, templateUnavailable: !!data.resourceTemplates?.unavailable,
          hasError: typeof data.error === 'string', error: typeof data.error === 'string' ? data.error.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 180) : undefined }
        await route.fulfill({ response }); return
      }
      report.requests.push({ phase, boundary: 'MCP UI fixture', action, status: 200 })
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures) }); return
    }
    if (['callTool', 'readResource'].includes(action)) {
      report.mockedCalls.push({ phase, action, toolName: body.toolName, uri: body.uri, uriTemplate: body.uriTemplate, arguments: body.arguments, mode: replyMode })
      const currentMode = replyMode
      await new Promise(resolve => setTimeout(resolve, currentMode === 'slow' ? 900 : 180))
      if (currentMode === 'lost') { await route.abort('failed'); return }
      if (currentMode === 'reject') { await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '模拟拒绝：请求未获允许。' }) }); return }
      const response = currentMode === 'tool-error' ? { isError: true, content: [{ type: 'text', text: '模拟工具错误：条件暂不满足。' }] }
        : action === 'readResource' ? { contents: [{ uri: body.uri || 'fixture://assets/ui-test', mimeType: 'text/plain', text: '模拟资源内容：读取完成。' }] }
          : { content: [{ type: 'text', text: '模拟返回：检索完成。' }], structuredContent: { count: 2, items: [{ id: 'ui-1' }, { id: 'ui-2' }] } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }); return
    }
    report.blockedWrites.push({ phase, path, action }); await route.abort('blockedbyclient'); return
  }
  if (request.method() !== 'GET' && forbidden(path, method)) {
    report.blockedWrites.push({ phase, path, method }); await route.abort('blockedbyclient'); return
  }
  await route.continue()
})
page.on('pageerror', error => report.errors.push({ phase, message: error.message.slice(0, 300) }))
page.on('dialog', async dialog => { if (dialog.type() === 'confirm' && dialog.message().startsWith('恢复服务声明')) await dialog.accept(); else await dialog.dismiss() })
async function shot(name: string) {
  const path = `${directory}/${name}.png`; await page.screenshot({ path, fullPage: true }); report.screenshots.push(path)
}
async function run(name: string, action: () => Promise<void>) {
  phase = name
  try { await action(); report.phases.push({ name, ok: true }) }
  catch (error: any) { report.phases.push({ name, ok: false, error: error.message.slice(0, 240) }); await shot(name + '-failed').catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) }
}
async function choose(label: string, needle: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  const popup = page.locator('.hep-search-popup'); await popup.waitFor()
  await popup.getByRole('textbox', { name: `搜索${label}`, exact: true }).fill(needle)
  await popup.getByRole('option').first().click()
}
async function capability(name: string) { await page.getByRole('navigation', { name: '能力类型', exact: true }).getByRole('button', { name, exact: true }).click() }
const params = () => page.getByRole('region', { name: '调试参数', exact: true })
const result = () => page.locator('.mcp-debug-result')
const call = () => page.getByRole('button', { name: '调用工具', exact: true })
const field = (name: string) => page.getByLabel(name, { exact: true })
async function jsonValue(label = '调用参数') { await page.getByRole('button', { name: 'JSON 编辑', exact: true }).click(); return page.getByRole('textbox', { name: `${label} JSON`, exact: true }) }
async function theme(preference: string) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const current = await page.locator('html').getAttribute('data-ds-theme-source')
  if (current === preference) return
  if (preference !== 'system') {
    const isDark = await page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))
    if (isDark !== (preference === 'dark')) await page.getByRole('button', { name: preference === 'dark' ? '切换到深色主题' : '切换到浅色主题', exact: true }).first().click()
    else {
      const settings = await nativeSettings(); await settings.getByRole('button', { name: preference === 'dark' ? '深色' : '浅色', exact: true }).click(); await page.keyboard.press('Escape')
    }
  } else {
    const settings = await nativeSettings(); await settings.getByRole('button', { name: '跟随系统', exact: true }).click(); await page.keyboard.press('Escape')
  }
  await page.waitForFunction(want => document.documentElement.getAttribute('data-ds-theme-source') === want, preference)
}
async function nativeSettings() {
  await page.getByRole('button', { name: '平台菜单', exact: true }).click()
  await page.locator('#harness-settings').getByRole('button', { name: '设置', exact: true }).click()
  const modal = page.locator('[data-shortcut-modal="settings"][role="dialog"]'); await modal.waitFor()
  if (!await modal.getByRole('button', { name: '跟随系统', exact: true }).isVisible()) await modal.getByText('通用', { exact: true }).first().click()
  return modal
}
async function inspect(name: string) {
  const measure = await page.evaluate(() => {
    const selection = document.querySelector('.mcp-debug-selection')!.getBoundingClientRect()
    const parameters = document.querySelector('.mcp-debug-parameters')!.getBoundingClientRect()
    const output = document.querySelector('.mcp-debug-result')!.getBoundingClientRect()
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, selectionWidth: selection.width,
      parameterWidth: parameters.width, resultWidth: output.width, parametersTop: parameters.top, resultTop: output.top,
      themeSource: document.documentElement.getAttribute('data-ds-theme-source') }
  })
  check(name + ' 无整页横向溢出', measure.documentWidth <= measure.width, measure)
  if (measure.width === 1440) check(name + ' 宽屏输入结果并排', Math.abs(measure.parametersTop - measure.resultTop) < 2)
  else check(name + ' 窄屏输入结果上下排列', measure.resultTop > measure.parametersTop)
  await shot(name)
}
let fatal: any
try {
  const auth = await context.request.post(origin + '/hep/login', { form: JSON.parse(readFileSync('/home/admin/harness-engineering-platform-data/.local/credentials/admin.json', 'utf8')), headers: { origin }, maxRedirects: 0 })
  check('真实平台认证', auth.status() === 303)
  // 只读选择既有会话，避免原生壳自动创建空白Session；不打开会话内容。
  const sessionsResponse = await context.request.post(origin + '/hep/api/session/list', { headers: { origin }, data: { type: 'client-request', rpcId: 'mcp-ui-existing-session', method: 'session/list', payload: { args: { _request: {} } } } })
  const sessions = await sessionsResponse.json(), existing = sessions.result?.value?.items?.find((item: any) => !item.running && item.blank === false && item.cwd !== '/home/admin/harness-engineering-platform-data')
  if (existing) await context.addInitScript(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), existing.sessionId)
  report.existingSessionSelected = !!existing
  await page.goto(origin + '/hep/#/mcp?tab=connection', { waitUntil: 'domcontentloaded' })
  await page.locator('.mcp-debug-workbench').waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.harness-account-name')?.textContent === 'admin')
  initialTheme = await page.locator('html').getAttribute('data-ds-theme-source')
  initialDark = await page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))
  check('记录精确主题偏好', ['light', 'dark', 'system'].includes(initialTheme!))
  report.initialThemePreference = initialTheme
  report.initialDark = initialDark
  report.initialTarget = (await page.getByRole('combobox', { name: '调试对象', exact: true }).innerText()).replace(/\s+/g, ' ').trim()
  await page.getByRole('button', { name: '发现工具与资源', exact: true }).click()
  await page.getByRole('combobox', { name: '工具', exact: true }).waitFor()
  if (!process.argv.includes('--visual-only')) {
  await run('defaults-and-required', async () => {
    check('工具标题同时显示原始工具名', (await page.getByRole('combobox', { name: '工具', exact: true }).innerText()).includes('查询告警 · query_alerts'))
    check('嵌套必填示例已填', await field('body.query').inputValue() === '示例检索')
    check('默认0保留', await field('body.count').inputValue() === '0')
    check('默认false保留', await field('body.includeClosed').inputValue() === 'false')
    check('必填星号可见', await page.locator('.mcp-parameter-required').count() > 0 || /severity\s*\*/.test(await page.locator('.mcp-debug-parameters').innerText()))
    const before = report.mockedCalls.length; await call().click(); await page.waitForTimeout(250)
    check('缺少必填值不派发调用', report.mockedCalls.length === before)
    await field('severity').selectOption('"high"')
    await field('body.query').fill('真实页面输入，仅UI夹具')
    const area = await jsonValue(), value = JSON.parse(await area.inputValue())
    check('无默认可选字段未提交', !('optionalId' in value))
    check('JSON与表单输入一致', value.severity === 'high' && value.body.query === '真实页面输入，仅UI夹具')
    await area.fill('{ "broken":')
    await page.getByRole('button', { name: '表单填写', exact: true }).click()
    check('非法JSON切回表单保留原文', await area.inputValue() === '{ "broken":')
    await area.fill(JSON.stringify(value)); await page.getByRole('button', { name: '表单填写', exact: true }).click()
    await page.getByRole('button', { name: '添加条目', exact: true }).click()
    await field('body.tags.0').fill('界面核验标签')
    const complex = page.getByRole('textbox', { name: 'body.advanced JSON', exact: true })
    await complex.fill('{"mode":"all"}')
    check('复杂字段保留局部JSON入口', await complex.inputValue() === '{"mode":"all"}' || JSON.parse(await complex.inputValue()).mode === 'all')
  })
  await run('tool-drafts-and-partial-input', async () => {
    await field('body.count').fill('-')
    check('数值半输入可见且禁止调用', await field('body.count').inputValue() === '-' && await call().isDisabled())
    await choose('工具', 'lookup_asset')
    check('未知业务ID保持未填', await field('assetId').inputValue() === '')
    await field('assetId').fill('ui-only-asset')
    await choose('工具', 'query_alerts')
    check('返回工具保留数值半输入', await field('body.count').inputValue() === '-')
    await field('body.count').fill('3')
    await choose('工具', 'lookup_asset')
    check('第二工具草稿保留', await field('assetId').inputValue() === 'ui-only-asset')
    await choose('工具', 'query_alerts')
    check('首工具普通输入保留', await field('body.query').inputValue() === '真实页面输入，仅UI夹具')
    await page.getByRole('button', { name: '发现工具与资源', exact: true }).click()
    await field('body.query').waitFor(); check('重新发现不覆盖草稿', await field('body.query').inputValue() === '真实页面输入，仅UI夹具')
  })
  await run('success-result-copy-download', async () => {
    replyMode = 'success'; await call().click()
    await result().getByText('正在请求，等待返回结果…', { exact: true }).waitFor()
    await result().getByText('调用完成', { exact: true }).waitFor()
    check('文本结果直接可读', await result().getByText('模拟返回：检索完成。', { exact: true }).isVisible())
    await field('body.query').fill('修改后的参数，尚未调用')
    check('修改输入标识历史结果', await result().getByText('输入或保存范围已变化，以下是上次提交的结果。', { exact: true }).isVisible())
    await result().getByRole('button', { name: '复制', exact: true }).click()
    await result().locator('.mcp-copy-feedback').waitFor()
    check('复制反馈可见', /复制/.test(await result().locator('.mcp-copy-feedback').innerText()))
    const downloadPromise = page.waitForEvent('download')
    await result().getByRole('button', { name: '下载', exact: true }).click()
    const download = await downloadPromise; check('下载结果为JSON', download.suggestedFilename() === 'mcp-debug-result.json')
  })
  for (const [mode, label] of [['tool-error', '工具返回错误'], ['reject', '请求失败'], ['lost', '结果待核对']]) await run('result-' + mode, async () => {
    replyMode = mode; await call().click(); await result().getByText(label, { exact: true }).waitFor()
    check(label + '状态准确', await result().locator('.mcp-debug-status').innerText() === label)
    if (mode === 'lost') check('未知结果提示先核对远端', (await result().innerText()).includes('远端可能已执行'))
  })
  await run('resource-and-template', async () => {
    replyMode = 'success'; await capability('资源 URI'); await choose('资源', '核验说明资源')
    check('选中资源展示说明', await page.getByText('资源说明：此内容用于界面读取合同验证。', { exact: true }).isVisible())
    await page.getByRole('button', { name: '读取资源', exact: true }).click(); await result().getByText('模拟资源内容：读取完成。', { exact: true }).waitFor()
    await capability('资源模板'); await choose('资源模板', '资产资源模板')
    check('选中模板展示说明', await page.getByText('模板说明：按资产标识读取，查询变量由服务判断是否需要。', { exact: true }).isVisible())
    await field('assetId').fill('template-ui-value')
    await page.getByRole('button', { name: '读取模板资源', exact: true }).click(); await result().getByText('模拟资源内容：读取完成。', { exact: true }).waitFor()
    await capability('工具'); check('切换能力保留工具草稿', await field('body.query').inputValue() === '修改后的参数，尚未调用')
    await capability('资源模板'); check('模板草稿独立保留', await field('assetId').inputValue() === 'template-ui-value'); await capability('工具')
  })
  await run('target-draft-isolation', async () => {
    const initial = await page.getByRole('combobox', { name: '调试对象', exact: true }).innerText()
    await page.getByRole('combobox', { name: '调试对象', exact: true }).click()
    const options = page.locator('.hep-search-popup').getByRole('option')
    if (await options.count() < 2) { await page.keyboard.press('Escape'); report.targetSwitchSkipped = '实际配置只有一个目标'; return }
    await options.nth(1).click(); await page.getByRole('button', { name: '发现工具与资源', exact: true }).click()
    await field('severity').selectOption('"low"'); await field('body.query').fill('第二目标独立草稿')
    await page.getByRole('combobox', { name: '调试对象', exact: true }).click()
    await page.locator('.hep-search-popup').getByRole('option').filter({ hasText: initial.replace(/⌄/g, '').trim() }).first().click()
    await page.getByRole('button', { name: '发现工具与资源', exact: true }).click(); await field('body.query').waitFor()
    check('返回目标保留原草稿', await field('body.query').inputValue() === '修改后的参数，尚未调用')
  })
  }
  for (const preference of ['light', 'dark']) {
    await theme(preference)
    for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]]) await run(`${width}-${preference}-layout-menu`, async () => {
      await page.setViewportSize({ width, height }); await inspect(`${width}-${preference}-form`)
      await page.getByRole('combobox', { name: '工具', exact: true }).click()
      const popup = page.locator('.hep-search-popup'); await popup.waitFor()
      const measurement = await popup.evaluate(element => { const r = element.getBoundingClientRect(), summary = element.querySelector('small')!, style = getComputedStyle(summary); return { width: r.width, left: r.left, right: r.right, viewport: innerWidth, lines: style.webkitLineClamp, summaryHeight: summary.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), background: getComputedStyle(element).background } })
      check('下拉受视口约束', measurement.left >= 11 && measurement.right <= measurement.viewport - 11, measurement)
      check('下拉宽度满足上下文', measurement.width >= Math.min(560, width - 24), measurement)
      check('摘要最多两行', measurement.lines === '2' && measurement.summaryHeight <= measurement.lineHeight * 2 + 1, measurement)
      await popup.getByRole('textbox', { name: '搜索工具', exact: true }).fill('描述末尾检索词')
      check('完整描述参与搜索', await popup.getByRole('option').count() === 1)
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
      await popup.waitFor({ state: 'hidden' })
      check('键盘选择后焦点回选择框', await page.getByRole('combobox', { name: '工具', exact: true }).evaluate(element => document.activeElement === element))
      const details = page.locator('.mcp-debug-description').first(); await details.locator('summary').click()
      check('完整工具说明可展开', await details.locator(':scope > p').isVisible() && await details.locator(':scope > p').textContent() === longDescription)
      await shot(`${width}-${preference}-description-expanded`); await details.locator('summary').click()
      await page.getByRole('combobox', { name: '工具', exact: true }).click(); await shot(`${width}-${preference}-menu`); await page.keyboard.press('Escape')
      check('Escape关闭菜单并返焦', await page.getByRole('combobox', { name: '工具', exact: true }).evaluate(element => document.activeElement === element))
    })
  }
  if (!process.argv.includes('--visual-only')) await run('real-readonly-discovery', async () => {
    useRealDiscovery = true; await page.setViewportSize({ width: 1440, height: 1000 })
    const discovered = page.waitForResponse(response => pathname(response.url()) === '/hep/api/mcp-manager' && requestBody(response.request()).action === 'test', { timeout: 35000 })
    await page.getByRole('button', { name: '发现工具与资源', exact: true }).click()
    await discovered
    check('真实发现单独留存，不计入模拟业务通过', !!report.realDiscovery)
    await shot('real-readonly-discovery')
  })
} catch (error: any) { fatal = error; report.fatal = error.message.slice(0, 350); await shot('fatal').catch(() => {}) }
finally {
  phase = 'restore-theme'
  if (initialTheme) {
    try { await theme(initialTheme); report.finalThemePreference = await page.locator('html').getAttribute('data-ds-theme-source'); report.finalDark = await page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')); check('精确恢复主题偏好', report.finalThemePreference === initialTheme && report.finalDark === initialDark) }
    catch (error: any) { report.restoreFailure = error.message.slice(0, 300) }
  }
  report.rerunScope = process.argv.includes('--visual-only') ? '仅补跑初次strict locator中断的6组视觉分支；先前功能阶段不重复' : '完整初次验收';
  report.finishedAt = new Date().toISOString(); report.passed = !fatal && !report.restoreFailure && report.phases.every((item: any) => item.ok) && report.checks.every((item: any) => item.ok) && !report.errors.length
  writeFileSync(directory + '/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await browser.close()
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, failedChecks: report.checks.filter((item: any) => !item.ok).map((item: any) => item.name), phasesFailed: report.phases.filter((item: any) => !item.ok), errors: report.errors, themeRestored: report.finalThemePreference === initialTheme, fatal: report.fatal }))
  if (!report.passed) process.exitCode = 1
}
