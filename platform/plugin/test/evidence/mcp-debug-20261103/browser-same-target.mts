import { chromium } from '/home/admin/work/cross-framework-sources/dsh/apps/web/node_modules/playwright/index.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// 单独补验归一化目标身份，不重跑其余已通过功能和视觉路径。
const origin = 'http://10.0.160.32:18120'
const activation = JSON.parse(readFileSync('.local/mcp-debug-20261103/activation.json', 'utf8'))
const directory = '.local/mcp-debug-20261103/same-target-' + new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const report: any = { at: new Date().toISOString(), scope: '真实18120认证/配置/客户端；仅MCP发现和一个工具调用在浏览器HTTP边界模拟。无server_id默认目标与显式重选同ID的在途回执连续性；主题不变，无实际业务调用。', checks: [], errors: [], blockedWrites: [], scriptResponses: [], screenshots: [], toolCalls: 0, templateCalls: 0, discoveries: 0, subphases: [], expectedClientSha256: activation.clientSha256 }
const browser = await chromium.launch({ headless: true, executablePath: '/home/admin/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.setDefaultTimeout(10000)
let release: (() => void) | undefined, started: (() => void) | undefined, initialTheme: string | null = null
const replyGate = new Promise<void>(resolve => { release = resolve })
const callStarted = new Promise<void>(resolve => { started = resolve })
const scriptBodies: Promise<void>[] = []
const loadedScriptBuffers: Array<{ path: string; bytes: Buffer }> = []
const pathname = (url: string) => { try { return new URL(url).pathname } catch { return '' } }
const bodyOf = (request: any) => { try { return request.postDataJSON() ?? {} } catch { return {} } }
const forbidden = (path: string, method: string) => /(?:^|\/)(?:session|workspace)\/(?:create|fork|prompt|cancel|delete|archive|unarchive|update|rename|set|send)(?:\/|$)/.test(path + '/' + method)
  || /assistant\/(?:context|session|confirm|reject)$/.test(method)
  || /(?:^|\/)(?:save|saveConfiguration|apply|invoke|send|start|stop|restart|remove|delete|enable|disable|confirm|run|batch|publish|create|import|rotateCredential|issueCredential)(?:\/|$)/.test(method)
const check = (name: string, ok: unknown, detail?: unknown) => { report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) throw new Error(name) }
page.on('pageerror', error => report.errors.push(error.message.slice(0, 300)))
page.on('response', response => {
  if (response.request().resourceType() !== 'script') return
  scriptBodies.push((async () => {
    try { const bytes = await response.body(); loadedScriptBuffers.push({ path: pathname(response.url()), bytes }); report.scriptResponses.push({ path: pathname(response.url()), status: response.status(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) } catch { /* 导航结束的取消不被当作成功装载。 */ }
  })())
})
await context.route('**/*', async route => {
  const request = route.request(), path = pathname(request.url()), body = bodyOf(request)
  if (path === '/hep/api/mcp-manager' && request.method() === 'POST') {
    if (body.action === 'test') {
      report.discoveries++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tools: [{ name: 'same_target_probe', title: '同目标回执验证', description: '此工具只在浏览器UI边界模拟，不调用实际MCP。', inputSchema: { type: 'object', properties: { query: { type: 'string', default: 'same-target-ui-only' } } } }], resources: { resources: [] }, resourceTemplates: { resourceTemplates: [{ name: '原生类型模板', uriTemplate: 'fixture://typed/{id}{?limit,tags}', description: '模板变量支持原生JSON类型，由服务负责展开。' }] } }) }); return
    }
    if (body.action === 'callTool') {
      report.toolCalls++; report.toolName = body.toolName; started!(); await replyGate
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '同一目标的原请求回执已收到。' }] }) }); return
    }
    if (body.action === 'readResource') {
      report.templateCalls++; report.templateArguments = body.arguments; report.templateUri = body.uriTemplate
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contents: [{ uri: 'fixture://typed/1', text: '模板类型回执已收到。' }] }) }); return
    }
    report.blockedWrites.push({ path, action: body.action }); await route.abort('blockedbyclient'); return
  }
  if (request.method() !== 'GET' && forbidden(path, body.method ?? '')) { report.blockedWrites.push({ path, method: body.method }); await route.abort('blockedbyclient'); return }
  await route.continue()
})
try {
  const auth = await context.request.post(origin + '/hep/login', { form: JSON.parse(readFileSync('/home/admin/harness-engineering-platform-data/.local/credentials/admin.json', 'utf8')), headers: { origin }, maxRedirects: 0 })
  check('真实平台认证', auth.status() === 303)
  const sessionsResponse = await context.request.post(origin + '/hep/api/session/list', { headers: { origin }, data: { type: 'client-request', rpcId: 'mcp-ui-same-target-existing', method: 'session/list', payload: { args: { _request: {} } } } })
  const sessions = await sessionsResponse.json(), existing = sessions.result?.value?.items?.find((item: any) => !item.running && item.blank === false && item.cwd !== '/home/admin/harness-engineering-platform-data')
  if (existing) await context.addInitScript(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), existing.sessionId)
  report.existingSessionSelected = !!existing
  await page.goto(origin + '/hep/#/mcp?tab=connection', { waitUntil: 'domcontentloaded' })
  await page.locator('.mcp-debug-workbench').waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('.harness-account-name')?.textContent === 'admin')
  initialTheme = await page.locator('html').getAttribute('data-ds-theme-source'); report.initialThemePreference = initialTheme
  check('初始入口未显式指定server_id', !new URL(page.url()).hash.includes('server_id'))
  report.initialTargetLabel = (await page.getByRole('combobox', { name: '调试对象', exact: true }).innerText()).replace(/\s+/g, ' ').trim()
  await Promise.allSettled(scriptBodies)
  const referenceClient = readFileSync('platform/plugin/lib/client.js')
  check('本地client候选对应激活清单', createHash('sha256').update(referenceClient).digest('hex') === activation.clientSha256)
  let preparedText = referenceClient.toString('utf8').replace(/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, '').replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '')
  if (!preparedText.endsWith('\n')) preparedText += '\n'
  report.preparedClientSha256 = createHash('sha256').update(Buffer.from(preparedText)).digest('hex')
  const urlAdapterNeedle = 'fetch(new URL("api/mcp-manager", document.baseURI)'
  const urlAdapterReplacement = 'fetch(__harnessSiteUrl(new URL("api/mcp-manager", document.baseURI))'
  report.urlAdapterReplacements = preparedText.split(urlAdapterNeedle).length - 1
  report.urlAdapterRule = 'runtime/adapters/dsh-web/src/client-urls.ts:5 transformClientUrls将三处全局fetch的最终URL包装为__harnessSiteUrl；原生私有闭包不属于模块注册字节段'
  check('确认既有URL适配的三处网络目标', report.urlAdapterReplacements === 3)
  const preparedClient = Buffer.from(preparedText.replaceAll(urlAdapterNeedle, urlAdapterReplacement))
  report.expectedHttpModuleSha256 = createHash('sha256').update(preparedClient).digest('hex')
  report.preparationRule = '复用锁定原生packages/client/modules/src/index.ts:305-316、408-412：去sourceURL/sourceMappingURL尾注并确保末尾换行；聚合后另加分号换行'
  report.actualLoadedModuleCandidates = loadedScriptBuffers.flatMap(item => {
    const text = item.bytes.toString('utf8'), marker = 'window.__ModuleLoader__.load({id:"@ai-agent-harness/harness-platform",', start = text.indexOf(marker)
    const closing = '\nreturn module.exports;}});', end = start < 0 ? -1 : text.indexOf(closing, start)
    if (start < 0 || end < 0) return []
    const candidate = Buffer.from(text.slice(start, end + closing.length) + '\n')
    const extractedPath = directory + '/actual-client-extracted.js', aggregatePath = directory + '/actual-client-aggregate.js'
    writeFileSync(extractedPath, candidate, { mode: 0o600 }); writeFileSync(aggregatePath, item.bytes, { mode: 0o600 })
    return [{ path: item.path, bytes: candidate.length, sha256: createHash('sha256').update(candidate).digest('hex'), extractedPath, aggregatePath }]
  })
  report.matchingClientResponses = loadedScriptBuffers.flatMap(item => {
    const offset = item.bytes.indexOf(preparedClient)
    return offset < 0 ? [] : [{ path: item.path, responseBytes: item.bytes.length, clientOffset: offset, clientBytes: preparedClient.length,
      clientSha256: createHash('sha256').update(item.bytes.subarray(offset, offset + preparedClient.length)).digest('hex') }]
  })
  check('实际HTTP模块字节匹配激活制品及既有URL适配', report.matchingClientResponses.some((item: any) => item.clientSha256 === report.expectedHttpModuleSha256))
  await page.getByRole('button', { name: '发现工具与资源', exact: true }).click()
  await page.getByRole('combobox', { name: '工具', exact: true }).waitFor()
  await page.getByRole('button', { name: '调用工具', exact: true }).click()
  await Promise.race([callStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('未观察到模拟调用')), 10000))])
  await page.locator('.mcp-debug-result').getByText('正在请求，等待返回结果…', { exact: true }).waitFor()
  check('只有一个在途调用', report.toolCalls === 1)
  await page.getByRole('combobox', { name: '调试对象', exact: true }).click()
  const current = page.locator('.hep-search-popup').locator('[role=option][aria-selected=true]')
  check('默认目标在候选中有唯一身份', await current.count() === 1)
  report.reselectedTargetLabel = (await current.innerText()).replace(/\s+/g, ' ').trim()
  await current.click()
  await page.waitForTimeout(100)
  check('重选同一目标保留在途状态', await page.locator('.mcp-debug-result').getByText('正在请求，等待返回结果…', { exact: true }).isVisible())
  release!()
  await page.locator('.mcp-debug-result').getByText('调用完成', { exact: true }).waitFor()
  check('原请求回执仍显示完成', await page.locator('.mcp-debug-result').getByText('同一目标的原请求回执已收到。', { exact: true }).isVisible())
  check('没有重发调用或重新发现', report.toolCalls === 1 && report.discoveries === 1)
  report.subphases.push({ name: 'same-target-inflight-receipt', ok: true })
  const sameTargetShot = directory + '/same-target-completed.png'; await page.screenshot({ path: sameTargetShot, fullPage: true }); report.screenshots.push(sameTargetShot)
  await page.getByRole('navigation', { name: '能力类型', exact: true }).getByRole('button', { name: '资源模板', exact: true }).click()
  await page.getByRole('combobox', { name: '资源模板', exact: true }).click()
  await page.locator('.hep-search-popup').getByRole('option').first().click()
  await page.getByRole('textbox', { name: 'id JSON', exact: true }).fill('1')
  await page.getByRole('textbox', { name: 'limit JSON', exact: true }).fill('10')
  await page.getByRole('textbox', { name: 'tags JSON', exact: true }).fill('["x","y"]')
  check('模板数字数组没有前端类型错误', await page.locator('.mcp-debug-parameters .mcp-parameter-error').count() === 0)
  await page.getByRole('button', { name: '读取模板资源', exact: true }).click()
  await page.locator('.mcp-debug-result').getByText('模板类型回执已收到。', { exact: true }).waitFor()
  check('模板数字和数组实参保持原类型', report.templateArguments?.id === 1 && report.templateArguments?.limit === 10 && JSON.stringify(report.templateArguments?.tags) === '["x","y"]', report.templateArguments)
  check('模板仅模拟调用一次', report.templateCalls === 1 && report.toolCalls === 1 && report.discoveries === 1)
  report.subphases.push({ name: 'template-native-json-types', ok: true })
  report.finalThemePreference = await page.locator('html').getAttribute('data-ds-theme-source')
  check('主题偏好保持不变', report.finalThemePreference === initialTheme)
  const shot = directory + '/template-native-types-completed.png'; await page.screenshot({ path: shot, fullPage: true }); report.screenshots.push(shot)
} catch (error: any) { report.failure = error.message.slice(0, 500); const shot = directory + '/same-target-failed.png'; await page.screenshot({ path: shot, fullPage: true }).then(() => report.screenshots.push(shot)).catch(() => {}) }
finally {
  release?.(); await Promise.allSettled(scriptBodies)
  if (!report.finalThemePreference && initialTheme) report.finalThemePreference = await page.locator('html').getAttribute('data-ds-theme-source').catch(() => null)
  report.passed = !report.failure && !report.errors.length && report.checks.every((item: any) => item.ok)
  report.finishedAt = new Date().toISOString(); writeFileSync(directory + '/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await browser.close()
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, errors: report.errors, failure: report.failure, toolCalls: report.toolCalls, discoveries: report.discoveries, templateCalls: report.templateCalls, subphases: report.subphases, themeUnchanged: report.finalThemePreference === initialTheme }))
  if (!report.passed) process.exitCode = 1
}
