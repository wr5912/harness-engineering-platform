import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createExternalInstancesHandler } from '../plugin/src/instances/external/index.ts'
import { externalInstances } from '../plugin/src/instances/external/registry.ts'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !root.includes('/.local/')) throw new Error('请显式提供隔离数据根')
const id = 'remote-agentscope-sample', origin = 'http://127.0.0.1:18652'
const state = resolve(root, '..', 'agentscope'), user = `harness-${id}`
const native = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-user-id': user }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`AgentScope ${method} ${path.split('?')[0]} HTTP ${response.status}`)
  return response.status === 204 ? undefined : response.json() as Promise<any>
}
mkdirSync(state, { recursive: true, mode: 0o700 })
const targetsFile = join(state, 'setup.json')
let target: any = existsSync(targetsFile) ? JSON.parse(readFileSync(targetsFile, 'utf8')) : undefined
if (!target) {
  const agent = await native('/agent/', 'POST', { name: '跨框架远程样本', system_prompt: '使用 get_asset 工具读取用户指定资产，再根据工具结果回答。' })
  const agentId = agent.agent_id ?? agent.id ?? agent.agent?.id
  if (!agentId) throw new Error('原生 Agent 未返回稳定 ID')
  const key = randomBytes(32).toString('base64url')
  writeFileSync(join(state, 'model.llm-api-key'), key, { mode: 0o600 })
  const credential = await native('/credential/', 'POST', { data: { type: 'openai_credential', name: '模拟模型', api_key: key, base_url: 'http://172.17.0.1:18650/v1' } })
  const credentialId = credential.credential_id ?? credential.id ?? credential.credential?.id
  if (!credentialId) throw new Error('原生模型凭据未返回稳定 ID')
  target = { agentId, credentialId, endpoint: origin, version: '2.0.8' }
  writeFileSync(targetsFile, JSON.stringify(target), { mode: 0o600 })
}
const handler = createExternalInstancesHandler(root), peer = { principal: { kind: 'owner' } }
async function management(endpoint: string, input: Record<string, unknown>) {
  const response: any = await handler(endpoint, input, new AbortController().signal, peer as any)
  if (!response?.ok) throw new Error(`${endpoint}: ${response?.error?.code} ${response?.error?.message}`)
  return response.value
}
if (!externalInstances(root).instances.some(row => row.id === id)) await management('save', {
  revision: externalInstances(root).revision, requestId: randomUUID(), agent: { id: 'remote-agentscope', name: 'AgentScope 远程样本', system: '跨框架接入验收', owner: '本项目样本维护者' },
  instance: { id, name: 'AgentScope 模拟远程实例', framework: 'agentscope', endpoint: origin, selector: target.agentId, declaredVersion: '2.0.8', managementMode: 'externally-managed', usageMode: 'shared', location: '独立容器模拟远程', instanceOwner: '样本维护者' },
  policy: { instanceId: id, subjects: ['platform-owner', 'sample-user-a', 'sample-user-b'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read', 'session:events'], enabled: true },
})
await management('verify', { id, revision: externalInstances(root).revision, requestId: randomUUID() })
await management('enable', { id, revision: externalInstances(root).revision, requestId: randomUUID() })
const access = new AgentAccessService(root), connectorDirectory = join(state, 'connector')
mkdirSync(connectorDirectory, { recursive: true, mode: 0o700 })
const connectorFile = join(connectorDirectory, 'config.json')
if (!existsSync(connectorFile)) {
  const { credential, secret } = access.createCredential(id)
  writeFileSync(join(connectorDirectory, 'instance.key'), secret, { mode: 0o600 })
  writeFileSync(connectorFile, JSON.stringify({ instanceId: id, clientId: credential.clientId, secretFile: '/run/connector/instance.key',
    tokenEndpoint: 'http://172.17.0.1:18656/oauth/token', resourceUrl: 'http://172.17.0.1:18656/api/agent-access/v1/resources/sample-assets/mcp',
    audience: 'urn:harness:sample-assets', scopes: ['assets:read'], host: '0.0.0.0', port: 8080 }), { mode: 0o600 })
}
access.saveGrant({ instanceId: id, resourceId: 'sample-assets', scopes: ['assets:read'], objects: ['A-1'], enabled: true, revision: access.status(id).revision })
const name = 'hep-cross-framework-agentscope-connector'
let running = false
try { running = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].State.Running } catch {}
if (!running) {
  try {
    const old = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0]
    if (old.Config.Labels?.['harness.task'] !== 'cross-framework-access') throw new Error('同名对象不属于本任务')
    execFileSync('docker', ['rm', name], { stdio: 'ignore' })
  } catch (error) { if (error instanceof Error && error.message.includes('不属于')) throw error }
  execFileSync('docker', ['run', '-d', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--name', name, '--label', 'harness.task=cross-framework-access', '--network', 'hep-cross-framework-agentscope',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${connectorDirectory}:/run/connector:ro`,
  '-v', `${resolve('.local/cross-framework/plugin-lib/agent-access-connector.js')}:/opt/connector.mjs:ro`, 'node:24-bookworm-slim', 'node', '/opt/connector.mjs', '/run/connector/config.json'], { stdio: ['ignore', 'pipe', 'pipe'] })
}
const sampleCredentials = JSON.parse(readFileSync(join(root, '.local/credentials/fixture.json'), 'utf8'))
const create = await fetch(`http://172.17.0.1:18656/api/external-instances/v1/${id}/invoke`, { method: 'POST', headers: { authorization: `Bearer ${sampleCredentials.userA}`, 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'session:create', requestId: randomUUID() }) })
const created: any = await create.json()
if (!create.ok) throw new Error('平台会话创建未完成：' + JSON.stringify(created))
const invocation = created
const nativeId = invocation.upstreamSessionId, query = `?agent_id=${encodeURIComponent(target.agentId)}&session_id=${encodeURIComponent(nativeId)}`
await native(`/sessions/${encodeURIComponent(nativeId)}?agent_id=${encodeURIComponent(target.agentId)}`, 'PATCH', { permission_mode: 'bypass', chat_model_config: { type: 'openai_chat_model', credential_id: target.credentialId, model: 'cross-framework-fixture', parameters: {} } })
const mcps = await native('/workspace/mcp' + query)
for (const mcp of mcps.mcps ?? mcps.items ?? []) if ((mcp.name ?? mcp.client?.name) !== 'protected_assets') await native('/workspace/mcp/' + encodeURIComponent(mcp.name ?? mcp.client?.name) + query, 'DELETE')
await native('/workspace/mcp' + query, 'POST', { name: 'protected_assets', is_stateful: false, mcp_config: { type: 'http_mcp', url: 'http://hep-cross-framework-agentscope-connector:8080/mcp' } })
await native('/workspace/mcp' + query, 'POST', { name: 'native_catalog', is_stateful: false, mcp_config: { type: 'http_mcp', url: 'http://172.17.0.1:18650/catalog/mcp', headers: { Authorization: `Bearer ${sampleCredentials.catalog}` } } })
writeFileSync(join(state, 'target.json'), JSON.stringify({ ...target, platformInstanceId: id, sessionId: invocation.sessionId, upstreamSessionId: nativeId }), { mode: 0o600 })
process.stdout.write(JSON.stringify({ instanceId: id, sessionId: invocation.sessionId, configured: true }) + '\n')
