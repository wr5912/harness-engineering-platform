import test from 'node:test'
import assert from 'node:assert/strict'
import { artifacts } from '../src/inspection/index.ts'
import { buildInspectionOperations } from '../src/reports/inspection-operations.ts'

test('同一结构化结果同时生成完整HTML、短聊天Markdown、完整Markdown与JSON，不修改原结果或伪造下载', () => {
  const result = { kind: 'status', run_id: 'offline-artifact-contract', scope: { count: 2, assetIds: [1, 2] }, items: [
    { assetId: 1, hostname: '设备1', ip: '192.0.2.1', status: 'abnormal', facts: { online: 'offline' }, message: '离线' },
    { assetId: 2, hostname: '设备2', ip: 'any', status: 'unknown', facts: { online: 'unknown' }, message: 'SOC未采集到状态数据' },
  ] }
  const before = JSON.stringify(result), outputs = artifacts(result)
  assert.deepEqual(outputs.map(x => x.id), ['report', 'details', 'chat', 'markdown'])
  const html = outputs.find(x => x.id === 'report'), chat = outputs.find(x => x.id === 'chat'), markdown = outputs.find(x => x.id === 'markdown'), json = JSON.parse(outputs.find(x => x.id === 'details').body)
  assert.equal(html.contentType, 'text/html; charset=utf-8')
  assert.equal(markdown.contentType, 'text/markdown; charset=utf-8')
  assert.equal(JSON.stringify(result), before)
  assert.equal(json.run_id, result.run_id)
  assert.equal(buildInspectionOperations(json).counts.devices, 2)
  for (const body of [html.body, markdown.body]) {
    assert.ok(body.includes('offline-artifact-contract'))
    assert.ok(body.includes('设备1'))
    assert.ok(body.includes('A1'))
    assert.ok(body.includes('验证'))
    assert.ok(body.includes('地址待核实'))
    assert.doesNotMatch(body, /download_url|\{\{html_download_url\}\}/)
  }
  assert.ok(chat.body.includes('offline-artifact-contract'))
  assert.ok(chat.body.includes('巡检概览（30秒速读）'))
  assert.ok(chat.body.includes('主要问题与处理建议'))
  assert.ok(chat.body.includes('设备离线（1 台）'))
  assert.ok(chat.body.includes('验证'))
  assert.ok(chat.body.includes('本次未执行扫描、修复、配置变更或处置'))
  assert.ok(chat.body.includes('unknown（未知）'))
  assert.doesNotMatch(chat.body, /A1｜|\| D\d+ \||设备1|<pre>|<table/)
  assert.match(html.body, /^<!doctype html>/)
  assert.match(html.body, /data-report-kind="inspection"/)
})
