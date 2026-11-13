import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.HARNESS_BROWSER_MODULE || 'playwright-core')
import { renderInspectionReport } from '../src/reports/inspection.ts'
import { renderDocument } from '../src/reports/common.ts'

const section = (kind, items) => ({ kind, status: 'completed', counts: { normal: 0, abnormal: 0, unknown: 0, not_applicable: 0, failed: 0 }, items })
const inspection = {
  kind: 'deep', status: 'completed', execution_status: 'completed', run_id: 'browser-fixture', generated_at: '2026-11-12T01:02:03.123Z',
  scope: { count: 2, assetIds: [11, 12], frozen_at: '2026-11-12T01:00:00.456Z', requested: { assetIds: [11, 12] } },
  checks: {
    status: section('status', [{ assetId: 11, ip: '192.0.2.11', status: 'abnormal', facts: { online: 'offline' }, message: '设备离线' }, { assetId: 12, ip: '192.0.2.12', status: 'normal', facts: { online: 'online' } }]),
    baseline: section('baseline', [{ assetId: 11, status: 'unknown', reasonCode: 'NO_TEMPLATE' }, { assetId: 12, status: 'normal' }]),
    reachability: section('reachability', [{ ruleId: 'R-11', status: 'abnormal', srcIp: '192.0.2.11', dstIp: '192.0.2.12', recommendation: '按A4：核对实际路径与策略' }]),
    vulnerabilities: section('vulnerabilities', [{ assetId: 11, status: 'abnormal', findings: [{ identity: 'CVE-BROWSER-1', observations: [{ sourceAssetId: 11, record: { cveId: 'CVE-BROWSER-1' } }] }] }]),
  },
}
const otherReport = renderDocument({
  kind: 'fault', title: '其他报告默认行为回归',
  content: '<input id="report-search"><table><tbody><tr data-record="fault-1" data-category="设备"><td>一</td></tr><tr data-record="fault-2" data-category="业务"><td>二</td></tr></tbody></table><section data-evidence-panel="fault-1" hidden>一详情</section><section data-evidence-panel="fault-2" hidden>二详情</section>',
  printContent: '<p>离线测试</p>', interaction: 'fault',
})

test('inspection in-browser defaults, filtering, explicit evidence and independent detail groups', async () => {
  const browser = await chromium.launch({ executablePath: process.env.HARNESS_BROWSER_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(renderInspectionReport(inspection), { waitUntil: 'load' })
    assert.equal(await page.locator('[data-evidence-panel][hidden]').count(), await page.locator('[data-evidence-panel]').count())
    assert.equal(await page.locator('tr[data-record].selected').count(), 0)
    for (const id of ['inspection-identity-details', 'inspection-device-details', 'inspection-rule-details', 'inspection-vulnerability-details', 'inspection-evidence-details']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), false)
    await page.locator('#inspection-evidence-details > summary').click()
    assert.equal(await page.locator('#inspection-evidence-prompt').textContent(), '选择记录查看证据')
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 0)
    const firstId = await page.locator('button[data-open-evidence]').first().getAttribute('data-open-evidence')
    await page.locator('button[data-filter="漏洞"]').click()
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 0)
    assert.equal(await page.locator('tr[data-record].selected').count(), 0)
    const visibleButton = page.locator('tr[data-record]:visible button[data-open-evidence]').first()
    const selectedId = await visibleButton.getAttribute('data-open-evidence')
    await visibleButton.click()
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 1)
    assert.equal(await page.locator('[data-evidence-panel]:visible').getAttribute('data-evidence-panel'), selectedId)
    assert.equal(await page.locator('#inspection-evidence-prompt').isVisible(), false)
    assert.equal(await page.locator(`tr[data-record="${selectedId}"].selected`).count(), 1)
    await page.locator('button[data-filter="全部"]').click()
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 1)
    assert.equal(await page.locator('[data-evidence-panel]:visible').getAttribute('data-evidence-panel'), selectedId)
    await page.locator('button[data-filter="基线"]').click()
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 0)
    assert.equal(await page.locator('tr[data-record].selected').count(), 0)
    await page.locator('button[data-filter="全部"]').click()
    assert.equal(await page.locator('[data-evidence-panel]:visible').count(), 0)
    assert.equal(await page.locator('tr[data-record].selected').count(), 0)
    const firstScreen = await page.locator('main.report-inspection > section').evaluateAll(nodes => nodes.slice(0, 3).map(node => node.innerText).join('\n'))
    assert.doesNotMatch(firstScreen, /源检查结果状态|展示核对|A1|A3|A4|按\s*A[1-4]/)
    assert.match(firstScreen, /检查执行状态/)
    assert.match(firstScreen, /冻结范围/)
    assert.ok(firstId)
    for (const id of ['inspection-device-details', 'inspection-rule-details', 'inspection-vulnerability-details']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), false)
    assert.equal(await page.locator('#inspection-evidence-details').evaluate(node => node.open), true)
    await page.locator('#inspection-identity-details > summary').click()
    assert.equal(await page.locator('#inspection-identity-details').evaluate(node => node.open), true)
    for (const id of ['inspection-device-details', 'inspection-rule-details', 'inspection-vulnerability-details']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), false)
    assert.equal(await page.locator('#inspection-evidence-details').evaluate(node => node.open), true)

    const other = await browser.newPage()
    await other.setContent(otherReport, { waitUntil: 'load' })
    assert.equal(await other.locator('[data-evidence-panel]:visible').count(), 1)
    assert.equal(await other.locator('[data-evidence-panel]:visible').getAttribute('data-evidence-panel'), 'fault-1')
  } finally { await browser.close() }
})

test('read-only saved Run rendering creates distinct review HTML files with byte digests', async () => {
  const output = '/tmp/inspection-review-fixtures-20261112'
  const { mkdirSync, writeFileSync, readFileSync: readExisting } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  mkdirSync(output, { recursive: true })
  const cases = [
    ['routine', { ...inspection, kind: 'routine', run_id: 'routine-fixture' }],
    ['deep', inspection],
  ]
  const reports = []
  for (const [name, result] of cases) {
    const file = `${output}/${name}-run.json`
    const original = JSON.stringify({ status: 'completed', result })
    writeFileSync(file, original)
    const run = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(run.status, 'completed')
    assert.equal(run.result?.kind, name)
    const html = renderInspectionReport(run.result)
    assert.equal(readFileSync(file, 'utf8'), original)
    const bytes = Buffer.from(html, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const path = `${output}/${name}-review-${sha256.slice(0, 12)}.html`
    try { assert.deepEqual(readExisting(path), bytes, '同摘要测试产物必须保持原字节') } catch (error) { if (error.code !== 'ENOENT') throw error; writeFileSync(path, bytes) }
    assert.equal(createHash('sha256').update(readExisting(path)).digest('hex'), sha256)
    reports.push({ path, bytes: bytes.byteLength, sha256 })
  }
  assert.equal(reports.length, 2)
  assert.ok(reports.every(item => item.bytes > 0 && /^[a-f0-9]{64}$/.test(item.sha256)))
})
