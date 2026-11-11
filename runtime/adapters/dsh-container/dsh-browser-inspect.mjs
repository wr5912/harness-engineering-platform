#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const MAX_SNAPSHOT = 12000
let stage = 'input'
const locatorKinds = new Set(['role', 'label', 'text', 'placeholder', 'test_id'])
const actionKinds = new Set(['click', 'fill', 'press', 'wait_for'])
const screenshotScopes = new Set(['viewport', 'full_page', 'element'])

function diagnostic(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
    .replace(/https?:\/\/\S+/g, '<目标地址>')
    .slice(0, 500)
}

async function input() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || typeof value.target_url !== 'string'
    || !/^https?:\/\/[^\s]+$/.test(value.target_url) || typeof value.evidence_root !== 'string'
    || !Array.isArray(value.actions) || !value.screenshot) throw new Error('检查请求格式无效')
  if (value.actions.length > 12) throw new Error('页面操作数量超过 12 个')
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1000 || value.timeout_ms > 120000) throw new Error('页面检查超时时间无效')
  for (const item of value.actions) {
    if (!item || typeof item !== 'object' || !actionKinds.has(item.action)) throw new Error('页面操作类型不受支持')
    if (item.action === 'wait_for') {
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500) throw new Error('等待文本无效')
    } else {
      if (!item.locator || !locatorKinds.has(item.locator.kind) || typeof item.locator.value !== 'string'
        || !item.locator.value.trim() || item.locator.value.length > 240) throw new Error('页面定位器无效')
      if (item.locator.name !== undefined && (typeof item.locator.name !== 'string' || !item.locator.name.trim() || item.locator.name.length > 240)) throw new Error('页面定位器名称无效')
      if (item.action === 'fill' && (typeof item.value !== 'string' || item.value.length > 4096)) throw new Error('填充内容无效')
      if (item.action === 'press' && (typeof item.key !== 'string' || !item.key.trim() || item.key.length > 80)) throw new Error('按键无效')
    }
  }
  if (!screenshotScopes.has(value.screenshot.scope)
    || (value.screenshot.scope === 'element' && (!value.screenshot.locator || !locatorKinds.has(value.screenshot.locator.kind)
      || typeof value.screenshot.locator.value !== 'string' || !value.screenshot.locator.value.trim() || value.screenshot.locator.value.length > 240))) throw new Error('截图范围无效')
  return value
}

function locator(page, value) {
  const options = { exact: value.exact === true }
  if (value.kind === 'role') return page.getByRole(value.value, value.name ? { name: value.name, exact: value.exact === true } : options)
  if (value.kind === 'label') return page.getByLabel(value.value, options)
  if (value.kind === 'text') return page.getByText(value.value, options)
  if (value.kind === 'placeholder') return page.getByPlaceholder(value.value, options)
  if (value.kind === 'test_id') return page.getByTestId(value.value)
  throw new Error('页面定位器类型不受支持')
}

function assertSameOrigin(page, origin) {
  if (new URL(page.url()).origin !== origin) throw new Error('页面操作跳转到了未登记的站点')
}

function safePageUrl(value) {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.search = ''
  return url.href
}

async function snapshot(page) {
  if (typeof page.locator('body').ariaSnapshot === 'function') {
    try { return (await page.locator('body').ariaSnapshot({ timeout: 5000 })).slice(0, MAX_SNAPSHOT) } catch { /* fallback below */ }
  }
  return (await page.locator('body').innerText({ timeout: 5000 })).slice(0, MAX_SNAPSHOT)
}

async function inspect(value) {
  const evidence = value.evidence_root
  await mkdir(evidence, { recursive: true })
  const screenshotFile = 'screenshot.png'
  const traceFile = 'trace.zip'
  const actionsFile = 'actions.json'
  const snapshotFile = 'snapshot.txt'
  const resultFile = 'result.json'
  const target = new URL(value.target_url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('页面入口地址无效')
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'UTC' })
  const page = await context.newPage()
  const origin = target.origin
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  try {
    stage = 'navigation'
    await page.goto(value.target_url, { waitUntil: 'domcontentloaded', timeout: value.timeout_ms })
    assertSameOrigin(page, origin)
    stage = 'action'
    for (const item of value.actions) {
      if (item.action === 'wait_for') await page.getByText(item.text, { exact: false }).waitFor({ state: 'visible', timeout: value.timeout_ms })
      else if (item.action === 'click') await locator(page, item.locator).click({ timeout: value.timeout_ms })
      else if (item.action === 'fill') await locator(page, item.locator).fill(item.value, { timeout: value.timeout_ms })
      else if (item.action === 'press') await locator(page, item.locator).press(item.key, { timeout: value.timeout_ms })
      assertSameOrigin(page, origin)
    }
    stage = 'screenshot'
    if (value.screenshot.scope === 'element') await locator(page, value.screenshot.locator).screenshot({ path: join(evidence, screenshotFile), timeout: value.timeout_ms })
    else await page.screenshot({ path: join(evidence, screenshotFile), fullPage: value.screenshot.scope === 'full_page', timeout: value.timeout_ms })
    const text = await snapshot(page)
    await writeFile(join(evidence, actionsFile), JSON.stringify(value.actions.map(item => item.action === 'fill' ? { ...item, value: '<已填入>' } : item), null, 2))
    await writeFile(join(evidence, snapshotFile), text)
    const result = { ok: true, stage: 'completed', page_url: safePageUrl(page.url()), screenshot_file: screenshotFile, snapshot_file: snapshotFile, actions_file: actionsFile, trace_file: traceFile }
    await context.tracing.stop({ path: join(evidence, traceFile) })
    await writeFile(join(evidence, resultFile), JSON.stringify(result, null, 2))
    return { ...result, evidence: { files: [screenshotFile, snapshotFile, actionsFile, traceFile, resultFile] } }
  } catch (error) {
    const failure = { ok: false, stage, error: { code: `browser_${stage}`, message: diagnostic(error) }, evidence: { files: [] } }
    try { await context.tracing.stop({ path: join(evidence, traceFile) }); failure.evidence.files.push(traceFile) } catch { /* preserve primary failure */ }
    try { await writeFile(join(evidence, resultFile), JSON.stringify(failure, null, 2)); failure.evidence.files.push(resultFile) } catch { /* preserve primary failure */ }
    return failure
  } finally {
    await context.close()
    await browser.close()
  }
}

try {
  const value = await input()
  const result = await inspect(value)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, stage, error: { code: `browser_${stage}`, message: diagnostic(error) } })}\n`)
  process.exitCode = 2
}
