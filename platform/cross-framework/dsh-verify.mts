/** 真实 DSH 循环与模拟模型、业务资源的入口/撤权/并存验收。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'
import { readSampleEndpoints } from './endpoints.mts'

if (!process.argv[2] || !process.argv[3]) throw new Error('用法：dsh-verify <隔离数据根> <DSH样本目录>')
const root = resolve(process.argv[2]), sample = resolve(process.argv[3]), instanceId = 'remote-dsh-sample'
if (!root.includes('/.local/') || !sample.includes('/.local/')) throw new Error('只允许隔离样本目录')
const credentials = JSON.parse(readFileSync(join(root, '.local/credentials/fixture.json'), 'utf8'))
const base = `${readSampleEndpoints(root).origin}/api/external-instances/v1/${instanceId}/invoke`
async function call(operation: string, input: Record<string, unknown> = {}) {
  const response = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${credentials.userA}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, requestId: randomUUID(), ...input }), signal: AbortSignal.timeout(30000) })
  const result = await response.json() as any
  if (!response.ok) throw new Error(`平台 ${operation} HTTP ${response.status} ${result.error ?? ''}`)
  return result
}
function events(value: any) { return (value?.records ?? []).map((row: any) => row.event).filter(Boolean) }
function toolResults(rows: any[]) { return rows.filter(row => row.type === 'tool/result').map(row => row.data?.message) }
async function turn(name: string, input: string) {
  const created = await call('session:create'), accepted = await call('session:prompt', { sessionId: created.sessionId, input })
  assert.equal(accepted.stage, 'accepted')
  const deadline = Date.now() + 60000
  let rows: any[] = []
  while (Date.now() < deadline) {
    const page = await call('session:read', { sessionId: created.sessionId }); rows = events(page.value)
    if (rows.some(row => row.type === 'turn/end') && rows.some(row => row.type === 'tool/result')) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  assert.ok(rows.some(row => row.type === 'turn/end'), `${name} 未取得真实 turn/end`)
  assert.ok(rows.some(row => row.type === 'tool/result'), `${name} 未取得实际工具返回`)
  return { name, sessionId: created.sessionId, upstreamSessionId: created.upstreamSessionId, accepted: true,
    toolCalls: rows.filter(row => row.type === 'tool/call').map(row => ({ name: row.data?.name, arguments: row.data?.arguments })), toolResults: toolResults(rows) }
}
const service = new AgentAccessService(root)
const updateGrant = (enabled: boolean) => service.saveGrant({ instanceId, resourceId: 'sample-assets', enabled, scopes: ['assets:read'], objects: ['A-1'], revision: service.status(instanceId).revision })
const results: any[] = []
if (process.argv.includes('--isolation')) {
  const result = await turn('真实 Bash 凭据隔离探针', '请执行隔离探针，核验指定机器凭据与 Docker socket 是否可读，只报告 READABLE 或 UNREADABLE，绝不输出文件内容。')
  assert.ok(result.toolCalls.some(call => /^(bash|Bash)$/.test(call.name)), '未经过真实 Bash 工具')
  const output = JSON.stringify(result.toolResults)
  assert.match(output, /instance\.secret:UNREADABLE/); assert.match(output, /docker\.sock:UNREADABLE/); assert.doesNotMatch(output, /:READABLE/)
  writeFileSync(join(sample, 'isolation-verification.json'), JSON.stringify({ at: new Date().toISOString(), instanceId, scope: '本机容器中的真实模型可用Bash；模拟模型只负责提出固定低影响探针', result }, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ instanceId, shellProbe: 'passed', evidence: join(sample, 'isolation-verification.json') }) + '\n')
  process.exit(0)
}
updateGrant(true)
try {
  const normal = await turn('签名资源正常调用', '请用资产工具查询资产 A-1，并依据工具返回回答。')
  assert.match(JSON.stringify(normal.toolResults), /A-1/); assert.match(JSON.stringify(normal.toolResults), /正常/); results.push(normal)
  updateGrant(false)
  const denied = await turn('撤销授予后的签名调用', '请用资产工具查询资产 A-1，并依据工具返回回答。')
  assert.ok(denied.toolResults.some(result => result.isError === true), '未取得签名资源拒绝的真实工具错误')
  assert.doesNotMatch(JSON.stringify(denied.toolResults), /\\"status\\":\\"正常\\"/); results.push(denied)
  const catalog = await turn('撤销期间原生认证服务', '请调用目录 catalog 工具查询业务目录，并依据工具返回回答。')
  assert.match(JSON.stringify(catalog.toolResults), /资产查询/); assert.match(JSON.stringify(catalog.toolResults), /native/); results.push(catalog)
} finally { updateGrant(true) }
const recovered = await turn('恢复授予后的签名调用', '请用资产工具查询资产 A-1，并依据工具返回回答。')
assert.match(JSON.stringify(recovered.toolResults), /A-1/); assert.match(JSON.stringify(recovered.toolResults), /正常/); results.push(recovered)
const proof = { at: new Date().toISOString(), instanceId, runtimeVersion: '0.2.1-rc.5', sourceCommit: 'b830ec950faba0a46dda564be3e2d854afed94f1',
  environment: '本机隔离容器模拟远程已有实例', model: '确定性模拟OpenAI模型；不证明真实模型或业务效果', resource: '模拟业务资源', results }
writeFileSync(join(sample, 'verification.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ instanceId, passed: results.map(result => result.name), evidence: join(sample, 'verification.json') }) + '\n')
