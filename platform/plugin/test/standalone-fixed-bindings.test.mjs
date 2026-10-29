import test from 'node:test'
import assert from 'node:assert/strict'
import { fixedCompositionToolName, registerFixedCompositionTools } from '../src/workflows/fixed-composition.ts'

const original = { group_id: 'business', group_link_version: 2, group_target_digest: 'a'.repeat(64), tool_name: 'query_asset_alerts', compositionId: 'asset-alerts', versionId: 'b'.repeat(64), expectedImplementationDigest: 'c'.repeat(64), input_schema: { type: 'object' } }

test('部署绑定改变目标与执行摘要，保留原工具别名、版本及真实执行回执校验', async () => {
  const tools = new Map(), observed = []
  const projected = { ...original, group_target_digest: 'd'.repeat(64), expectedImplementationDigest: 'e'.repeat(64) }
  const context = {
    standaloneBindings: { resolve(name, binding) { assert.equal(name, 'business_tool'); assert.deepEqual(binding, original); return projected } },
    tools: { register(tool) { tools.set(tool.name, tool) }, get() { return {} } },
    mcpSessionManager: {
      currentGroup() { return { token: 'configured', targetDigest: projected.group_target_digest } },
      async listGroupTools() { return { tools: [{ name: original.tool_name, _meta: { 'io.deepseek.dsh/mcp-group-tool': { serverId: 'platform-compositions', kind: 'tool', sourceName: original.tool_name } } }], _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: projected.group_target_digest } } } },
      async callGroupTool(_id, _version, _name, _args, meta) { observed.push(meta); return { isError: false, content: [], structuredContent: { version: { versionId: original.versionId, implementationDigest: projected.expectedImplementationDigest } } } },
    },
  }
  const aliases = registerFixedCompositionTools(context, { business_tool: original })
  assert.equal(aliases.get('business_tool'), fixedCompositionToolName('business_tool', original))
  const result = await tools.get(aliases.get('business_tool')).execute({}, { signal: new AbortController().signal, agent: { session: { id: 'session-one' } }, callId: 'call-one' })
  assert.equal(result.isError, false)
  assert.equal(observed[0].harness.versionId, original.versionId)
  assert.equal(observed[0].harness.expectedImplementationDigest, projected.expectedImplementationDigest)
})

test('部署投影不能把固定业务版本静默替换成另一版本', async () => {
  const tools = new Map()
  const context = { tools: { register(tool) { tools.set(tool.name, tool) } }, standaloneBindings: { resolve(_name, binding) { return { ...binding, versionId: 'f'.repeat(64) } } } }
  const alias = registerFixedCompositionTools(context, { business_tool: original }).get('business_tool')
  await assert.rejects(tools.get(alias).execute({}, { signal: new AbortController().signal }), /不得改变固定组合/)
})
