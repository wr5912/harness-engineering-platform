import assert from 'node:assert/strict'
import test from 'node:test'
import { registerFixedCompositionTools } from '../src/workflows/fixed-composition.ts'

const digest = 'a'.repeat(64)
const versionId = 'b'.repeat(64)
const implementationDigest = 'c'.repeat(64)
const binding = {
  group_id: 'research-tools', group_link_version: 2, group_target_digest: digest,
  tool_name: 'query_asset_alerts', compositionId: 'asset-alerts',
  versionId, expectedImplementationDigest: implementationDigest, input_schema: { type: 'object' },
}

test('v2 固定组合在原生工具身份下调用同进程分组并核对版本', async () => {
  const registered = new Map(), observed = []
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) }, get(name) { return name === 'query_asset_alerts' ? { name } : undefined } },
    mcpSessionManager: {
      currentGroup(id, version) { observed.push(['current', id, version]); return { token: 'configured', targetDigest: digest } },
      async listGroupTools(id, version) { observed.push(['list', id, version]); return {
        tools: [{ name: binding.tool_name, _meta: { 'io.deepseek.dsh/mcp-group-tool': {
          serverId: 'platform-compositions', kind: 'tool', sourceName: binding.tool_name } } }], _meta: { 'io.deepseek.dsh/mcp-group-target': { digest } },
      } },
      async callGroupTool(id, version, name, args, meta, exec) {
        observed.push(['call', id, version, name, args, meta, exec])
        return { isError: false, content: [], structuredContent: { version: { versionId, implementationDigest } } }
      },
    },
  }
  const alias = registerFixedCompositionTools(ctx, { query_asset_alerts: binding }).get('query_asset_alerts')
  const exec = { signal: new AbortController().signal, callId: 'call-1', agent: { session: { id: 'session-1' } } }
  const result = await registered.get(alias).execute({ asset: 'asset-1' }, exec)
  assert.equal(result.isError, false)
  const call = observed.find(row => row[0] === 'call')
  assert.deepEqual(call.slice(1, 5), [binding.group_id, 2, binding.tool_name, { asset: 'asset-1' }])
  assert.equal(call[5]['io.deepseek.dsh/mcp-group-target'].digest, digest)
  assert.equal(call[5].harness.execution.session_id, 'session-1')
  assert.equal(call[6], exec)
})

test('v2 固定组合拒绝摘要漂移且不调用分组工具', async () => {
  let called = false
  const registered = new Map()
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) }, get() { return {} } },
    mcpSessionManager: {
      currentGroup() { return { token: 'configured', targetDigest: 'd'.repeat(64) } },
      async listGroupTools() { called = true; return { tools: [] } },
      async callGroupTool() { called = true },
    },
  }
  const alias = registerFixedCompositionTools(ctx, { query_asset_alerts: binding }).get('query_asset_alerts')
  await assert.rejects(registered.get(alias).execute({}, {
    signal: new AbortController().signal, callId: 'call-2', agent: { session: { id: 'session-2' } },
  }), /已变化/)
  assert.equal(called, false)
})

test('v2 固定组合不把其他来源的同名工具作为当前组合', async () => {
  const registered = new Map()
  let called = false
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) }, get() { return {} } },
    mcpSessionManager: {
      currentGroup() { return { token: 'configured', targetDigest: digest } },
      async listGroupTools() { return { tools: [{ name: binding.tool_name, _meta: {
        'io.deepseek.dsh/mcp-group-tool': { serverId: 'another-source', kind: 'tool', sourceName: binding.tool_name },
      } }], _meta: { 'io.deepseek.dsh/mcp-group-target': { digest } } } },
      async callGroupTool() { called = true },
    },
  }
  const alias = registerFixedCompositionTools(ctx, { query_asset_alerts: binding }).get('query_asset_alerts')
  await assert.rejects(registered.get(alias).execute({}, {
    signal: new AbortController().signal, callId: 'call-3', agent: { session: { id: 'session-3' } },
  }), /固定组合执行失败/)
  assert.equal(called, false)
})
