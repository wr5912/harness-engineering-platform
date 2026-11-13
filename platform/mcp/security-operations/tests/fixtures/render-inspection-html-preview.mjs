// 仅渲染附件可见内容离线复现 fixture；不创建 Run、不注册附件、不访问网络。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { buildInspectionOperations, renderInspectionMarkdown } from '../../src/reports/inspection-operations.ts'
import { renderInspectionReport } from '../../src/reports/inspection.ts'

globalThis.fetch = () => { throw new Error('离线样例禁止联网') }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const directory = path.join(root, 'agents/security-operations-expert/docs/reporting-preview')
const result = JSON.parse(fs.readFileSync(path.join(directory, 'attachment-visible.fixture.json'), 'utf8'))
const model = buildInspectionOperations(result)
assert.equal(model.devices.length, 91)
assert.equal(new Set(model.devices.map(device => device.assetId)).size, 91)
assert.equal(model.rules.length, 6)
assert.equal(model.counts.vulnerabilityRecords, 740)
assert.equal(model.counts.abnormalDevices, 28)
assert.equal(model.counts.offlineDevices, 25)
assert.equal(model.counts.gapDevices, 0)
assert.equal(new Set(model.socStateGroups.flatMap(group => group.deviceIds)).size, 82)
assert.deepEqual(Object.fromEntries(model.socStateGroups.map(group => [group.reason, group.deviceIds.length])), { NO_TEMPLATE: 31, NO_DATA: 51 })
assert.equal(new Set(model.gapGroups.flatMap(group => group.ruleIds)).size, 4)
assert.equal(model.gapGroups.some(group => ['NO_TEMPLATE', 'NO_DATA'].includes(group.reason)), false)
assert.equal(model.reportId, undefined)
assert.equal(model.runId, undefined)
const markdown = renderInspectionMarkdown(result)
const html = renderInspectionReport(result)
assert.equal((markdown.match(/^\| D\d+/gm) ?? []).length, 28)
assert.match(html, /<!doctype html>/i)
assert.match(html, /<\/html>\s*$/i)
assert.ok(html.includes('CVE-1999-0524'))
assert.ok(html.includes('opensearch:ocsf-findings-'))
fs.writeFileSync(path.join(directory, '安全巡检报告_离线样例.md'), markdown)
fs.writeFileSync(path.join(directory, '安全巡检报告_离线样例.html'), html)
console.log(JSON.stringify({ counts: model.counts, socStateGroups: model.socStateGroups.map(group => ({ reason: group.reason, devices: group.deviceIds.length })), incompleteRules: new Set(model.gapGroups.flatMap(group => group.ruleIds)).size, htmlBytes: Buffer.byteLength(html), markdownBytes: Buffer.byteLength(markdown), coverageNotes: model.coverageNotes }, null, 2))
