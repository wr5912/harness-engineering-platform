import '../../mcp/security-operations/test-bootstrap.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { lfxWorkflow } from '../src/mcp/lfx-runtime.ts'

const root = process.env.HARNESS_ASSET_ROOT ?? new URL('../../../../harness-engineering-platform-data/', import.meta.url).pathname
const { create } = await import(`${root}/mcp/compositions/troubleshooting-business-access/src/index.ts`)
const input = { source: { ip: '172.16.138.226', assetId: 3617426 }, target: { ip: '172.16.1.160', assetId: 3617438 }, protocol: 'tcp', port: 8834 }
const config = { workflow: 'troubleshooting-business-access', engine: 'lfx', title: '业务访问故障排查', connections: { master: 'm', detect: 'd', graph: 'g' } }
const assets = { '172.16.138.226': 3617426, '172.16.1.160': 3617438 }

function socStub(propose) {
  const calls = []
  const soc = async (_conn, operation, args) => {
    calls.push({ operation, args })
    if (operation === 'list_soc_asset') {
      const id = assets[args.ip]
      return { code: 200, total: id ? 1 : 0, rows: id ? [{ assetId: id, ip: args.ip }] : [] }
    }
    if (operation === 'get_soc_asset_by_asset_id') return { code: 200, data: { assetId: args.assetId, ip: args.assetId === 3617426 ? '172.16.138.226' : '172.16.1.160', online: true, stateEvidence: { signals: [] } } }
    if (operation === 'get_soc_asset_port_evidence') return { code: 200, data: { ip: args.ip, port: args.port, protocol: args.protocol, status: 'NO_RECORD', recordedAt: null, source: null, service: null } }
    if (operation === 'get_soc_asset_collection_capability') return { code: 200, data: { assetId: args.assetId, groups: [] } }
    if (operation === 'get_reachability_route_candidates') return { code: 200, data: { status: 'UNKNOWN', candidates: [], gaps: ['路由投影不完整'] } }
    return { code: 200, data: { status: 'UNKNOWN', candidates: [], gaps: ['无匹配'] } }
  }
  soc.fingerprint = id => `fixture:${id}`
  soc.describe = async () => ({ readonly: true, inputSchema: { type: 'object' } })
  soc.validateSchema = () => true
  soc.propose = propose
  soc.calls = calls
  return soc
}
async function run({ propose, budget, signal = AbortSignal.timeout(180_000) }) {
  const soc = socStub(propose)
  const workflow = lfxWorkflow(root, 'troubleshooting-business-access', create(soc), soc)
  const prepared = await workflow.prepare(input, config, signal)
  if (budget !== undefined) prepared.diagnostic_loop.proposal_budget_ms = budget
  const progress = []
  const context = { runId: 'run-lfx-fixture', nodeId: 'root', signal, shared: prepared, progress: v => progress.push(v),
    call: fn => fn(), map: async (items, call) => Promise.all(items.map(call)) }
  const result = await workflow.execute(input, config, context)
  return { soc, workflow, result, progress }
}

test('真实LFX：7轮事实→提议成功继续→stop/report，facts/receipts与HTML/details保留', async () => {
  let proposed = 0
  const { soc, workflow, result } = await run({ propose: async () => {
    proposed++
    return proposed === 1
      ? { proposal: { check: 'collectionCapability', args: { assetId: 3617438 }, reason: '核对采集适用性' }, model: { provider: 'fixture', model: 'fixture' } }
      : { proposal: { check: null, reason: '无尚未尝试的能力' }, model: { provider: 'fixture', model: 'fixture' } }
  } })
  assert.ok(proposed >= 1, '真实执行器必须进入受控提议')
  assert.ok(soc.calls.length >= 8, `应执行多轮只读请求，实际 ${soc.calls.length}`)
  assert.ok(Array.isArray(result.items) && result.items.length >= 7)
  assert.ok(Object.values(result.raw_receipts ?? {}).length >= 7, '来源回执必须保留')
  assert.equal(result.conclusion, 'inconclusive')
  assert.notEqual(result.unified_conclusion.rootCause.statusCode, 'CONFIRMED')
  const artifacts = workflow.artifacts(result)
  assert.deepEqual(artifacts.map(a => a.id), ['report', 'details'])
  assert.ok(artifacts[0].body.includes('首屏结论'))
  assert.equal(JSON.parse(artifacts[1].body).run_id, 'run-lfx-fixture')
})

test('真实LFX：忽略abort的慢模型在独立预算内收口，stop/report仍产出', async () => {
  const { workflow, result } = await run({ budget: 60, propose: () => new Promise(() => {}) })
  assert.match(String(result.stop_reason), /独立预算 60ms/)
  assert.ok(Array.isArray(result.items) && result.items.length >= 1, '已追加事实必须保留')
  assert.notEqual(result.unified_conclusion.rootCause.statusCode, 'CONFIRMED')
  const artifacts = workflow.artifacts(result)
  assert.deepEqual(artifacts.map(a => a.id), ['report', 'details'])
  assert.ok(artifacts[0].body.includes('首屏结论'))
})

test('真实LFX：等待组件期间取消工作流，流式连接及时结束', async () => {
  const controller = new AbortController()
  let entered = false, started
  await assert.rejects(run({ signal: controller.signal, propose: async () => {
    entered = true; started = Date.now()
    setTimeout(() => controller.abort(), 30)
    await new Promise(resolve => setTimeout(resolve, 300))
    return { proposal: { check: null, reason: '已取消' } }
  } }), error => error.name === 'AbortError')
  assert.equal(entered, true)
  assert.ok(Date.now() - started < 2000, '不能等待组件或默认传输超时才结束')
})
