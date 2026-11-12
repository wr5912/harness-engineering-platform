/** 锁定 DSH 样本的登记与资源配置；不接管产品中的接入实例生命周期。 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { externalDetail, externalInstances, getExternalInstance, mutateExternal } from '../plugin/src/instances/external/registry.ts'
import { probeExternal } from '../plugin/src/instances/external/adapters.ts'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'
import { readSampleEndpoints } from './endpoints.mts'

if (!process.argv[2] || !process.argv[3] || !process.argv[4]) throw new Error('用法：dsh-setup <隔离数据根> <样本状态目录> <DSH专用凭据文件>')
const root = resolve(process.argv[2]), sample = resolve(process.argv[3]), credentialFile = resolve(process.argv[4]), id = 'remote-dsh-sample'
if (!root.includes('/.local/') || !sample.includes('/.local/')) throw new Error('样本只允许使用独立 .local 数据目录')
const endpoints = readSampleEndpoints(root)
const target = JSON.parse(readFileSync(join(sample, 'target.json'), 'utf8'))
if (target.commit !== 'ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c' || target.version !== '0.2.2-rc.2') throw new Error('DSH 样本版本与锁定来源不一致')
const credentials = join(root, '.local/credentials/external'); mkdirSync(credentials, { recursive: true, mode: 0o700 })
copyFileSync(credentialFile, join(credentials, 'cross-framework-dsh.json'))
if (!getExternalInstance(root, id)) mutateExternal(root, 'save', { revision: externalInstances(root).revision, requestId: randomUUID(),
  agent: { id: 'remote-dsh-agent', name: 'DSH 原框架接入样本', system: '本机模拟远程部署', owner: '本项目接入验收' },
  instance: { id, agentId: 'remote-dsh-agent', name: 'DSH rc.5 源码实例', framework: 'dsh', endpoint: target.endpoint,
    selector: target.selector, credentialRef: 'cross-framework-dsh', managementMode: 'externally-managed', usageMode: 'shared', declaredVersion: target.version, location: '独立容器，模拟远程已有服务' },
  policy: { subjects: ['platform-owner', 'sample-user-a', 'sample-user-b'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read'], enabled: true } })
let detail = externalDetail(root, id)
const verification = await probeExternal(root, detail.instance, AbortSignal.timeout(30000))
if (!verification.ok) throw new Error('DSH 原生接口核验失败：' + verification.checks.filter(row => !row.ok).map(row => row.detail).join('；'))
detail = mutateExternal(root, 'verify', { id, revision: detail.revision, requestId: randomUUID() }, verification)
detail = mutateExternal(root, 'enable', { id, revision: detail.revision, requestId: randomUUID() })
const service = new AgentAccessService(root)
// 此目录不在 DSH 样本挂载范围内，模型文件工具与 shell 不能读取实例机器秘密。
const connectorDirectory = join(root, '.local/connectors', id); mkdirSync(connectorDirectory, { recursive: true, mode: 0o700 })
const connectorFile = join(connectorDirectory, 'config.json')
if (!existsSync(connectorFile)) {
  const identity = service.createCredential(id)
  writeFileSync(join(connectorDirectory, 'instance.secret'), identity.secret, { mode: 0o600 })
  writeFileSync(connectorFile, JSON.stringify({ instanceId: id, clientId: identity.credential.clientId, secretFile: '/run/instance/instance.secret',
    tokenEndpoint: endpoints.origin + '/oauth/token', resourceUrl: endpoints.origin + '/api/agent-access/v1/resources/sample-assets/mcp',
    audience: 'urn:harness:sample-assets', scopes: ['assets:read'], host: '0.0.0.0', port: 8080 }, null, 2), { mode: 0o600 })
}
service.saveGrant({ instanceId: id, resourceId: 'sample-assets', scopes: ['assets:read'], objects: ['A-1'], enabled: true, revision: service.status(id).revision })
const connectorArtifact = resolve('.local/cross-framework/plugin-lib/agent-access-connector.js')
if (!existsSync(connectorArtifact)) throw new Error('请先构建本轮隔离 connector 制品，再执行 DSH 样本配置')
copyFileSync(connectorArtifact, join(connectorDirectory, 'connector.mjs'))
const name = 'hep-cross-framework-dsh-connector', docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let current: any
try { current = JSON.parse(docker(['inspect', name]))[0] } catch { /* 首次部署 */ }
if (current && current.Config.Labels?.['hep.sample'] !== 'cross-framework-dsh-connector') throw new Error('同名 connector 不属于本任务')
if (!current?.State.Running) {
  if (current) docker(['rm', name])
  docker(['run', '-d', '--name', name, '--label', 'hep.sample=cross-framework-dsh-connector', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--network', 'hep-cross-framework-dsh', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '-v', `${connectorDirectory}:/run/instance:ro`, 'node:24-bookworm-slim', 'node', '/run/instance/connector.mjs', '/run/instance/config.json'])
}
const native = JSON.parse(readFileSync(join(root, '.local/credentials/fixture.json'), 'utf8'))
const patchFile = join(sample, 'home/cordis.patch.yml'), patch = JSON.parse(readFileSync(patchFile, 'utf8'))
const additions = patch.find((row: any) => Array.isArray(row.insert))?.insert ?? []
const signed = additions.find((row: any) => row.id === 'cross-framework-signed-mcp'), ordinary = additions.find((row: any) => row.id === 'cross-framework-ordinary-mcp')
if (signed) signed.config.url = `http://${name}:8080/mcp`
if (ordinary) { ordinary.config.url = endpoints.fixture + '/catalog/mcp'; ordinary.config.headers = { Authorization: `Bearer ${native.catalog}` } }
writeFileSync(patchFile, JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 })
writeFileSync(join(sample, 'setup.json'), JSON.stringify({ instanceId: id, entryState: detail.instance.entryState, connector: name, resource: 'sample-assets', endpoint: target.endpoint,
  sourceCommit: target.commit, runtimeVersion: target.version, evidenceScope: '真实DSH Runtime与模拟远程部署、模拟业务资源' }, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ instanceId: id, entryState: detail.instance.entryState, connector: name, resource: 'sample-assets', next: '核对样本实际装载的MCP和模型；必要时只重启此样本' }) + '\n')
