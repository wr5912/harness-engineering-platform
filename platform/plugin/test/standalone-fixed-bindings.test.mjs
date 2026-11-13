import test from 'node:test'
import assert from 'node:assert/strict'
import { fixedCompositionToolName, registerFixedCompositionTools } from '../src/workflows/fixed-composition.ts'

const binding = { group_id: 'business', group_link_version: 2, group_target_digest: 'a'.repeat(64), tool_name: 'query_asset_alerts', compositionId: 'asset-alerts', versionId: 'b'.repeat(64), expectedImplementationDigest: 'c'.repeat(64), input_schema: { type: 'object' } }
function fixture(options = {}) {
  const tools = new Map(), observed = []
  let connection = { url: 'http://platform.test/hep/mcp/groups/business/v2', headers: { Authorization: 'Bearer configured' } }, closed = false
  const context = {
    tools: { register(tool) { tools.set(tool.name, tool) }, get() { return {} } },
    mcpSessionManager: { groupConnection(id, version) { assert.equal(id, binding.group_id); assert.equal(version, 2); return connection } },
  }
  const aliases = registerFixedCompositionTools(context, { business_tool: binding }, { clientFactory: async (url, token, signal, headers) => {
    assert.equal(url, connection.url); assert.equal(token, ''); assert.deepEqual(headers, connection.headers); signal.throwIfAborted()
    return {
      listTools: async () => {
        if (options.changeConnection) connection = { ...connection, url: 'http://changed.test/mcp' }
        return { tools: [{ name: binding.tool_name, _meta: { 'io.deepseek.dsh/mcp-group-tool': { serverId: 'platform-compositions', kind: 'tool', sourceName: binding.tool_name } } }], _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: binding.group_target_digest } } }
      },
      callTool: async params => { observed.push(params); return { content: [], structuredContent: { version: { versionId: options.wrongVersion ? 'd'.repeat(64) : binding.versionId, implementationDigest: binding.expectedImplementationDigest } } } },
      close: async () => { closed = true },
    }
  } })
  return { alias: aliases.get('business_tool'), observed, closed: () => closed,
    execute: () => tools.get(aliases.get('business_tool')).execute({}, { signal: new AbortController().signal, agent: { session: { id: 'session-one' } }, callId: 'call-one' }) }
}
test('独立客户端通过平台连接执行固定版本，保留工具身份和实际执行回执', async () => {
  const f = fixture()
  assert.equal(f.alias, fixedCompositionToolName('business_tool', binding))
  assert.notEqual((await f.execute()).isError, true)
  assert.equal(f.observed[0]._meta.harness.versionId, binding.versionId)
  assert.equal(f.observed[0]._meta.harness.expectedImplementationDigest, binding.expectedImplementationDigest)
  assert.equal(f.observed[0]._meta.harness.execution.session_id, 'session-one')
  assert.equal(f.closed(), true)
})
test('平台返回其他版本不能被当作固定版本成功', async () => {
  const f = fixture({ wrongVersion: true })
  assert.equal((await f.execute()).isError, true)
  assert.equal(f.closed(), true)
})
test('发现期间连接改变时不调用其他目标，关闭原客户端', async () => {
  const f = fixture({ changeConnection: true })
  await assert.rejects(f.execute(), /固定组合执行失败/)
  assert.equal(f.observed.length, 0)
  assert.equal(f.closed(), true)
})
