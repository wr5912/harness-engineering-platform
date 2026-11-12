import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'
import { createExternalInstancesHandler } from '../plugin/src/instances/external/index.ts'
import { externalInstances } from '../plugin/src/instances/external/registry.ts'
import { readSampleEndpoints } from './endpoints.mts'

const root = resolve(process.argv[2] ?? ''), sample = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3] || !root.includes('/.local/') || !sample.includes('/.local/')) throw new Error('请显式指定隔离平台数据根和 AgentScope 样本目录')
const endpoints = readSampleEndpoints(root)
const target = JSON.parse(readFileSync(join(sample, 'target.json'), 'utf8'))
const credentials = JSON.parse(readFileSync(join(root, '.local/credentials/fixture.json'), 'utf8'))
const instanceId = 'remote-agentscope-sample', service = new AgentAccessService(root)
const original = service.status(instanceId).grants.find(row => row.resourceId === 'sample-assets')
if (!original) throw new Error('缺少 AgentScope 的模拟资产授予')
const originalGrant = structuredClone(original), results: any[] = []
const endpoint = endpoints.origin + '/api/external-instances/v1/' + instanceId + '/invoke'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const knownSecrets = Object.values(credentials).filter((value): value is string => typeof value === 'string' && value.length > 0)
for (const path of [join(sample, 'connector/instance.key'), join(sample, 'model.llm-api-key')]) if (existsSync(path)) knownSecrets.push(readFileSync(path, 'utf8').trim())
function serialize(value: unknown) { return knownSecrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[已隐藏凭据]') : text, JSON.stringify(value, null, 2)) + '\n' }
async function invoke(operation: string, input?: string) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.userA}` },
    body: JSON.stringify({ operation, sessionId: target.sessionId, input, requestId: randomUUID() }), redirect: 'error', signal: AbortSignal.timeout(30000) })
  const value = await response.json() as any
  if (!response.ok) throw new Error(`平台接入 ${operation} 未完成（HTTP ${response.status}，${value.error ?? value.stage ?? 'unknown'}）`)
  return value
}
const content = (messages: any[]) => messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
async function mcpObservation() {
  const response = await fetch(`http://127.0.0.1:18652/workspace/mcp?agent_id=${encodeURIComponent(target.agentId)}&session_id=${encodeURIComponent(target.upstreamSessionId)}`, {
    headers: { 'x-user-id': 'harness-' + instanceId }, signal: AbortSignal.timeout(15000), redirect: 'error',
  })
  if (!response.ok) throw new Error('原生 MCP 状态读取失败')
  const value: any = await response.json(), clients: any[] = Array.isArray(value) ? value : value.mcps ?? value.items ?? []
  return clients.map(client => ({ name: client.name, healthy: client.is_healthy, tools: (client.tools ?? []).map((tool: any) => tool.name),
    errorHttpStatus: typeof client.error === 'string' ? /\b(401|403|503)\b/.exec(client.error)?.[1] : undefined }))
}
async function prepareSession() {
  const handler = createExternalInstancesHandler(root)
  for (const operation of ['verify', 'enable']) {
    const result = await handler(operation, { id: instanceId, revision: externalInstances(root).revision, requestId: randomUUID() }, new AbortController().signal, { principal: { kind: 'owner' } } as any)
    if (!result.ok) throw new Error(`AgentScope ${operation} 未完成：${result.error.code}`)
  }
  const created = await invoke('session:create')
  target.sessionId = created.sessionId; target.upstreamSessionId = created.upstreamSessionId
  const origin = 'http://127.0.0.1:18652', user = 'harness-' + instanceId
  async function native(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-user-id': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`原生 AgentScope 配置失败（HTTP ${response.status}）`)
    return response.status === 204 ? undefined : response.json() as any
  }
  const query = `?agent_id=${encodeURIComponent(target.agentId)}&session_id=${encodeURIComponent(target.upstreamSessionId)}`
  await native(`/sessions/${encodeURIComponent(target.upstreamSessionId)}?agent_id=${encodeURIComponent(target.agentId)}`, 'PATCH', {
    permission_mode: 'bypass', chat_model_config: { type: 'openai_chat_model', credential_id: target.credentialId, model: 'cross-framework-fixture', parameters: {} },
  })
  const response = await native('/workspace/mcp' + query), clients: any[] = Array.isArray(response) ? response : response.mcps ?? response.items ?? []
  for (const item of clients) if (!['protected_assets', 'native_catalog'].includes(item.name)) await native('/workspace/mcp/' + encodeURIComponent(item.name) + query, 'DELETE')
  if (!clients.some(item => item.name === 'protected_assets')) await native('/workspace/mcp' + query, 'POST', { name: 'protected_assets', is_stateful: false, mcp_config: { type: 'http_mcp', url: 'http://hep-cross-framework-agentscope-connector:8080/mcp' } })
  if (!clients.some(item => item.name === 'native_catalog')) await native('/workspace/mcp' + query, 'POST', { name: 'native_catalog', is_stateful: false, mcp_config: { type: 'http_mcp', url: endpoints.fixture + '/catalog/mcp', headers: { Authorization: `Bearer ${credentials.catalog}` } } })
  writeFileSync(join(sample, 'target.json'), JSON.stringify(target), { mode: 0o600 })
}
async function run(label: string, input: string, tool: string) {
  const previous = await invoke('session:read'), priorMessages: any[] = previous.value?.messages ?? []
  const beforeEvents = new Set(service.status(instanceId).records.map(row => row.requestId + ':' + row.stage))
  const accepted = await invoke('session:prompt', input)
  let last: any, messages: any[] = [], blocks: any[] = [], complete = false, discoveryBlocked = false, discovery: any[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    last = await invoke('session:read')
    messages = (last.value?.messages ?? []).slice(priorMessages.length)
    blocks = content(messages)
    const result = blocks.find(block => block.type === 'tool_result' && block.name?.includes(tool) && block.state !== 'running')
    const final = messages.some(message => message.role === 'assistant' && (message.content ?? []).some((block: any) => block.type === 'text'))
    complete = last.value?.is_running === false && Boolean(result) && final
    if (!complete && attempt >= 2 && tool === 'get_asset' && last.value?.is_running === false && final
      && service.status(instanceId).grants.some(row => row.resourceId === 'sample-assets' && !row.enabled)) {
      discovery = await mcpObservation()
      discoveryBlocked = discovery.some(row => row.name === 'protected_assets' && !row.healthy && ['401', '403', '503'].includes(row.errorHttpStatus))
      complete = discoveryBlocked
    }
    if (complete) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const calls = blocks.filter(block => ['tool_call', 'tool_result'].includes(block.type) && block.name?.includes(tool))
  const toolResults = calls.filter(block => block.type === 'tool_result')
  const events = service.status(instanceId).records.filter(row => !beforeEvents.has(row.requestId + ':' + row.stage))
  const row = { label, sessionId: target.sessionId, upstreamSessionId: target.upstreamSessionId, promptStage: accepted.stage, complete,
    isRunning: last?.value?.is_running, succeeded: toolResults.some(block => block.state === 'success'),
    denied: toolResults.some(block => ['error', 'denied', 'interrupted'].includes(block.state)) || discoveryBlocked,
    denialStage: discoveryBlocked ? 'mcp-discovery' : undefined, discovery, calls, events,
    finalTexts: messages.filter(message => message.role === 'assistant').flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text) }
  results.push(row)
  process.stdout.write(JSON.stringify({ label, complete, succeeded: row.succeeded, denied: row.denied, tools: calls.map(block => ({ name: block.name, type: block.type, state: block.state })), resourceStages: events.map(event => event.stage) }) + '\n')
  return row
}
let failure: string | undefined
try {
  if (!original.enabled) service.saveGrant({ ...original, enabled: true, revision: service.status(instanceId).revision })
  await prepareSession()
  const asset = await run('正常签名资产', '调用 get_asset 查询 A-1 的状态。', 'get_asset')
  const catalog = await run('正常原认证目录', '调用 get_catalog 查询目录 catalog。', 'get_catalog')
  if (!asset.complete || !asset.succeeded || !catalog.complete || !catalog.succeeded) throw new Error('撤权前双资源路径未完成，保留观察结果')
  service.saveGrant({ ...originalGrant, enabled: false, revision: service.status(instanceId).revision })
  await run('撤签名授权后原认证目录', '调用 get_catalog 查询目录 catalog。', 'get_catalog')
  await run('撤签名授权后资产拒绝', '调用 get_asset 查询 A-1 的状态。', 'get_asset')
} catch (error) { failure = error instanceof Error ? error.message : '验收中断' }
finally { service.saveGrant({ ...originalGrant, revision: service.status(instanceId).revision }) }
if (!failure) await run('恢复签名授权后资产', '调用 get_asset 查询 A-1 的状态。', 'get_asset')
if (!failure && process.argv.includes('--shell')) await run('原生 Bash 凭据隔离探针', '执行隔离探针，仅报告 connector 文件及 Docker socket 是否可读取，不输出文件内容。', 'Bash')
const isolation = results.find(row => row.label === '原生 Bash 凭据隔离探针')
const isolationOutput = isolation ? JSON.stringify(isolation.calls.filter((block: any) => block.type === 'tool_result').map((block: any) => block.output)) : ''
const isolationPassed = !isolation || isolation.succeeded && ['/run/connector/instance.key', '/run/connector/config.json', '/run/instance/instance.secret', '/var/run/docker.sock'].every(path => isolationOutput.includes(path + ':UNREADABLE'))
const passed = !failure && results.length >= 5 && results[0].succeeded && results[1].succeeded && results[2].succeeded
  && results[3].denied && !results[3].succeeded && !results[3].events.some((event: any) => event.stage === 'dispatched') && results[4].succeeded
  && isolationPassed
const evidence = { at: new Date().toISOString(), instanceId, passed, failure, isolationPassed, results,
  boundary: '真实 AgentScope 2.0.8 Service Runtime、独立容器模拟远程部署、确定性模拟推理与模拟业务资源；不构成真实模型、真实远程主机或业务效果验收',
  scope: '仅撤销并恢复 AgentScope sample-assets 授予；native_catalog 继续使用独立原生认证。模型文字不作为工具成功依据。' }
if (existsSync(join(sample, 'coexistence-evidence.json'))) {
  const previous = JSON.parse(readFileSync(join(sample, 'coexistence-evidence.json'), 'utf8'))
  writeFileSync(join(sample, 'coexistence-history-' + String(previous.at ?? runId).replace(/[:.]/g, '-') + '.json'), serialize(previous), { mode: 0o600, flag: 'wx' })
}
writeFileSync(join(sample, 'coexistence-evidence.json'), serialize(evidence), { mode: 0o600 })
if (process.argv[4]) { const directory = resolve(process.argv[4]); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `agentscope-runtime-${runId}.json`), serialize(evidence), { flag: 'wx' }) }
process.stdout.write(JSON.stringify({ passed, failure, resultCount: results.length }) + '\n')
if (!passed) process.exitCode = 1
