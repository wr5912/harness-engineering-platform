import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { invokeExternal } from '../plugin/src/instances/external/access.ts'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'

const root = resolve(process.argv[2]), sample = resolve(process.argv[3]), id = 'remote-opencode-sample'
const caller = { subjectId: 'sample-user-a', source: 'cross-framework-fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() }
const service = new AgentAccessService(root), original = service.status(id).grants.find(row => row.resourceId === 'sample-assets')
if (!original) throw new Error('缺少 OpenCode 资源授予')
const originalGrant = structuredClone(original)
async function run(label: string, input: string, tool: string) {
  const signal = AbortSignal.timeout(90000)
  const created = await invokeExternal(root, caller, { id, operation: 'session:create', requestId: randomUUID() }, signal)
  const prompt = await invokeExternal(root, caller, { id, operation: 'session:prompt', requestId: randomUUID(), sessionId: created.sessionId, input }, signal)
  let last: any, idle = false
  for (let attempt = 0; attempt < 45; attempt++) {
    last = await invokeExternal(root, caller, { id, operation: 'session:read', requestId: randomUUID(), sessionId: created.sessionId }, signal)
    idle = last.value?.data?.some((message: any) => message.type === 'idle')
    if (idle) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const messages: any[] = last?.value?.data ?? [], calls = messages.flatMap(message => message.content ?? []).filter(part => part.type === 'tool' && part.name?.includes(tool))
  return { label, sessionId: created.sessionId, upstreamSessionId: created.upstreamSessionId, promptStage: prompt.stage, idle,
    completed: calls.some(call => call.state?.status === 'completed'), failed: calls.some(call => call.state?.status === 'error'), calls,
    finalTexts: messages.filter(message => message.type === 'assistant' && message.finish === 'stop').flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text) }
}
const results: Awaited<ReturnType<typeof run>>[] = []
try {
  if (!original.enabled) service.saveGrant({ ...original, enabled: true, revision: service.status(id).revision })
  results.push(await run('正常签名资产', '调用 get_asset 查询 A-1 的状态。', 'get_asset'))
  results.push(await run('正常原认证目录', '调用 get_catalog 查询目录 catalog。', 'get_catalog'))
  if (!results.every(row => row.idle && row.completed)) throw new Error('撤权前的双资源正常路径未完成')
  service.saveGrant({ ...originalGrant, enabled: false, revision: service.status(id).revision })
  results.push(await run('撤签名授权后原认证目录', '调用 get_catalog 查询目录 catalog。', 'get_catalog'))
  results.push(await run('撤签名授权后资产拒绝', '调用 get_asset 查询 A-1 的状态。', 'get_asset'))
} finally {
  service.saveGrant({ ...originalGrant, revision: service.status(id).revision })
}
results.push(await run('恢复签名授权后资产', '调用 get_asset 查询 A-1 的状态。', 'get_asset'))
const passed = results[0]?.completed && results[1]?.completed && results[2]?.completed && results[3]?.failed && !results[3]?.completed && results[4]?.completed
const output = { at: new Date().toISOString(), instanceId: id, passed, results,
  scope: '仅撤销并恢复 OpenCode 的 sample-assets 授予；native_catalog 使用独立原生认证、原连接，不进入 Harness 签发链。',
  runtimeEvidence: JSON.parse(readFileSync(join(sample, 'deployment.json'), 'utf8')) }
writeFileSync(join(sample, 'coexistence-evidence.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ passed, results: results.map(({ label, idle, completed, failed, upstreamSessionId }) => ({ label, idle, completed, failed, upstreamSessionId })) }) + '\n')
if (!passed) process.exitCode = 1
