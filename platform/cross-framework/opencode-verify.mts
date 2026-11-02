import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { invokeExternal } from '../plugin/src/instances/external/access.ts'

const root = resolve(process.argv[2]), sample = resolve(process.argv[3])
const caller = { subjectId: 'sample-user-a', source: 'cross-framework-fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() }
const instanceId = 'remote-opencode-sample', signal = AbortSignal.timeout(120000)
const created = await invokeExternal(root, caller, { id: instanceId, operation: 'session:create', requestId: randomUUID() }, signal)
const accepted = await invokeExternal(root, caller, { id: instanceId, operation: 'session:prompt', sessionId: created.sessionId,
  input: '请调用 get_asset 查询 A-1，再依据工具结果给出状态。', requestId: randomUUID() }, signal)
let projection: Awaited<ReturnType<typeof invokeExternal>> | undefined
let complete = false
for (let attempt = 0; attempt < 30; attempt++) {
  projection = await invokeExternal(root, caller, { id: instanceId, operation: 'session:read', sessionId: created.sessionId, requestId: randomUUID() }, signal)
  const value = projection.value as { data?: Array<{ type?: string; outcome?: string; finish?: string; content?: Array<{ type?: string; name?: string; state?: { status?: string } }> }> }
  const messages = value?.data ?? []
  if (messages.some(message => message.type === 'idle' && message.outcome === 'succeeded')
    && messages.some(message => message.type === 'assistant' && message.finish === 'stop')
    && messages.some(message => message.content?.some(part => part.type === 'tool' && part.name?.includes('get_asset') && part.state?.status === 'completed'))) { complete = true; break }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
const result = { instanceId, created, accepted, projection, complete, at: new Date().toISOString(),
  runtime: JSON.parse(readFileSync(join(sample, 'deployment.json'), 'utf8')), boundary: '真实 OpenCode 源码 Runtime、隔离容器模拟远程部署、模拟推理与模拟业务资源' }
writeFileSync(join(sample, 'runtime-evidence.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ instanceId, sessionId: created.sessionId, upstreamSessionId: created.upstreamSessionId, acceptedStage: accepted.stage, complete,
  projection: JSON.stringify(projection?.value).slice(0, 1600) }) + '\n')
if (!complete) process.exitCode = 1
