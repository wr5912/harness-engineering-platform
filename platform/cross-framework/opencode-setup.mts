import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from '../../platform/plugin/node_modules/esbuild/lib/main.js'
import { externalDetail, externalInstances, getExternalInstance, mutateExternal } from '../plugin/src/instances/external/registry.ts'
import { probeExternal } from '../plugin/src/instances/external/adapters.ts'
import { AgentAccessService } from '../plugin/src/agent-access/service.ts'
import { configureOpenCodeSample } from './opencode-sample.mts'

const root = resolve(process.argv[2]), sample = resolve(process.argv[3]), id = 'remote-opencode-sample'
const credential = JSON.parse(readFileSync(join(sample, 'server-credential.json'), 'utf8'))
const authDir = join(root, '.local/credentials/external'); mkdirSync(authDir, { recursive: true, mode: 0o700 })
writeFileSync(join(authDir, 'sample-opencode.json'), JSON.stringify({ headers: { authorization: `Basic ${Buffer.from(`opencode:${credential.password}`).toString('base64')}` } }), { mode: 0o600 })
if (!getExternalInstance(root, id)) mutateExternal(root, 'save', { revision: externalInstances(root).revision, requestId: randomUUID(),
  agent: { id: 'remote-opencode-agent', name: 'OpenCode 原框架接入样本', system: '本机模拟远程部署', owner: '本项目接入验收' },
  instance: { id, agentId: 'remote-opencode-agent', name: 'OpenCode v2.2.5 源码实例', framework: 'opencode', endpoint: 'http://127.0.0.1:18655',
    selector: '/workspace', credentialRef: 'sample-opencode', managementMode: 'externally-managed', usageMode: 'shared', declaredVersion: '2.2.5', location: '隔离容器，模拟远程已有服务' },
  policy: { subjects: ['sample-user-a', 'sample-user-b'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read', 'session:events'], enabled: true } })
let detail = externalDetail(root, id)
const verification = await probeExternal(root, detail.instance, AbortSignal.timeout(30000))
if (!verification.ok) throw new Error('OpenCode 原生目标验证未通过：' + verification.checks.filter(row => !row.ok).map(row => row.detail).join('；'))
detail = mutateExternal(root, 'verify', { id, revision: detail.revision, requestId: randomUUID() }, verification)
detail = mutateExternal(root, 'enable', { id, revision: detail.revision, requestId: randomUUID() })
const service = new AgentAccessService(root), connectorDirectory = join(sample, 'connector'); mkdirSync(connectorDirectory, { recursive: true, mode: 0o700 })
const identity = service.createCredential(id, service.status(id).credentials.some(row => row.effectiveStatus === 'active'))
writeFileSync(join(connectorDirectory, 'instance.secret'), identity.secret, { mode: 0o600 })
service.saveGrant({ instanceId: id, resourceId: 'sample-assets', scopes: ['assets:read'], objects: ['A-1'], enabled: true, revision: service.status(id).revision })
const config = { instanceId: id, clientId: identity.credential.clientId, secretFile: '/run/instance/instance.secret', tokenEndpoint: 'http://172.17.0.1:18656/oauth/token',
  resourceUrl: 'http://172.17.0.1:18656/api/agent-access/v1/resources/sample-assets/mcp', audience: 'urn:harness:sample-assets', scopes: ['assets:read'], host: '0.0.0.0', port: 18700 }
writeFileSync(join(connectorDirectory, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
await build({ entryPoints: [resolve('platform/plugin/src/agent-access/connector.ts')], outfile: join(connectorDirectory, 'connector.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const container = 'hep-cross-framework-opencode-connector'
const run = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
try {
  const old = JSON.parse(run(['inspect', container]))[0]
  if (old.Config.Labels?.['hep.sample'] !== 'cross-framework-opencode-connector') throw new Error('同名 connector 不属于本任务')
  run(['rm', '-f', container])
} catch (error) { if (error instanceof Error && error.message.includes('不属于')) throw error }
run(['run', '-d', '--name', container, '--label', 'hep.sample=cross-framework-opencode-connector', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  '--network', 'hep-cross-framework-opencode', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
  '-v', `${connectorDirectory}:/run/instance:ro`, 'node:24-bookworm-slim', 'node', '/run/instance/connector.mjs', '/run/instance/config.json'])
configureOpenCodeSample(sample, { modelEndpoint: 'http://172.17.0.1:18650/v1', connectorUrl: `http://${container}:18700/mcp`, model: 'cross-framework-fixture',
  nativeCatalog: { url: 'http://172.17.0.1:18650/catalog/mcp', credentialFile: join(root, '.local/credentials/fixture.json') } })
process.stdout.write(JSON.stringify({ instanceId: id, entryState: detail.instance.entryState, observedVersion: verification.observedVersion,
  connector: container, resource: 'sample-assets', credentialId: identity.credential.id, secretVisibleToModel: false }) + '\n')
