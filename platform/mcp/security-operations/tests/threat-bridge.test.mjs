import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createThreatBridge } from '../src/threat/bridge.ts'

test('原生网关仅接受本轮授权、catalog工具和指定报告入口，并传递取消', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threat-bridge-'))
  const tool = 'ai_soc_asset__get_soc_asset_by_asset_id'
  await writeFile(join(root, '.current-ai_soc_asset-tools.local.json'), JSON.stringify({ items: [{ name: tool }] }))
  const calls = [], controller = new AbortController()
  const bindings = { socConnectionId: 'soc-basic', reportConnectionId: 'report-basic' }
  const bridge = await createThreatBridge(root, bindings, {
    async invoke(connection, name, args, signal) {
      signal.throwIfAborted(); calls.push({ connection, name, args })
      return { content: [{ type: 'text', text: JSON.stringify({ code: 200, data: { status: 'ONLINE' } }) }] }
    },
  }, controller.signal)
  const request = (body, key = bridge.key) => fetch(bridge.runtime + '/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body),
  })
  try {
    const query = { resource: 'ai_soc_asset', tool, args: { assetId: 9106 } }
    assert.equal((await request(query, 'invalid')).status, 403)
    assert.equal((await request({ ...query, resource: 'other' })).status, 422)
    assert.equal((await request({ ...query, tool: 'ai_soc_asset__unknown' })).status, 422)
    assert.equal((await request({ resource: 'report-write', tool: 'other', args: {} })).status, 422)
    assert.equal(calls.length, 0)
    assert.deepEqual((await (await request(query)).json()).result.data, { status: 'ONLINE' })
    await request({ resource: 'report-write', tool: 'save_persistence_result', args: { businessId: 'basic-report' } })
    assert.deepEqual(calls.map(call => call.connection), ['soc-basic', 'report-basic'])
    controller.abort()
    assert.equal((await request(query)).status, 502)
    assert.equal(calls.length, 2)
  } finally { bridge.close(); await rm(root, { recursive: true, force: true }) }
})

test('原生网关保留 MCP 错误回执的可展示原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threat-bridge-error-'))
  const tool = 'ai_soc_asset__get_soc_asset_by_asset_id'
  await writeFile(join(root, '.current-ai_soc_asset-tools.local.json'), JSON.stringify({ items: [{ name: tool }] }))
  const bridge = await createThreatBridge(root, { socConnectionId: 'soc-error', reportConnectionId: 'report-error' }, {
    async invoke() { return { isError: true, content: [{ type: 'text', text: '上游 HTTP 502：连接暂不可用' }] } },
  }, new AbortController().signal)
  try {
    const response = await fetch(bridge.runtime + '/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bridge.key },
      body: JSON.stringify({ resource: 'ai_soc_asset', tool, args: { assetId: 9106 } }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      status: 'error', status_code: 502,
      result: { code: 502, data: null, message: 'MCP 工具返回错误：上游 HTTP 502：连接暂不可用' },
    })
  } finally { bridge.close(); await rm(root, { recursive: true, force: true }) }
})
